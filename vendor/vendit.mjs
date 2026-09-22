import {componentSocket, componentHooks, transaction, onceTransaction, requireCustomer, requireProximity, fixerRank, foodTierId, housingItem, textName, lifestyleItem, intrinsicAttack, kindLabel, saleBlocked, fitDialog} from "../scripts/core.mjs";
const marketSocket=componentSocket("vendit");
/***** Vendit™ Persistent Shops Module (v1.2.5; converted from macro v3.0.3)
 * UI: Player "Buy" button narrower (no flex-grow)
 * UI: Edit dialog uses a single scrollbar (window-content); list no longer scrolls separately
 * Fix: data-items attribute typo that broke item rows (and delete ✖ appearance)
 * UX: Manager list live-refresh on New / Save / Delete
 * Safe: extra-robust venditId sanitizing for tile args
 * Keeps: socket GM stock writes, Preview, Quick Add, Test Roll, theme, autosize, themed footer buttons
 * UI: Freezed per dialog instance to stop creep
*****/

const MODULE_ID = "night-city-market";
const MODULE_VERSION = "1.2.5";
const STORE_NS = MODULE_ID;
const STORE_KEY = "venditDb";
const FLAG_VER  = 7;
const SOCKET = `module.${MODULE_ID}`;
const BINDER_MACRO_NAME = "Торговля — привязка автомата";
const BINDER_MACRO_IMG = "modules/night-city-market/assets/Vendit.webp";

let calendarHookBound = false;
let calendarProcessing = false;
let tileHookBound = false;
let gmPurchaseQueue = Promise.resolve();
const purchaseWaiters = new Map();

/* -------------------- tiny utils -------------------- */
const esc = (s="") => String(s)
  .replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;")
  .replaceAll("'","&#039;");
const currentSceneId = () => canvas?.scene?.id ?? null;
const currentSceneName = () => canvas?.scene?.name ?? "";
const activeSceneDocument = () => game.scenes?.find?.(scene => scene.active) ?? null;
const activeSceneId = () => activeSceneDocument()?.id ?? null;
const activeSceneName = () => activeSceneDocument()?.name ?? "";
const isActiveGM = () => {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  return !activeGM || activeGM.id === game.user.id;
};
const shopIsOnActiveScene = (shop) => {
  const sceneId = activeSceneId();
  return !!sceneId && !!shop?.sceneId && shop.sceneId === sceneId;
};

/* -------------------- storage -------------------- */
function defaultDynamicSettings(){
  return {
    enabled:false,
    stockSource:"table",
    stockTable:"",
    stockPack:"",
    stockPool:[],
    minItems:3,
    maxItems:6,
    qtyMin:1,
    qtyMax:4,
    cycleDaysMin:2,
    cycleDaysMax:3,
    npcTraffic:true,
    nextCycle:0,
    lastCycle:0,
    saleEnabled:false,
    saleSource:"table",
    saleTable:"",
    salePool:[]
  };
}
function defaultGlobalDynamic(){
  return {
    autoTiles:false,
    autoTileKeywords:"vendit,vending machine,vending",
    autoTileTemplateId:"",
    salePingsMin:1,
    salePingsMax:3
  };
}
function defaultRuntime(){
  return {
    saleDayKey:"",
    saleSchedule:[],
    lastTimestamp:0
  };
}
function defaultDB(){
  return {
    _ver: FLAG_VER,
    era2045:true,
    defaults:{
      packKey:"",
      rollTable:"",
      interactionRangeSquares:2,
      dynamic:defaultGlobalDynamic()
    },
    runtime:defaultRuntime(),
    vendits:{}
  };
}
function normalizePool(pool){
  return Array.isArray(pool) ? pool.filter(Boolean).map(entry => ({
    uuid:String(entry.uuid || ""),
    name:String(entry.name || "Неизвестный предмет"),
    img:String(entry.img || "icons/svg/item-bag.svg")
  })) : [];
}
function normalizeDB(val){
  const db = (val && typeof val === "object") ? val : defaultDB();
  db.defaults ||= {};
  db.defaults.packKey ||= "";
  db.defaults.rollTable ||= "";
  if (!Number.isFinite(Number(db.defaults.interactionRangeSquares))) db.defaults.interactionRangeSquares = 2;
  db.defaults.interactionRangeSquares = Math.max(0, Math.min(12, Number(db.defaults.interactionRangeSquares)));
  db.defaults.dynamic = foundry.utils.mergeObject(defaultGlobalDynamic(), db.defaults.dynamic || {}, {inplace:false});
  db.runtime = foundry.utils.mergeObject(defaultRuntime(), db.runtime || {}, {inplace:false});
  db.vendits ||= {};

  for (const v of Object.values(db.vendits)){
    v.items = (v.items ?? []).map(it => {
      const price = Math.max(0, Number(it.price ?? 0));
      return {
        ...it,
        qty: typeof it.qty === "number" ? it.qty : 1,
        infinite:!!it.infinite,
        basePrice:Math.max(0, Number(it.basePrice ?? price)),
        regularPrice:Math.max(0, Number(it.regularPrice ?? price)),
        priceFactor:Number(it.priceFactor ?? 100),
        dynamicManaged:!!it.dynamicManaged,
        saleUntil:Number(it.saleUntil ?? 0),
        saleFactor:Number(it.saleFactor ?? 0)
      };
    });
    v.dynamic = foundry.utils.mergeObject(defaultDynamicSettings(), v.dynamic || {}, {inplace:false});
    v.dynamic.stockPack ||= "";
    v.dynamic.stockPool = normalizePool(v.dynamic.stockPool);
    v.dynamic.salePool = normalizePool(v.dynamic.salePool);
    if (!v.dynamic.stockTable) v.dynamic.stockTable = v.rollTable || "";
    v.tileUuid ||= "";
  }
  db._ver = FLAG_VER;
  return db;
}
function registerSettings(){
  game.settings.register(STORE_NS, STORE_KEY, {
    name: "База торговых автоматов",
    scope: "world",
    config: false,
    type: Object,
    default: defaultDB()
  });
}
async function loadAll(){
  const val = await game.settings.get(STORE_NS, STORE_KEY);
  return normalizeDB(val);
}
async function saveAll(db){ return game.settings.set(STORE_NS, STORE_KEY, normalizeDB(db)); }

/* -------------------- GM socket writes stock for players -------------------- */
let socketBound = false;
function bindVenditSocket(){
  if (socketBound) return;
  marketSocket.on(SOCKET, async msg => {
    if (!msg) return;

    if (msg.op === "purchase-response" && msg.userId === game.user.id){
      const waiter = purchaseWaiters.get(msg.nonce);
      if (waiter){ purchaseWaiters.delete(msg.nonce); waiter.resolve(msg.result); }
      return;
    }

    if (msg.op === "purchase" && isActiveGM()){
      // Serialize requests on one authoritative GM so multiple GM clients cannot double-dispense.
      gmPurchaseQueue = gmPurchaseQueue.then(async () => {
        const result = await gmProcessPurchase(msg);
        marketSocket.emit(SOCKET, {op:"purchase-response", nonce:msg.nonce, userId:msg.userId, result});
      }).catch(error => console.error("Vendit™ | GM purchase queue failed", error));
      return;
    }

    // Compatibility with 1.1.x clients; new 1.2.0 purchases use the authoritative purchase path above.
    if (msg.op === "stock" && isActiveGM()){
      const db = await loadAll();
      const v = db.vendits?.[msg.id];
      if (v && v.items?.[msg.index]){
        v.items[msg.index].qty = Math.max(0, Number(msg.qty|0));
        await saveAll(db);
      }
    }
  });
  socketBound = true;
}

/* -------------------- item/wealth helpers -------------------- */
async function adjustWealth(actor, delta, reason="Операция торгового автомата"){
  const w = foundry.utils.deepClone(actor.system?.wealth ?? {});
  const before = w.value ?? 0;
  w.value = before + (delta|0);
  w.transactions ??= [];
  const dir = delta>=0 ? "Увеличено" : "Уменьшено";
  w.transactions.push([`${dir} на ${Math.abs(delta|0)} получателю ${w.value|0}`, reason]);
  await actor.update({"system.wealth": w});
}
async function giveItem(actor, itemDoc){
  const data = itemDoc.toObject(); delete data._id;
  return actor.createEmbeddedDocuments("Item", [data]);
}
async function byUUID(uuid){ try{ return await fromUuid(uuid); }catch{ return null; } }

function purchaseNonce(){ return `${game.user?.id || "u"}-${Date.now()}-${randomID(8)}`; }
async function ncm_gmProcessPurchase(request){
  const fail = message => ({ok:false, message});
  try{
    const db = await loadAll();
    const shop = db.vendits?.[request.shopId];
    if (!shop) return fail("Торговый автомат больше не существует.");

    let index = Number(request.index);
    let item = shop.items?.[index];
    if (!item || (request.itemUuid && String(item.uuid || "") !== String(request.itemUuid))){
      index = (shop.items || []).findIndex(entry => String(entry.uuid || "") === String(request.itemUuid || ""));
      item = index >= 0 ? shop.items[index] : null;
    }
    if (!item) return fail("Ассортимент изменился. Откройте автомат заново.");
    if (!item.infinite && Number(item.qty || 0) <= 0) return fail(`${item.name} закончился.`);

    const buyer = await byUUID(request.buyerUuid);
    if (!buyer || buyer.documentName !== "Actor") return fail("Не удалось найти покупателя.");
    const requester = game.users?.get(request.userId);
    const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!requester) return fail("Не найден отправитель запроса.");
    if (!requester.isGM && typeof buyer.testUserPermission === "function" && !buyer.testUserPermission(requester, ownerLevel)){
      return fail("У вас нет прав владельца выбранного покупателя.");
    }

    requireCustomer(buyer,request.userId,shop);
    await requireProximity(shop,buyer,request.userId,db.defaults?.interactionRangeSquares??2);
    const doc = await byUUID(item.uuid);
    if (!doc) return fail("Предмет больше не существует.");
    const cost = Math.max(0, Number(item.price || 0));
    const funds = Number(buyer.system?.wealth?.value ?? 0);
    if (cost > funds) return fail(`${buyer.name} не хватает денег на ${item.name} (${cost} эб).`);

    let created = [];
    let paid = false;
    try{
      if (cost > 0){ await adjustWealth(buyer, -cost, `Автомат: ${item.name}`); paid = true; }
      created = await giveItem(buyer, doc) || [];
      if (!item.infinite){
        item.qty = Math.max(0, Number(item.qty || 0) - 1);
        await saveAll(db);
      }
    }catch(error){
      try{
        const ids = (created || []).map(entry => entry?.id).filter(Boolean);
        if (ids.length) await buyer.deleteEmbeddedDocuments("Item", ids);
      }catch(rollbackError){ console.error("Vendit™ | Item rollback failed", rollbackError); }
      if (paid){
        try{ await adjustWealth(buyer, +cost, `Возврат автомата: ${item.name}`); }
        catch(refundError){ console.error("Vendit™ | Wealth rollback failed", refundError); }
      }
      throw error;
    }

    try{
      await ChatMessage.create({content:`<div class="sl-chat-card"><h3>STREETLIFE / ЧЕК</h3><b>Автомат</b>: выдано <i>${esc(item.name)}</i> получателю <b>${esc(buyer.name)}</b> (${cost} эб).</div>`, speaker:ChatMessage.getSpeaker({alias:"Автомат"})});
    }catch(chatError){
      // A chat-render failure must never report a completed purchase as failed or charge twice on retry.
      console.warn("Vendit™ | Purchase completed but chat log could not be created", chatError);
    }
    return {ok:true, index, qty:Number(item.qty || 0), infinite:!!item.infinite, cost, itemName:item.name, price:Number(item.price || 0), saleUntil:Number(item.saleUntil || 0), saleFactor:Number(item.saleFactor || 0), priceFactor:Number(item.priceFactor || 100)};
  }catch(error){
    console.error("Vendit™ | Authoritative purchase failed", error);
    return fail("Ошибка покупки. Проверьте консоль мастера.");
  }
}
async function requestVenditPurchase({shopId,index,itemUuid,buyerUuid}){
  const request = {shopId,index,itemUuid,buyerUuid,userId:game.user.id,nonce:purchaseNonce()};
  if (game.user.isGM) return gmProcessPurchase(request);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!purchaseWaiters.has(request.nonce)) return;
      purchaseWaiters.delete(request.nonce);
      resolve({ok:false, message:"Автомат не получил ответ мастера. Дождитесь его подключения."});
    }, 6000);
    purchaseWaiters.set(request.nonce, {resolve:result => { clearTimeout(timer); resolve(result); }});
    marketSocket.emit(SOCKET, {op:"purchase", ...request});
  });
}

/* -------------------- reference parsing -------------------- */
function splitReferenceList(value){
  if (Array.isArray(value)) return value.flatMap(splitReferenceList);
  return String(value ?? "")
    .split(/[\r\n,;]+/g)
    .map(ref => ref.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}
function randomFrom(list){
  return Array.isArray(list) && list.length ? list[randomInt(0, list.length - 1)] : null;
}
function normalizePackKey(ref){
  let value = String(ref || "").trim();
  if (!value) return "";
  value = value.replace(/^Compendium\./i, "");
  const itemMarker = value.indexOf(".Item.");
  if (itemMarker >= 0) value = value.slice(0, itemMarker);
  return value;
}
function resolveItemPacks(ref){
  const requested = splitReferenceList(ref);
  const found = [];
  const seen = new Set();
  for (const raw of requested){
    const key = normalizePackKey(raw);
    const low = key.toLowerCase();
    const matches = game.packs.filter(pack => {
      if (pack.documentName !== "Item") return false;
      const values = [
        pack.collection,
        pack.metadata?.id,
        pack.metadata?.name,
        pack.metadata?.label,
        pack.title,
        `${pack.metadata?.packageName || ""}.${pack.metadata?.name || ""}`
      ].filter(Boolean).map(value => String(value).toLowerCase());
      return values.includes(low) || values.some(value => value.endsWith(`.${low}`));
    });
    const direct = game.packs.get(key);
    if (direct?.documentName === "Item") matches.unshift(direct);
    for (const pack of matches){
      if (seen.has(pack.collection)) continue;
      seen.add(pack.collection);
      found.push(pack);
    }
  }
  return found;
}

/* -------------------- RollTable resolver/draw -------------------- */
async function findSingleRollTable(ref){
  const candidate = String(ref || "").trim();
  if (!candidate) return null;

  try{
    const direct = await fromUuid(candidate);
    if (direct?.documentName === "RollTable") return direct;
  }catch{}

  if (candidate.includes("::")){
    const splitAt = candidate.indexOf("::");
    const packKey = candidate.slice(0, splitAt).replace(/^Compendium\./i, "").trim();
    const rest = candidate.slice(splitAt + 2).trim();
    const pack = game.packs.get(packKey);
    if (pack?.documentName === "RollTable"){
      const idx = await pack.getIndex({fields:["name"]});
      const low = rest.toLowerCase();
      const hit = idx.find(entry => entry._id === rest)
        || idx.find(entry => entry.name?.toLowerCase() === low)
        || idx.find(entry => entry.name?.toLowerCase().includes(low));
      if (hit) return pack.getDocument(hit._id);
    }
  }

  const worldById = game.tables.get(candidate);
  if (worldById) return worldById;
  const low = candidate.toLowerCase();
  const worldByName = game.tables.find(table => table.name?.toLowerCase() === low)
    || game.tables.find(table => table.name?.toLowerCase().includes(low));
  if (worldByName) return worldByName;

  for (const pack of game.packs.filter(pack => pack.documentName === "RollTable")){
    try{
      const index = await pack.getIndex({fields:["name"]});
      const hit = index.find(entry => entry._id === candidate)
        || index.find(entry => entry.name?.toLowerCase() === low)
        || index.find(entry => entry.name?.toLowerCase().includes(low));
      if (hit) return pack.getDocument(hit._id);
    }catch{}
  }
  return null;
}
async function findRollTables(ref){
  const tables = [];
  const seen = new Set();
  for (const candidate of splitReferenceList(ref)){
    const table = await findSingleRollTable(candidate);
    if (!table || seen.has(table.uuid)) continue;
    seen.add(table.uuid);
    tables.push(table);
  }
  return tables;
}
async function findRollTable(ref){
  const tables = await findRollTables(ref);
  return tables[0] || null;
}
async function resolveTableResultDocument(result){
  if (!result) return null;

  try{
    let doc = result.document;
    if (doc && typeof doc.then === "function") doc = await doc;
    if (doc) return doc;
  }catch{}

  try{
    if (typeof result.getDocument === "function"){
      const doc = await result.getDocument();
      if (doc) return doc;
    }
  }catch{}

  const collection = String(result.documentCollection || result.collection || "").trim();
  const documentId = String(result.documentId || result.documentID || "").trim();
  if (collection && documentId){
    const normalizedCollection = collection.replace(/^Compendium\./i, "");
    const pack = game.packs.get(normalizedCollection);
    if (pack){
      try{
        const doc = await pack.getDocument(documentId);
        if (doc) return doc;
      }catch{}
    }
    if (["Item", "предметов"].includes(collection)){
      const doc = game.items.get(documentId);
      if (doc) return doc;
    }
    try{
      const doc = await fromUuid(`${collection}.${documentId}`);
      if (doc) return doc;
    }catch{}
  }

  const text = String(result.text || "");
  const uuidMatch = text.match(/@UUID\[([^\]]+)\]/i);
  if (uuidMatch){
    try{
      const doc = await fromUuid(uuidMatch[1]);
      if (doc) return doc;
    }catch{}
  }
  const compendiumMatch = text.match(/@Compendium\[([^\]]+)\]/i);
  if (compendiumMatch){
    const parts = compendiumMatch[1].split(".");
    const documentId = parts.pop();
    const packKey = parts.join(".");
    const pack = game.packs.get(packKey);
    if (pack && documentId){
      try{
        const doc = await pack.getDocument(documentId);
        if (doc) return doc;
      }catch{}
    }
  }
  return null;
}
async function drawFromTable(ref){
  const tables = await findRollTables(ref);
  if (!tables.length) return null;
  const table = randomFrom(tables);
  const roll = await table.roll({recursive:true});
  for (const result of shuffle(roll?.results || [])){
    const doc = await resolveTableResultDocument(result);
    if (doc) return doc;
  }
  return null;
}

/* -------------------- theme -------------------- */
function makeCSS(bodyId, accent="#00FFF7"){
  const is2045 = String(accent).toUpperCase() === "#E64539";
  const secondary = is2045 ? "#F2C14E" : "#FCEE0A";
  const bg = is2045 ? "#100B0B" : "#071014";
  const panel = is2045 ? "#191011" : "#0D171A";
  const panel2 = is2045 ? "#211416" : "#101D21";
  const text = is2045 ? "#FFF2EE" : "#E9FEFF";
  const muted = is2045 ? "#D8A8A1" : "#91CED1";
  const danger = is2045 ? "#FF766C" : "#FF5F67";
  return `
.dialog-host-${bodyId}{
  --accent:${accent}; --secondary:${secondary}; --bg:${bg}; --panel:${panel}; --panel2:${panel2};
  --text:${text}; --muted:${muted}; --danger:${danger}; --edge:rgba(255,255,255,.09);
  max-width:96vw;
}
.dialog-host-${bodyId} .window-header{
  background:var(--bg) !important; color:var(--text) !important;
  border:2px solid var(--accent) !important; border-bottom:0 !important;
  border-radius:10px 10px 0 0 !important;
  box-shadow:0 0 0 1px #000 inset, 0 0 18px rgba(0,0,0,.45);
}
.dialog-host-${bodyId} .window-title,
.dialog-host-${bodyId} .window-header .close,
.dialog-host-${bodyId} .window-header .popout{ color:var(--text) !important; font-weight:850; }
.dialog-host-${bodyId} .window-content{
  color:var(--text) !important;
  background-color:var(--bg) !important;
  background-image:
    linear-gradient(30deg, rgba(255,255,255,.028) 12%, transparent 12.5%, transparent 87%, rgba(255,255,255,.028) 87.5%, rgba(255,255,255,.028)),
    linear-gradient(150deg, rgba(255,255,255,.028) 12%, transparent 12.5%, transparent 87%, rgba(255,255,255,.028) 87.5%, rgba(255,255,255,.028)),
    linear-gradient(30deg, rgba(255,255,255,.028) 12%, transparent 12.5%, transparent 87%, rgba(255,255,255,.028) 87.5%, rgba(255,255,255,.028)),
    linear-gradient(150deg, rgba(255,255,255,.028) 12%, transparent 12.5%, transparent 87%, rgba(255,255,255,.028) 87.5%, rgba(255,255,255,.028)),
    linear-gradient(60deg, rgba(255,255,255,.018) 25%, transparent 25.5%, transparent 75%, rgba(255,255,255,.018) 75%, rgba(255,255,255,.018)),
    linear-gradient(60deg, rgba(255,255,255,.018) 25%, transparent 25.5%, transparent 75%, rgba(255,255,255,.018) 75%, rgba(255,255,255,.018)) !important;
  background-size:28px 49px !important;
  background-position:0 0,0 0,14px 24.5px,14px 24.5px,0 0,14px 24.5px !important;
  border:2px solid var(--accent) !important; border-top:0 !important;
  border-radius:0 0 10px 10px !important; padding:10px !important;
}
.dialog-host-${bodyId} .dialog-buttons{
  flex:0 0 auto !important; gap:8px !important; padding:8px 10px !important; margin:0 !important;
  background:var(--bg) !important; border-top:1px solid var(--edge) !important;
}
.dialog-host-${bodyId} .dialog-button{
  flex:0 0 auto !important; width:auto !important; min-width:106px !important; height:36px !important;
  margin:0 !important; padding:0 16px !important; border:2px solid var(--accent) !important;
  border-radius:4px !important; background:transparent !important; color:var(--text) !important;
  font-weight:850 !important; box-shadow:none !important;
}
.dialog-host-${bodyId} .dialog-button:hover,
.dialog-host-${bodyId} .dialog-button:focus{ color:var(--secondary) !important; border-color:var(--secondary) !important; box-shadow:0 0 12px color-mix(in srgb, var(--secondary) 35%, transparent) !important; }

#${bodyId}{ --accent:${accent}; --secondary:${secondary}; --bg:${bg}; --panel:${panel}; --panel2:${panel2}; --text:${text}; --muted:${muted}; --danger:${danger}; color:var(--text); color-scheme:dark; }
#${bodyId} *{ box-sizing:border-box; }
#${bodyId} .wrap{ display:flex; flex-direction:column; gap:12px; min-width:0; color:var(--text); }
#${bodyId} .title{font-size:21px;font-weight:900;line-height:1.05;color:var(--accent);margin:0}
#${bodyId} .section-title{font-size:14px;font-weight:900;letter-spacing:.55px;text-transform:uppercase;color:var(--secondary);margin:0 0 8px}
#${bodyId} .muted{font-size:12px;color:var(--muted);opacity:1;line-height:1.35}
#${bodyId} .badge{display:inline-flex;align-items:center;border:1px solid var(--accent);border-radius:999px;padding:2px 7px;font-size:10px;font-weight:900;color:var(--accent);background:rgba(0,0,0,.32)}
#${bodyId} .badge.secondary{border-color:var(--secondary);color:var(--secondary)}
#${bodyId} code{color:var(--secondary);background:rgba(0,0,0,.42);border:1px solid color-mix(in srgb, var(--accent) 45%, transparent);border-radius:5px;padding:2px 5px;user-select:all}
#${bodyId} .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
#${bodyId} .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:9px;background:var(--panel);border:1px solid var(--accent);border-radius:8px}
#${bodyId} .grid2{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;min-width:0}
#${bodyId} .field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;align-items:end}
#${bodyId} .source-grid{display:grid;grid-template-columns:minmax(190px,.42fr) minmax(320px,1.58fr);gap:9px;align-items:end}
#${bodyId} .identity-grid{grid-template-columns:minmax(320px,1fr) 240px;max-width:760px;width:100%;gap:10px}
#${bodyId} .identity-grid .identity-name, #${bodyId} .identity-grid .identity-id{width:100%!important;max-width:none!important}
#${bodyId} .action-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:8px;align-items:stretch}
#${bodyId} .action-grid .btn{width:100%;min-width:0;min-height:44px;white-space:normal;line-height:1.15;overflow-wrap:anywhere;text-align:center}
#${bodyId} label{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--muted);font-size:12px;font-weight:750}
#${bodyId} label.inline{flex-direction:row;align-items:center;gap:7px;color:var(--text)}
#${bodyId} input, #${bodyId} select, #${bodyId} textarea{
  width:100%; min-width:0; min-height:36px; padding:7px 9px !important;
  background:rgba(0,0,0,.56) !important; color:var(--text) !important; caret-color:var(--accent);
  border:1px solid var(--accent) !important; border-radius:6px !important; box-shadow:none !important;
}
#${bodyId} select{appearance:auto !important;-webkit-appearance:auto !important;padding-right:28px !important}
#${bodyId} select option{background:var(--bg) !important;color:var(--text) !important}
#${bodyId} input:focus, #${bodyId} select:focus, #${bodyId} textarea:focus{border-color:var(--secondary) !important;outline:1px solid var(--secondary) !important}
#${bodyId} input[type="number"]{text-align:right;min-width:78px}
#${bodyId} input[type="checkbox"]{width:18px!important;height:18px!important;min-height:18px!important;flex:0 0 18px;accent-color:var(--accent)}
#${bodyId} textarea{min-height:68px;resize:vertical}
#${bodyId} .btn{
  min-height:36px;padding:7px 13px;background:transparent;color:var(--text);border:2px solid var(--accent);border-radius:4px;
  font-weight:850;cursor:pointer;white-space:nowrap;box-shadow:none;
}
#${bodyId} .btn:hover:not([disabled]), #${bodyId} .btn:focus:not([disabled]){color:var(--secondary);border-color:var(--secondary);box-shadow:0 0 0 1px var(--secondary) inset,0 0 12px color-mix(in srgb,var(--secondary) 28%,transparent)}
#${bodyId} .btn[disabled]{opacity:.45;cursor:not-allowed}
#${bodyId} .btn.secondary{border-color:var(--secondary);color:var(--secondary)}
#${bodyId} .btn.danger{border-color:var(--danger);color:var(--danger)}
#${bodyId} .icon-btn{flex:0 0 36px!important;width:36px!important;min-width:36px!important;max-width:36px!important;height:36px!important;min-height:36px!important;padding:0!important;display:inline-grid!important;place-items:center}
#${bodyId} .list{display:flex;flex-direction:column;gap:8px;overflow:visible;min-width:0}
#${bodyId} .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--accent);border-radius:8px;padding:10px;min-width:0;box-shadow:0 1px 0 rgba(255,255,255,.05) inset}
#${bodyId} .card.feature{border-left:5px solid var(--secondary)}
#${bodyId} .item-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0}
#${bodyId} .item-left{display:flex;align-items:center;gap:10px;min-width:0}
#${bodyId} .item-copy{min-width:0;flex:1 1 auto}
#${bodyId} .thumb{width:44px;height:44px;flex:0 0 44px;border-radius:6px;object-fit:cover;background:#111;border:1px solid color-mix(in srgb,var(--accent) 55%,#000)}
#${bodyId} .name{font-weight:850;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#${bodyId} .item-controls{display:flex;align-items:end;justify-content:flex-end;gap:7px;flex-wrap:wrap;min-width:0}
#${bodyId} .item-controls label{width:auto;min-width:72px}
#${bodyId} .drop{padding:12px;border:1px dashed var(--accent);border-radius:7px;text-align:center;color:var(--muted);background:rgba(0,0,0,.28)}
#${bodyId} .drop.drag{border-color:var(--secondary);color:var(--secondary);background:color-mix(in srgb,var(--secondary) 8%,transparent)}
#${bodyId} .status-strip{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:7px 9px;background:rgba(0,0,0,.35);border-left:4px solid var(--accent);color:var(--muted);font-size:12px}

/* Vendit-specific player machine shell */
#${bodyId} .machine-shell{display:flex;flex-direction:column;gap:10px}
#${bodyId} .machine-header{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:13px 14px 12px;background:linear-gradient(115deg,var(--panel2),var(--panel));border:2px solid var(--accent);border-radius:7px;box-shadow:0 0 20px rgba(0,0,0,.35) inset}
#${bodyId} .machine-header::before{content:"";position:absolute;left:0;top:0;width:42%;height:5px;background:var(--secondary);clip-path:polygon(0 0,100% 0,94% 100%,0 100%)}
#${bodyId} .machine-kicker{margin-top:3px;color:var(--secondary);font-size:11px;font-weight:950;letter-spacing:1.25px;text-transform:uppercase}
#${bodyId} .machine-title{color:var(--accent);font-size:24px;font-weight:950;line-height:1.05;overflow-wrap:anywhere}
#${bodyId} .machine-sub{margin-top:4px;color:var(--muted);font-size:11px;letter-spacing:.65px}
#${bodyId} .machine-buyer{min-width:190px;padding:8px 10px;background:#0008;border:1px solid var(--secondary);border-radius:5px;text-align:right}
#${bodyId} .machine-buyer span{display:block;color:var(--secondary);font-size:9px;font-weight:900;letter-spacing:1px}
#${bodyId} .machine-buyer b{display:block;margin-top:2px;color:var(--text);font-size:13px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${bodyId} .product-card{padding:0!important;overflow:hidden;border-left:4px solid var(--accent)!important}
#${bodyId} .product-card .item-row{padding:10px 11px}
#${bodyId} .product-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:4px;color:var(--muted);font-size:11px}
#${bodyId} .price{color:var(--secondary);font-size:16px;font-weight:950}
#${bodyId} .stock{color:var(--muted);font-weight:750}
#${bodyId} .buy{min-width:116px;height:40px;border-color:var(--secondary);color:var(--secondary);font-weight:950}
#${bodyId} .buy:hover:not([disabled]){border-color:var(--accent);color:var(--accent)}

@media(max-width:980px){
  #${bodyId} .action-grid{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
}
@media(max-width:820px){
  #${bodyId} .source-grid{grid-template-columns:1fr}
  #${bodyId} .identity-grid{max-width:none}
  #${bodyId} .grid2{grid-template-columns:1fr}
  #${bodyId} .item-row{grid-template-columns:1fr}
  #${bodyId} .item-controls{justify-content:flex-start}
  #${bodyId} .machine-header{grid-template-columns:1fr}
  #${bodyId} .machine-buyer{text-align:left;min-width:0}
}
`;
}

/* Footer buttons: dimensions only; colors come from the scoped Vendit skin. */
function forceFooterButtons(app, accent){
  const btns = app.querySelectorAll(".dialog-buttons .dialog-button");
  for (const b of btns){
    Object.assign(b.style, {fontFamily:"inherit", fontSize:"14px", height:"36px", minHeight:"36px", lineHeight:"1.15"});
  }
}

/* -------------------- autosize (single scrollbar; no dead space) -------------------- */
function autosizeDialog(appEl, bodyId){
  const app = appEl?.[0] ?? appEl; if (!app) return;
  const header  = app.querySelector(".window-header");
  const footer  = app.querySelector(".dialog-buttons");
  const content = app.querySelector(".window-content");
  const wrap    = content?.querySelector(`#${bodyId} .wrap`);
  if (!content || !wrap) return;

  const preferred = bodyId.includes("dynamic-") ? 980
    : bodyId.includes("network-") ? 900
    : bodyId.includes("edit-") ? 940
    : bodyId.includes("shop-") ? 800
    : 840;
  const pad = 24;
  const measuredW = Math.ceil(Math.max(wrap.scrollWidth + pad, preferred));
  const fixedW = Number(app.dataset.venditFixedW || 0) || Math.min(measuredW, 1180);
  app.dataset.venditFixedW = String(fixedW);
  app.style.width = `${Math.min(fixedW, Math.max(640, window.innerWidth - 28))}px`;
  app.style.maxWidth = "96vw";

  const hH = header?.offsetHeight ?? 36;
  const fH = footer?.offsetHeight ?? 52;
  const margin = 18;
  const natural = wrap.scrollHeight + hH + fH + margin;
  const cap = Math.max(380, Math.min(window.innerHeight - 24, 920));

  if (natural <= cap){
    app.style.height = "auto";
    content.style.height = "auto";
    content.style.maxHeight = `${Math.max(260, cap - hH - fH)}px`;
    content.style.overflowY = "auto";
    content.style.overflowX = "hidden";
  } else {
    const totalH  = Math.min(natural, cap);
    app.style.height = `${totalH}px`;
    const contentH = Math.max(220, totalH - hH - fH);
    content.style.height = `${contentH}px`;
    content.style.maxHeight = `${contentH}px`;
    content.style.overflowY = "auto";
    content.style.overflowX = "hidden";
  }
  fitDialog(app);
}
function observeResize(app, bodyId){
  const content= (app?.[0] ?? app)?.querySelector(".window-content");
  if (!content) return;
  let t=null;
  const mo = new MutationObserver(()=>{ clearTimeout(t); t=setTimeout(()=>autosizeDialog(app, bodyId), 30); });
  mo.observe(content, { childList:true, subtree:true, attributes:true });
  return mo;
}

/* -------------------- close lifecycle --------------------
 * Foundry keeps Dialog v1 applications in the DOM briefly while they close.
 * Removing Vendit's scoped stylesheet/host class synchronously during the
 * close callback lets the still-visible window fall back to core Foundry CSS,
 * which can momentarily enlarge images and flash the default grey background.
 * Hide the application inline first, then clean our transient CSS up only after
 * Foundry has had time to finish removing the window.
 */
function cleanupDialogAfterClose(appEl, {bodyId="", style=null, observer=null, delay=450}={}){
  const app = appEl?.element?.[0] ?? appEl?.[0] ?? appEl ?? null;
  try{ observer?.disconnect?.(); }catch{}

  if (app instanceof HTMLElement){
    // Inline !important survives removal of Vendit's stylesheet and prevents
    // a single-frame Foundry/default-theme restyle during the close animation.
    app.style.setProperty("visibility", "hidden", "important");
    app.style.setProperty("opacity", "0", "important");
    app.style.setProperty("pointer-events", "none", "important");
    app.setAttribute("aria-hidden", "true");
  }

  setTimeout(()=>{
    try{ style?.remove?.(); }catch{}
    try{ if (app instanceof HTMLElement && bodyId) app.classList.remove(`dialog-host-${bodyId}`); }catch{}
  }, Math.max(250, Number(delay)||450));
}

/* -------------------- quick add search helpers -------------------- */
async function findItemByNameFromPack(packKey, name){
  const packs = resolveItemPacks(packKey);
  if (!packs.length || !name) return null;
  const low = name.toLowerCase();
  const indexed = [];
  for (const pack of packs){
    try{ indexed.push([pack, await pack.getIndex({fields:["name","img","system.price","system.price.market"]})]); }
    catch{}
  }
  for (const [pack, index] of indexed){
    const hit = index.find(entry => entry.name?.toLowerCase() === low);
    if (hit) return pack.getDocument(hit._id);
  }
  for (const [pack, index] of indexed){
    const hit = index.find(entry => entry.name?.toLowerCase().includes(low));
    if (hit) return pack.getDocument(hit._id);
  }
  return null;
}
async function drawItemFromPack(packRef){
  const candidates = [];
  for (const pack of resolveItemPacks(packRef)){
    try{
      const index = await pack.getIndex({fields:["name","img"]});
      for (const entry of index) candidates.push([pack, entry]);
    }catch{}
  }
  const choice = randomFrom(candidates);
  if (!choice) return null;
  return choice[0].getDocument(choice[1]._id);
}
async function findItemAnywhere(name){
  const world = game.items.getName(name) || game.items.find(i=>i.name?.toLowerCase().includes(name.toLowerCase()));
  if (world) return world;
  for (const p of game.packs.filter(x=>x.documentName==="Item")){
    const idx = await p.getIndex({fields:["name"]});
    const hit = idx.find(e=>e.name?.toLowerCase()===name.toLowerCase()) || idx.find(e=>e.name?.toLowerCase().includes(name.toLowerCase()));
    if (hit) return await p.getDocument(hit._id);
  }
  return null;
}

/* -------------------- dynamic stock, pricing, tile binding, and CitiNet -------------------- */
const clampInt = (value, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || 0));
const randomInt = (min, max) => {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
};
const shuffle = (values) => {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
function getItemMarketPrice(doc){
  const raw = doc?.system?.price?.market ?? doc?.system?.price ?? 0;
  return Math.max(0, Number(raw) || 0);
}
function weightedPriceFactor(){
  const roll = Math.random();
  if (roll < 0.08){
    // Discounts are rare and strongly weighted toward 99%, with a tiny chance of a real bargain.
    return Math.max(75, 99 - Math.floor(Math.pow(Math.random(), 2) * 25));
  }
  if (roll < 0.63) return 100;
  return randomInt(101, 115);
}
function priceFromFactor(basePrice, factor){
  const base = Math.max(0, Number(basePrice) || 0);
  if (base === 0) return 0;
  return Math.max(1, Math.round(base * (Number(factor) || 100) / 100));
}
function normalizeDynamicBounds(dynamic){
  dynamic.minItems = clampInt(dynamic.minItems, 1, 50);
  dynamic.maxItems = clampInt(dynamic.maxItems, dynamic.minItems, 50);
  dynamic.qtyMin = clampInt(dynamic.qtyMin, 0, 999);
  dynamic.qtyMax = clampInt(dynamic.qtyMax, dynamic.qtyMin, 999);
  dynamic.cycleDaysMin = clampInt(dynamic.cycleDaysMin, 1, 365);
  dynamic.cycleDaysMax = clampInt(dynamic.cycleDaysMax, dynamic.cycleDaysMin, 365);
  return dynamic;
}
function getSimpleCalendar(){
  return globalThis.SimpleCalendar?.api ? globalThis.SimpleCalendar : null;
}
function calendarTimestamp(){
  const sc = getSimpleCalendar();
  try{ return Number(sc?.api?.timestamp?.() ?? 0); }catch{ return 0; }
}
function calendarDate(){
  const sc = getSimpleCalendar();
  try{ return sc?.api?.currentDateTime?.() ?? null; }catch{ return null; }
}
function calendarDayKey(date = calendarDate()){
  if (!date) return "";
  return `${date.year}:${date.month}:${date.day}`;
}
function calendarDayStart(date = calendarDate()){
  const sc = getSimpleCalendar();
  if (!sc || !date) return 0;
  try{
    return Number(sc.api.dateToTimestamp({
      year:date.year, month:date.month, day:date.day,
      hour:0, minute:0, seconds:0
    }) || 0);
  }catch{ return 0; }
}
function calendarTimeConfig(){
  const sc = getSimpleCalendar();
  try{
    return sc?.api?.getTimeConfiguration?.() || {
      hoursInDay:24, minutesInHour:60, secondsInMinute:60
    };
  }catch{
    return {hoursInDay:24, minutesInHour:60, secondsInMinute:60};
  }
}
function calendarDaySeconds(){
  const cfg = calendarTimeConfig();
  return Math.max(1,
    Number(cfg.hoursInDay || 24) *
    Number(cfg.minutesInHour || 60) *
    Number(cfg.secondsInMinute || 60)
  );
}
function addCalendarDays(timestamp, days){
  const sc = getSimpleCalendar();
  if (!sc || !timestamp) return 0;
  try{ return Number(sc.api.timestampPlusInterval(timestamp, {day:Number(days) || 0}) || 0); }
  catch{ return timestamp + calendarDaySeconds() * (Number(days) || 0); }
}
function isCalendarPrimaryGM(){
  if (!game.user?.isGM) return false;
  const sc = getSimpleCalendar();
  try{
    if (typeof sc?.api?.isPrimaryGM === "function") return !!sc.api.isPrimaryGM();
  }catch{}
  return game.users?.activeGM?.id ? game.users.activeGM.id === game.user.id : true;
}
function endOfCalendarDay(date = calendarDate()){
  const start = calendarDayStart(date);
  return start ? start + calendarDaySeconds() - 1 : 0;
}
async function poolEntryToDocument(entry){
  if (!entry) return null;
  if (entry.uuid){
    const doc = await byUUID(entry.uuid);
    if (doc) return doc;
  }
  return entry.name ? findItemAnywhere(entry.name) : null;
}
async function rollTableForVendit(table){
  let working = table;
  try{
    working = await table.clone({}, {save:false});
    for (const result of working.results || []) result.updateSource({drawn:false});
  }catch{}
  const rolled = await working.roll({recursive:true});
  return {table:working, rolled};
}
async function previewRollTable(ref){
  const tables = await findRollTables(ref);
  if (!tables.length) return {count:0, table:null, rolled:null};
  const source = randomFrom(tables);
  const {table, rolled} = await rollTableForVendit(source);
  if (rolled?.results?.length && typeof table.toMessage === "function") await table.toMessage(rolled.results, {roll:rolled.roll});
  return {count:tables.length, table, rolled};
}
async function drawItemFromTable(ref, depth=0){
  if (!ref || depth > 4) return null;
  const tables = await findRollTables(ref);
  if (!tables.length) return null;
  for (const table of shuffle(tables)){
    try{
      // Roll a reset clone so Vendit neither exhausts nor alters the GM's source table.
      const {rolled} = await rollTableForVendit(table);
      for (const result of shuffle(rolled?.results || [])){
        const doc = await resolveTableResultDocument(result);
        if (doc?.documentName === "Item") return doc;
        if (doc?.documentName === "RollTable"){
          const nested = await drawItemFromTable(doc.uuid, depth + 1);
          if (nested) return nested;
        }
      }
    }catch(error){
      console.warn(`Vendit™ | RollTable failed: ${table.name}`, error);
    }
  }
  return null;
}
async function chooseSourceDocument(shop, sourceKind="stock", defaults={}){
  const dynamic = shop.dynamic || defaultDynamicSettings();
  const mode = sourceKind === "sale" ? dynamic.saleSource : dynamic.stockSource;
  const tableRef = sourceKind === "sale"
    ? (dynamic.saleTable || shop.rollTable || defaults.rollTable || "")
    : (dynamic.stockTable || shop.rollTable || defaults.rollTable || "");
  const packRef = dynamic.stockPack || shop.packKey || defaults.packKey || "";
  const pool = sourceKind === "sale" ? dynamic.salePool : dynamic.stockPool;
  if (mode === "pool"){
    for (const entry of shuffle(pool || [])){
      const doc = await poolEntryToDocument(entry);
      if (doc) return doc;
    }
    return null;
  }
  if (sourceKind === "stock" && mode === "pack") return drawItemFromPack(packRef);
  return drawItemFromTable(tableRef);
}
function buildDynamicItem(doc, dynamic, {saleManaged=false}={}){
  const basePrice = getItemMarketPrice(doc);
  const factor = weightedPriceFactor();
  const qty = randomInt(dynamic.qtyMin, dynamic.qtyMax);
  const price = priceFromFactor(basePrice, factor);
  return {
    uuid:doc.uuid,
    name:doc.name,
    img:doc.img,
    basePrice,
    regularPrice:price,
    price,
    priceFactor:factor,
    qty,
    infinite:false,
    dynamicManaged:true,
    saleManaged:!!saleManaged,
    saleUntil:0,
    saleFactor:0
  };
}
function clearExpiredSale(item, now){
  if (!item?.saleUntil || Number(item.saleUntil) > Number(now || 0)) return false;
  item.price = Math.max(0, Number(item.regularPrice ?? item.basePrice ?? item.price ?? 0));
  item.saleUntil = 0;
  item.saleFactor = 0;
  return true;
}
function applyRegularDynamicPrice(item){
  const factor = weightedPriceFactor();
  const basePrice = Math.max(0, Number(item.basePrice ?? item.price ?? 0));
  const price = priceFromFactor(basePrice, factor);
  item.priceFactor = factor;
  item.regularPrice = price;
  if (!item.saleUntil) item.price = price;
}
function findShopItem(shop, doc){
  const uuid = String(doc?.uuid || "");
  const name = String(doc?.name || "").toLowerCase();
  return (shop.items || []).find(item =>
    (uuid && String(item.uuid || "") === uuid) ||
    (name && String(item.name || "").toLowerCase() === name)
  );
}
async function fillDynamicStock(shop, {replace=false, defaults={}}={}){
  const dynamic = normalizeDynamicBounds(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.items ||= [];
  if (replace) shop.items = shop.items.filter(item => !item.dynamicManaged);

  const target = randomInt(dynamic.minItems, dynamic.maxItems);
  let managed = shop.items.filter(item => item.dynamicManaged);
  if (managed.length > target){
    const removable = shuffle(managed).sort((a,b) => Number(a.qty || 0) - Number(b.qty || 0));
    const removeSet = new Set(removable.slice(0, managed.length - target));
    shop.items = shop.items.filter(item => !removeSet.has(item));
    managed = shop.items.filter(item => item.dynamicManaged);
  }

  const seen = new Set(shop.items.map(item => String(item.uuid || item.name || "").toLowerCase()));
  let attempts = 0;
  while (managed.length < target && attempts < 60){
    attempts++;
    const doc = await chooseSourceDocument(shop, "stock", defaults);
    if (!doc) break;
    const key = String(doc.uuid || doc.name || "").toLowerCase();
    if (seen.has(key)) continue;
    const item = buildDynamicItem(doc, dynamic);
    shop.items.push(item);
    managed.push(item);
    seen.add(key);
  }
  return managed.length;
}
function scheduleNextCycle(shop, now = calendarTimestamp()){
  const dynamic = normalizeDynamicBounds(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  if (!now){ dynamic.nextCycle = 0; return 0; }
  const days = randomInt(dynamic.cycleDaysMin, dynamic.cycleDaysMax);
  dynamic.lastCycle = now;
  dynamic.nextCycle = addCalendarDays(now, days);
  return dynamic.nextCycle;
}
async function runNpcCycle(shop, now = calendarTimestamp(), {replace=false, defaults={}}={}){
  const dynamic = normalizeDynamicBounds(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.items ||= [];
  for (const item of shop.items){
    clearExpiredSale(item, now);
    if (!item.dynamicManaged || item.infinite) continue;

    if (dynamic.npcTraffic){
      const demand = Math.random();
      if (demand < 0.64 && Number(item.qty || 0) > 0){
        item.qty = Math.max(0, Number(item.qty || 0) - randomInt(1, Math.min(2, Math.max(1, Number(item.qty || 0)))));
      } else if (demand > 0.86){
        item.qty = Math.min(dynamic.qtyMax, Number(item.qty || 0) + randomInt(1, 2));
      }
    }
    if (!item.saleUntil) applyRegularDynamicPrice(item);
  }

  // Sold-out products usually disappear from a busy machine rather than living forever at 0 stock.
  shop.items = shop.items.filter(item => {
    if (!item.dynamicManaged || Number(item.qty || 0) > 0) return true;
    return Math.random() >= 0.70;
  });

  await fillDynamicStock(shop, {replace, defaults});
  scheduleNextCycle(shop, now);
  return shop;
}
function generateDailySaleSchedule(db, now, date){
  const globalDynamic = db.defaults.dynamic || defaultGlobalDynamic();
  const min = clampInt(globalDynamic.salePingsMin, 0, 12);
  const max = clampInt(globalDynamic.salePingsMax, min, 12);
  const count = randomInt(min, max);
  const start = calendarDayStart(date);
  const cfg = calendarTimeConfig();
  const hourSeconds = Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60);
  const latestHour = Math.max(1, Number(cfg.hoursInDay || 24) - 2);
  const earliestHour = Math.min(9, latestHour);
  const slots = [];
  let attempts = 0;
  while (slots.length < count && attempts < 100){
    attempts++;
    const hour = randomInt(earliestHour, latestHour);
    const minute = [0, 15, 30, 45][randomInt(0, 3)];
    const ts = start + hour * hourSeconds + minute * Number(cfg.secondsInMinute || 60);
    if (slots.some(existing => Math.abs(existing - ts) < hourSeconds * 2)) continue;
    slots.push(ts);
  }
  db.runtime.saleDayKey = calendarDayKey(date);
  db.runtime.saleSchedule = slots.sort((a,b)=>a-b).map(ts => ({ts, done:false}));
  db.runtime.lastTimestamp = now;
}
function shopsEligibleForSceneSale(db, sceneId = activeSceneId()){
  // CitiNet advertising is tied to Foundry's globally activated Scene, not the
  // Scene a GM happens to be viewing on their own canvas. This prevents a GM
  // browsing or preparing another Scene from generating public chat pings for it.
  if (!sceneId) return [];
  return Object.values(db.vendits || {}).filter(shop => {
    const dynamic = shop.dynamic || {};
    if (!dynamic.saleEnabled) return false;
    if (!shop.sceneId || shop.sceneId !== sceneId) return false;
    if (!shop.tileUuid) return false; // CitiNet PING LOCATION requires a physical map target.

    if (dynamic.saleSource === "pool" && !(dynamic.salePool || []).length) return false;
    if (dynamic.saleSource !== "pool" && !(dynamic.saleTable || shop.rollTable || db.defaults?.rollTable)) return false;
    return true;
  });
}
async function activateSaleOnShop(shop, now = calendarTimestamp(), defaults={}){
  const dynamic = normalizeDynamicBounds(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const doc = await chooseSourceDocument(shop, "sale", defaults);
  if (!doc) return null;
  shop.items ||= [];
  let item = findShopItem(shop, doc);
  if (!item){
    item = buildDynamicItem(doc, dynamic, {saleManaged:true});
    shop.items.push(item);
  }
  const basePrice = Math.max(0, Number(item.basePrice ?? getItemMarketPrice(doc)));
  item.basePrice = basePrice;
  item.regularPrice = Math.max(0, Number(item.regularPrice ?? item.price ?? basePrice));
  const factor = weightedPriceFactor();
  item.saleFactor = factor;
  item.saleUntil = endOfCalendarDay();
  item.price = priceFromFactor(basePrice, factor);
  if (!item.infinite && Number(item.qty || 0) <= 0) item.qty = randomInt(dynamic.qtyMin, dynamic.qtyMax);
  return item;
}
function saleDirectionText(factor){
  if (factor < 100) return `${100-factor}% ниже рыночной цены`;
  if (factor > 100) return `${factor-100}% наценки за спрос в Найт-Сити`;
  return "обычная рыночная цена";
}
async function postCitiNetSale(shop, item, {requireActiveScene=true}={}){
  const activeScene = activeSceneDocument();
  if (requireActiveScene && (!activeScene || shop?.sceneId !== activeScene.id)){
    console.debug(`Vendit™ | Suppressed CitiNet ping for non-active scene: ${shop?.sceneName || shop?.sceneId || "Неизвестная сцена"}`);
    return false;
  }
  const sceneName = activeScene?.name || shop.sceneName || "Найт-Сити";
  const content = `
  <div class="vendit-citinet-card" style="border:1px solid #00fff7;background:rgba(0,0,0,.90);padding:10px;color:#00fff7;border-radius:8px;overflow:hidden">
    <div style="font-size:16px;line-height:1.15;font-weight:900;color:#ffdd00">СИТИНЕТ // АКЦИЯ ТОРГОВОГО АВТОМАТА</div>
    <div style="font-size:12px;line-height:1.35;opacity:.8;margin:4px 0 9px;overflow-wrap:anywhere">Местная реклама — ${esc(sceneName)}</div>
    <div style="display:grid;grid-template-columns:44px minmax(0,1fr);gap:9px;align-items:center">
      <img src="${esc(item.img || 'icons/svg/item-bag.svg')}" style="width:42px;height:42px;object-fit:cover;border:1px solid #00fff7;border-radius:4px">
      <div style="min-width:0;line-height:1.35;overflow-wrap:anywhere;word-break:normal">
        <div><b>${esc(shop.name)}</b> обновлена цена <b>${esc(item.name)}</b>.</div>
        <div style="font-size:18px;font-weight:900;color:#ffdd00;margin-top:2px">${Number(item.price || 0)} эб</div>
        <div style="font-size:11px;opacity:.8;margin-top:2px">${esc(saleDirectionText(Number(item.saleFactor || 100)))}. До конца игрового дня или окончания запаса.</div>
      </div>
    </div>
    <button type="button" data-vendit-ping="${esc(shop.id)}" style="display:block;width:100%;max-width:none;margin:9px 0 0;background:#000;color:#00fff7;border:1px solid #00fff7;border-radius:6px;padding:7px 9px;font-weight:800;cursor:pointer;line-height:1.2"><i class="fas fa-location-dot"></i> ПОКАЗАТЬ НА КАРТЕ</button>
  </div>`;
  await ChatMessage.create({
    content,
    speaker:ChatMessage.getSpeaker({alias:"Ситинет // Торговые автоматы"})
  });
  return true;
}
async function fireRandomSceneSale(db, now = calendarTimestamp()){
  const sceneId = activeSceneId();
  if (!sceneId) return false;
  const eligible = shopsEligibleForSceneSale(db, sceneId);
  if (!eligible.length) return false;

  // Re-check after source resolution begins so a Scene activation change cannot
  // leak a notification from the Scene that just became inactive.
  const shop = eligible[randomInt(0, eligible.length - 1)];
  if (activeSceneId() !== sceneId || shop.sceneId !== sceneId) return false;
  const item = await activateSaleOnShop(shop, now, db.defaults);
  if (!item) return false;
  if (activeSceneId() !== sceneId) return false;
  return postCitiNetSale(shop, item, {requireActiveScene:true});
}
async function ncm_processCalendarTick({allowSalePing=true, forceStock=false}={}){
  if (calendarProcessing || !isCalendarPrimaryGM()) return false;
  const sc = getSimpleCalendar();
  if (!sc) return false;
  calendarProcessing = true;
  try{
    const now = calendarTimestamp();
    const date = calendarDate();
    if (!now || !date) return false;
    const db = await loadAll();
    let changed = false;

    for (const shop of Object.values(db.vendits || {})){
      const dynamic = shop.dynamic || defaultDynamicSettings();
      for (const item of shop.items || []) changed = clearExpiredSale(item, now) || changed;
      if (!dynamic.enabled) continue;
      normalizeDynamicBounds(dynamic);
      if (!dynamic.nextCycle){
        await fillDynamicStock(shop, {replace:false, defaults:db.defaults});
        scheduleNextCycle(shop, now);
        changed = true;
        continue;
      }
      let loops = 0;
      const forceThisShop = !!forceStock;
      while ((forceThisShop || now >= Number(dynamic.nextCycle || 0)) && loops < 20){
        loops++;
        await runNpcCycle(shop, forceThisShop ? now : Number(dynamic.nextCycle || now), {replace:false, defaults:db.defaults});
        changed = true;
        if (forceThisShop) break;
      }
    }

    if (db.runtime.saleDayKey !== calendarDayKey(date)){
      generateDailySaleSchedule(db, now, date);
      changed = true;
    }

    if (allowSalePing){
      const due = (db.runtime.saleSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) <= now);
      if (due.length){
        // Collapse multiple skipped alarms into one CitiNet message so a long time jump never chat-spams.
        for (const entry of due) entry.done = true;
        await fireRandomSceneSale(db, now);
        changed = true;
      }
    }
    db.runtime.lastTimestamp = now;
    if (changed) await saveAll(db);
    return changed;
  }catch(error){
    console.error("Vendit™ | Calendar processing failed", error);
    return false;
  }finally{
    calendarProcessing = false;
  }
}
function getTileDocument(tileLike){
  if (!tileLike) return null;
  if (tileLike.documentName === "Tile") return tileLike;
  if (tileLike.document?.documentName === "Tile") return tileLike.document;
  if (tileLike.object?.document?.documentName === "Tile") return tileLike.object.document;
  return null;
}
function venditIdFromTile(tileLike){
  const tile = getTileDocument(tileLike);
  if (!tile) return null;
  return tile.getFlag?.(MODULE_ID, "venditId") || tile.flags?.[MODULE_ID]?.venditId || null;
}
function getTokenObject(tokenLike){
  if (!tokenLike) return null;
  if (Array.isArray(tokenLike)){
    for (const entry of tokenLike){
      const token = getTokenObject(entry);
      if (token) return token;
    }
    return null;
  }
  if (tokenLike.document?.documentName === "Token") return tokenLike;
  if (tokenLike.documentName === "Token") return tokenLike.object || canvas?.tokens?.get?.(tokenLike.id) || null;
  if (tokenLike.object?.document?.documentName === "Token") return tokenLike.object;
  if (tokenLike.actor && tokenLike.center && tokenLike.document) return tokenLike;
  return null;
}
function findContextTile(input, depth=0){
  if (depth > 8 || input == null) return null;
  const direct = getTileDocument(input);
  if (direct) return direct;
  if (Array.isArray(input)){
    for (const entry of input){
      const tile = findContextTile(entry, depth + 1);
      if (tile) return tile;
    }
    return null;
  }
  if (typeof input === "object"){
    for (const key of ["tile", "triggeringTile", "origin", "context", "args"]){
      if (input[key] == null) continue;
      const tile = findContextTile(input[key], depth + 1);
      if (tile) return tile;
    }
  }
  return null;
}
function findContextToken(input, depth=0){
  if (depth > 8 || input == null) return null;
  const direct = getTokenObject(input);
  if (direct) return direct;
  if (Array.isArray(input)){
    for (const entry of input){
      const token = findContextToken(entry, depth + 1);
      if (token) return token;
    }
    return null;
  }
  if (typeof input === "object"){
    for (const key of ["token", "tokens", "triggeringToken", "origin", "context", "args"]){
      if (input[key] == null) continue;
      const token = findContextToken(input[key], depth + 1);
      if (token) return token;
    }
  }
  return null;
}
function tileCenterPoint(tileLike){
  const tile = getTileDocument(tileLike);
  if (!tile) return null;
  const object = tile.object;
  if (object?.center && Number.isFinite(object.center.x) && Number.isFinite(object.center.y)) return {x:object.center.x, y:object.center.y};
  return {x:Number(tile.x || 0) + Number(tile.width || 0) / 2, y:Number(tile.y || 0) + Number(tile.height || 0) / 2};
}
function tokenCenterPoint(tokenLike){
  const token = getTokenObject(tokenLike);
  if (!token) return null;
  if (token.center && Number.isFinite(token.center.x) && Number.isFinite(token.center.y)) return {x:token.center.x, y:token.center.y};
  const doc = token.document;
  const size = Number(canvas?.grid?.size || canvas?.scene?.grid?.size || 100);
  return {
    x:Number(doc?.x || 0) + (Number(doc?.width || 1) * size) / 2,
    y:Number(doc?.y || 0) + (Number(doc?.height || 1) * size) / 2
  };
}
function gridSpacesBetweenPoints(from, to){
  if (!from || !to) return Infinity;
  try{
    if (!canvas?.grid?.isGridless){
      const result = canvas?.grid?.measurePath?.([from, to]);
      const waypoint = result?.waypoints?.[result.waypoints.length - 1];
      const spaces = Number(waypoint?.spaces);
      if (Number.isFinite(spaces)) return spaces;
    }
  }catch(error){ console.debug("Vendit™ | Grid measurement fallback", error); }
  const size = Number(canvas?.grid?.size || canvas?.scene?.grid?.size || 100);
  return Math.hypot(Number(to.x)-Number(from.x), Number(to.y)-Number(from.y)) / Math.max(1, size);
}
function tokenForBuyer(buyer, preferredToken=null){
  const preferred = getTokenObject(preferredToken);
  if (preferred?.actor && (!buyer || preferred.actor.id === buyer.id)) return preferred;
  const controlled = (canvas?.tokens?.controlled || []).find(token => token.actor?.id === buyer?.id);
  if (controlled) return controlled;
  return (canvas?.tokens?.placeables || []).find(token => token.actor?.id === buyer?.id) || null;
}
async function resolveInteractionTile(shop, preferredTile=null){
  const direct = getTileDocument(preferredTile);
  if (direct) return direct;
  if (!shop?.tileUuid) return null;
  try{
    const doc = await fromUuid(shop.tileUuid);
    return getTileDocument(doc);
  }catch(error){
    console.warn("Vendit™ | Could not resolve bound Tile for interaction", error);
    return null;
  }
}
async function validateVenditProximity(shop, buyer, {tile=null, token=null, rangeSquares=2}={}){
  if (game.user?.isGM) return {ok:true};
  const targetTile = await resolveInteractionTile(shop, tile);
  if (!targetTile) return {ok:true}; // Legacy unbound ID-only Vendits retain their old behavior.
  if (targetTile.parent?.id && currentSceneId() !== targetTile.parent.id){
    return {ok:false, message:"Автомат находится на другой сцене."};
  }
  const buyerToken = tokenForBuyer(buyer, token);
  if (!buyerToken) return {ok:false, message:"Сначала разместите или выделите токен своего персонажа рядом с автоматом."};
  const spaces = gridSpacesBetweenPoints(tokenCenterPoint(buyerToken), tileCenterPoint(targetTile));
  const allowed = Math.max(0, Number(rangeSquares || 0));
  if (spaces > allowed){
    return {ok:false, spaces, message:`Вы слишком далеко от автомата. Подойдите на расстояние ${allowed} клеток от автомата.`};
  }
  return {ok:true, spaces, tile:targetTile, token:buyerToken};
}
async function pingVenditLocation(venditId){
  const db = await loadAll();
  const shop = db.vendits?.[venditId];
  if (!shop) return ui.notifications.warn("Автомат больше недоступен.");
  if (!shopIsOnActiveScene(shop)) return ui.notifications.warn("Автомат находится вне активной сцены.");
  if (currentSceneId() !== shop.sceneId) return ui.notifications.warn("Откройте активную сцену, чтобы найти автомат.");
  const tile = await resolveInteractionTile(shop);
  if (!tile) return ui.notifications.warn("Автомат не привязан к месту на карте.");
  const center = tileCenterPoint(tile);
  if (!center) return ui.notifications.warn("Не удалось определить расположение автомата.");
  try{ await canvas?.animatePan?.({x:center.x, y:center.y, duration:450}); }catch{}
  try{ await canvas?.ping?.(center); }catch(error){ console.warn("Vendit™ | Map ping failed", error); }
  return true;
}
function selectedTileDocuments(){
  return (canvas?.tiles?.controlled || []).map(tile => getTileDocument(tile)).filter(Boolean);
}
async function clearBoundTileFlag(shop){
  if (!shop?.tileUuid) return false;
  try{
    const tile = await fromUuid(shop.tileUuid);
    if (tile?.documentName === "Tile" && venditIdFromTile(tile) === shop.id){
      await tile.unsetFlag(MODULE_ID, "venditId");
    }
  }catch(error){ console.warn("Vendit™ | Could not clear previous Tile binding", error); }
  shop.tileUuid = "";
  return true;
}
async function bindVenditToTile(shop, tileDoc, db=null){
  const tile = getTileDocument(tileDoc);
  if (!tile) throw new Error("Тайл не выбран.");

  // A Vendit owns one direct Tile binding. Rebinding cleans the old flag so no ghost Tile remains.
  if (shop.tileUuid && shop.tileUuid !== tile.uuid) await clearBoundTileFlag(shop);

  // If this Tile previously belonged to another Vendit, detach that stale reverse link too.
  const previousId = venditIdFromTile(tile);
  if (previousId && previousId !== shop.id && db?.vendits?.[previousId]){
    const previous = db.vendits[previousId];
    if (previous.tileUuid === tile.uuid) previous.tileUuid = "";
  }

  shop.sceneOnly = true;
  shop.sceneId = tile.parent?.id || currentSceneId();
  shop.sceneName = tile.parent?.name || currentSceneName();
  shop.tileUuid = tile.uuid;
  await tile.setFlag(MODULE_ID, "venditId", shop.id);
  return shop;
}
async function deleteVendit(db, id){
  const shop = db.vendits?.[id];
  if (!shop) return false;
  await clearBoundTileFlag(shop);
  if (db.defaults?.dynamic?.autoTileTemplateId === id) db.defaults.dynamic.autoTileTemplateId = "";
  delete db.vendits[id];
  await saveAll(db);
  return true;
}
function tileMatchesAutoKeywords(tile, keywords){
  const doc = getTileDocument(tile);
  if (!doc) return false;
  const haystack = [doc.name, doc.texture?.src, doc.img].filter(Boolean).join(" ").toLowerCase();
  return String(keywords || "").split(",").map(k => k.trim().toLowerCase()).filter(Boolean).some(k => haystack.includes(k));
}
async function createDynamicVenditForTile(tileDoc){
  if (!game.user?.isGM) return null;
  const tile = getTileDocument(tileDoc);
  if (!tile || venditIdFromTile(tile)) return null;
  const db = await loadAll();
  const globalDynamic = db.defaults.dynamic || defaultGlobalDynamic();
  if (!globalDynamic.autoTiles || !tileMatchesAutoKeywords(tile, globalDynamic.autoTileKeywords)) return null;

  const template = db.vendits?.[globalDynamic.autoTileTemplateId] || null;
  const id = `V-${randomID()}`;
  const scene = tile.parent;
  const shop = template ? foundry.utils.deepClone(template) : {
    id,
    name:"Автомат",
    sceneOnly:true,
    sceneId:scene?.id || currentSceneId(),
    sceneName:scene?.name || currentSceneName(),
    packKey:db.defaults.packKey || "",
    rollTable:db.defaults.rollTable || "",
    items:[],
    dynamic:defaultDynamicSettings()
  };
  shop.id = id;
  shop.name = tile.name?.trim() || `${template?.name || "Автомат"} — ${scene?.name || "Найт-Сити"}`;
  shop.sceneOnly = true;
  shop.sceneId = scene?.id || currentSceneId();
  shop.sceneName = scene?.name || currentSceneName();
  shop.tileUuid = tile.uuid;
  // Auto-Tile templates copy configuration/pools, never the template machine's live inventory.
  shop.items = [];
  shop.dynamic = foundry.utils.mergeObject(defaultDynamicSettings(), shop.dynamic || {}, {inplace:false});
  shop.dynamic.enabled = true;
  // A cloned template starts a new machine lifecycle instead of inheriting its timer history.
  shop.dynamic.nextCycle = 0;
  shop.dynamic.lastCycle = 0;
  if (!shop.dynamic.stockTable) shop.dynamic.stockTable = shop.rollTable || db.defaults.rollTable || "";
  await fillDynamicStock(shop, {replace:true, defaults:db.defaults});
  scheduleNextCycle(shop, calendarTimestamp());
  db.vendits[id] = shop;
  try{
    await saveAll(db);
    await tile.setFlag(MODULE_ID, "venditId", id);
  }catch(error){
    // Avoid leaving a half-created shop or Tile flag if either persistence step fails.
    delete db.vendits[id];
    try{ await saveAll(db); }catch{}
    try{ if (venditIdFromTile(tile) === id) await tile.unsetFlag(MODULE_ID, "venditId"); }catch{}
    throw error;
  }
  ui.notifications.info(`Создан автомат с обновляемым складом: ${shop.name}`);
  return shop;
}
function bindAutoTileHook(){
  if (tileHookBound) return;
  componentHooks.on("createTile", async (tile, options, userId) => {
    if (userId !== game.user?.id || !game.user?.isGM) return;
    try{ await createDynamicVenditForTile(tile); }
    catch(error){ console.error("Vendit™ | Auto Tile creation failed", error); }
  });
  tileHookBound = true;
}
function bindCalendarHooks(){
  if (calendarHookBound) return;
  const bind = () => {
    const sc = getSimpleCalendar();
    if (!sc) return false;
    const hookName = sc.Hooks?.DateTimeChange || "simple-calendar-date-time-change";
    componentHooks.on(hookName, () => processCalendarTick({allowSalePing:true}));
    calendarHookBound = true;
    processCalendarTick({allowSalePing:false});
    return true;
  };
  if (bind()) return;
  componentHooks.on("simple-calendar-ready", bind);
}
function bindCitiNetButtons(){
  if (document.body?.dataset?.venditCitiNetBound === MODULE_VERSION) return;
  document.addEventListener("click", (event) => {
    // Old chat cards used data-vendit-open. Treat them as location pings too so
    // historical sale messages cannot remain a remote-shopping bypass after upgrade.
    const button = event.target?.closest?.("[data-vendit-ping], [data-vendit-open]");
    if (!button) return;
    event.preventDefault();
    const id = button.getAttribute("data-vendit-ping") || button.getAttribute("data-vendit-open");
    if (id) pingVenditLocation(id);
  });
  if (document.body) document.body.dataset.venditCitiNetBound = MODULE_VERSION;
}
async function addDocumentToPool(pool, doc){
  if (!doc || doc.documentName !== "Item") return false;
  if (pool.some(entry => entry.uuid === doc.uuid)) return false;
  pool.push({uuid:doc.uuid, name:doc.name, img:doc.img});
  return true;
}
async function openDynamicConfig(venditId, externalDB=null){
  const bodyId = `vendit-dynamic-${randomID()}`;
  const db = externalDB || await loadAll();
  const shop = db.vendits?.[venditId];
  if (!shop) return ui.notifications.warn(`Автомат не найден: ${venditId}`);
  shop.dynamic = foundry.utils.mergeObject(defaultDynamicSettings(), shop.dynamic || {}, {inplace:false});
  const dynamic = shop.dynamic;
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeCSS(bodyId, accent);
  const scReady = !!getSimpleCalendar();
  const isTemplate = () => db.defaults?.dynamic?.autoTileTemplateId === shop.id;

  const renderPool = (pool, kind) => (pool || []).length ? pool.map((entry, index) => `
    <div class="card" data-pool-kind="${kind}" data-pool-index="${index}">
      <div class="item-row">
        <div class="item-left"><img class="thumb" src="${esc(entry.img || 'icons/svg/item-bag.svg')}"><div class="item-copy"><div class="name" title="${esc(entry.name)}">${esc(entry.name)}</div></div></div>
        <button class="btn icon-btn danger" data-pool-remove="${kind}:${index}" title="Убрать"><i class="fas fa-times"></i></button>
      </div>
    </div>`).join("") : `<div class="muted">В подборке пока нет предметов.</div>`;

  const templateLabel = isTemplate() ? "Очистить шаблон для тайлов" : "Сделать шаблоном для тайлов";
  const templateIcon = isTemplate() ? "fa-unlink" : "fa-clone";
  const content = `
  <div id="${bodyId}">
    <div class="wrap">
      <div class="status-strip"><b>ОБНОВЛЕНИЕ ТОРГОВОГО АВТОМАТА</b><span>${scReady ? "Simple Calendar подключён" : "Ожидание Simple Calendar"}</span></div>
      <div>
        <div class="title">${esc(shop.name)}</div>
        <div class="muted">Обновление склада, фоновые покупатели, привязка к тайлу и реклама скидок в Ситинете.</div>
      </div>
      <label class="inline"><input type="checkbox" class="d-enabled" ${dynamic.enabled ? "checked" : ""}> <b>Включить обновление склада и фоновых покупателей</b></label>

      <div class="card feature">
        <div class="section-title">Генератор ассортимента</div>
        <div class="source-grid">
          <label>Источник<select class="d-stock-source"><option value="table" ${dynamic.stockSource === "table" ? "selected" : ""}>Таблица</option><option value="pack" ${dynamic.stockSource === "pack" ? "selected" : ""}>Компендиум</option><option value="pool" ${dynamic.stockSource === "pool" ? "selected" : ""}>Ручная подборка</option></select></label>
          <label>Таблицы ассортимента<input type="text" class="d-stock-table" value="${esc(dynamic.stockTable || shop.rollTable || db.defaults.rollTable || "")}" placeholder="UUID / название / pack::название — несколько значений через запятую или с новой строки"></label>
        </div>
        <label style="margin-top:8px">Компендиумы ассортимента<input type="text" class="d-stock-pack" value="${esc(dynamic.stockPack || shop.packKey || db.defaults.packKey || "")}" placeholder="package.pack — несколько значений через запятую или с новой строки"></label>
        <div class="muted" style="margin-top:5px">Пустые поля используют настройки автомата, а затем общие настройки.</div>
        <div class="field-grid" style="margin-top:9px">
          <label>Мин. товаров<input type="number" class="d-min-items" min="1" max="50" value="${dynamic.minItems}"></label>
          <label>Макс. товаров<input type="number" class="d-max-items" min="1" max="50" value="${dynamic.maxItems}"></label>
          <label>Мин. количество<input type="number" class="d-qty-min" min="0" max="999" value="${dynamic.qtyMin}"></label>
          <label>Макс. количество<input type="number" class="d-qty-max" min="0" max="999" value="${dynamic.qtyMax}"></label>
          <label>Мин. дней между обновлениями<input type="number" class="d-cycle-min" min="1" max="365" value="${dynamic.cycleDaysMin}"></label>
          <label>Макс. дней между обновлениями<input type="number" class="d-cycle-max" min="1" max="365" value="${dynamic.cycleDaysMax}"></label>
        </div>
        <label class="inline" style="margin-top:9px"><input type="checkbox" class="d-traffic" ${dynamic.npcTraffic ? "checked" : ""}> Имитировать покупки НПС и редкие поставки при обновлении</label>
        <div class="source-grid" style="grid-template-columns:minmax(0,1fr) auto;margin-top:9px"><input type="text" class="stock-search" list="${bodyId}-items" placeholder="Добавить предмет в подборку ассортимента…"><button class="btn" data-stock-add>Добавить</button></div>
        <div class="drop" data-stock-drop style="margin-top:8px">Перетащите предметы в список ассортимента</div>
        <div class="list" data-stock-pool style="margin-top:8px">${renderPool(dynamic.stockPool, "stock")}</div>
      </div>

      <div class="card feature">
        <div class="section-title">Акции в Ситинете</div>
        <label class="inline"><input type="checkbox" class="d-sale-enabled" ${dynamic.saleEnabled ? "checked" : ""}> Разрешить объявления о ценах этого автомата на активной сцене</label>
        <div class="source-grid" style="margin-top:9px">
          <label>Источник товаров для акции<select class="d-sale-source"><option value="table" ${dynamic.saleSource === "table" ? "selected" : ""}>Таблица</option><option value="pool" ${dynamic.saleSource === "pool" ? "selected" : ""}>Ручная подборка</option></select></label>
          <label>Таблицы акций<input type="text" class="d-sale-table" value="${esc(dynamic.saleTable || shop.rollTable || db.defaults.rollTable || "")}" placeholder="Рекламируются только предметы из этих таблиц"></label>
        </div>
        <div class="muted" style="margin-top:5px">Распределение цен: обычно 100%, нередко 101–115%, скидки до 75–99% встречаются редко. Это настраиваемая симуляция торговли.</div>
        <div class="source-grid" style="grid-template-columns:minmax(0,1fr) auto;margin-top:9px"><input type="text" class="sale-search" list="${bodyId}-items" placeholder="Добавить предмет в подборку акций…"><button class="btn" data-sale-add>Добавить</button></div>
        <div class="drop" data-sale-drop style="margin-top:8px">Перетащите предметы в список акций</div>
        <div class="list" data-sale-pool style="margin-top:8px">${renderPool(dynamic.salePool, "sale")}</div>
      </div>

      <datalist id="${bodyId}-items"></datalist>
      <div class="action-grid">
        <button class="btn" data-generate><i class="fas fa-random"></i> Создать 3–6 товаров</button>
        <button class="btn" data-cycle><i class="fas fa-people-arrows"></i> Сымитировать покупателей</button>
        <button class="btn" data-sale-test><i class="fas fa-broadcast-tower"></i> Проверить объявление</button>
        <button class="btn" data-bind-tile><i class="fas fa-link"></i> Привязать выбранный тайл</button>
        <button class="btn secondary" data-template><i class="fas ${templateIcon}"></i> <span>${templateLabel}</span></button>
      </div>
      <div class="status-strip"><span>Привязанный тайл: <b>${esc(shop.tileUuid || "None")}</b></span><span class="template-status">Шаблон для тайлов: <b>${isTemplate() ? "ДА" : "НЕТ"}</b></span></div>
      <div class="muted">Шаблон содержит только настройки. Каждый новый подходящий тайл получает отдельный автомат и новый ассортимент; текущий запас шаблона не копируется.</div>
    </div>
  </div>`;

  function readForm(root){
    dynamic.enabled = root.querySelector(".d-enabled").checked;
    dynamic.stockSource = root.querySelector(".d-stock-source").value;
    dynamic.stockTable = root.querySelector(".d-stock-table").value.trim();
    dynamic.stockPack = root.querySelector(".d-stock-pack").value.trim();
    dynamic.minItems = Number(root.querySelector(".d-min-items").value);
    dynamic.maxItems = Number(root.querySelector(".d-max-items").value);
    dynamic.qtyMin = Number(root.querySelector(".d-qty-min").value);
    dynamic.qtyMax = Number(root.querySelector(".d-qty-max").value);
    dynamic.cycleDaysMin = Number(root.querySelector(".d-cycle-min").value);
    dynamic.cycleDaysMax = Number(root.querySelector(".d-cycle-max").value);
    dynamic.npcTraffic = root.querySelector(".d-traffic").checked;
    dynamic.saleEnabled = root.querySelector(".d-sale-enabled").checked;
    dynamic.saleSource = root.querySelector(".d-sale-source").value;
    dynamic.saleTable = root.querySelector(".d-sale-table").value.trim();
    normalizeDynamicBounds(dynamic);
    shop.dynamic = dynamic;
  }
  async function persist(root){
    readForm(root);
    db.vendits[shop.id] = shop;
    await saveAll(db);
  }

  const dlg = new Dialog({
    title:`Обновление автомата — ${shop.name}`,
    content,
    buttons:{save:{label:"Сохранить", callback:async html => persist(html[0].querySelector(`#${bodyId}`))}, close:{label:"Закрыть"}},
    render:async html => {
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      const root = html[0].querySelector(`#${bodyId}`);
      forceFooterButtons(app, accent);
      autosizeDialog(app, bodyId);
      requestAnimationFrame(()=> autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);
      const stockPoolEl = root.querySelector("[data-stock-pool]");
      const salePoolEl = root.querySelector("[data-sale-pool]");
      const datalist = root.querySelector(`#${bodyId}-items`);

      const names = new Set();
      const options = [];
      const configuredPack = dynamic.stockPack || shop.packKey || db.defaults.packKey || "";
      const sourcePacks = configuredPack ? resolveItemPacks(configuredPack) : game.packs.filter(pack => pack.documentName === "Item");
      if (!configuredPack){
        for (const item of game.items){
          if (item.name && !names.has(item.name.toLowerCase())){ names.add(item.name.toLowerCase()); options.push(item.name); }
        }
      }
      for (const pack of sourcePacks){
        try{
          const index = await pack.getIndex({fields:["name"]});
          for (const entry of index){
            if (!entry.name || names.has(entry.name.toLowerCase())) continue;
            names.add(entry.name.toLowerCase()); options.push(entry.name);
          }
        }catch{}
      }
      datalist.innerHTML = options.sort((a,b)=>a.localeCompare(b)).map(name => `<option value="${esc(name)}"></option>`).join("");

      const rerenderPools = () => {
        stockPoolEl.innerHTML = renderPool(dynamic.stockPool, "stock");
        salePoolEl.innerHTML = renderPool(dynamic.salePool, "sale");
        autosizeDialog(app, bodyId);
      };
      async function addByName(kind){
        const input = root.querySelector(kind === "stock" ? ".stock-search" : ".sale-search");
        const packRef = root.querySelector(".d-stock-pack").value.trim() || shop.packKey || db.defaults.packKey;
        const doc = packRef ? await findItemByNameFromPack(packRef, input.value.trim()) : await findItemAnywhere(input.value.trim());
        if (!doc) return ui.notifications.warn(packRef ? `Предмет не найден в выбранных компендиумах: ${input.value.trim()}` : `Предмет не найден: ${input.value.trim()}`);
        await addDocumentToPool(kind === "stock" ? dynamic.stockPool : dynamic.salePool, doc);
        input.value = "";
        rerenderPools();
        await persist(root);
      }
      async function handleDrop(event, kind){
        event.preventDefault(); event.currentTarget.classList.remove("drag");
        let data = null; try{ data = JSON.parse(event.dataTransfer.getData("text/plain")); }catch{}
        if (!data || data.type !== "Item") return;
        const uuid = data.uuid || (data.pack ? `${data.pack}.Item.${data.id}` : `Item.${data.id}`);
        const doc = await byUUID(uuid); if (!doc) return;
        await addDocumentToPool(kind === "stock" ? dynamic.stockPool : dynamic.salePool, doc);
        rerenderPools(); await persist(root);
      }
      for (const [selector, kind] of [["[data-stock-drop]","stock"],["[data-sale-drop]","sale"]]){
        const el = root.querySelector(selector);
        el.addEventListener("dragover", event => { event.preventDefault(); el.classList.add("drag"); });
        el.addEventListener("dragleave", event => { event.preventDefault(); el.classList.remove("drag"); });
        el.addEventListener("drop", event => handleDrop(event, kind));
      }

      root.addEventListener("click", async event => {
        const remove = event.target.closest("[data-pool-remove]")?.getAttribute("data-pool-remove");
        if (remove){
          const [kind, index] = remove.split(":");
          (kind === "stock" ? dynamic.stockPool : dynamic.salePool).splice(Number(index), 1);
          rerenderPools(); await persist(root); return;
        }
        if (event.target.closest("[data-stock-add]")) return addByName("stock");
        if (event.target.closest("[data-sale-add]")) return addByName("sale");
        if (event.target.closest("[data-generate]")){
          readForm(root); dynamic.enabled = true;
          const count = await fillDynamicStock(shop, {replace:true, defaults:db.defaults});
          scheduleNextCycle(shop, calendarTimestamp()); await persist(root);
          ui.notifications.info(`Создано ${count} товаров для ${shop.name}.`); return;
        }
        if (event.target.closest("[data-cycle]")){
          readForm(root); await runNpcCycle(shop, calendarTimestamp(), {replace:false, defaults:db.defaults}); await persist(root);
          ui.notifications.info(`Фоновое обновление завершено для ${shop.name}.`); return;
        }
        if (event.target.closest("[data-sale-test]")){
          readForm(root);
          if (!shopIsOnActiveScene(shop)) return ui.notifications.warn("Перед тестовым объявлением сделайте сцену автомата активной.");
          if (!shop.tileUuid) return ui.notifications.warn("Перед показом расположения привяжите автомат к тайлу.");
          const item = await activateSaleOnShop(shop, calendarTimestamp(), db.defaults);
          if (!item) return ui.notifications.warn("В выбранной таблице или списке не найден товар для акции.");
          await persist(root); await postCitiNetSale(shop, item, {requireActiveScene:true}); return;
        }
        if (event.target.closest("[data-bind-tile]")){
          const tiles = selectedTileDocuments();
          if (tiles.length !== 1) return ui.notifications.warn("Сначала выделите ровно один тайл текущей сцены.");
          await bindVenditToTile(shop, tiles[0], db); await persist(root);
          ui.notifications.info(`${shop.name} привязан к выбранному тайлу.`); return;
        }
        const templateButton = event.target.closest("[data-template]");
        if (templateButton){
          await persist(root);
          if (isTemplate()){
            db.defaults.dynamic.autoTileTemplateId = "";
            ui.notifications.info("Шаблон очищен. Новые тайлы используют общие настройки, пока не выбран другой шаблон.");
          } else {
            db.defaults.dynamic.autoTileTemplateId = shop.id;
            ui.notifications.info(`${shop.name} теперь используется как шаблон для тайлов.`);
          }
          await saveAll(db);
          const active = isTemplate();
          templateButton.querySelector("span").textContent = active ? "Очистить шаблон для тайлов" : "Сделать шаблоном для тайлов";
          templateButton.querySelector("i").className = `fas ${active ? "fa-unlink" : "fa-clone"}`;
          root.querySelector(".template-status").innerHTML = `Шаблон для тайлов: <b>${active ? "ДА" : "НЕТ"}</b>`;
        }
      });
    },
    close:(appEl) => cleanupDialogAfterClose(appEl, {bodyId, style, observer:dlg._mo})
  }, {resizable:true});
  dlg.render(true);
}
async function openDynamicManager(externalDB=null){
  const bodyId = `vendit-network-${randomID()}`;
  const db = externalDB || await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeCSS(bodyId, accent);
  const globalDynamic = db.defaults.dynamic;

  const renderRows = () => Object.values(db.vendits || {}).sort((a,b)=>a.name.localeCompare(b.name)).map(shop => {
    const dynamic = shop.dynamic || defaultDynamicSettings();
    const status = dynamic.enabled ? "обновляемые" : "Постоянный";
    const products = (shop.items || []).filter(item => item.dynamicManaged).length;
    const template = globalDynamic.autoTileTemplateId === shop.id ? `<span class="badge secondary">ШАБЛОН ДЛЯ ТАЙЛОВ</span>` : "";
    return `<div class="card"><div class="grid2"><div><div class="name">${esc(shop.name)} <span class="badge">${status}</span> ${template}</div><div class="muted">${products} товаров · ${esc(shop.sceneName || "Любая сцена")}${shop.tileUuid ? " · Тайл привязан" : ""}</div></div><button class="btn" data-config="${esc(shop.id)}"><i class="fas fa-cogs"></i> Настроить</button></div></div>`;
  }).join("") || `<div class="muted">Сначала создайте автомат, затем настройте обновление ассортимента.</div>`;

  const templateName = () => db.vendits?.[globalDynamic.autoTileTemplateId]?.name || "Нет";
  const content = `
  <div id="${bodyId}"><div class="wrap">
    <div class="status-strip"><b>СЕТЬ ТОРГОВЫХ АВТОМАТОВ</b><span>${db.era2045 ? "2045 КРАСНАЯ ЭПОХА" : "2077 СИТИНЕТ"}</span></div>
    <div class="title">Обновляемая сеть</div>
    <div class="card feature">
      <div class="section-title">Автоматическое создание по тайлам</div>
      <label class="inline"><input type="checkbox" class="g-auto" ${globalDynamic.autoTiles ? "checked" : ""}> Создавать автомат при появлении тайла с подходящим названием</label>
      <label style="margin-top:8px">Ключевые слова в названии / картинке тайла<input type="text" class="g-keywords" value="${esc(globalDynamic.autoTileKeywords || "")}"></label>
      <div class="field-grid" style="margin-top:8px">
        <label>Мин. объявлений в день<input type="number" class="g-ping-min" min="0" max="12" value="${globalDynamic.salePingsMin}"></label>
        <label>Макс. объявлений в день<input type="number" class="g-ping-max" min="0" max="12" value="${globalDynamic.salePingsMax}"></label>
      </div>
      <div class="status-strip" style="margin-top:9px"><span>Шаблон для тайлов: <b class="template-name">${esc(templateName())}</b></span><button class="btn danger" type="button" data-clear-template ${globalDynamic.autoTileTemplateId ? "" : "disabled"}><i class="fas fa-unlink"></i> Очистить шаблон</button></div>
      <div class="muted" style="margin-top:7px">Шаблон содержит настройки обновления, источники товаров и правила акций. Каждый подходящий тайл получает отдельный автомат и новый ассортимент из 3–6 товаров. Без шаблона используются общие настройки.</div>
    </div>
    <div class="action-grid">
      <button class="btn" data-process><i class="fas fa-forward"></i> Обработать обновления склада</button>
      <button class="btn" data-scene-sale><i class="fas fa-broadcast-tower"></i> Проверить объявление активной сцены</button>
      <button class="btn secondary" data-binder><i class="fas fa-code"></i> Создать / восстановить макрос привязки</button>
    </div>
    <div class="list" data-network-list>${renderRows()}</div>
  </div></div>`;

  const dlg = new Dialog({
    title:"Автоматы — обновляемая сеть",
    content,
    buttons:{save:{label:"Сохранить", callback:async html => {
      const root = html[0].querySelector(`#${bodyId}`);
      globalDynamic.autoTiles = root.querySelector(".g-auto").checked;
      globalDynamic.autoTileKeywords = root.querySelector(".g-keywords").value.trim();
      globalDynamic.salePingsMin = clampInt(root.querySelector(".g-ping-min").value, 0, 12);
      globalDynamic.salePingsMax = clampInt(root.querySelector(".g-ping-max").value, globalDynamic.salePingsMin, 12);
      db.defaults.dynamic = globalDynamic; await saveAll(db);
    }}, close:{label:"Закрыть"}},
    render:html => {
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      const root = html[0].querySelector(`#${bodyId}`);
      forceFooterButtons(app, accent); autosizeDialog(app, bodyId); requestAnimationFrame(()=>autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);
      root.addEventListener("click", async event => {
        const id = event.target.closest("[data-config]")?.getAttribute("data-config");
        if (id) return openDynamicConfig(id, db);
        if (event.target.closest("[data-process]")){
          await processCalendarTick({allowSalePing:false, forceStock:true}); ui.notifications.info("Обновление складов автоматов обработано."); return;
        }
        if (event.target.closest("[data-scene-sale]")){
          const fresh = await loadAll();
          if (!await fireRandomSceneSale(fresh, calendarTimestamp())) return ui.notifications.warn("На активной сцене нет автомата с включёнными распродажами и действующим источником товаров.");
          await saveAll(fresh); return;
        }
        if (event.target.closest("[data-binder]")){
          await ensureBinderMacro({repair:true, notify:true}); return;
        }
        if (event.target.closest("[data-clear-template]")){
          globalDynamic.autoTileTemplateId = ""; db.defaults.dynamic = globalDynamic; await saveAll(db);
          root.querySelector(".template-name").textContent = "None";
          event.target.closest("[data-clear-template]").disabled = true;
          root.querySelector("[data-network-list]").innerHTML = renderRows();
          ui.notifications.info("Шаблон для тайлов очищен.");
        }
      });
    },
    close:(appEl) => cleanupDialogAfterClose(appEl, {bodyId, style, observer:dlg._mo})
  }, {resizable:true});
  dlg.render(true);
}

/* -------------------- Options dialog -------------------- */
async function openOptions(externalDB=null){
  const bodyId = `vendit-options-${randomID()}`;
  const db = externalDB || await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeCSS(bodyId, accent);

  const content = `
  <div id="${bodyId}"><div class="wrap">
    <div class="status-strip"><b>НАСТРОЙКИ АВТОМАТОВ</b><span>${db.era2045 ? "2045" : "2077"}</span></div>
    <div class="title">Настройки</div>
    <div class="card feature">
      <div class="section-title">Источники по умолчанию</div>
      <label>Компендиумы по умолчанию<textarea class="pack" placeholder="package.pack — через запятую или с новой строки">${esc(db.defaults?.packKey||"")}</textarea></label>
      <label style="margin-top:8px">Таблицы по умолчанию (UUID / название / pack::название)<textarea class="table" placeholder="Через запятую или с новой строки">${esc(db.defaults?.rollTable||"")}</textarea></label>
      <div class="action-grid" style="margin-top:8px"><button class="btn" type="button" data-test-pack>Проверить компендиумы</button><button class="btn" type="button" data-test-table>Проверить таблицы</button></div>
      <div class="muted" style="margin-top:6px">Если оба поля пусты, быстрый поиск использует все предметы мира и компендиумов.</div>
    </div>
    <div class="card">
      <div class="section-title">Тема эпохи и макрос тайла</div>
      <label class="inline"><input type="checkbox" class="era" ${db.era2045?"checked":""}> Использовать <b>красную тему 2045</b> для автомата. Если выключено, используется бирюзово-жёлтая тема 2077.</label>
      <label style="margin-top:9px">Расстояние взаимодействия (в клетках)<input type="number" class="interaction-range" min="0" max="12" step="1" value="${Number(db.defaults?.interactionRangeSquares ?? 2)}"></label>
      <div class="muted" style="margin-top:4px">Привязанные к тайлам автоматы открываются игрокам в пределах указанного расстояния. Предпросмотр мастера доступен из любой точки.</div>
      <div class="action-grid" style="margin-top:9px"><button class="btn secondary" type="button" data-binder><i class="fas fa-code"></i> Создать / восстановить макрос автомата</button></div>
      <div class="muted" style="margin-top:6px">Макрос передаёт контекст тайла и токена Monk's и также принимает аргумент <code>id=YOUR-ID</code> .</div>
    </div>
  </div></div>`;

  const dlg = new Dialog({
    title:"Автоматы — настройки", content,
    buttons:{
      save:{label:"Сохранить", callback:async html => {
        const root = html[0].querySelector(`#${bodyId}`);
        db.defaults = {
          ...(db.defaults||{}),
          packKey:root.querySelector(".pack").value.trim(),
          rollTable:root.querySelector(".table").value.trim(),
          interactionRangeSquares:Math.max(0, Math.min(12, Number(root.querySelector(".interaction-range")?.value ?? 2)))
        };
        db.era2045 = !!root.querySelector(".era").checked; await saveAll(db);
      }}, close:{label:"Закрыть"}
    },
    render:html => {
      document.head.appendChild(style);
      const app = html[0].closest(".app"); app.classList.add(`dialog-host-${bodyId}`);
      forceFooterButtons(app, accent); autosizeDialog(app, bodyId); requestAnimationFrame(()=>autosizeDialog(app, bodyId)); dlg._mo=observeResize(app, bodyId);
      const root = html[0].querySelector(`#${bodyId}`);
      root.querySelector("[data-test-pack]")?.addEventListener("click", () => {
        const packs = resolveItemPacks(root.querySelector(".pack").value);
        if (!packs.length) return ui.notifications.warn("По этим ключам не найдены компендиумы предметов.");
        ui.notifications.info(`Найдено ${packs.length} Компендиум предметов: ${packs.map(pack=>pack.title||pack.collection).join(", ")}`);
      });
      root.querySelector("[data-test-table]")?.addEventListener("click", async () => {
        const preview = await previewRollTable(root.querySelector(".table").value);
        if (!preview.count) return ui.notifications.warn("По этим ссылкам не найдены таблицы.");
        if (!preview.rolled?.results?.length) return ui.notifications.warn("Таблица найдена, но не дала подходящего результата.");
        ui.notifications.info(`Найдено ${preview.count} Таблица бросков.`);
      });
      root.querySelector("[data-binder]")?.addEventListener("click", () => ensureBinderMacro({repair:true, notify:true}));
    },
    close:app => cleanupDialogAfterClose(app, {bodyId, style, observer:dlg._mo})
  }, {resizable:true});
  dlg.render(true);
}

/* -------------------- Admin UI -------------------- */
async function openAdmin() {
  if (!game.user.isGM) return ui.notifications.warn("Управление автоматами доступно только мастеру.");
  const bodyId = `vendit-${randomID()}`;
  const sceneId = currentSceneId();
  const db = await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeCSS(bodyId, accent);

  function renderList() {
    const rows = Object.values(db.vendits).sort((a,b)=>a.name.localeCompare(b.name)).map(v=>{
      const sc = v.sceneOnly ? (v.sceneName || v.sceneId || "(сцена)") : "Любая сцена";
      const template = db.defaults?.dynamic?.autoTileTemplateId === v.id ? `<span class="badge secondary">ШАБЛОН</span>` : "";
      return `<div class="card" data-id="${v.id}">
        <div class="grid2">
          <div><div class="name">${esc(v.name)} <span class="badge">${v.dynamic?.enabled ? "обновляемые" : "Постоянный"}</span> ${template}</div><div class="muted">ID ${esc(v.id)} · ${esc(sc)}${v.tileUuid ? " · Тайл привязан" : ""}</div></div>
          <div class="item-controls">
            <button class="btn" data-dynamic="${esc(v.id)}"><i class="fas fa-network-wired"></i> обновляемые</button>
            <button class="btn" data-edit="${esc(v.id)}"><i class="fas fa-edit"></i> Изменить</button>
            <button class="btn danger" data-del="${esc(v.id)}"><i class="fas fa-trash"></i> Удалить</button>
          </div>
        </div>
      </div>`;
    }).join("") || `<div class="muted">Автоматов пока нет. Нажмите <b>Новый автомат</b> для создания.</div>`;
    return rows;
  }

  const tipHTML = `
  <div class="status-strip">
    <span><b>Макрос тайла:</b> используйте автоматически созданный макрос <code>Торговля — привязка автомата</code> . Для привязанных тайлов аргумент не нужен; отдельный автомат можно открыть через <code>id=YOUR-ID</code>.</span>
    <button class="btn secondary" type="button" data-binder><i class="fas fa-code"></i> Восстановить макрос</button>
  </div>`;

  const content = `
  <div id="${bodyId}">
    <div class="wrap">
      <div class="status-strip"><b>УПРАВЛЕНИЕ ТОРГОВЫМИ АВТОМАТАМИ</b><span>${db.era2045 ? "2045 КРАСНАЯ ЭПОХА" : "2077 СИТИНЕТ"}</span></div>
      <div class="title">Торговля — автоматы</div>
      <div class="toolbar">
        <button class="btn" data-new><i class="fas fa-plus-circle"></i> Новый автомат</button>
        <button class="btn" data-network><i class="fas fa-network-wired"></i> Обновляемая сеть</button>
        <button class="btn" data-opts><i class="fas fa-sliders-h"></i> Настройки</button>
      </div>
      <div class="list" data-list>${renderList()}</div>
      ${tipHTML}
    </div>
  </div>`;

  const dlg = new Dialog({
    title: "Торговля — автоматы",
    content,
    buttons: { close: { label: "Закрыть" } },
    render: (html)=>{
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      forceFooterButtons(app, accent);
      autosizeDialog(app, bodyId);
      requestAnimationFrame(()=> autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);

      const root = html[0].querySelector(`#${bodyId}`);
      const $list = root.querySelector("[data-list]");

      const refresh = ()=>{ $list.innerHTML = renderList(); autosizeDialog(app, bodyId); };

      root.querySelector("[data-new]").addEventListener("click", ()=> editVendit());
      root.querySelector("[data-network]").addEventListener("click", ()=> openDynamicManager(db));
      root.querySelector("[data-opts]").addEventListener("click", ()=> openOptions(db));
      root.querySelector("[data-binder]")?.addEventListener("click", ()=> ensureBinderMacro({repair:true, notify:true}));

      $list.addEventListener("click", async (ev)=>{
        const idDynamic = ev.target.closest("[data-dynamic]")?.getAttribute("data-dynamic");
        const idEdit = ev.target.closest("[data-edit]")?.getAttribute("data-edit");
        const idDel  = ev.target.closest("[data-del]")?.getAttribute("data-del");
        if (idDynamic) return openDynamicConfig(idDynamic, db);
        if (idEdit) return editVendit(db.vendits[idEdit]);
        if (idDel) {
          const ok = await Dialog.confirm({
            title:"Удалить автомат",
            content:`<p>Удалить <b>${esc(db.vendits[idDel]?.name ?? idDel)}</b>?</p>`,
            yes: ()=> true, no: ()=> false, defaultYes: false
          });
          if (!ok) return;
          await deleteVendit(db, idDel);
          ui.notifications.info("Автомат удалён; его привязки к тайлам и шаблонам очищены.");
          refresh();
        }
      });

      async function editVendit(v=null){
        const editorBodyId = `vendit-edit-${randomID()}`;
        const data = v ? foundry.utils.deepClone(v) : {
          id: randomID(), name: "Новый автомат", sceneOnly: true,
          sceneId, sceneName: canvas?.scene?.name ?? "",
          packKey: db.defaults?.packKey ?? "",
          rollTable: db.defaults?.rollTable ?? "",
          items:[],
          tileUuid:"",
          dynamic:defaultDynamicSettings()
        };

        db.vendits[data.id] = data; await saveAll(db); // ensure it exists immediately
        refresh();

        const content = `
        <div id="${editorBodyId}">
          <div class="wrap">
            <div class="status-strip"><b>РЕДАКТОР АССОРТИМЕНТА АВТОМАТА</b><span>${data.dynamic?.enabled ? "ОБНОВЛЯЕМЫЙ" : "ПОСТОЯННЫЙ"}</span></div>
            <div class="source-grid identity-grid">
              <label class="identity-name">Название<br><input type="text" class="v-name" value="${esc(data.name)}"></label>
              <label class="identity-id">ID (для триггеров)<br><input type="text" class="v-id" value="${esc(data.id)}"></label>
            </div>
            <div class="row">
              <label class="row" style="gap:6px">
                <input type="checkbox" class="v-scene" ${data.sceneOnly?"checked":""}> Только на сцене <b>${esc(canvas?.scene?.name ?? "текущая сцена")}</b>
              </label>
            </div>
            <div class="row" style="flex-direction:column; align-items:stretch">
              <label>Компендиум этого автомата<br><input type="text" class="v-pack" value="${esc(data.packKey||"")}"></label>
              <label>Таблица этого автомата (UUID / название / pack::название)<br>
                <div class="row" style="gap:6px; width:100%">
                  <input style="flex:1" type="text" class="v-table" value="${esc(data.rollTable||"")}">
                  <button class="btn" data-testr>Проверить бросок</button>
                  <button class="btn" data-preview>Предпросмотр</button>
                </div>
              </label>
              <div class="muted">Если оба поля пусты, быстрый поиск использует все предметы мира и компендиумов.</div>
            </div>
            <div class="row">
              <input type="text" class="v-quick" list="vendit-suggest" placeholder="Поиск предметов в мире и компендиумах…">
              <datalist id="vendit-suggest"></datalist>
              <button class="btn" data-qadd>Добавить</button>
            </div>
            <div class="drop" data-drop>Перетащите предметы для добавления</div>
            <div class="list" data-items>${renderItems()}</div>
          </div>
        </div>`;

        function renderItems(){
          if (!data.items.length) return `<div class="muted">Предметов пока нет.</div>`;
          return data.items.map((it, i)=>`
            <div class="card" data-i="${i}">
              <div class="item-row">
                <div class="item-left">
                  <img class="thumb" src="${it.img || 'icons/svg/box.svg'}">
                  <div class="item-copy">
                    <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
                    <div class="muted">Цена ${it.price|0} эб</div>
                  </div>
                </div>
                <div class="item-controls">
                  <label>Кол-во<input type="number" class="qty" min="0" step="1" value="${(it.infinite?0:(it.qty??1))|0}" ${it.infinite?'disabled':''}></label>
                  <label class="inline" style="min-width:48px"><input type="checkbox" class="inf" ${it.infinite?'checked':''}>∞</label>
                  <label>Цена<input type="number" class="price" min="0" step="1" value="${it.price|0}"></label>
                  <button class="btn icon-btn danger" data-rem="${i}" title="Удалить"><i class="fas fa-times"></i></button>
                </div>
              </div>
            </div>
          `).join("");
        }

        const edDlg = new Dialog({
          title: `Изменить автомат — ${data.name}`,
          content,
          buttons: {
            save: { label:"Сохранить", callback: async (html)=>{
              const root = html[0].querySelector(`#${editorBodyId}`);
              data.name      = root.querySelector(".v-name").value.trim() || data.name;
              const newId    = root.querySelector(".v-id").value.trim()   || data.id;
              data.sceneOnly = root.querySelector(".v-scene").checked;
              if (data.sceneOnly) { data.sceneId = sceneId; data.sceneName = canvas?.scene?.name ?? ""; }
              data.packKey   = root.querySelector(".v-pack").value.trim();
              data.rollTable = root.querySelector(".v-table").value.trim();

              if (newId !== data.id && db.vendits?.[newId]) {
                ui.notifications.warn("Этот ID автомата уже занят. Выберите уникальный ID.");
                return false;
              }

              if (newId !== data.id) {
                const oldId = data.id;
                delete db.vendits[oldId];
                data.id = newId;
                if (db.defaults?.dynamic?.autoTileTemplateId === oldId) db.defaults.dynamic.autoTileTemplateId = newId;
                if (data.tileUuid){
                  try{
                    const tile = await fromUuid(data.tileUuid);
                    if (tile?.documentName === "Tile" && venditIdFromTile(tile) === oldId) await tile.setFlag(MODULE_ID, "venditId", newId);
                  }catch(error){ console.warn("Vendit™ | Could not update Tile after Vendit ID change", error); }
                }
              }
              db.vendits[data.id] = data; await saveAll(db);
              refresh();
            }},
            close: { label:"Закрыть" }
          },
          render: (html)=>{
            const style2 = document.createElement("style"); style2.textContent = makeCSS(editorBodyId, accent);
            document.head.appendChild(style2); edDlg._style = style2;

            const app = html[0].closest('.app');
            app.classList.add(`dialog-host-${editorBodyId}`);
            forceFooterButtons(app, accent);

            const root = html[0].querySelector(`#${editorBodyId}`);
            const $items    = root.querySelector("[data-items]");
            const $drop     = root.querySelector("[data-drop]");
            const $datalist = root.querySelector("#vendit-suggest");
            const $quick    = root.querySelector(".v-quick");
            const $packIn   = root.querySelector(".v-pack");
            const $tableIn  = root.querySelector(".v-table");

            // prevent Enter from submitting the entire dialog
            root.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); }}, true);

            async function buildSuggestions(){
              const seen = new Set(); const options = [];
              const configuredPack = $packIn.value.trim() || db.defaults.packKey;
              const packs = configuredPack ? resolveItemPacks(configuredPack) : game.packs.filter(pack => pack.documentName === "Item");
              if (!configuredPack){
                for (const item of game.items){
                  const name = item.name?.trim(); if (!name) continue;
                  const key = name.toLowerCase(); if (seen.has(key)) continue;
                  seen.add(key); options.push(name);
                }
              }
              for (const pack of packs){
                try{
                  const index = await pack.getIndex({fields:["name"]});
                  for (const entry of index){
                    const name = entry.name?.trim(); if (!name) continue;
                    const key = name.toLowerCase(); if (seen.has(key)) continue;
                    seen.add(key); options.push(name);
                  }
                }catch{}
              }
              $datalist.innerHTML = options.sort((a,b)=>a.localeCompare(b)).map(name=>`<option value="${esc(name)}"></option>`).join("");
            }
            buildSuggestions();
            $packIn.addEventListener("change", buildSuggestions);

            async function commit(){ db.vendits[data.id]=data; await saveAll(db); refresh(); }

            root.addEventListener("input", async (ev)=>{
              const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i"));
              if (Number.isNaN(idx) || !data.items[idx]) return;
              const it = data.items[idx];
              if (ev.target.classList.contains("price")){
                it.price = Math.max(0, Number(ev.target.value|0));
                it.basePrice = it.price;
                it.regularPrice = it.price;
                it.priceFactor = 100;
                it.saleUntil = 0;
                it.saleFactor = 0;
                await commit();
              }
              if (ev.target.classList.contains("qty"))  { it.qty   = Math.max(0, Number(ev.target.value|0)); await commit(); }
            });

            root.addEventListener("change", async (ev)=>{
              if (ev.target.classList.contains("inf")){
                const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i")); if (Number.isNaN(idx)) return;
                const it = data.items[idx]; it.infinite = ev.target.checked;
                const q = card.querySelector(".qty"); if (q){ q.disabled = it.infinite; if (it.infinite) q.value = 0; }
                await commit();
              }
            });

            async function doQuickAdd(){
              const name = $quick.value.trim(); if (!name) return;
              const packKey = $packIn.value.trim() || db.defaults.packKey;
              const doc = packKey ? await findItemByNameFromPack(packKey, name) : await findItemAnywhere(name);
              if (!doc) return ui.notifications.warn(packKey ? `Предмет не найден в выбранных компендиумах: ${name}` : `Предмет не найден: ${name}`);
              const price = (doc.system?.price?.market != null) ? Number(doc.system.price.market) : (Number(doc.system?.price) || 0);
              const cleanPrice = Math.max(0, price|0);
              data.items.push({ uuid: doc.uuid, name: doc.name, img: doc.img, price:cleanPrice, basePrice:cleanPrice, regularPrice:cleanPrice, priceFactor:100, qty:1, infinite:false, dynamicManaged:false, saleUntil:0, saleFactor:0 });
              if ($items) $items.innerHTML = renderItems();
              $quick.value = "";
              await commit(); autosizeDialog(app, editorBodyId);
            }

            root.addEventListener("click", async (ev)=>{
              const i = ev.target.closest("[data-rem]")?.getAttribute("data-rem");
              if (i != null) { data.items.splice(Number(i),1); if ($items) $items.innerHTML = renderItems(); await commit(); autosizeDialog(app, editorBodyId); }
              if (ev.target.closest("[data-qadd]")) return doQuickAdd();
              if (ev.target.closest("[data-testr]")){
                const ref = $tableIn.value.trim() || db.defaults.rollTable;
                const preview = await previewRollTable(ref);
                if (!preview.count) return ui.notifications.warn("Таблица не найдена.");
                if (!preview.rolled?.results?.length) return ui.notifications.warn("Таблица найдена, но не дала результата.");
              }
              if (ev.target.closest("[data-preview]")){
                await commit();
                openShop(data.id);
              }
            });

            // Drag & drop
            function dragOver(e){ e.preventDefault(); $drop.classList.add("drag"); }
            function dragLeave(e){ e.preventDefault(); $drop.classList.remove("drag"); }
            async function onDrop(e){
              e.preventDefault(); $drop.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw);}catch{}
              if (!d || d.type!=="Item") return;
              const uuid = d.uuid || (d.pack ? `${d.pack}.Item.${d.id}` : `Item.${d.id}`);
              const doc  = await fromUuid(uuid); if (!doc) return;
              const price = (doc.system?.price?.market != null) ? Number(doc.system.price.market) : (Number(doc.system?.price) || 0);
              const cleanPrice = Math.max(0, price|0);
              data.items.push({ uuid, name: doc.name, img: doc.img, price:cleanPrice, basePrice:cleanPrice, regularPrice:cleanPrice, priceFactor:100, qty:1, infinite:false, dynamicManaged:false, saleUntil:0, saleFactor:0 });
              if ($items) $items.innerHTML = renderItems(); await commit(); autosizeDialog(app, editorBodyId);
            }
            $drop.addEventListener("dragover", dragOver);
            $drop.addEventListener("dragleave", dragLeave);
            $drop.addEventListener("drop", onDrop);

            autosizeDialog(app, editorBodyId);
            requestAnimationFrame(()=> autosizeDialog(app, editorBodyId));
            edDlg._mo = observeResize(app, editorBodyId);
          },
          close: (appEl)=>{
            cleanupDialogAfterClose(appEl, {bodyId:editorBodyId, style:edDlg._style, observer:edDlg._mo});
            refresh(); // make sure the manager reflects final state
          }
        });
        edDlg.render(true);
      }
    },
    close: (appEl)=> cleanupDialogAfterClose(appEl, {bodyId, style, observer:dlg._mo})
  });

  dlg.render(true);
}

/* -------------------- Player shop -------------------- */
async function openShop(venditId, {interactionTile=null, interactionToken=null, enforceProximity=false}={}){
  const bodyId = `vendit-shop-${randomID()}`;
  const sceneId = currentSceneId();
  if (isCalendarPrimaryGM()) await processCalendarTick({allowSalePing:false});
  const db = await loadAll();
  const shop = db.vendits?.[venditId];
  if(!shop) return ui.notifications.warn(`Автомат не найден: ${venditId}`);
  if (shop.sceneOnly && sceneId && shop.sceneId && sceneId !== shop.sceneId && !game.user.isGM) return ui.notifications.warn("Автомат недоступен на этой сцене.");

  const items = shop.items||[];
  const preferredToken = getTokenObject(interactionToken);
  const buyer = preferredToken?.actor ?? canvas.tokens.controlled[0]?.actor ?? game.user.character;
  if(!buyer) return ui.notifications.warn("Выделите токен или назначьте персонажа игроку.");

  // Any player interaction originating from a Tile is range-gated. A directly
  // bound Vendit is also range-gated even if somebody tries to call openShop by ID.
  if (!game.user.isGM && (enforceProximity || interactionTile || shop.tileUuid)){
    const check = await validateVenditProximity(shop, buyer, {
      tile:interactionTile,
      token:preferredToken,
      rangeSquares:Number(db.defaults?.interactionRangeSquares ?? 2)
    });
    if (!check.ok) return ui.notifications.warn(check.message);
  }

  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeCSS(bodyId, accent);
  const eraKicker = db.era2045 ? "ТОРГОВЫЙ УЗЕЛ DATA POOL // 2045" : "ТОРГОВЫЙ УЗЕЛ СИТИНЕТ // 2077";

  const renderItems = () => items.length ? items.map((it,i)=>{
    const soldOut = !it.infinite && Number(it.qty||0) <= 0;
    const stockText = it.infinite ? "∞ ЗАПАС" : `${Number(it.qty||0)} ОСТАЛОСЬ`;
    const factor = it.saleUntil ? Number(it.saleFactor || 100) : Number(it.priceFactor || 100);
    const badge = it.saleUntil ? `<span class="badge secondary">СИТИНЕТ ${factor}%</span>` : (it.dynamicManaged && factor !== 100 ? `<span class="badge">РЫНОК ${factor}%</span>` : "");
    return `<div class="card product-card" data-product="${i}"><div class="item-row">
      <div class="item-left"><img class="thumb" src="${esc(it.img || 'icons/svg/item-bag.svg')}"><div class="item-copy"><div class="name" title="${esc(it.name)}">${esc(it.name)}</div><div class="product-meta"><span class="price">${Number(it.price||0)} эб</span><span class="stock">${stockText}</span>${badge}</div></div></div>
      <button class="btn buy" data-i="${i}" ${soldOut?'disabled':''}><i class="fas ${soldOut?'fa-ban':'fa-shopping-cart'}"></i> ${soldOut?"РАСПРОДАНО":"КУПИТЬ"}</button>
    </div></div>`;
  }).join("") : `<div class="card"><div class="muted" style="padding:8px;text-align:center">НЕТ ТОВАРОВ // ЗАГЛЯНИТЕ ПОЗЖЕ</div></div>`;

  const content = `<div id="${bodyId}"><div class="wrap machine-shell">
    <div class="machine-header">
      <div><div class="machine-kicker">${eraKicker}</div><div class="machine-title">ТОРГОВЫЙ АВТОМАТ // ${esc(shop.name)}</div><div class="machine-sub">АВТОМАТИЧЕСКАЯ ВЫДАЧА · ЦЕНА ПРОВЕРЯЕТСЯ ПРИ ПОКУПКЕ</div></div>
      <div class="machine-buyer"><span>ПОКУПАТЕЛЬ</span><b>${esc(buyer.name)}</b></div>
    </div>
    <div class="status-strip"><span>СОСТОЯНИЕ: <b>В СЕТИ</b></span><span>${shop.dynamic?.enabled ? "ОБНОВЛЯЕМЫЙ СКЛАД" : "ПОСТОЯННЫЙ СКЛАД"}</span></div>
    <div class="list" data-list>${renderItems()}</div>
  </div></div>`;

  const dlg = new Dialog({
    title:"Автомат", content, buttons:{close:{label:"Закрыть"}},
    render:html => {
      document.head.appendChild(style);
      const app = html[0].closest(".app"); app.classList.add(`dialog-host-${bodyId}`);
      forceFooterButtons(app, accent); autosizeDialog(app, bodyId); requestAnimationFrame(()=>autosizeDialog(app, bodyId)); dlg._mo=observeResize(app, bodyId);
      const root = html[0].querySelector(`#${bodyId}`);
      root.querySelector("[data-list]")?.addEventListener("click", async ev => {
        const button = ev.target.closest(".buy");
        const iStr = button?.getAttribute("data-i"); if (iStr == null || button.disabled) return;
        const i = Number(iStr); const it = items[i]; if (!it) return;
        if (!it.infinite && Number(it.qty||0) <= 0) return ui.notifications.warn(`${it.name} закончился.`);
        // Lock immediately, then let the GM atomically validate funds + stock + Item delivery.
        button.disabled = true; button.dataset.busy = "1";
        const previous = button.innerHTML; button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ВЫДАЧА`;
        try{
          const result = await requestVenditPurchase({shopId:shop.id, index:i, itemUuid:it.uuid, buyerUuid:buyer.uuid});
          if (!result?.ok){
            ui.notifications.warn(result?.message || "Покупка не удалась.");
            button.disabled=false; button.innerHTML=previous; return;
          }
          it.qty = result.qty;
          it.price = result.price;
          it.saleUntil = result.saleUntil;
          it.saleFactor = result.saleFactor;
          it.priceFactor = result.priceFactor;
          const card = button.closest(".product-card");
          const meta = card?.querySelector(".product-meta");
          if (meta){
            const stockText = result.infinite ? "∞ ЗАПАС" : `${Number(result.qty||0)} ОСТАЛОСЬ`;
            const factor = result.saleUntil ? Number(result.saleFactor || 100) : Number(result.priceFactor || 100);
            const badge = result.saleUntil ? `<span class="badge secondary">СИТИНЕТ ${factor}%</span>` : (it.dynamicManaged && factor !== 100 ? `<span class="badge">РЫНОК ${factor}%</span>` : "");
            meta.innerHTML = `<span class="price">${Number(result.price||0)} эб</span><span class="stock">${stockText}</span>${badge}`;
          }
          if (!result.infinite && result.qty <= 0){ button.disabled=true; button.innerHTML=`<i class="fas fa-ban"></i> РАСПРОДАНО`; }
          else { button.disabled=false; button.innerHTML=`<i class="fas fa-shopping-cart"></i> КУПИТЬ`; }
        }catch(error){
          console.error("Vendit™ | Purchase failed", error); ui.notifications.error("Покупка не удалась.");
          button.disabled=false; button.innerHTML=previous;
        }finally{ delete button.dataset.busy; }
      });
    },
    close:appEl => cleanupDialogAfterClose(appEl, {bodyId, style, observer:dlg._mo})
  });
  dlg.render(true);
}

/* -------------------- generated Monk's Active Tiles binder -------------------- */
function binderMacroCommand(){
  return `return game.vendit.run({\n  args: typeof args === "undefined" ? null : args,\n  tile: typeof tile === "undefined" ? null : tile,\n  token: typeof token === "undefined" ? null : token,\n  actor: typeof actor === "undefined" ? null : actor\n});`;
}
async function ensureBinderMacro({repair=false, notify=false}={}){
  if (!game.user?.isGM) return null;
  const activeGM = game.users?.activeGM;
  if (activeGM && activeGM.id !== game.user.id) return game.macros?.getName?.(BINDER_MACRO_NAME) || null;
  let macro = game.macros?.getName?.(BINDER_MACRO_NAME) || null;
  const command = binderMacroCommand();
  if (!macro){
    macro = await Macro.create({name:BINDER_MACRO_NAME, type:"script", scope:"global", img:BINDER_MACRO_IMG, command, flags:{[MODULE_ID]:{generatedBinder:true}}});
    if (notify) ui.notifications.info("Макрос привязки автомата создан.");
    return macro;
  }

  const generated = !!macro.getFlag?.(MODULE_ID, "generatedBinder");
  const canonicalCommand = macro.command === command;
  const canAutoMaintain = generated || canonicalCommand;
  const needsCommand = macro.command !== command || macro.type !== "script" || macro.scope !== "global";
  const needsImage = macro.img !== BINDER_MACRO_IMG;
  const needsFlag = !generated;

  if (repair || (canAutoMaintain && (needsImage || needsFlag))){
    const update = {img:BINDER_MACRO_IMG, [`flags.${MODULE_ID}.generatedBinder`]:true};
    if (repair || needsCommand){
      update.type = "script";
      update.scope = "global";
      update.command = command;
    }
    await macro.update(update);
    if (notify) ui.notifications.info("Макрос привязки автомата восстановлен.");
  } else if (notify) ui.notifications.info("Макрос привязки автомата уже готов.");
  return macro;
}

/* -------------------- public module API -------------------- */
function parseVenditId(input, depth=0){
  if (depth > 8 || input == null) return null;
  const tileId = venditIdFromTile(input?.tile || input?.triggeringTile || input?.origin?.tile || input);
  if (tileId) return String(tileId);

  if (typeof input === "string"){
    const match = input.match(/id\s*=\s*([^,;]+)$/i);
    const value = String(match ? match[1] : input).replace(/[<>"'()\[\]\s]/g, "");
    return value || null;
  }
  if (Array.isArray(input)){
    for (const entry of input){
      const parsed = parseVenditId(entry, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  if (typeof input === "object"){
    const nestedKeys = ["args", "tile", "triggeringTile", "origin", "context"];
    for (const key of nestedKeys){
      if (input[key] == null) continue;
      const parsed = parseVenditId(input[key], depth + 1);
      if (parsed) return parsed;
    }
    if (input.venditId) return parseVenditId(String(input.venditId), depth + 1);
    if (input.id && !getTileDocument(input)) return parseVenditId(String(input.id), depth + 1);
  }
  return null;
}
async function openFromArgs(argsLike){
  const venditId = parseVenditId(argsLike);
  if (venditId){
    const interactionTile = findContextTile(argsLike);
    const interactionToken = findContextToken(argsLike);
    return openShop(venditId, {interactionTile, interactionToken, enforceProximity:!!interactionTile});
  }
  if (!game.user.isGM) return ui.notifications.warn("Тайл не привязан к автомату. Попросите мастера настроить его.");
  return openAdmin();
}

function exposeApi(){
  const api = {
    version:MODULE_VERSION,
    openManager:openAdmin,
    openOptions,
    openShop,
    openDynamicManager,
    openDynamicConfig,
    openTile:(tile, token=null) => {
      const id = venditIdFromTile(tile);
      return id ? openShop(id, {interactionTile:tile, interactionToken:token, enforceProximity:true}) : ui.notifications.warn("Тайл не привязан к автомату.");
    },
    pingLocation:pingVenditLocation,
    run:openFromArgs,
    bindSelectedTile:async (venditId) => {
      const db = await loadAll();
      const shop = db.vendits?.[venditId];
      const tiles = selectedTileDocuments();
      if (!shop) return ui.notifications.warn(`Автомат не найден: ${venditId}`);
      if (tiles.length !== 1) return ui.notifications.warn("Сначала выделите ровно один тайл.");
      await bindVenditToTile(shop, tiles[0], db);
      await saveAll(db);
      return shop;
    },
    generate:async (venditId, replace=true) => {
      const db = await loadAll();
      const shop = db.vendits?.[venditId];
      if (!shop) return null;
      shop.dynamic ||= defaultDynamicSettings();
      shop.dynamic.enabled = true;
      await fillDynamicStock(shop, {replace, defaults:db.defaults});
      scheduleNextCycle(shop, calendarTimestamp());
      await saveAll(db);
      return shop;
    },
    processCalendar:processCalendarTick,
    ensureBinderMacro,
    getDB:loadAll,
    saveDB:saveAll
  };
  game.vendit = api;
  // Compatibility aliases for older helper macros and console snippets.
  game.venditrun = openFromArgs;
  globalThis.Vendit = api;
}

componentHooks.once("init", () => {
  registerSettings();
  console.log(`Vendit™ | Initializing module v${MODULE_VERSION}`);
});

componentHooks.once("ready", async () => {
  bindVenditSocket();
  exposeApi();
  bindCalendarHooks();
  bindAutoTileHook();
  bindCitiNetButtons();
  try{ /* Binder is created on explicit request. */ }catch(error){ console.warn("Vendit™ | Could not auto-create Binder macro", error); }
  console.log(`Vendit™ | Ready v${MODULE_VERSION}. API available at game.vendit`);
});

componentHooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  // Match Bodega™: the manager lives under Token controls instead of being hidden on the Tile layer.
  const target = controls.find(c => c.name === "token");
  if (!target) return;
  target.tools ||= [];
  if (target.tools.some(t => t.name === "vendit-manager")) return;
  target.tools.push({
    name:"vendit-manager",
    title:"Торговля — автоматы",
    icon:"fas fa-store",
    button:true,
    visible:true,
    onClick:() => openAdmin()
  });
});

export {requestVenditPurchase};

async function gmProcessPurchase(request) { return onceTransaction(request?.nonce ? `vendit:${request.userId}:${request.nonce}` : null, () => ncm_gmProcessPurchase(request)); }

export {gmProcessPurchase};

function processCalendarTick(options={}) { return transaction(()=>ncm_processCalendarTick(options)); }
