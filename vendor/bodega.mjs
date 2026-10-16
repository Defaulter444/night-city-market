import {acceptsBuyback} from "../scripts/point-model.mjs";
import {componentSocket, componentHooks, transaction, onceTransaction, requireCustomer, requireProximity, fixerRank, foodTierId, housingItem, textName, lifestyleItem, intrinsicAttack, kindLabel, saleBlocked, fitDialog, requireMarketGM} from "../scripts/core.mjs";
const marketSocket=componentSocket("bodega");
/**
 * Bodega™ Persistent Shops — Foundry VTT Module v2.3.13
 *
 * Ported from the Bodega™ v2.0.3 / v2.0.3c macros for Foundry VTT 12.
 * Keeps the existing world setting namespace (bodega.db) so configured shops migrate in place.
 */

(() => {
"use strict";

const MODULE_ID = "night-city-market";
const MODULE_VERSION = "2.3.13";
const SOCKET = `module.${MODULE_ID}`;
let isGM = false;
let sceneId = null;
let calendarHookBound = false;
let calendarProcessing = false;
// ---------- World Script: Bodega Socket Binder (late-load safe) ----------
function bindBodegaBridge() {
  if (marketSocket._bodegaBound === MODULE_VERSION) return;

  marketSocket.on(SOCKET, async (msg) => {
    if (!msg) return;

    // UI broadcasts are processed by every client.
    if (msg.op === "purse-ui") {
      document.querySelectorAll(`.v-purse[data-shop="${msg.id}"]`).forEach(inp => inp.value = String(msg.purse|0));
      document.querySelectorAll(`.wrap[data-shop="${msg.id}"] .purse-val`).forEach(el => el.textContent = String(msg.purse|0));
      return;
    }
    if (msg.op === "purse-ack") {
      window.__bodegaAck ||= {};
      window.__bodegaAck[msg.id] = Date.now();
      return;
    }
    if (msg.op === "stock-ui") {
      updateOpenShopStock(msg.id, msg.itemKey, msg.stockClass, msg.qty);
      return;
    }
    if (msg.op === "buyback-done" || msg.op === "buyback-failed" || msg.op === "purchase-done" || msg.op === "purchase-failed") return;

    // Only the active GM may persist shop, stock, ledger, purchase, or buyback changes.
    // This prevents duplicate transactions when more than one GM account is connected.
    if (!game.user?.isGM) return;
    if (game.users?.activeGM?.id && game.users.activeGM.id !== game.user.id) return;

    if (msg.op === "stock") {
      const db = await loadAll();
      const v = db.shops?.[msg.id];
      if (v) {
        let target = v.items?.[msg.index] ?? null;
        if (msg.itemKey){
          const byKey = (v.items || []).find(item => dynamicItemKey(item) === msg.itemKey && (!msg.stockClass || item.stockClass === msg.stockClass));
          if (byKey) target = byKey;
        }
        if (target){ target.qty = Math.max(0, Number(msg.qty|0)); await saveAll(db); }
      }
      return;
    }

    if (msg.op === "purse") {
      const db = await loadAll();
      const v = db.shops?.[msg.id];
      if (v) {
        v.purse = Math.max(0, Number(msg.purse|0));
        await saveAll(db);
        marketSocket.emit(SOCKET, {op:"purse-ui", id:msg.id, purse:v.purse});
        marketSocket.emit(SOCKET, {op:"purse-ack", id:msg.id, purse:v.purse});
      }
      return;
    }

    if (msg.op === "add") {
      const db = await loadAll();
      const shop = db.shops?.[msg.id];
      if (!shop || !msg.item) return;
      const hit = (shop.items || []).find(x => x.name === msg.item.name && (x.price|0) === (msg.item.price|0));
      if (hit) hit.qty = Math.max(0, Number((hit.qty || 0)|0) + (msg.item.qty || 1));
      else {
        shop.items ||= [];
        shop.items.push(msg.item);
      }
      await saveAll(db);
      return;
    }

    if (msg.op === "ledger-wealth") {
      const ledger = await fromUuid(msg.ledgerUuid);
      if (!ledger) return;
      await adjustLedgerWealth(ledger, Number(msg.delta|0), String(msg.reason || "Магазин"));
      const purseNow = Number(ledger.system?.wealth?.value|0);
      marketSocket.emit(SOCKET, {op:"purse-ui", id:msg.id, purse:purseNow});
      marketSocket.emit(SOCKET, {op:"purse-ack", id:msg.id, purse:purseNow});
      return;
    }

    if (msg.op === "gm-buyback-review") {
      await openGMReviewBuyback(msg.payload);
      return;
    }

    if (msg.op === "gm-buyback") {
      const nonce = msg.payload?.nonce;
      try {
        const result = await gmProcessBuyback(msg.payload);
        marketSocket.emit(SOCKET, {
          op: result?.ok ? "buyback-done" : "buyback-failed",
          id:msg.payload?.shopId,
          nonce,
          message:result?.message || "Не удалось завершить скупку."
        });
      } catch (error) {
        console.error("Bodega | GM buyback failed", error);
        marketSocket.emit(SOCKET, {op:"buyback-failed", id:msg.payload?.shopId, nonce, message:"Ошибка скупки у мастера — проверьте консоль."});
        ui.notifications.error("Ошибка скупки на стороне мастера. Подробности в консоли.");
      }
    }

    if (msg.op === "gm-purchase") {
      const nonce = msg.payload?.nonce;
      try {
        const result = await gmProcessPurchase(msg.payload);
        marketSocket.emit(SOCKET, {
          op: result?.ok ? "purchase-done" : "purchase-failed",
          id:msg.payload?.shopId,
          nonce,
          userId:msg.payload?.userId || null,
          message:result?.message || (result?.ok ? "Покупка завершена." : "Не удалось завершить покупку."),
          itemKey:result?.itemKey || msg.payload?.itemKey || "",
          stockClass:result?.stockClass || msg.payload?.stockClass || "",
          qtyRemaining:result?.qtyRemaining,
          qtyPurchased:result?.qtyPurchased,
          total:result?.total,
          purse:result?.purse
        });
      } catch (error) {
        console.error("Bodega | GM purchase failed", error);
        marketSocket.emit(SOCKET, {op:"purchase-failed", id:msg.payload?.shopId, nonce, userId:msg.payload?.userId || null, message:"Ошибка покупки у мастера — проверьте консоль."});
        ui.notifications.error("Ошибка покупки на стороне мастера. Подробности в консоли.");
      }
    }
  });

  // Supports fallback approval cards, including existing cards and popped-out chat.
  document.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.("[data-bodega-approve]");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!game.user?.isGM) return ui.notifications.warn("Подтверждение доступно только мастеру.");
    try {
      const result = await gmProcessBuyback(a2b(btn.getAttribute("data-bodega-approve")));
      if (result?.ok) {
        btn.disabled = true;
        btn.innerHTML = "<i class=\"fas fa-check\"></i> Подтверждено";
      }
    } catch (error) {
      console.error("Bodega | Approval payload failed", error);
      ui.notifications.error("Не удалось обработать подтверждение.");
    }
  }, true);

  marketSocket._bodegaBound = MODULE_VERSION;
  console.log(`Bodega | Socket bridge bound v${MODULE_VERSION} за ${game.user?.name}`);
}

async function gmProcessPurchase(payload, reviewOverride=null) { return onceTransaction(`bodega:gmProcessPurchase:${payload?.userId}:${payload?.nonce}`, () => ncm_gmProcessPurchase(payload, reviewOverride)); }
async function gmProcessBuyback(payload, reviewOverride=null) { return onceTransaction(`bodega:gmProcessBuyback:${payload?.userId}:${payload?.nonce}`, () => ncm_gmProcessBuyback(payload, reviewOverride)); }
// -------------------- quantity stack helpers --------------------
function readStackQty(it){
  const s = it.system ?? {};
  return Number(
    s.quantity ?? s.qty ?? s.amount ?? s.count ?? s.value ??
    s.rounds ?? s.bullets ?? s.charges ?? s.uses ?? s.ammo ?? 1
  ) || 1;
}
async function writeStackQty(it, newQty){
  const p = it.system ?? {};
  const v = Math.max(0, Number(newQty|0));
  const field =
    ("quantity" in p) ? "system.quantity" :
    ("qty" in p)      ? "system.qty" :
    ("amount" in p)   ? "system.amount" :
    ("count" in p)    ? "system.count" :
    ("value" in p)    ? "system.value" :
    ("rounds" in p)   ? "system.rounds" :
    ("bullets" in p)  ? "system.bullets" :
    ("charges" in p)  ? "system.charges" :
    ("uses" in p)     ? "system.uses" :
    ("ammo" in p)     ? "system.ammo" : null;
  if (field){ await it.update({[field]: v}); return; }
  if (v<=0) await it.parent?.deleteEmbeddedDocuments("Item", [it.id]);
}

function resolveQtyField(sys={}) {
  if ("quantity" in sys) return "quantity";
  if ("qty"      in sys) return "qty";
  if ("amount"   in sys) return "amount";
  if ("count"    in sys) return "count";
  if ("value"    in sys) return "value";
  if ("rounds"   in sys) return "rounds";
  if ("bullets"  in sys) return "bullets";
  if ("charges"  in sys) return "charges";
  if ("uses"     in sys) return "uses";
  if ("ammo"     in sys) return "ammo";
  return null;
}

/** Number of constituent units sold for one market-price package on a source Item. */
function marketPackageSizeFromData(docOrData){
  const sys = docOrData?.system ?? {};
  const field = resolveQtyField(sys);
  if (!field) return 1;
  return Math.max(1, Number(sys[field] ?? 1) || 1);
}
function bodegaMarketFlags(docOrData){
  return docOrData?.flags?.[MODULE_ID]?.marketPackage || {};
}
function sourceUuidForMarketPackage(doc){
  return doc?._stats?.compendiumSource
    || doc?.flags?.core?.sourceId
    || doc?._stats?.duplicateSource
    || bodegaMarketFlags(doc)?.sourceUuid
    || null;
}
function inferAmmoMarketPackageSize(doc){
  if (String(doc?.type || '').toLowerCase() !== 'ammo') return 1;
  const variety = String(doc?.system?.variety || '').toLowerCase();
  if (variety === 'grenade' || variety === 'rocket') return 1;
  if (variety === 'battery') {
    const html = String(doc?.system?.description?.value || '');
    const match = html.match(/contains\s+(\d+)\s+(?:shots?|rounds?|charges?)/i);
    return Math.max(1, Number(match?.[1] || 8));
  }
  return 10;
}
async function resolveMarketPackageInfo(doc){
  const flags = bodegaMarketFlags(doc);
  const flaggedSize = Number(flags.size || 0) || 0;
  let packageSize = flaggedSize;
  let marketPrice = Math.max(0, Number(flags.price || 0) || 0);
  const sourceUuid = sourceUuidForMarketPackage(doc);
  let verified = flaggedSize > 0;
  let provenance = verified ? "bodega-metadata" : "unknown";

  if (sourceUuid){
    try {
      const source = await fromUuid(sourceUuid);
      if (source){
        packageSize = marketPackageSizeFromData(source);
        marketPrice = getItemMarketValue(source);
        verified = true;
        provenance = "source";
      }
    } catch {}
  }

  if (!packageSize){
    const itemType = String(doc?.type || '').toLowerCase();
    const qtyField = resolveQtyField(doc?.system ?? {});
    if (itemType === 'ammo'){
      // CPR ammo has stable market-package conventions even when imported source metadata is missing.
      packageSize = inferAmmoMarketPackageSize(doc);
      verified = true;
      provenance = "cpr-ammo-fallback";
    } else if (!qtyField){
      // A document with no stack/amount field is inherently one atomic market item.
      packageSize = 1;
      verified = true;
      provenance = "atomic-item";
    } else {
      // Never interpret an Actor's current remaining stack as its original market package.
      // It could be 3 cigarettes left from a 20-pack, 2 doses from a larger drug pack, etc.
      packageSize = 1;
      verified = false;
      provenance = "unverified-stack";
    }
  }

  if (!marketPrice) marketPrice = getItemMarketValue(doc);
  return {
    packageSize:Math.max(1, packageSize|0),
    marketPrice:Math.max(0, marketPrice|0),
    sourceUuid,
    verified:!!verified,
    provenance,
    requiresReview:!verified
  };
}
function proportionalBuybackTotal(marketPrice, percent, quantity, packageSize=1){
  const numerator = Math.max(0, Number(marketPrice || 0)) * Math.max(0, Number(percent || 0)) * Math.max(0, Number(quantity || 0));
  const denominator = 100 * Math.max(1, Number(packageSize || 1));
  return Math.max(0, Math.floor(numerator / denominator));
}
function proportionalUnitRetail(marketPrice, packageSize=1){
  if (Math.max(0, Number(marketPrice || 0)) <= 0) return 0;
  return Math.max(1, Math.floor(Number(marketPrice || 0) / Math.max(1, Number(packageSize || 1))));
}
function stampMarketPackageFlags(data, {size=1, price=0, sourceUuid=null}={}){
  data.flags ||= {};
  data.flags[MODULE_ID] ||= {};
  data.flags[MODULE_ID].marketPackage = {
    size:Math.max(1, Number(size || 1)|0),
    price:Math.max(0, Number(price || 0)|0),
    sourceUuid:sourceUuid || null
  };
  return data;
}

/** Give item from shop with a specific quantity, using stack field when available. */
async function giveFromShopQty(actor, shopItem, qty=1){
  qty = Math.max(1, Number(qty|0));
  let doc = shopItem.uuid ? await byUUID(shopItem.uuid) : null;
  let data;

  if (doc) {
    data = doc.toObject();
  } else if (shopItem.raw) {
    data = foundry.utils.duplicate(shopItem.raw);
  } else {
    ui.notifications.warn("Предмет больше недоступен для продажи.");
    return null;
  }

  delete data._id;

  const sys = data.system ?? {};
  const field = resolveQtyField(sys);
  const sourcePackageSize = Math.max(1, Number(shopItem.packageSize || marketPackageSizeFromData(data)) || 1);
  const sourceMarketPrice = Math.max(0, Number(shopItem.marketPackagePrice ?? getItemMarketValue(doc || {system:sys})) || 0);
  stampMarketPackageFlags(data, {size:sourcePackageSize, price:sourceMarketPrice, sourceUuid:shopItem.uuid || doc?.uuid || null});

  if (field) {
    // Bodega QTY is packages/items. A source entry with amount 10 is one 10-round package,
    // so buying 2 must deliver 20 constituent units rather than 11.
    sys[field] = sourcePackageSize * qty;
    // Loose trade-ins can carry a per-unit market price distinct from the original package.
    if ((shopItem.tradeIn || shopItem.stockClass === "tradein") && shopItem.marketPackagePrice != null){
      if (sys.price?.market != null) sys.price.market = Math.max(0, Number(shopItem.marketPackagePrice|0));
      else if (typeof sys.price === "number") sys.price = Math.max(0, Number(shopItem.marketPackagePrice|0));
    }
    data.system = sys;
    return actor.createEmbeddedDocuments("Item", [data]);
  } else {
    // No stackable field → create N copies. Stamp each copy so a later buyback retains source pricing metadata.
    const payload = Array.from({length: qty}, () => stampMarketPackageFlags(foundry.utils.duplicate(data), {size:1, price:sourceMarketPrice, sourceUuid:shopItem.uuid || doc?.uuid || null}));
    return actor.createEmbeddedDocuments("Item", payload);
  }
}

const STORE_NS = MODULE_ID;
const STORE_KEY = "bodegaDb";
const PLAYER_VENDOR_INTERACTION_KEY = "bodegaPlayerVendorInteraction";
const FLAG_VER  = 7; // v7 adds Actor-wide and specific-Token vendor HUD bindings

// -------------------- tiny utils --------------------
const esc = (s="") => String(s)
  .replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;")
  .replaceAll("'","&#039;");

// CSS selectors cannot safely target an unescaped ID that begins with a digit.
// Prefix every dialog body ID so randomID() can never create the old player-only skin failure.
function makeUiId(kind="ui"){
  return `bodega-${kind}-${randomID()}`;
}

// Foundry may keep a closing Dialog in the DOM briefly for its close animation.
// Keep the scoped skin alive through that animation so large source avatars never flash at natural size.
function cleanupDialogVisuals(style, observer=null){
  observer?.disconnect?.();
  window.setTimeout(() => style?.remove?.(), 750);
}

// ---------- Ledger helpers ----------
async function resolveLedger(shop){
  if (!shop?.ledgerUuid) return null;
  try { return await fromUuid(shop.ledgerUuid); } catch { return null; }
}
async function adjustLedgerWealth(ledger, delta, reason, {preventNegative=false}={}){
  if (!ledger) return {ok:false, value:0};
  const before = Number(ledger.system?.wealth?.value ?? 0);
  const change = Number(delta|0);
  if (preventNegative && before + change < 0) {
    return {ok:false, value:before, message:"У продавца недостаточно денег для скупки."};
  }
  await adjustWealth(ledger, change, reason);
  return {ok:true, value:Number(ledger.system?.wealth?.value ?? (before + change))};
}
// Merge/push item into ledger inventory
async function addToLedger(ledger, rawOrDoc, qty=1){
  if (!ledger) return;
  let data;
  if (rawOrDoc?.toObject){
    data = rawOrDoc.toObject(); delete data._id;
  } else {
    data = foundry.utils.duplicate(rawOrDoc);
    delete data._id;
  }
  const sys = data.system ?? {};
  const f = resolveQtyField(sys);
  if (f){ sys[f] = Math.max(0, Number(qty|0)); data.system = sys; return ledger.createEmbeddedDocuments("Item", [data]); }
  const payload = Array.from({length: qty}, () => foundry.utils.duplicate(data));
  return ledger.createEmbeddedDocuments("Item", payload);
}

// ---------- chat approval helpers ----------
function bodegaNonce(){ return `${Date.now()}-${randomID()}`; }
function b2a(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
function a2b(s){ return JSON.parse(decodeURIComponent(escape(atob(s)))); }
window.__bodegaDone ||= new Set();

/** Serialize all cash/stock transactions per shop so buys and buybacks cannot race each other. */
const bodegaShopQueues = new Map();
async function withBodegaShopQueue(shopId, task){
  const key = String(shopId ?? "__unknown__");
  const previous = bodegaShopQueues.get(key) || Promise.resolve();
  const current = previous.catch(()=>{}).then(task);
  bodegaShopQueues.set(key, current);
  try { return await current; }
  finally { if (bodegaShopQueues.get(key) === current) bodegaShopQueues.delete(key); }
}
async function ncm_gmProcessBuyback(payload, reviewOverride=null){
  return withBodegaShopQueue(payload?.shopId, () => gmProcessBuybackUnlocked(payload, reviewOverride));
}

/** Active-GM review flow for an unverified stacked Item. The player never supplies the
 * trusted package override; only the GM dialog can create it locally. */
async function openGMReviewBuyback(payload, localResultCallback=null){
  const sendResult = (result) => {
    if (typeof localResultCallback === "function") {
      try { localResultCallback(result); } catch (error) { console.error("Bodega | Local GM review callback failed", error); }
      return;
    }
    marketSocket.emit(SOCKET, {
      op:result?.ok ? "buyback-done" : "buyback-failed",
      id:payload?.shopId,
      nonce:payload?.nonce,
      userId:payload?.userId || null,
      message:result?.message || (result?.ok ? "Скупка одобрена мастером и завершена." : "Мастер не одобрил скупку.")
    });
  };

  if (!game.user?.isGM) {
    const result = {ok:false, message:"Проверка скупки доступна только мастеру."};
    sendResult(result);
    return result;
  }

  window.__bodegaReviewOpen ||= new Set();
  if (payload?.nonce && window.__bodegaReviewOpen.has(payload.nonce)) return {ok:false, duplicate:true};
  if (payload?.nonce) window.__bodegaReviewOpen.add(payload.nonce);

  const db = await loadAll();
  const shop = db.shops?.[payload?.shopId];
  const seller = payload?.sellerUuid ? await fromUuid(payload.sellerUuid) : null;
  let item = seller?.items?.get?.(payload?.itemId) || null;
  if (!item && seller && payload?.itemName) item = seller.items.find(i => i.name === payload.itemName);

  const failEarly = (message) => {
    if (payload?.nonce) window.__bodegaReviewOpen.delete(payload.nonce);
    const result = {ok:false, message};
    sendResult(result);
    ui.notifications.warn(message);
    return result;
  };
  if (!shop) return failEarly("Магазин для проверки не найден.");
  if (!seller) return failEarly("Продавец для проверки не найден.");
  if (!item) return failEarly("У персонажа больше нет этого предмета.");

  try { requireCustomer(seller,payload.userId,shop); } catch(error) { return failEarly(error.message); }
  const kind = getItemKind(item);
  const bb = shop.buyback?.[kind] || {on:false, pct:0};
  if (!bb.on) return failEarly("Сейчас магазин не покупает эту категорию предметов.");
  if (!acceptsBuyback(shop,item)) return failEarly("Этот товар не соответствует специализации магазина.");
  if (lifestyleItem(item) || intrinsicAttack(item) || item.system?.equipped === "equipped" || seller.system?.installedItems?.list?.includes(item.id) || seller.items.some(parent=>parent.system?.installedItems?.list?.includes(item.id))) return failEarly("Нельзя продать надетый, установленный или служебный предмет.");
  if (item.system?.installedItems?.list?.length) return failEarly("Перед продажей снимите улучшения с предмета. Передача товарищу поддерживает целый комплект.");
  if (saleBlocked(item,seller)) return failEarly("Этот предмет защищён от продажи: снимите экипировку или улучшения; образ жизни и включённые порции не продаются.");
  const rank = getFixerRank(seller);
  const cfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const finalPct = applyFixerBonusToSell(bb.pct|0, rank, cfg);
  const have = readStackQty(item);
  const qty = Math.max(1, Math.min(have, Number(payload?.qty|0) || 1));
  const itemMarket = Math.max(0, getItemMarketValue(item)|0);
  const ledger = await resolveLedger(shop);
  const vendorCash = ledger ? Math.max(0, Number(ledger.system?.wealth?.value|0)) : Math.max(0, Number(shop.purse|0));
  const bodyId = makeUiId("buyback-review");
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style");
  style.textContent = makeAdminCSS(accent, bodyId);
  let finished = false;

  const content = `
  <div id="${bodyId}">
    <div class="wrap buyback-review-wrap">
      <div class="title">Проверка скупки мастером</div>

      <div class="card review-summary">
        <div class="review-summary-grid">
          <div class="review-stat"><span>Продавец</span><b>${esc(seller.name)}</b></div>
          <div class="review-stat"><span>Предмет</span><b>${esc(item.name)}</b></div>
          <div class="review-stat"><span>Количество у персонажа</span><b>${have}</b></div>
          <div class="review-stat"><span>Предложено к продаже</span><b>${qty}</b></div>
          <div class="review-stat"><span>Процент выкупа</span><b>${finalPct}%</b></div>
          <div class="review-stat"><span>Деньги продавца</span><b>${vendorCash} эб</b></div>
        </div>
      </div>

      <div class="card review-package-card">
        <div class="review-help">
          Не найден исходный предмет для этой стопки. Укажите <b>исходную рыночную упаковку</b> ниже. Текущее количество у персонажа не считается размером исходной упаковки.
        </div>

        <div class="review-fields">
          <label class="review-field">
            <span>Цена упаковки (эб)</span>
            <input data-review-price type="number" min="0" step="1" value="${itemMarket}">
          </label>
          <label class="review-field">
            <span>Единиц в упаковке <em class="review-required">Обязательно</em></span>
            <input data-review-size type="number" min="1" step="1" placeholder="например: 1, 10, 20" aria-required="true">
          </label>
        </div>

        <label class="review-remember">
          <input data-review-remember type="checkbox" checked>
          <span>Сохранить параметры упаковки для оставшегося количества у персонажа</span>
        </label>

        <div class="card review-preview" data-review-preview><b>Требуется:</b> укажите исходное число единиц в упаковке для расчёта цены.</div>

        <div class="review-actions">
          <button type="button" class="btn review-approve" data-review-approve aria-disabled="true"><i class="fas fa-check"></i> Одобрить скупку</button>
        </div>
      </div>
    </div>
  </div>`;

  const dlg = new Dialog({
    title:`Магазин — проверка ${item.name}`,
    content,
    buttons:{ cancel:{label:"Отменить проверку"} },
    render:(html)=>{
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app?.classList.add(`dialog-host-${bodyId}`);
      forceFooterButtons(app, accent);
      const root = html[0].querySelector(`#${bodyId}`);
      const priceInput = root?.querySelector("[data-review-price]");
      const sizeInput = root?.querySelector("[data-review-size]");
      const rememberInput = root?.querySelector("[data-review-remember]");
      const preview = root?.querySelector("[data-review-preview]");
      const approve = root?.querySelector("[data-review-approve]");

      const reviewState = () => {
        const priceRaw = Number(priceInput?.value || 0);
        const price = Math.max(0, Math.floor(Number.isFinite(priceRaw) ? priceRaw : 0));
        const sizeRaw = Number(sizeInput?.value || 0);
        const size = Math.floor(sizeRaw);
        const validSize = Number.isFinite(sizeRaw) && sizeRaw >= 1 && sizeRaw === size;
        const total = validSize ? proportionalBuybackTotal(price, finalPct, qty, size) : 0;
        const cashOkay = total <= vendorCash;
        return {price, size, validSize, total, cashOkay};
      };

      const refresh = () => {
        const {price, size, validSize, total, cashOkay} = reviewState();
        sizeInput?.classList.toggle("review-invalid", !validSize && !!String(sizeInput?.value || "").trim());
        if (preview) {
          if (!validSize) preview.innerHTML = "<b>Требуется:</b> укажите целое число единиц в упаковке: <b>не менее 1</b>. Например: 1 для отдельного предмета, 10 для коробки из десяти патронов, 20 для пачки сигарет.";
          else if (total <= 0) preview.innerHTML = `Проверенная упаковка: <b>${size}</b> ед.${size===1?'':'s'} за <b>${price}</b> эб. Стоимость предложенного количества: <b>меньше 1 эб</b> по цене ${finalPct}%.`;
          else if (!cashOkay) preview.innerHTML = `Цена выкупа: <b>${total} эб</b>, но у продавца только <b>${vendorCash} эб</b>.`;
          else preview.innerHTML = `Проверенная упаковка: <b>${size}</b> ед.${size===1?'':'s'} за <b>${price}</b> эб → выплата продавцу <b>${total} эб</b> за ${qty} ед.${qty===1?'':'s'} по цене ${finalPct}%.`;
        }
        if (approve) {
          const ready = validSize && total > 0 && cashOkay;
          approve.setAttribute("aria-disabled", ready ? "false" : "true");
          approve.classList.toggle("review-ready", ready);
          approve.title = ready ? "Подтвердить проверенную скупку" : "Показать недостающие сведения";
        }
      };
      priceInput?.addEventListener("input", refresh);
      sizeInput?.addEventListener("input", refresh);
      refresh();

      approve?.addEventListener("click", async () => {
        const {price:marketPrice, size:packageSize, validSize, total, cashOkay} = reviewState();
        if (!validSize) {
          sizeInput?.classList.add("review-invalid");
          sizeInput?.focus();
          return ui.notifications.warn("Перед подтверждением укажите исходное число единиц в упаковке.");
        }
        if (total <= 0) {
          priceInput?.focus();
          return ui.notifications.warn("Цена скупки меньше 1 эб. Проверьте цену и размер упаковки.");
        }
        if (!cashOkay) return ui.notifications.warn(`У продавца только ${vendorCash} эб; этого недостаточно для выплаты ${total} эб по проверенной оценке.`);
        approve.disabled = true;
        approve.innerHTML = "<i class=\"fas fa-spinner fa-spin\"></i> Обработка";
        const result = await gmProcessBuyback(payload, {
          approved:true, packageSize, marketPrice, remember:!!rememberInput?.checked
        });
        finished = true;
        if (payload?.nonce) window.__bodegaReviewOpen.delete(payload.nonce);
        sendResult(result);
        if (result?.ok) ui.notifications.info(`Подтверждено ${item.name} скупка на сумму ${result.total|0} эб.`);
        else ui.notifications.warn(result?.message || "Не удалось завершить проверенную скупку.");
        dlg.close();
      });
    },
    close:()=>{
      cleanupDialogVisuals(style);
      if (payload?.nonce) window.__bodegaReviewOpen.delete(payload.nonce);
      if (!finished) sendResult({ok:false, message:"Мастер отменил проверку. Продажи и оплаты не было."});
    }
  }, {
    width:720,
    resizable:true
  });
  dlg.render(true);
  return {ok:true, pending:true};
}

const bodegaPurchaseResults = new Map();
function rememberPurchaseResult(nonce, result){
  if (!nonce) return result;
  bodegaPurchaseResults.set(nonce, result);
  if (bodegaPurchaseResults.size > 300){
    const first = bodegaPurchaseResults.keys().next().value;
    if (first) bodegaPurchaseResults.delete(first);
  }
  return result;
}
async function ncm_gmProcessPurchase(payload){
  return withBodegaShopQueue(payload?.shopId, () => gmProcessPurchaseUnlocked(payload));
}

/** GM-authoritative purchase. Stock, buyer funds, vendor purse, and item delivery commit in one serialized shop transaction. */
async function gmProcessPurchaseUnlocked(payload){
  const fail = (message) => rememberPurchaseResult(payload?.nonce, {ok:false, message});
  if (!payload?.nonce) return {ok:false, message:"Получен некорректный запрос покупки."};
  if (bodegaPurchaseResults.has(payload.nonce)) return bodegaPurchaseResults.get(payload.nonce);
  if (!game.user?.isGM) return fail("Покупку обрабатывает только мастер.");

  const db = await loadAll();
  const shop = db.shops?.[payload.shopId];
  if (!shop) return fail("Магазин не найден.");
  const buyer = await fromUuid(payload.buyerUuid);
  if (!buyer) return fail("Покупатель не найден.");
  requireCustomer(buyer,payload.userId,shop);

  const wantedKey = String(payload.itemKey || "").toLowerCase();
  const wantedClass = String(payload.stockClass || "");
  const wantedPrice = Math.max(0, Number(payload.price|0));
  const sourceIndex = Number(payload.index);
  let item = Number.isInteger(sourceIndex) ? shop.items?.[sourceIndex] : null;
  const matches = candidate => candidate &&
    (!wantedKey || dynamicItemKey(candidate) === wantedKey) &&
    (!wantedClass || String(candidate.stockClass || (candidate.dynamicManaged ? "dynamic" : "static")) === wantedClass) &&
    (!Number.isFinite(wantedPrice) || Number(candidate.price|0) === wantedPrice);
  if (!matches(item)) item = (shop.items || []).find(matches) || null;
  if (!item) return fail("Товар изменился или закончился. Откройте магазин заново.");

  const rank = getFixerRank(buyer);
  const fixer = rank > 0;
  if (item.fixerOnly){
    if (!fixer) return fail(`Только фиксёры могут покупать ${item.name}.`);
    const minR = (item.fixerMinRank==null || item.fixerMinRank==="") ? null : Number(item.fixerMinRank|0);
    if (minR != null && rank < minR) return fail(`Требуется ранг «Деловой хватки» ${minR}+.`);
  }

  const available = item.infinite ? Number.POSITIVE_INFINITY : Math.max(0, Number(item.qty|0));
  if (!item.infinite && available <= 0) return fail(`${item.name} закончился.`);
  const requested = Math.max(1, Number(payload.qty|0) || 1);
  const qty = item.infinite ? requested : Math.min(requested, available);
  if (qty <= 0) return fail(`${item.name} закончился.`);

  const discCfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const pricing = bodegaBuyPricing(item.price|0, shop, buyer, fixer, rank, discCfg, !!item.fixerOnly);
  const each = pricing.price;
  const total = Math.max(0, each * qty);
  const funds = Math.max(0, Number(buyer.system?.wealth?.value ?? 0));
  if (total > funds) return fail(`${buyer.name} не хватает денег на ${item.name} ×${qty} (${total} эб).</div>`);

  const ledger = await resolveLedger(shop);
  const beforeQty = item.infinite ? null : Math.max(0, Number(item.qty|0));
  const beforePurse = Math.max(0, Number(shop.purse|0));
  let buyerDebited = false;
  let ledgerCredited = false;
  let grantedDocs = [];
  try {
    if (total > 0){
      await adjustWealth(buyer, -total, `Магазин: ${item.name} ×${qty}`);
      buyerDebited = true;
    }

    const granted = await giveFromShopQty(buyer, item, qty);
    grantedDocs = Array.isArray(granted) ? granted.filter(Boolean) : (granted ? [granted] : []);
    if (!grantedDocs.length) throw new Error("Не удалось передать предмет.");

    if (!item.infinite) item.qty = Math.max(0, beforeQty - qty);

    if (ledger){
      await adjustLedgerWealth(ledger, +total, `Продажа магазина: ${item.name} ×${qty}`);
      ledgerCredited = total > 0;
    } else {
      shop.purse = Math.max(0, beforePurse + total);
    }

    await saveAll(db);
    const purseNow = ledger ? Math.max(0, Number(ledger.system?.wealth?.value|0)) : Math.max(0, Number(shop.purse|0));
    const stockClass = String(item.stockClass || (item.dynamicManaged ? "dynamic" : "static"));
    const itemKey = dynamicItemKey(item);
    const qtyRemaining = item.infinite ? null : Math.max(0, Number(item.qty|0));

    if (!item.infinite){
      updateOpenShopStock(shop.id, itemKey, stockClass, qtyRemaining);
      marketSocket.emit(SOCKET, {op:"stock-ui", id:shop.id, itemKey, stockClass, qty:qtyRemaining});
    }
    document.querySelectorAll(`.wrap[data-shop="${shop.id}"] .purse-val`).forEach(el => el.textContent = String(purseNow));
    marketSocket.emit(SOCKET, {op:"purse-ui", id:shop.id, purse:purseNow});
    marketSocket.emit(SOCKET, {op:"purse-ack", id:shop.id, purse:purseNow});

    try {
      await ChatMessage.create({
        content:`<div class="sl-chat-card"><h3>STREETLIFE / ЧЕК</h3><b>Магазин</b>: продано <i>${esc(item.name)}</i> ×${qty} получателю <b>${esc(buyer.name)}</b> (${total} эб).</div>`,
        speaker:ChatMessage.getSpeaker({alias:"Магазин"})
      });
    } catch (chatError) { console.warn("Bodega | Purchase succeeded but receipt chat failed", chatError); }

    return rememberPurchaseResult(payload.nonce, {ok:true, message:"Покупка завершена.", itemName:item.name, itemKey, stockClass, qtyPurchased:qty, qtyRemaining, total, purse:purseNow});
  } catch (error) {
    console.error("Bodega | Purchase transaction failed", error);
    try {
      if (grantedDocs.length) await buyer.deleteEmbeddedDocuments("Item", grantedDocs.map(doc => doc.id).filter(Boolean));
    } catch (rollbackError) { console.error("Bodega | Purchase item rollback failed", rollbackError); }
    try { if (buyerDebited && total > 0) await adjustWealth(buyer, +total, `Возврат магазина: ${item.name} ×${qty}`); }
    catch (rollbackError) { console.error("Bodega | Purchase wealth rollback failed", rollbackError); }
    try { if (ledgerCredited && total > 0) await adjustLedgerWealth(ledger, -total, `Отмена операции магазина: ${item.name} ×${qty}`, {preventNegative:true}); }
    catch (rollbackError) { console.error("Bodega | Purchase ledger rollback failed", rollbackError); }
    if (!item.infinite && beforeQty != null) item.qty = beforeQty;
    shop.purse = beforePurse;
    return fail("Ошибка покупки. Выполняется возврат; если проблема повторяется, проверьте консоль мастера.");
  }
}

/** GM-only: process one sell approval payload inside the per-shop queue. */
async function gmProcessBuybackUnlocked(payload, reviewOverride=null){
  const fail = (message, level="warn") => {
    ui.notifications?.[level]?.(message);
    return {ok:false, message};
  };

  if (!payload?.nonce) return fail("Получен некорректный запрос скупки.", "error");
  if (window.__bodegaDone.has(payload.nonce)) return {ok:true, duplicate:true};
  if (!game.user?.isGM) return fail("Одобрить скупку может только мастер.");

  const db = await loadAll();
  const shop = db.shops?.[payload.shopId];
  if (!shop) return fail("Магазин не найден.", "error");

  const seller = await fromUuid(payload.sellerUuid);
  if (!seller) return fail("Продавец не найден.", "error");
  requireCustomer(seller,payload.userId,shop);

  let item = seller.items.get(payload.itemId);
  if (!item && payload.itemName) {
    item = seller.items.find(i => i.name === payload.itemName && getItemMarketValue(i) === (payload.baseVal|0));
  }
  if (!item) return fail("У продавца не найден предмет.", "error");

  if (!acceptsBuyback(shop,item)) return fail("Этот товар не соответствует специализации магазина.");
  if (lifestyleItem(item) || intrinsicAttack(item) || item.system?.equipped === "equipped" || seller.system?.installedItems?.list?.includes(item.id) || seller.items.some(parent=>parent.system?.installedItems?.list?.includes(item.id))) return fail("Нельзя продать надетый, установленный или служебный предмет.");
  if (item.system?.installedItems?.list?.length) return fail("Перед продажей снимите улучшения с предмета. Передача товарищу поддерживает целый комплект.");
  if (saleBlocked(item,seller)) return fail("Этот предмет защищён от продажи: снимите экипировку или улучшения; образ жизни и включённые порции не продаются.");
  const rank = getFixerRank(seller);
  const kind = getItemKind(item);
  const cfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const bb = shop.buyback?.[kind] || {on:false, pct:0};
  if (!bb.on) return fail("Продавец сейчас не покупает эту категорию.");

  let packageInfo = await resolveMarketPackageInfo(item);
  if (!packageInfo.verified && reviewOverride?.approved === true) {
    const reviewedSize = Math.max(1, Number(reviewOverride.packageSize || 0) | 0);
    const reviewedPrice = Math.max(0, Number(reviewOverride.marketPrice ?? getItemMarketValue(item)) | 0);
    if (!reviewedSize) return fail("Мастер не указал допустимый размер упаковки.");
    packageInfo = {
      ...packageInfo,
      packageSize:reviewedSize,
      marketPrice:reviewedPrice,
      verified:true,
      provenance:"gm-review",
      requiresReview:false
    };
    if (reviewOverride.remember !== false) {
      try {
        await item.update({[`flags.${MODULE_ID}.marketPackage`]: {
          size:reviewedSize,
          price:reviewedPrice,
          sourceUuid:sourceUuidForMarketPackage(item) || null,
          reviewedBy:game.user?.id || null,
          reviewedAt:Date.now()
        }});
      } catch (error) {
        console.warn("Bodega | Could not remember GM-reviewed market package metadata", error);
      }
    }
  }
  if (!packageInfo.verified) {
    return fail("Не удалось определить исходный размер упаковки. Нужна проверка мастера.");
  }
  const baseValue = packageInfo.marketPrice;
  const packageSize = packageInfo.packageSize;
  const finalPct = applyFixerBonusToSell(bb.pct|0, rank, cfg);
  const have = readStackQty(item);
  const qty = Math.max(1, Math.min(have, Number(payload.qty|0) || 1));
  const total = proportionalBuybackTotal(baseValue, finalPct, qty, packageSize);
  const purse = Math.max(0, Number(shop.purse|0));
  const ledger = await resolveLedger(shop);
  const vendorCash = ledger ? Number(ledger.system?.wealth?.value|0) : purse;

  if (total <= 0) return fail(`Цена пока меньше 1 эб. Продайте больше: ${packageSize > 1 ? `упаковка (${packageSize} ед.)` : 'item'} за одну сделку.`);
  if (total > vendorCash) return fail("У продавца недостаточно денег для скупки.");

  const raw = item.toObject();
  delete raw._id;

  let ledgerDebited = false;
  let sellerCredited = false;
  let sellerItemChanged = false;
  try {
    // Debit vendor cash first while the per-shop queue is held. This makes the no-negative
    // guarantee real even when several players hit Sell at nearly the same time.
    if (ledger) {
      const debit = await adjustLedgerWealth(ledger, -total, `Скупка магазина: ${item.name} ×${qty}`, {preventNegative:true});
      if (!debit?.ok) return fail(debit?.message || "У продавца недостаточно денег для скупки.");
      ledgerDebited = true;
    } else {
      shop.purse = Math.max(0, purse - total);
    }

    if (have > qty) await writeStackQty(item, have - qty);
    else await seller.deleteEmbeddedDocuments("Item", [item.id]);
    sellerItemChanged = true;

    await adjustWealth(seller, +total, `Скупка магазина: ${item.name} ×${qty}`);
    sellerCredited = true;

    const packDoc = await findItemAnywhere(item.name);
    const looseUnitPrice = packageSize > 1 ? proportionalUnitRetail(baseValue, packageSize) : Math.max(0, baseValue|0);
    const entry = {
      uuid:null,
      raw,
      name:item.name,
      img:item.img,
      price:looseUnitPrice,
      packageSize:1,
      marketPackagePrice:looseUnitPrice,
      qty,
      infinite:false,
      fixerOnly:false,
      fixerMinRank:null,
      autoFixerLocked:false,
      dynamicManaged:false,
      tradeIn:true,
      stockClass:"tradein"
    };
    syncAutoFixerLock(entry, db.defaults, {newItem:true});
    const hit = null; // Sold custom items retain separate state and effects.
    if (hit) hit.qty = (hit.qty|0) + qty;
    else {
      shop.items ||= [];
      shop.items.push(entry);
    }

    if (ledger) await addToLedger(ledger, raw, qty);
    await saveAll(db);
    const purseNow = ledger
      ? Math.max(0, Number(ledger.system?.wealth?.value|0))
      : Math.max(0, Number(shop.purse|0));

    window.__bodegaDone.add(payload.nonce);
    document.querySelectorAll(`.wrap[data-shop="${payload.shopId}"] .purse-val`).forEach(el => el.textContent = String(purseNow));
    marketSocket.emit(SOCKET, {op:"purse-ui", id:payload.shopId, purse:purseNow});
    marketSocket.emit(SOCKET, {op:"purse-ack", id:payload.shopId, purse:purseNow});

    try {
      await ChatMessage.create({
        content:`<div class="sl-chat-card"><h3>STREETLIFE / ЧЕК</h3><b>Магазин</b>: куплено <i>${esc(item.name)}</i> ×${qty}${packageSize > 1 ? ` ед.${qty===1?'':'s'} (${packageSize}/рыночная упаковка)` : ''} у <b>${esc(seller.name)}</b> за ${total} эб.</div>`,
        speaker:ChatMessage.getSpeaker({alias:"Магазин"})
      });
    } catch (chatError) {
      console.warn("Bodega | Buyback succeeded but receipt chat failed", chatError);
    }
    return {ok:true, total, qty, itemName:item.name, purse:purseNow};
  } catch (error) {
    console.error("Bodega | Buyback transaction failed", error);
    // Best-effort rollback. The ledger refund is itself never a negative operation.
    try { if (sellerCredited) await adjustWealth(seller, -total, `Отмена операции магазина: ${item.name} ×${qty}`); } catch (rollbackError) { console.error("Bodega | Seller wealth rollback failed", rollbackError); }
    try {
      if (sellerItemChanged) {
        const stillThere = seller.items.get(payload.itemId) || seller.items.find(i => i.name === payload.itemName && getItemMarketValue(i) === baseValue);
        if (stillThere) await writeStackQty(stillThere, have);
        else await seller.createEmbeddedDocuments("Item", [foundry.utils.duplicate(raw)]);
      }
    } catch (rollbackError) { console.error("Bodega | Seller item rollback failed", rollbackError); }
    try { if (ledgerDebited) await adjustLedgerWealth(ledger, +total, `Отмена операции магазина: ${item.name} ×${qty}`); } catch (rollbackError) { console.error("Bodega | Ledger rollback failed", rollbackError); }
    return fail("Ошибка скупки. Проверьте консоль мастера.", "error");
  }
}

// -------------------- storage --------------------
function defaultDynamicSettings(){
  return {
    enabled:false,
    stockSource:"table",
    stockTable:"",
    stockPack:"",
    stockPool:[],
    minItems:5,
    maxItems:10,
    qtyMin:1,
    qtyMax:6,
    npcTraffic:true,
    trafficMin:2,
    trafficMax:3,
    restockEnabled:true,
    restockHour:6,
    restockMinute:0,
    restockMode:"rotate",
    initializedAt:0,
    trafficDayKey:"",
    trafficSchedule:[],
    lastTraffic:0,
    lastRestock:0,
    nextRestock:0,
    lastProcessed:0
  };
}
function normalizeDynamicPool(pool){
  return Array.isArray(pool) ? pool.filter(Boolean).map(entry => ({
    uuid:String(entry.uuid || ""),
    name:String(entry.name || "Неизвестный предмет"),
    img:String(entry.img || "icons/svg/item-bag.svg")
  })) : [];
}
function normalizeDynamicSettings(value){
  const base = defaultDynamicSettings();
  const dynamic = foundry.utils.mergeObject(base, value || {}, {inplace:false});
  dynamic.stockPool = normalizeDynamicPool(dynamic.stockPool);
  dynamic.stockSource = ["table","pack","pool"].includes(dynamic.stockSource) ? dynamic.stockSource : "table";
  dynamic.restockMode = ["refill","rotate"].includes(dynamic.restockMode) ? dynamic.restockMode : "rotate";
  dynamic.minItems = Math.max(1, Math.min(50, Number(dynamic.minItems|0) || 5));
  dynamic.maxItems = Math.max(dynamic.minItems, Math.min(50, Number(dynamic.maxItems|0) || dynamic.minItems));
  dynamic.qtyMin = Math.max(0, Math.min(999, Number(dynamic.qtyMin|0)));
  dynamic.qtyMax = Math.max(dynamic.qtyMin, Math.min(999, Number(dynamic.qtyMax|0) || dynamic.qtyMin));
  dynamic.trafficMin = Math.max(0, Math.min(12, Number(dynamic.trafficMin|0)));
  dynamic.trafficMax = Math.max(dynamic.trafficMin, Math.min(12, Number(dynamic.trafficMax|0) || dynamic.trafficMin));
  dynamic.restockHour = Math.max(0, Number(dynamic.restockHour|0));
  dynamic.restockMinute = Math.max(0, Number(dynamic.restockMinute|0));
  dynamic.initializedAt = Number(dynamic.initializedAt || 0);
  dynamic.trafficDayKey = String(dynamic.trafficDayKey || "");
  dynamic.trafficSchedule = Array.isArray(dynamic.trafficSchedule) ? dynamic.trafficSchedule.map(entry => ({ts:Number(entry?.ts || 0), done:!!entry?.done})).filter(entry => entry.ts > 0) : [];
  dynamic.lastTraffic = Number(dynamic.lastTraffic || 0);
  dynamic.lastRestock = Number(dynamic.lastRestock || 0);
  dynamic.nextRestock = Number(dynamic.nextRestock || 0);
  dynamic.lastProcessed = Number(dynamic.lastProcessed || 0);
  return dynamic;
}
function normalizeCustomerDiscounts(value){
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value){
    if (!entry) continue;
    const actorUuid = String(entry.actorUuid || entry.uuid || "").trim();
    const actorId = String(entry.actorId || "").trim();
    if (!actorUuid && !actorId) continue;
    const key = actorUuid || actorId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      actorUuid,
      actorId,
      name:String(entry.name || "Постоянный клиент"),
      img:String(entry.img || "icons/svg/mystery-man.svg"),
      pct:Math.max(0, Math.min(100, Number(entry.pct|0) || 0))
    });
  }
  return out;
}
function getPreferredCustomerDiscount(shop, actor){
  if (!shop || !actor) return null;
  const actorUuid = String(actor.uuid || "");
  const actorId = String(actor.id || "");
  const hit = normalizeCustomerDiscounts(shop.customerDiscounts).find(entry =>
    (entry.actorUuid && entry.actorUuid === actorUuid) ||
    (entry.actorId && entry.actorId === actorId)
  );
  return hit || null;
}

// -------------------- Vendor Token / Actor HUD bindings --------------------
function normalizeVendorActors(value){
  if (!Array.isArray(value)) return [];
  const out = []; const seen = new Set();
  for (const entry of value){
    if (!entry) continue;
    const actorId = String(entry.actorId || "").trim();
    const actorUuid = String(entry.actorUuid || entry.uuid || "").trim();
    if (!actorId && !actorUuid) continue;
    const key = actorId || actorUuid;
    if (seen.has(key)) continue; seen.add(key);
    out.push({
      actorId, actorUuid,
      name:String(entry.name || "Персонаж продавца"),
      img:String(entry.img || "icons/svg/mystery-man.svg")
    });
  }
  return out;
}
function normalizeVendorTokens(value){
  if (!Array.isArray(value)) return [];
  const out = []; const seen = new Set();
  for (const entry of value){
    if (!entry) continue;
    const tokenUuid = String(entry.tokenUuid || entry.uuid || "").trim();
    const tokenId = String(entry.tokenId || "").trim();
    const boundSceneId = String(entry.sceneId || "").trim();
    if (!tokenUuid && !(boundSceneId && tokenId)) continue;
    const key = tokenUuid || `${boundSceneId}:${tokenId}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({
      tokenUuid, tokenId, sceneId:boundSceneId,
      actorId:String(entry.actorId || ""),
      actorUuid:String(entry.actorUuid || ""),
      name:String(entry.name || "Токен продавца"),
      sceneName:String(entry.sceneName || ""),
      img:String(entry.img || "icons/svg/mystery-man.svg")
    });
  }
  return out;
}
function vendorTokenDocument(tokenLike){
  if (!tokenLike) return null;
  if (tokenLike.documentName === "Token") return tokenLike;
  if (tokenLike.document?.documentName === "Token") return tokenLike.document;
  if (tokenLike.object?.documentName === "Token") return tokenLike.object.document;
  if (tokenLike.document?.object?.documentName === "Token") return tokenLike.document.object.document;
  return null;
}
function bodegaDragEventData(event){
  // Foundry v12 can emit different drag payload shapes depending on whether the
  // source is a Sidebar document, a sheet element, or a Canvas placeable. Use
  // Foundry's parser first, then retain the legacy text/plain fallback.
  try {
    const parsed = globalThis.TextEditor?.getDragEventData?.(event);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length) return parsed;
  } catch(_){}
  try {
    const raw = event?.dataTransfer?.getData?.("text/plain");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch(_) { return null; }
}
async function resolveSpecificVendorTokenDrop(data){
  if (!data) return null;

  // Prefer an explicit embedded Token UUID when Foundry gives us one. Some
  // module drag payloads use tokenUuid/documentUuid instead of uuid.
  const uuidCandidates = [data.tokenUuid, data.documentUuid, data.uuid, data.sourceUuid]
    .map(v => String(v || "").trim()).filter(Boolean);
  for (const uuid of uuidCandidates){
    if (!/(^|\.)Token\./.test(uuid) && !/^Scene\.[^.]+\.Token\./.test(uuid)) continue;
    try {
      const doc = await fromUuid(uuid);
      const token = vendorTokenDocument(doc);
      if (token) return token;
    } catch(_){}
  }

  // Accept explicit scene/token identifiers used by Canvas/placeable payloads.
  const tokenId = String(data.tokenId || data.tokenID || (data.type === "Token" ? (data.id || data._id) : "") || "").trim();
  const droppedSceneId = String(data.sceneId || data.sceneID || data.parentId || data.parentID || canvas?.scene?.id || sceneId || "").trim();
  if (tokenId && droppedSceneId){
    try {
      const doc = await fromUuid(`Scene.${droppedSceneId}.Token.${tokenId}`);
      const token = vendorTokenDocument(doc);
      if (token) return token;
    } catch(_){}
  }

  // Live Foundry v12 can report a Canvas Token drag as its represented Actor.
  // If exactly one Token is controlled, safely resolve that exact placed Token
  // when it represents the Actor in the drag payload. This avoids guessing when
  // multiple copies of the same NPC are selected.
  const controlled = Array.from(canvas?.tokens?.controlled || [])
    .map(t => vendorTokenDocument(t)).filter(Boolean);
  if (controlled.length === 1){
    const selected = controlled[0];
    const selectedActorId = String(selected.actorId || selected.actor?.id || "");
    const selectedActorUuid = String((selectedActorId ? game.actors?.get(selectedActorId)?.uuid : null) || selected.actor?.uuid || "");
    const payloadActorId = String(data.actorId || (data.type === "Actor" ? (data.id || data._id) : "") || "");
    const payloadActorUuid = String(data.actorUuid || (data.type === "Actor" ? data.uuid : "") || "");
    const actorMatches =
      (payloadActorId && selectedActorId && payloadActorId === selectedActorId) ||
      (payloadActorUuid && selectedActorUuid && payloadActorUuid === selectedActorUuid);
    if (actorMatches) return selected;
  }
  return null;
}
function vendorBindingShopAvailable(shop){
  if (!shop) return false;
  if (game.user?.isGM) return true;
  if (!shop.sceneOnly) return true;
  const currentSceneId = canvas?.scene?.id || sceneId || "";
  return !shop.sceneId || !currentSceneId || String(shop.sceneId) === String(currentSceneId);
}
function resolveBodegaForVendorTokenFromDb(tokenLike, db, {includeUnavailable=false}={}){
  const token = vendorTokenDocument(tokenLike);
  if (!token) return null;
  const shops = Object.values(db?.shops || {});
  const tokenUuid = String(token.uuid || "");
  const tokenId = String(token.id || token._id || "");
  const tokenSceneId = String(token.parent?.id || token.parent?._id || canvas?.scene?.id || "");

  // Exact Token bindings always win. This lets one appearance of an otherwise
  // Actor-bound vendor run a different booth/Bodega on a specific Scene.
  for (const shop of shops){
    if (!includeUnavailable && !vendorBindingShopAvailable(shop)) continue;
    const hit = normalizeVendorTokens(shop.vendorTokens).find(entry =>
      (entry.tokenUuid && tokenUuid && entry.tokenUuid === tokenUuid) ||
      (entry.sceneId && entry.tokenId && entry.sceneId === tokenSceneId && entry.tokenId === tokenId)
    );
    if (hit) return {shop, bindingType:"token", binding:hit, token};
  }

  const actorId = String(token.actorId || token.actor?.id || "");
  const baseActor = actorId ? game.actors?.get(actorId) : null;
  const actorUuid = String(baseActor?.uuid || token.actor?.uuid || "");
  for (const shop of shops){
    if (!includeUnavailable && !vendorBindingShopAvailable(shop)) continue;
    const hit = normalizeVendorActors(shop.vendorActors).find(entry =>
      (entry.actorId && actorId && entry.actorId === actorId) ||
      (entry.actorUuid && actorUuid && entry.actorUuid === actorUuid)
    );
    if (hit) return {shop, bindingType:"actor", binding:hit, token};
  }
  return null;
}
function resolveBodegaForVendorTokenSync(tokenLike, options={}){
  ensureSetting();
  const db = game.settings.get(STORE_NS, STORE_KEY);
  return resolveBodegaForVendorTokenFromDb(tokenLike, db, options);
}
async function resolveBodegaForVendorToken(tokenLike, options={}){
  const token = vendorTokenDocument(tokenLike);
  if (!token) return null;
  const db = await loadAll();
  return resolveBodegaForVendorTokenFromDb(token, db, options);
}
function vendorBuyerFromContext(vendorToken=null){
  const vendorDoc = vendorTokenDocument(vendorToken);
  const vendorUuid = String(vendorDoc?.uuid || "");
  const vendorActorId = String(vendorDoc?.actorId || "");
  const controlled = Array.from(canvas?.tokens?.controlled || []);
  const customerToken = controlled.find(tok => {
    const doc = vendorTokenDocument(tok);
    if (!doc?.actor) return false;
    if (vendorUuid && String(doc.uuid || "") === vendorUuid) return false;
    if (vendorActorId && String(doc.actorId || "") === vendorActorId && controlled.length === 1) return false;
    return game.user?.isGM || doc.actor.isOwner;
  });
  return customerToken?.actor || game.user?.character || null;
}
async function openShopFromVendorToken(tokenLike){
  const token = vendorTokenDocument(tokenLike);
  if (!token) return ui.notifications.warn("Не удалось найти токен продавца.");
  const match = await resolveBodegaForVendorToken(token);
  if (!match) return ui.notifications.warn("Этот токен не привязан к доступному магазину.");
  return openShop(match.shop.id, {vendorToken:token});
}
function ensureVendorHudStyle(){
  if (document.getElementById("bodega-token-hud-style")) return;
  const style = document.createElement("style");
  style.id = "bodega-token-hud-style";
  style.textContent = `
    #token-hud .bodega-token-hud i{color:#00fff7;text-shadow:0 0 5px rgba(0,255,247,.45);}
    #token-hud .bodega-token-hud:hover i{color:#f2d64b;text-shadow:0 0 7px rgba(242,214,75,.5);}
  `;
  document.head.appendChild(style);
}
function playerVendorInteractionMode(){
  ensureSetting();
  return String(game.settings.get(STORE_NS, PLAYER_VENDOR_INTERACTION_KEY) || "ctrl-click");
}
function originalPointerEvent(event){
  return event?.nativeEvent || event?.data?.originalEvent || event?.originalEvent || event;
}
function playerVendorGestureMatches(event){
  if (game.user?.isGM) return false;
  const mode = playerVendorInteractionMode();
  if (mode === "disabled") return false;
  const ev = originalPointerEvent(event) || {};
  if (ev.button != null && Number(ev.button) !== 0) return false;
  const shift = !!ev.shiftKey;
  const alt = !!ev.altKey;
  const ctrl = !!ev.ctrlKey || !!ev.metaKey;
  if (mode === "shift-click") return shift && !alt && !ctrl;
  if (mode === "alt-click") return alt && !shift && !ctrl;
  if (mode === "ctrl-click") return ctrl && !shift && !alt;
  return false;
}
function consumePlayerVendorGesture(event){
  const ev = originalPointerEvent(event);
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  ev?.stopImmediatePropagation?.();
}
function playerVendorCanvasPoint(event){
  try{
    if (typeof event?.getLocalPosition === "function" && canvas?.stage) return event.getLocalPosition(canvas.stage);
    if (typeof event?.data?.getLocalPosition === "function" && canvas?.stage) return event.data.getLocalPosition(canvas.stage);
  }catch(_err){}
  const point = event?.global || event?.data?.global || originalPointerEvent(event)?.global;
  if (!point) return null;
  const x = Number(point.x); const y = Number(point.y);
  return Number.isFinite(x) && Number.isFinite(y) ? {x,y} : null;
}
function tokenContainsPlayerVendorPoint(tokenObject, point){
  if (!tokenObject || !point || tokenObject.visible === false || tokenObject.renderable === false) return false;
  const doc = vendorTokenDocument(tokenObject);
  if (!doc || (doc.hidden && !game.user?.isGM)) return false;
  try{
    const bounds = tokenObject.bounds;
    if (bounds?.contains) return !!bounds.contains(point.x, point.y);
  }catch(_err){}
  const x = Number(doc.x ?? tokenObject.x ?? 0);
  const y = Number(doc.y ?? tokenObject.y ?? 0);
  const gridSize = Number(canvas?.grid?.size || canvas?.dimensions?.size || 100);
  const width = Math.max(1, Number(doc.width || 1)) * gridSize;
  const height = Math.max(1, Number(doc.height || 1)) * gridSize;
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}
function findPlayerVendorAtCanvasEvent(event){
  const point = playerVendorCanvasPoint(event);
  if (!point) return null;
  const placeables = Array.from(canvas?.tokens?.placeables || []);
  // Walk from the visually upper end first. We only claim the gesture if the
  // Token under the pointer actually resolves to a Bodega, so ordinary canvas
  // clicks remain completely Foundry-owned.
  for (let i = placeables.length - 1; i >= 0; i--){
    const tokenObject = placeables[i];
    if (!tokenContainsPlayerVendorPoint(tokenObject, point)) continue;
    const token = vendorTokenDocument(tokenObject);
    const match = resolveBodegaForVendorTokenSync(token);
    if (match) return {token, match, tokenObject, point};
  }
  return null;
}
let playerVendorCanvasStage = null;
let playerVendorCanvasHandler = null;
let playerVendorCanvasUsesCapture = false;
let playerVendorDomCanvas = null;
let playerVendorDomHandler = null;
let playerVendorLastClaimAt = 0;
let playerVendorHandledNativeEvents = new WeakSet();
function playerVendorDomCanvasElement(){
  const view = canvas?.app?.view || canvas?.app?.renderer?.view;
  if (view?.addEventListener) return view;
  const board = document.getElementById("board") || document.querySelector("canvas#board") || document.querySelector("#board canvas");
  return board?.addEventListener ? board : null;
}
function playerVendorRendererPoint(event, element){
  const ev = originalPointerEvent(event) || event;
  if (!element?.getBoundingClientRect || !Number.isFinite(Number(ev?.clientX)) || !Number.isFinite(Number(ev?.clientY))) return null;
  const rect = element.getBoundingClientRect();
  if (!rect?.width || !rect?.height) return null;
  const renderer = canvas?.app?.renderer;
  const screenW = Number(renderer?.screen?.width || element.width || rect.width);
  const screenH = Number(renderer?.screen?.height || element.height || rect.height);
  if (!Number.isFinite(screenW) || !Number.isFinite(screenH) || screenW <= 0 || screenH <= 0) return null;
  return {
    x:(Number(ev.clientX) - rect.left) * (screenW / rect.width),
    y:(Number(ev.clientY) - rect.top) * (screenH / rect.height)
  };
}
function findPlayerVendorAtDomEvent(event, element){
  const point = playerVendorRendererPoint(event, element);
  if (!point) return null;
  const placeables = Array.from(canvas?.tokens?.placeables || []);
  for (let i = placeables.length - 1; i >= 0; i--){
    const tokenObject = placeables[i];
    if (!tokenObject || tokenObject.visible === false || tokenObject.renderable === false) continue;
    const token = vendorTokenDocument(tokenObject);
    if (!token || (token.hidden && !game.user?.isGM)) continue;
    let contains = false;
    try{
      const bounds = tokenObject.getBounds?.() || tokenObject.bounds;
      contains = !!bounds?.contains?.(point.x, point.y);
    }catch(_err){}
    if (!contains) continue;
    const match = resolveBodegaForVendorTokenSync(token);
    if (match) return {token, match, tokenObject, point};
  }
  return null;
}
function claimPlayerVendorGesture(event){
  const native = originalPointerEvent(event);
  try{
    if (native && typeof native === "object"){
      if (playerVendorHandledNativeEvents.has(native)) return false;
      playerVendorHandledNativeEvents.add(native);
    }
  }catch(_err){}
  const now = Number(globalThis.performance?.now?.() || Date.now());
  if (now - playerVendorLastClaimAt < 120) return false;
  playerVendorLastClaimAt = now;
  return true;
}
function unbindPlayerVendorCanvasInteraction(){
  if (playerVendorCanvasStage && playerVendorCanvasHandler){
    try{
      if (playerVendorCanvasUsesCapture && typeof playerVendorCanvasStage.removeEventListener === "function"){
        playerVendorCanvasStage.removeEventListener("pointerdown", playerVendorCanvasHandler, {capture:true});
      } else if (typeof playerVendorCanvasStage.off === "function") {
        playerVendorCanvasStage.off("pointerdown", playerVendorCanvasHandler);
      }
    }catch(_err){}
  }
  if (playerVendorDomCanvas && playerVendorDomHandler){
    try{ playerVendorDomCanvas.removeEventListener("pointerdown", playerVendorDomHandler, true); }catch(_err){}
  }
  playerVendorCanvasStage = null;
  playerVendorCanvasHandler = null;
  playerVendorCanvasUsesCapture = false;
  playerVendorDomCanvas = null;
  playerVendorDomHandler = null;
  playerVendorLastClaimAt = 0;
  playerVendorHandledNativeEvents = new WeakSet();
}
function bindPlayerVendorCanvasInteraction(){
  if (game.user?.isGM) return true;
  const stage = canvas?.stage || null;
  const domCanvas = playerVendorDomCanvasElement();
  if (!stage && !domCanvas) return false;
  if (playerVendorCanvasStage === stage && playerVendorDomCanvas === domCanvas && (playerVendorCanvasHandler || playerVendorDomHandler)) return true;
  unbindPlayerVendorCanvasInteraction();

  const openHit = (event, hit) => {
    if (!hit || !claimPlayerVendorGesture(event)) return false;
    consumePlayerVendorGesture(event);
    void openShop(hit.match.shop.id, {vendorToken:hit.token});
    return true;
  };

  // Primary path: capture the actual HTML canvas pointer event. This survives
  // unowned-NPC Token handlers and modules which stop PIXI propagation.
  if (domCanvas){
    const domHandler = (event) => {
      try{
        if (!playerVendorGestureMatches(event)) return;
        openHit(event, findPlayerVendorAtDomEvent(event, domCanvas));
      }catch(err){ console.warn("Bodega | Player vendor DOM-canvas interaction failed", err); }
    };
    domCanvas.addEventListener("pointerdown", domHandler, true);
    playerVendorDomCanvas = domCanvas;
    playerVendorDomHandler = domHandler;
  }

  // Secondary path: retain the PIXI stage listener as a fallback for Foundry
  // renderers where the board element cannot be resolved. Duplicate events are
  // suppressed by claimPlayerVendorGesture().
  if (stage){
    const stageHandler = (event) => {
      try{
        if (!playerVendorGestureMatches(event)) return;
        openHit(event, findPlayerVendorAtCanvasEvent(event));
      }catch(err){ console.warn("Bodega | Player vendor PIXI interaction failed", err); }
    };
    if (typeof stage.addEventListener === "function"){
      stage.addEventListener("pointerdown", stageHandler, {capture:true});
      playerVendorCanvasUsesCapture = true;
      playerVendorCanvasHandler = stageHandler;
      playerVendorCanvasStage = stage;
    } else if (typeof stage.on === "function") {
      stage.on("pointerdown", stageHandler);
      playerVendorCanvasHandler = stageHandler;
      playerVendorCanvasStage = stage;
    }
  }

  return !!(playerVendorDomHandler || playerVendorCanvasHandler);
}
function bodegaBuyPricing(listPrice, shop, actor, isFixer, rank, discCfg, fixerOnlyFlag){
  const list = Math.max(0, Number(listPrice|0));
  const fixerPct = (fixerOnlyFlag && isFixer) ? rankToDiscount(rank, discCfg) : 0;
  const preferred = getPreferredCustomerDiscount(shop, actor);
  const preferredPct = Math.max(0, Math.min(100, Number(preferred?.pct|0) || 0));
  // Relationship rewards do not stack with Operator pricing. The better eligible discount wins.
  const appliedPct = Math.max(fixerPct, preferredPct);
  return {
    listPrice:list,
    price:Math.max(0, Math.round(list * (100 - appliedPct) / 100)),
    appliedPct, fixerPct, preferredPct, preferred
  };
}

function defaultDB(){
  return {
    _ver: FLAG_VER,
    era2045:true,
    defaults:{
      packKey:"",
      rollTable:"",
      fixerDiscounts: { t1:10, t2:15, t3:20 },
      autoFixerLock:{ enabled:false, threshold:500 }
    },
    // items: stockClass is static | dynamic | tradein. dynamicManaged is retained for compatibility.
    // shop:  {id,name,..., faces:[], vendorActors:[], vendorTokens:[], items:[], dynamic:{...}, purse, customerDiscounts:[], buyback:{ [kind]:{on,pct} }, ledgerUuid? }
    shops:{}
  };
}
function ensureSetting(){
  if (!game.settings.settings.get(`${STORE_NS}.${STORE_KEY}`)) {
    game.settings.register(STORE_NS, STORE_KEY, {name:"База магазинов", scope:"world", config:false, type:Object, default: defaultDB()});
  }
  if (!game.settings.settings.get(`${STORE_NS}.${PLAYER_VENDOR_INTERACTION_KEY}`)) {
    game.settings.register(STORE_NS, PLAYER_VENDOR_INTERACTION_KEY, {
      name:"Открытие магазина через токен продавца",
      hint:"Выберите сочетание клавиш для открытия магазина игроками. Обычный щелчок продолжит работать как раньше. Кнопка мастера в меню токена сохраняется.",
      scope:"world",
      config:true,
      type:String,
      choices:{
        "ctrl-click":"Ctrl/Cmd + ЛКМ (рекомендуется)",
        "shift-click":"Shift + ЛКМ (может мешать выбору нескольких токенов)",
        "alt-click":"Alt + ЛКМ (может мешать подсветке токенов)",
        "disabled":"Отключено — только меню токена мастера"
      },
      default:"ctrl-click",
      onChange:()=>{ try{ bindPlayerVendorCanvasInteraction(); }catch(err){ console.warn("Bodega | Could not rebind player vendor interaction after setting change", err); } }
    });
  }
}
async function loadAll(){
  ensureSetting();
  const val = await game.settings.get(STORE_NS, STORE_KEY);
  if (!val || typeof val !== "object") return defaultDB();

  // --- Legacy migration if version is older
  if (!val._ver || val._ver < FLAG_VER){
    for (const v of Object.values(val.shops ?? {})){
      v.items = (v.items ?? []).map(it => ({
        ...it,
        qty: typeof it.qty==="number" ? it.qty : 1,
        infinite: !!it.infinite,
        fixerOnly: !!it.fixerOnly,
        fixerMinRank: (it.fixerMinRank==null || it.fixerMinRank==="")
          ? null
          : Math.max(1, Math.min(10, Number(it.fixerMinRank|0)))
      }));
    }
    val._ver = FLAG_VER;
  }

  // --- ALWAYS normalize shape (covers shops made before buyback/dynamic inventory existed)
  val.defaults ||= {};
  val.defaults.packKey = String(val.defaults.packKey || "");
  val.defaults.rollTable = String(val.defaults.rollTable || "");
  val.defaults.fixerDiscounts = {
    t1:Math.max(0, Math.min(95, Number(val.defaults.fixerDiscounts?.t1 ?? 10)|0)),
    t2:Math.max(0, Math.min(95, Number(val.defaults.fixerDiscounts?.t2 ?? 15)|0)),
    t3:Math.max(0, Math.min(95, Number(val.defaults.fixerDiscounts?.t3 ?? 20)|0))
  };
  val.defaults.autoFixerLock = normalizeAutoFixerLock(val.defaults.autoFixerLock);
  const kinds = ["Ammo","Armor","Clothing","Cyberdeck","Cyberware","Drug","Gear","Upgrade","Vehicle","Weapon"];
  for (const v of Object.values(val.shops ?? {})){
    // faces
    v.faces = Array.isArray(v.faces) ? v.faces : [];

    // purse
    v.purse = Math.max(0, Number.isFinite(v.purse) ? Number(v.purse|0) : 0);

    // Per-Bodega preferred-customer discounts. These grant price reductions only;
    // they never bypass Fixer-only visibility/access rules.
    v.customerDiscounts = normalizeCustomerDiscounts(v.customerDiscounts);

    // Vendor HUD bindings. Actor-wide bindings follow every Token using that Actor;
    // exact Token bindings are scene-specific overrides and resolve first.
    v.vendorActors = normalizeVendorActors(v.vendorActors);
    v.vendorTokens = normalizeVendorTokens(v.vendorTokens);

    // Tile bindings. Keep this as an array so one Bodega can appear on multiple scenes.
    v.tileUuids = Array.isArray(v.tileUuids) ? [...new Set(v.tileUuids.filter(Boolean).map(String))] : [];

    // Inventory classes. Existing/manual stock defaults to static.
    v.items = (v.items ?? []).map(it => {
      const dynamicManaged = !!it.dynamicManaged || it.stockClass === "dynamic";
      const tradeIn = !!it.tradeIn || it.stockClass === "tradein";
      return {
        ...it,
        qty: typeof it.qty === "number" ? Math.max(0, Number(it.qty|0)) : 1,
        infinite:!!it.infinite,
        fixerOnly:!!it.fixerOnly,
        fixerMinRank:(it.fixerMinRank==null || it.fixerMinRank==="") ? null : Math.max(1, Math.min(10, Number(it.fixerMinRank|0))),
        autoFixerLocked:!!it.autoFixerLocked,
        packageSize:it.packageSize==null ? null : Math.max(1, Number(it.packageSize || 1)|0),
        marketPackagePrice:it.marketPackagePrice==null ? null : Math.max(0, Number(it.marketPackagePrice|0)),
        dynamicManaged:dynamicManaged && !tradeIn,
        tradeIn,
        stockClass:tradeIn ? "tradein" : (dynamicManaged ? "dynamic" : "static")
      };
    });
    for (const item of v.items) syncAutoFixerLock(item, val.defaults, {newItem:false});
    v.dynamic = normalizeDynamicSettings(v.dynamic);
    if (!v.dynamic.stockTable) v.dynamic.stockTable = v.rollTable || "";
    if (!v.dynamic.stockPack) v.dynamic.stockPack = v.packKey || "";

    // buyback
    if (!v.buyback || typeof v.buyback !== "object") v.buyback = {};
    for (const k of kinds){
      const cur = v.buyback[k] || {};
      v.buyback[k] = {
        on: !!cur.on,
        pct: Math.max(0, Math.min(120, Number(cur.pct|0) || 0))
      };
    }
  }

  return val;
}
async function saveAll(db){ requireMarketGM(); ensureSetting(); return game.settings.set(STORE_NS, STORE_KEY, db); }

// -------------------- theme --------------------
function updateOpenShopStock(shopId, itemKey, stockClass, qty){
  const id = String(shopId || "");
  const key = String(itemKey || "").toLowerCase();
  const klass = String(stockClass || "");
  const remaining = Math.max(0, Number(qty|0));
  for (const wrap of document.querySelectorAll('.wrap[data-shop]')){
    if (String(wrap.dataset.shop || "") !== id) continue;
    for (const row of wrap.querySelectorAll('[data-bodega-item-key]')){
      if (String(row.dataset.bodegaItemKey || "").toLowerCase() !== key) continue;
      if (klass && String(row.dataset.bodegaStockClass || "") !== klass) continue;
      const stock = row.querySelector('.stock-live');
      if (stock) stock.textContent = `${remaining} осталось`;
      const input = row.querySelector('.qty-buy');
      const button = row.querySelector('.buy');
      if (input){
        input.max = String(Math.max(1, remaining));
        if (remaining <= 0) input.disabled = true;
        else {
          input.disabled = false;
          const current = Math.max(1, Number(input.value|0) || 1);
          input.value = String(Math.min(current, remaining));
        }
      }
      if (button){
        if (remaining <= 0){
          button.disabled = true;
          button.dataset.soldOut = "1";
          button.innerHTML = "<i class=\"fas fa-ban\"></i> Распродано";
        } else {
          button.dataset.soldOut = "";
          if (row.dataset.busy !== "1") button.disabled = false;
          if (row.dataset.busy !== "1") button.innerHTML = "<i class=\"fas fa-shopping-cart\"></i> Купить";
        }
      }
    }
  }
}

function makeAdminCSS(accent="#00FFF7", bodyId){
  const highlight = String(accent).toUpperCase() === "#E64539" ? accent : "#f2d64b";
  return `
.dialog-host-${bodyId}, #${bodyId}{ --accent:${accent}; --yellow:${highlight}; --hover:#fff0a0; --bg:#080c0f; --panel:#10171d; --text:#edfaff; --muted:#8fb8c2; color:var(--text); }
.dialog-host-${bodyId}{ background:var(--bg) !important; }
.dialog-host-${bodyId} .window-header{
  background:#080c0f !important; color:var(--text) !important;
  border:1px solid var(--accent); border-top:3px solid var(--yellow); border-bottom:0;
  border-radius:10px 10px 0 0; box-shadow:0 0 14px rgba(0,0,0,.45);
}
.dialog-host-${bodyId} .window-title,
.dialog-host-${bodyId} .window-header .close,
.dialog-host-${bodyId} .window-header .popout{ color:var(--text) !important; }
.dialog-host-${bodyId} .window-content{
  background-color:#080c0f !important; color:var(--text) !important;
  background-image:radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px),radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px),linear-gradient(#080c0f,#080c0f) !important;
  background-size:24px 24px,24px 24px,auto !important; background-position:0 0,12px 12px,0 0 !important;
  border-left:1px solid var(--accent); border-right:1px solid var(--accent); padding:8px 10px !important;
}
.dialog-host-${bodyId} .dialog-buttons{
  background:#080c0f !important; border:1px solid var(--accent); border-top:1px solid rgba(255,255,255,.08);
  border-radius:0 0 10px 10px; padding:7px 10px !important;
}
.dialog-host-${bodyId} form{ background:transparent !important; }
#${bodyId}{ color:var(--text); }
#${bodyId}, #${bodyId} *{ box-sizing:border-box; }
#${bodyId} .wrap{ background:linear-gradient(180deg,#0d1318 0,#080c0f 100%); border:1px solid var(--accent); border-top:3px solid var(--yellow); border-radius:8px; padding:12px; color:var(--text); min-width:520px; box-shadow:0 0 18px rgba(0,0,0,.5); }
#${bodyId} .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#${bodyId} .title{font-size:20px;font-weight:900;margin:0 0 4px;color:var(--yellow);letter-spacing:.5px;text-transform:uppercase}
#${bodyId} .muted{font-size:14px;color:var(--muted);opacity:1}
#${bodyId} .stock-badge{display:inline-block;border:1px solid var(--accent);border-radius:999px;padding:1px 7px;font-size:10px;font-weight:900;letter-spacing:.35px;text-transform:uppercase;color:var(--text);background:#071015;margin-left:5px;}
#${bodyId} .stock-badge.dynamic{border-color:var(--yellow);color:var(--yellow);}
#${bodyId} .stock-badge.tradein{border-color:#ff9f43;color:#ffd7a8;}
#${bodyId} label, #${bodyId} fieldset{ color:var(--text); }
#${bodyId} legend{ color:var(--yellow); font-weight:800; }
#${bodyId} code, #${bodyId} .tile-script code{ color:var(--yellow); background:#05080a; border:1px solid rgba(242,214,75,.35); border-radius:4px; padding:2px 5px; user-select:text; }
#${bodyId} .tile-script{ margin-top:8px; padding-top:7px; border-top:1px solid rgba(255,255,255,.08); font-size:12px; color:var(--muted); min-width:0; max-width:100%; overflow-wrap:anywhere; }
#${bodyId} .tile-script code{ display:inline-block; max-width:100%; white-space:normal; word-break:break-all; vertical-align:middle; }
#${bodyId} .manager-toolbar{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:2px; }
#${bodyId} .manager-card-head{ display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
#${bodyId} .manager-summary{ min-width:0; line-height:1.35; }
#${bodyId} .manager-actions{ display:grid; grid-template-columns:repeat(2, minmax(118px, auto)); gap:6px; align-items:start; }
#${bodyId} .manager-actions .btn{ min-width:118px; height:34px; padding:5px 9px; white-space:nowrap; }
@media (max-width:800px){ #${bodyId} .manager-card-head{ grid-template-columns:1fr; } #${bodyId} .manager-actions{ grid-template-columns:repeat(2,minmax(0,1fr)); } }
#${bodyId} .btn{ background:#0b1217; color:var(--text); border:1px solid var(--accent); border-radius:6px; padding:6px 10px; min-height:32px; line-height:1.15; font-weight:800; cursor:pointer; flex:0 0 auto; width:auto; min-width:0; }
#${bodyId} .btn:hover{ color:var(--yellow); border-color:var(--yellow); box-shadow:0 0 10px color-mix(in srgb,var(--accent) 35%,transparent); }
#${bodyId} input, #${bodyId} select, #${bodyId} textarea{ background:#070b0e !important; color:var(--text) !important; border:1px solid var(--accent); border-radius:5px; padding:8px; caret-color:var(--yellow); }
#${bodyId} textarea{ width:100%; min-height:62px; resize:vertical; }
#${bodyId} select{ appearance:auto; height:auto !important; min-height:0 !important; line-height:normal !important; padding:8px !important; text-indent:0 !important; vertical-align:middle; }
#${bodyId} .wrap.edit .dyn-source{ width:220px !important; min-width:220px !important; max-width:220px; }
#${bodyId} .wrap.edit .dyn-restock-mode{ width:220px !important; min-width:220px !important; max-width:220px; }
#${bodyId} .dyn-pool-tools[hidden]{ display:none !important; }
#${bodyId} .dyn-search-wrap{ position:relative; flex:1 1 320px; min-width:240px; }
#${bodyId} .dyn-pool-search{ width:100%; }
#${bodyId} .dyn-search-results{ margin-top:4px; max-height:190px; overflow-y:auto; overflow-x:hidden; border:1px solid var(--accent); border-radius:6px; background:#05090c; padding:4px; scrollbar-width:thin; scrollbar-color:var(--accent) #05090c; }
#${bodyId} .dyn-search-results[hidden]{ display:none !important; }
#${bodyId} .dyn-search-hit{ width:100%; min-height:34px; display:grid; grid-template-columns:28px minmax(0,1fr) auto; align-items:center; gap:8px; padding:4px 7px; margin:0 0 3px; background:#0b1217; color:var(--text); border:1px solid rgba(0,255,247,.22); border-radius:4px; text-align:left; cursor:pointer; }
#${bodyId} .dyn-search-hit:last-child{ margin-bottom:0; }
#${bodyId} .dyn-search-hit:hover{ border-color:var(--yellow); color:var(--yellow); }
#${bodyId} .dyn-search-hit img{ width:26px; height:26px; object-fit:cover; border-radius:3px; }
#${bodyId} .dyn-search-hit .src{ color:var(--muted); font-size:11px; white-space:nowrap; }
#${bodyId} .dyn-pool-tools [data-dyn-pool]{ max-height:150px; overflow-y:auto; overflow-x:hidden; align-content:flex-start; padding-right:3px; scrollbar-width:thin; scrollbar-color:var(--accent) #05090c; }
#${bodyId} option{ background:#070b0e; color:var(--text); }
#${bodyId} input[type="checkbox"]{ accent-color:var(--accent); }
#${bodyId} input[type="number"]{ text-align:right; }
#${bodyId} .list{ display:flex; flex-direction:column; gap:8px; overflow:visible; padding-right:4px; }
#${bodyId} .card{ background:var(--panel); border:1px solid var(--accent); border-left:3px solid var(--yellow); border-radius:6px; padding:10px; color:var(--text); }
/* GM Buyback Review: deliberately wider/cleaner than the generic admin rows. */
#${bodyId} .buyback-review-wrap{ min-width:0; width:100%; overflow:visible; padding:14px; }
#${bodyId} .buyback-review-wrap .review-summary{ margin-top:9px; }
#${bodyId} .review-summary-grid{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 10px; }
#${bodyId} .review-stat{ min-width:0; padding:8px 10px; border:1px solid rgba(0,255,247,.22); border-radius:5px; background:#090f13; }
#${bodyId} .review-stat > span{ display:block; margin-bottom:2px; color:var(--muted); font-size:11px; line-height:1.15; font-weight:800; letter-spacing:.35px; text-transform:uppercase; }
#${bodyId} .review-stat > b{ display:block; color:var(--text); line-height:1.25; overflow-wrap:anywhere; }
#${bodyId} .review-package-card{ margin-top:10px; }
#${bodyId} .review-help{ color:var(--muted); line-height:1.4; margin-bottom:12px; }
#${bodyId} .review-fields{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; align-items:end; }
#${bodyId} .review-field{ display:block; min-width:0; font-weight:700; }
#${bodyId} .review-field > span{ display:block; margin-bottom:5px; }
#${bodyId} .review-required{ display:inline-block; margin-left:5px; padding:1px 5px; border:1px solid rgba(255,222,59,.65); border-radius:999px; color:#ffde3b; font-size:9px; line-height:1.25; font-style:normal; font-weight:900; letter-spacing:.4px; text-transform:uppercase; vertical-align:1px; }
#${bodyId} .review-field input{ display:block; width:100% !important; min-width:0; }
#${bodyId} .review-field input.review-invalid{ border-color:#ff6b6b !important; box-shadow:0 0 0 1px rgba(255,107,107,.45), 0 0 8px rgba(255,107,107,.18) !important; }
#${bodyId} .review-remember{ display:flex; align-items:flex-start; gap:9px; margin-top:12px; line-height:1.3; cursor:pointer; }
#${bodyId} .review-remember input{ flex:0 0 auto; margin-top:2px; }
#${bodyId} .review-remember span{ min-width:0; white-space:normal; overflow-wrap:anywhere; }
#${bodyId} .review-preview{ margin-top:12px; min-height:54px; display:flex; align-items:center; line-height:1.35; border-left-color:var(--accent); background:#081116; }
#${bodyId} .review-actions{ display:flex; justify-content:flex-end; margin-top:12px; }
#${bodyId} .review-actions .review-approve{ min-width:190px; }
#${bodyId} .review-actions .review-approve[aria-disabled="true"]{ opacity:.72; }
#${bodyId} .review-actions .review-approve.review-ready{ opacity:1; }
@media (max-width:640px){
  #${bodyId} .review-summary-grid, #${bodyId} .review-fields{ grid-template-columns:1fr; }
  #${bodyId} .review-actions .review-approve{ width:100%; }
}
#${bodyId} .item-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
#${bodyId} .item-left{ display:flex; align-items:center; gap:10px; min-width:0; }
#${bodyId} .thumb{ width:50px; height:50px; border-radius:4px; object-fit:cover; }
#${bodyId} .name{ font-weight:800; color:var(--text) !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${bodyId} .grid2{ display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; }
#${bodyId} .drop{ padding:12px; border:1px dashed var(--accent); border-radius:6px; text-align:center; color:var(--muted); background:#080d11; }
#${bodyId} .drop.drag{ background:rgba(0,0,0,.6); }
#${bodyId} .faces{ display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
#${bodyId} .face{ width:28px; height:28px; border-radius:50%; border:1px solid var(--accent); object-fit:cover; }
#${bodyId} .face-chip{ display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid var(--accent); border-radius:999px; background:rgba(0,0,0,.4); }
#${bodyId} .face-chip .x{ font-weight:800; cursor:pointer; }
#${bodyId} .customer-discount-list{ display:flex; flex-direction:column; gap:6px; margin:8px 0; }
#${bodyId} .customer-discount-row{ display:grid; grid-template-columns:32px minmax(0,1fr) auto 28px; gap:8px; align-items:center; padding:6px 8px; border:1px solid rgba(0,255,247,.32); border-radius:6px; background:#080d11; }
#${bodyId} .customer-discount-row .face{ width:30px; height:30px; }
#${bodyId} .customer-discount-row .customer-name{ min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:800; }
#${bodyId} .customer-discount-row .discount-control{ display:flex; align-items:center; gap:5px; white-space:nowrap; }
#${bodyId} .customer-discount-row .customer-discount-pct{ width:68px; }
#${bodyId} .customer-discount-row .x{ cursor:pointer; font-weight:900; text-align:center; color:var(--muted); }
#${bodyId} .customer-discount-row .x:hover{ color:var(--yellow); }
#${bodyId} .vendor-binding-list{ display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:6px 0; }
#${bodyId} .vendor-binding-chip{ max-width:100%; }
#${bodyId} .vendor-binding-chip .vendor-label{ max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:800; }
#${bodyId} .vendor-binding-chip .binding-kind{ font-size:9px; padding:1px 5px; margin-left:2px; }
#${bodyId} .card .del{
  flex:0 0 auto;
  width:36px; height:36px; padding:0;
  display:inline-flex; align-items:center; justify-content:center;
}
/* Hard stop for horizontal spill */
#${bodyId} .wrap { overflow: hidden; box-sizing: border-box; }
#${bodyId} .list { overflow-x: hidden; }

/* Make rows able to shrink within the card */
#${bodyId} .card { max-width: 100%; }
#${bodyId} .item-row { min-width: 0; }
#${bodyId} .item-left > div{ min-width:0; }
#${bodyId} .name { min-width: 0; }

/* Buy controls */
#${bodyId} .buy-controls .qty-buy{ width:64px; }
#${bodyId} .buy-controls { flex-wrap: nowrap; }

/* Fixer-Only Min clamp */
#${bodyId} .price-line{ display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* Player view row alignment */
#${bodyId} .wrap:not(.edit) .item-row{ justify-content:flex-start; }
#${bodyId} .wrap:not(.edit) .item-row .item-left{ flex:1 1 0; min-width:0; }
#${bodyId} .buy-controls{ margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:nowrap; flex:0 0 auto; min-width:0; max-width:100%; }
#${bodyId} .wrap:not(.edit) .buy-controls .qty-buy{ width:72px; }

/* Long name knee capper */
#${bodyId} .name { max-width:48vw; overflow:hidden; text-overflow:ellipsis; }

/* Edit tightening */
#${bodyId} .wrap.edit .card{ padding:8px }
#${bodyId} .wrap.edit fieldset{ padding:8px }
#${bodyId} .wrap.edit .row{ gap:6px }
#${bodyId} .wrap.edit .item-row{ gap:8px }
#${bodyId} .wrap.edit .item-left{ gap:8px }
#${bodyId} .wrap.edit .thumb{ width:40px; height:40px }
#${bodyId} .wrap.edit .name{ font-weight:700; }
#${bodyId} .wrap.edit input{ padding:6px }
#${bodyId} .wrap.edit .qty{ width:64px }
#${bodyId} .wrap.edit .price{ width:50px }
#${bodyId} .wrap.edit .fixermin{ width:56px }
#${bodyId} .wrap.edit label{ gap:4px }
#${bodyId} .wrap.edit .card .del{ width:32px; height:32px; }
#${bodyId} .wrap.edit .bb-grid{ gap:8px 10px }
#${bodyId} .wrap.edit .drop{ padding:10px }
#${bodyId} .wrap.edit .item-row{ display:grid !important; grid-template-columns:minmax(0,1fr) auto; align-items:start; gap:10px; }
#${bodyId} .wrap.edit .item-left{ min-width:0; }
#${bodyId} .wrap.edit .name{ white-space:normal; word-break:break-word; line-height:1.15; }
#${bodyId} .wrap.edit .item-controls{ display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; max-width:460px; }
@media (max-width: 820px){
  #${bodyId} .wrap.edit .item-row{ grid-template-columns:1fr; }
  #${bodyId} .wrap.edit .item-controls{ justify-content:flex-start; max-width:none; }
}

/* unify player Buy & Sell button footprints */
#${bodyId} .card .buy, #${bodyId} .card .sell{ min-width:88px; max-width:150px; height:36px; white-space:nowrap; }

#${bodyId} .shop-header{ display:flex; align-items:center; gap:12px; }
#${bodyId} .shop-head-center{ flex:1; text-align:center; }

#${bodyId} .faces-large .face-lg{ width:112px; height:112px; border-radius:50%; border:1px solid var(--accent); object-fit:cover; }
#${bodyId} .face-block{ display:flex; flex-direction:column; align-items:center; gap:4px; min-width:112px; }
#${bodyId} .face-label{ font-size:16px; line-height:1.1; max-width:132px; text-align:center; opacity:.9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

#${bodyId} .buyer-line{ font-size:24px; font-weight:800; }
#${bodyId} .fixer-tag{ font-size:16px; }

#${bodyId} .price-eb b, #${bodyId} .price-line b{ font-size:16px; font-weight:800; }
#${bodyId} .price-eb .eb, #${bodyId} .price-line .eb{ font-weight:800; }
#${bodyId} .price-line del{ opacity:.6; margin-right:6px; }
#${bodyId} .price-line{ display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:48vw; }

#${bodyId} .bb-grid{ display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px 14px; }
`;
}

function makePlayerCSS(accent = "#00FFF7", bodyId){
  const highlight = String(accent).toUpperCase() === "#E64539" ? accent : "#f2d64b";
  const bg     = "#080c0f";       // Choom Trade-style charcoal
  const panel  = "#10171d";       // raised card background
  const text   = "#edfaff";
  const muted  = "#8fb8c2";
  const line   = "rgba(0,0,0,.7)";

  // honeycomb like the reference
  const honeyA = "radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px)";
  const honeyB = "radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px)";

  return `
/* ---------- Bodega skin scope (wins against Foundry theme) ---------- */
.dialog-host-${bodyId} { --accent:${accent}; --yellow:${highlight}; --bg:${bg}; --panel:${panel}; --muted:${muted}; --text:${text}; --line:${line}; }

/* Kill host theme and draw neon chrome */
.dialog-host-${bodyId} .window-header{
  background:${bg} !important;
  color:var(--text) !important;
  border:1px solid var(--accent);
  border-top:3px solid var(--yellow);
  border-bottom:0;
  border-radius:12px 12px 0 0;
  box-shadow:0 0 0 1px ${bg} inset, 0 0 12px rgba(0,0,0,.35);
}
.dialog-host-${bodyId} .window-title{ color:var(--text) !important; font-weight:800; letter-spacing:.2px; }
.dialog-host-${bodyId} .window-content{
  background:${bg} !important;
  border:1px solid var(--accent);
  border-top:0;
  border-radius:0 0 12px 12px;
  padding:8px 10px 10px !important;
  color:var(--text);
  /* honeycomb */
  background-image:${honeyA}, ${honeyB}, linear-gradient(${bg}, ${bg});
  background-size: 24px 24px, 24px 24px, auto;
  background-position: 0 0, 12px 12px, 0 0;
  background-blend-mode: normal;
}

/* Footer buttons zone */
.dialog-host-${bodyId} .dialog-buttons{
  background:${bg} !important;
  border-top:1px solid rgba(255,255,255,.08);
  border-radius:0 0 10px 10px;
  padding:8px 10px;
}

/* ---------- Content layout ---------- */
#${bodyId}, #${bodyId} *{ box-sizing:border-box; }
#${bodyId} .stock-badge{ display:inline-block; border:1px solid var(--accent); border-radius:999px; padding:1px 7px; font-size:10px; font-weight:900; letter-spacing:.35px; text-transform:uppercase; margin-left:4px; color:var(--text); background:#071015; }
#${bodyId} .stock-badge.dynamic{ border-color:var(--yellow); color:var(--yellow); }
#${bodyId} .stock-badge.tradein{ border-color:#ff9f43; color:#ffd7a8; }
#${bodyId} .wrap{ display:flex; flex-direction:column; gap:14px; color:var(--text) !important; }
#${bodyId} .title{ font-weight:900; font-size:20px; color:var(--yellow) !important; letter-spacing:.4px; text-transform:uppercase; }

/* make the window itself wider and stop themes from clamping it */
.dialog-host-${bodyId} {
  width: 820px !important;       /* <- match the JS width above */
  max-width: 92vw;               /* still behave on small screens */
}
.dialog-host-${bodyId} .window-content {
  max-width: none !important;    /* prevent theme max-widths */
}

/* header block */
#${bodyId} .shop-header{ display:flex; align-items:center; gap:18px; padding:10px; background:linear-gradient(90deg,#0f171d,#0a0f13); border:1px solid var(--accent); border-left:4px solid var(--yellow); border-radius:6px; }
#${bodyId} .faces{ display:flex; align-items:center; gap:8px; }
#${bodyId} .face-lg{ width:144px !important; height:144px !important; min-width:144px !important; min-height:144px !important; max-width:144px !important; max-height:144px !important; border-radius:8px; border:2px solid var(--accent); border-top-color:var(--yellow); object-fit:cover !important; display:block; flex:0 0 144px; box-shadow:0 0 14px color-mix(in srgb,var(--accent) 22%,transparent); }
#${bodyId} .face-block{ flex:0 0 144px; min-width:144px; max-width:160px; }
#${bodyId} .face-label{ font-size:13px; margin-top:5px; color:var(--yellow); opacity:1; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${bodyId} .shop-head-center{ flex:1; display:flex; flex-direction:column; align-items:center; gap:2px; }
#${bodyId} .buyer-line{ font-size:22px; font-weight:900; color:var(--text) !important; }
#${bodyId} .muted{ color:var(--muted) !important; }
#${bodyId} .eb{ font-weight:800; }

/* list + cards with neon outline */
#${bodyId} .list{ display:flex; flex-direction:column; gap:10px; }
#${bodyId} .card{
  background:var(--panel);
  border:1px solid var(--accent);
  border-left:3px solid var(--yellow);
  border-radius:6px;
  box-shadow:0 6px 18px rgba(0,0,0,.22);
  color:var(--text) !important;
}
#${bodyId} .card .title{ font-size:16px; margin:10px 10px 6px; font-weight:800; color:var(--accent); }
#${bodyId} .item-row{ display:flex; align-items:center; gap:12px; padding:10px; }
#${bodyId} .item-left{ display:flex; align-items:center; gap:10px; flex:1 1 0; min-width:0; }
#${bodyId} .thumb{ width:40px; height:40px; object-fit:cover; border-radius:6px; border:1px solid var(--line); background:#222; }
#${bodyId} .name{ font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${bodyId} .price-line{ font-size:12px; color:var(--muted); }
#${bodyId} .price-line del{ opacity:.5; margin-right:6px; text-decoration-thickness:2px; }
#${bodyId} .price-line b{ font-size:16px; font-weight:900; color:var(--yellow) !important; }

/* exact pill controls: qty + Buy/Sell */
#${bodyId} .buy-controls{ margin-left:auto; display:flex; align-items:center; gap:10px; }
/* sell rows use the same right-hand control rail as buy */
#${bodyId} .sell-controls{
  margin-left:auto; display:flex; align-items:center; gap:10px;
}
#${bodyId} .empty-note .empty-text{
  text-align:center; font-size:14.5px; padding:10px 12px; color:var(--muted);
}
#${bodyId} .qty-label{ font-size:11px; letter-spacing:.4px; }
#${bodyId} input.qty-buy, #${bodyId} input.qty-sell{
  width:88px; height:36px;
  background:#070b0e !important;
  border:1px solid var(--accent);
  border-radius:5px;
  color:var(--text) !important;
  padding:0 10px;
  text-align:center;
  font-weight:800;
  outline:none;
  box-shadow:0 0 8px rgba(0,0,0,.55) inset;
}
#${bodyId} .btn{
  height:36px; min-width:110px; padding:0 14px;
  background:#0b1217;
  border:1px solid var(--accent);
  border-radius:5px;
  color:var(--text) !important; font-weight:800;
}
#${bodyId} .btn:hover:not([disabled]){
  color:var(--yellow) !important; border-color:var(--yellow); box-shadow:0 0 12px rgba(39,255,215,.25);
}
#${bodyId} .btn[disabled]{ opacity:.6; cursor:not-allowed; }

/* “Fixer” tag strip */
#${bodyId} .fixer-tag{
  margin:0 0 4px; padding:8px 10px;
  border:2px solid var(--accent);
  border-left-width:6px;
  border-radius:10px;
  background:rgba(39,255,215,.06);
  font-size:12px;
}

/* Sell block looks like a framed section */
#${bodyId} [data-sell-list] .item-row{ padding:10px; }
#${bodyId} .card[data-sell]{ padding-top:6px; }

#${bodyId} input, #${bodyId} select, #${bodyId} button{ font-family:inherit; }
#${bodyId} input, #${bodyId} select{ background:#070b0e !important; color:var(--text) !important; border-color:var(--accent) !important; }
#${bodyId} label{ color:var(--muted) !important; }
#${bodyId} .item-row b:not(.price-line b){ color:var(--text) !important; }

/* keep Foundry popout header icons visible */
.dialog-host-${bodyId} .window-header .popout,
.dialog-host-${bodyId} .window-header .close{ color:var(--text) !important; }
`;
}


// Footer buttons themed + fixed height
function forceFooterButtons(app, accent, opts={}){
  const minBtnWidth = Number(opts.minBtnWidth ?? 96);
  const btns = app.querySelectorAll(".dialog-buttons .dialog-button");
  for (const b of btns){
    Object.assign(b.style, {
      background:"rgba(0,0,0,.5)",
      color:accent,
      border:`1px solid ${accent}`,
      borderRadius:"10px",
      padding:"6px 12px",
      fontWeight:"800",
      fontFamily:"inherit",
      fontSize:"14px",
      height:"36px",
      minHeight:"36px",
      width:"auto",
      minWidth:`${minBtnWidth}px`,
      lineHeight:"1.2"
    });
  }
}

// -------------------- autosize --------------------
function autosizeDialog(appEl, bodyId){
  const app = appEl?.[0] ?? appEl; if (!app) return;
  const header  = app.querySelector(".window-header");
  const footer  = app.querySelector(".dialog-buttons");
  const content = app.querySelector(".window-content");
  const wrap    = content?.querySelector(`#${bodyId} .wrap`);
  if (!content || !wrap) return;

  const minW = Number(app.dataset.bodegaMinW || 720);
  const capW = Number(app.dataset.bodegaCapW || 1200);

  const pad = 24;
  const measuredW = Math.ceil(Math.max(wrap.scrollWidth + pad, minW));
  const fixedW = app.dataset.bodegaFixedW || Math.min(measuredW, capW);
  app.dataset.bodegaFixedW = fixedW;
  app.style.width = `${fixedW}px`;

  const hH = header?.offsetHeight ?? 36;
  const fH = footer?.offsetHeight ?? 46;
  const margin = 16;
  const natural = wrap.scrollHeight + hH + fH + margin;
  const capH = Math.max(360, Math.min(window.innerHeight - 24, 900));

  if (natural <= capH){
    app.style.height = "auto";
    content.style.height = "auto";
    content.style.overflowX = "hidden";
    content.style.overflowY = "visible";
  } else {
    const totalH  = Math.min(natural, capH);
    app.style.height = `${totalH}px`;
    const contentH = Math.max(200, totalH - hH - fH);
    content.style.height = `${contentH}px`;
    content.style.overflowX = "hidden";
    content.style.overflowY = "auto";
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

// -------------------- source + Fixer access helpers --------------------
function splitReferenceList(value){
  if (Array.isArray(value)) return value.flatMap(splitReferenceList);
  return String(value ?? "").split(/[\r\n,;]+/g).map(ref => ref.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}
function normalizeAutoFixerLock(value){
  return {
    enabled:!!value?.enabled,
    threshold:Math.max(0, Math.min(999999, Number(value?.threshold ?? 500)|0))
  };
}
function syncAutoFixerLock(item, defaults={}, {newItem=false}={}){
  if (!item) return item;
  const cfg = normalizeAutoFixerLock(defaults?.autoFixerLock);
  const qualifies = cfg.enabled && Number(item.price || 0) >= cfg.threshold;
  if (qualifies){
    // Preserve a GM's existing manual Fixer-only choice. Newly created non-Fixer items
    // are tagged so disabling/changing the global rule can safely undo only our own lock.
    if (!item.fixerOnly || item.autoFixerLocked || newItem){
      if (!item.fixerOnly || item.autoFixerLocked){
        item.fixerOnly = true;
        item.fixerMinRank = null;
        item.autoFixerLocked = true;
      }
    }
  } else if (item.autoFixerLocked){
    item.fixerOnly = false;
    item.fixerMinRank = null;
    item.autoFixerLocked = false;
  }
  return item;
}
function syncAllAutoFixerLocks(db){
  if (!db?.shops) return;
  for (const shop of Object.values(db.shops)) for (const item of (shop.items || [])) syncAutoFixerLock(item, db.defaults, {newItem:false});
}

// -------------------- quick add search helpers --------------------
async function findItemByNameFromPack(packKey, name){
  const pack = game.packs.get(packKey);
  if (!pack || pack.documentName!=="Item") return null;
  const idx = await pack.getIndex({fields:["name","img","system.price","system.price.market"]});
  const hit = idx.find(e=>e.name?.toLowerCase()===name.toLowerCase()) || idx.find(e=>e.name?.toLowerCase().includes(name.toLowerCase()));
  return hit ? await pack.getDocument(hit._id) : null;
}
async function findItemByNameFromPacks(ref, name){
  for (const pack of resolveDynamicItemPacks(ref)){
    const doc = await findItemByNameFromPack(pack.collection, name);
    if (doc) return doc;
  }
  return null;
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


// -------------------- dynamic inventory / Simple Calendar --------------------
const dynamicClampInt = (value, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || 0));
const dynamicRandomInt = (min, max) => {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
};
const dynamicShuffle = (values) => {
  const copy = [...(values || [])];
  for (let i = copy.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
function splitDynamicReferences(value){ return splitReferenceList(value); }
function normalizeDynamicPackKey(ref){
  let value = String(ref || "").trim().replace(/^Compendium\./i, "");
  const itemMarker = value.indexOf(".Item.");
  if (itemMarker >= 0) value = value.slice(0, itemMarker);
  return value;
}
function resolveDynamicItemPacks(ref){
  const found = [];
  const seen = new Set();
  for (const raw of splitDynamicReferences(ref)){
    const key = normalizeDynamicPackKey(raw);
    const low = key.toLowerCase();
    const direct = game.packs.get(key);
    const matches = game.packs.filter(pack => {
      if (pack.documentName !== "Item") return false;
      const values = [pack.collection, pack.metadata?.id, pack.metadata?.name, pack.metadata?.label, pack.title, `${pack.metadata?.packageName || ""}.${pack.metadata?.name || ""}`]
        .filter(Boolean).map(value => String(value).toLowerCase());
      return values.includes(low) || values.some(value => value.endsWith(`.${low}`));
    });
    if (direct?.documentName === "Item") matches.unshift(direct);
    for (const pack of matches){
      if (seen.has(pack.collection)) continue;
      seen.add(pack.collection);
      found.push(pack);
    }
  }
  return found;
}
async function findDynamicRollTable(ref){
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
async function findDynamicRollTables(ref){
  const tables = [];
  const seen = new Set();
  for (const candidate of splitDynamicReferences(ref)){
    const table = await findDynamicRollTable(candidate);
    if (!table || seen.has(table.uuid)) continue;
    seen.add(table.uuid);
    tables.push(table);
  }
  return tables;
}
async function resolveDynamicTableResultDocument(result){
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
    if (pack){ try{ const doc = await pack.getDocument(documentId); if (doc) return doc; }catch{} }
    if (["Item","предметов"].includes(collection)){
      const doc = game.items.get(documentId);
      if (doc) return doc;
    }
    try{ const doc = await fromUuid(`${collection}.${documentId}`); if (doc) return doc; }catch{}
  }
  const text = String(result.text || "");
  const uuidMatch = text.match(/@UUID\[([^\]]+)\]/i);
  if (uuidMatch){ try{ const doc = await fromUuid(uuidMatch[1]); if (doc) return doc; }catch{} }
  const compendiumMatch = text.match(/@Compendium\[([^\]]+)\]/i);
  if (compendiumMatch){
    const parts = compendiumMatch[1].split(".");
    const documentId = parts.pop();
    const packKey = parts.join(".");
    const pack = game.packs.get(packKey);
    if (pack && documentId){ try{ const doc = await pack.getDocument(documentId); if (doc) return doc; }catch{} }
  }
  return null;
}
async function rollDynamicTable(table){
  let working = table;
  try{
    working = await table.clone({}, {save:false});
    for (const result of working.results || []) result.updateSource({drawn:false});
  }catch{}
  return working.roll({recursive:true});
}
async function drawDynamicItemFromTable(ref, depth=0){
  if (!ref || depth > 4) return null;
  const tables = await findDynamicRollTables(ref);
  for (const table of dynamicShuffle(tables)){
    try{
      const roll = await rollDynamicTable(table);
      for (const result of dynamicShuffle(roll?.results || [])){
        const doc = await resolveDynamicTableResultDocument(result);
        if (doc?.documentName === "Item") return doc;
        if (doc?.documentName === "RollTable"){
          const nested = await drawDynamicItemFromTable(doc.uuid, depth + 1);
          if (nested) return nested;
        }
      }
    }catch(error){ console.warn(`Bodega | Dynamic RollTable failed: ${table.name}`, error); }
  }
  return null;
}
async function drawDynamicItemFromPack(ref){
  const candidates = [];
  for (const pack of resolveDynamicItemPacks(ref)){
    try{
      const index = await pack.getIndex({fields:["name","img"]});
      for (const entry of index) candidates.push([pack, entry]);
    }catch{}
  }
  if (!candidates.length) return null;
  const [pack, entry] = candidates[dynamicRandomInt(0, candidates.length - 1)];
  return pack.getDocument(entry._id);
}
async function dynamicPoolEntryToDocument(entry){
  if (!entry) return null;
  if (entry.uuid){ const doc = await byUUID(entry.uuid); if (doc) return doc; }
  return entry.name ? findItemAnywhere(entry.name) : null;
}
async function chooseDynamicSourceDocument(shop, defaults={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const mode = dynamic.stockSource;
  if (mode === "pool"){
    for (const entry of dynamicShuffle(dynamic.stockPool)){
      const doc = await dynamicPoolEntryToDocument(entry);
      if (doc) return doc;
    }
    return null;
  }
  if (mode === "pack") return drawDynamicItemFromPack(dynamic.stockPack || shop.packKey || defaults.packKey || "");
  return drawDynamicItemFromTable(dynamic.stockTable || shop.rollTable || defaults.rollTable || "");
}
function getDynamicMarketPrice(doc){
  const raw = doc?.system?.price?.market ?? doc?.system?.price ?? 0;
  return Math.max(0, Number(raw) || 0);
}
function buildDynamicStockItem(doc, dynamic, now=calendarTimestamp(), defaults={}){
  const price = getDynamicMarketPrice(doc);
  const item = {
    uuid:doc.uuid,
    name:doc.name,
    img:doc.img,
    price,
    packageSize:marketPackageSizeFromData(doc),
    marketPackagePrice:price,
    qty:dynamicRandomInt(dynamic.qtyMin, dynamic.qtyMax),
    infinite:false,
    fixerOnly:false,
    fixerMinRank:null,
    dynamicManaged:true,
    tradeIn:false,
    stockClass:"dynamic",
    autoFixerLocked:false,
    generatedAt:Number(now || 0)
  };
  return syncAutoFixerLock(item, defaults, {newItem:true});
}
function dynamicItemKey(itemOrDoc){
  return String(itemOrDoc?.uuid || itemOrDoc?.name || "").toLowerCase();
}
async function fillDynamicStock(shop, {replace=false, defaults={}, now=calendarTimestamp()}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.dynamic = dynamic;
  shop.items ||= [];
  if (replace) shop.items = shop.items.filter(item => !item.dynamicManaged);
  const target = dynamicRandomInt(dynamic.minItems, dynamic.maxItems);
  let managed = shop.items.filter(item => item.dynamicManaged);
  if (managed.length > target){
    const removable = dynamicShuffle(managed).sort((a,b) => Number(a.qty || 0) - Number(b.qty || 0));
    const removeSet = new Set(removable.slice(0, managed.length - target));
    shop.items = shop.items.filter(item => !removeSet.has(item));
    managed = shop.items.filter(item => item.dynamicManaged);
  }
  const seen = new Set(shop.items.map(dynamicItemKey).filter(Boolean));
  let attempts = 0;
  while (managed.length < target && attempts < 80){
    attempts++;
    const doc = await chooseDynamicSourceDocument(shop, defaults);
    if (!doc || doc.documentName !== "Item") break;
    const key = dynamicItemKey(doc);
    if (!key || seen.has(key)) continue;
    const item = buildDynamicStockItem(doc, dynamic, now, defaults);
    shop.items.push(item);
    managed.push(item);
    seen.add(key);
  }
  return managed.length;
}
async function runNpcTraffic(shop, events=1, now=calendarTimestamp()){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  if (!dynamic.npcTraffic) return {events:0, units:0};
  const eventCount = dynamicClampInt(events, 0, 24);
  let units = 0;
  for (let eventIndex=0; eventIndex<eventCount; eventIndex++){
    for (const item of shop.items || []){
      if (!item.dynamicManaged || item.infinite) continue;
      const qty = Math.max(0, Number(item.qty || 0));
      if (!qty || Math.random() >= 0.50) continue;
      const cap = Math.min(qty, Math.random() < 0.18 ? 3 : 2);
      const sold = dynamicRandomInt(1, Math.max(1, cap));
      item.qty = Math.max(0, qty - sold);
      units += sold;
    }
  }
  if (eventCount) dynamic.lastTraffic = Number(now || dynamic.lastTraffic || 0);
  shop.dynamic = dynamic;
  return {events:eventCount, units};
}
async function restockDynamicShop(shop, {defaults={}, now=calendarTimestamp()}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.dynamic = dynamic;
  shop.items ||= [];
  if (dynamic.restockMode === "rotate"){
    const lowThreshold = Math.max(dynamic.qtyMin, Math.ceil(Math.max(1, dynamic.qtyMax) * 0.25));
    shop.items = shop.items.filter(item => {
      if (!item.dynamicManaged) return true;
      const qty = Math.max(0, Number(item.qty || 0));
      if (qty <= 0) return false;
      if (qty <= lowThreshold && Math.random() < 0.55) return false;
      return true;
    });
  }
  for (const item of shop.items){
    if (!item.dynamicManaged || item.infinite) continue;
    item.qty = dynamicRandomInt(dynamic.qtyMin, dynamic.qtyMax);
  }
  await fillDynamicStock(shop, {replace:false, defaults, now});
  dynamic.lastRestock = Number(now || dynamic.lastRestock || 0);
  if (!dynamic.initializedAt) dynamic.initializedAt = Number(now || Date.now());
  return shop;
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
function calendarDayKey(date=calendarDate()){
  if (!date) return "";
  return `${date.year}:${date.month}:${date.day}`;
}
function calendarTimeConfig(){
  const sc = getSimpleCalendar();
  try{ return sc?.api?.getTimeConfiguration?.() || {hoursInDay:24, minutesInHour:60, secondsInMinute:60}; }
  catch{ return {hoursInDay:24, minutesInHour:60, secondsInMinute:60}; }
}
function calendarDaySeconds(){
  const cfg = calendarTimeConfig();
  return Math.max(1, Number(cfg.hoursInDay || 24) * Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60));
}
function calendarDayStart(date=calendarDate()){
  const sc = getSimpleCalendar();
  if (!sc || !date) return 0;
  try{
    return Number(sc.api.dateToTimestamp({year:date.year, month:date.month, day:date.day, hour:0, minute:0, seconds:0}) || 0);
  }catch{ return 0; }
}
function addCalendarDays(timestamp, days){
  const sc = getSimpleCalendar();
  if (!timestamp) return 0;
  try{ return Number(sc?.api?.timestampPlusInterval?.(timestamp, {day:Number(days) || 0}) || 0); }
  catch{ return timestamp + calendarDaySeconds() * (Number(days) || 0); }
}
function calendarTimeOnDay(date, hour, minute){
  const sc = getSimpleCalendar();
  if (!sc || !date) return 0;
  const cfg = calendarTimeConfig();
  const h = dynamicClampInt(hour, 0, Math.max(0, Number(cfg.hoursInDay || 24) - 1));
  const m = dynamicClampInt(minute, 0, Math.max(0, Number(cfg.minutesInHour || 60) - 1));
  try{ return Number(sc.api.dateToTimestamp({year:date.year, month:date.month, day:date.day, hour:h, minute:m, seconds:0}) || 0); }
  catch{ return calendarDayStart(date) + h * Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60) + m * Number(cfg.secondsInMinute || 60); }
}
function isCalendarPrimaryGM(){
  if (!game.user?.isGM) return false;
  const sc = getSimpleCalendar();
  try{ if (typeof sc?.api?.isPrimaryGM === "function") return !!sc.api.isPrimaryGM(); }catch{}
  return game.users?.activeGM?.id ? game.users.activeGM.id === game.user.id : true;
}
function scheduleNextRestock(shop, now=calendarTimestamp(), date=calendarDate()){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const today = calendarTimeOnDay(date, dynamic.restockHour, dynamic.restockMinute);
  if (!today){ dynamic.nextRestock = 0; return 0; }
  dynamic.nextRestock = today > now ? today : addCalendarDays(today, 1);
  shop.dynamic = dynamic;
  return dynamic.nextRestock;
}
function generateTrafficSchedule(shop, now=calendarTimestamp(), date=calendarDate(), {markPastDone=false}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const start = calendarDayStart(date);
  if (!start){ dynamic.trafficSchedule=[]; dynamic.trafficDayKey=""; return []; }
  const cfg = calendarTimeConfig();
  const hourSeconds = Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60);
  const minuteSeconds = Number(cfg.secondsInMinute || 60);
  const firstHour = Math.min(8, Math.max(0, Number(cfg.hoursInDay || 24) - 1));
  const lastHour = Math.max(firstHour, Number(cfg.hoursInDay || 24) - 1);
  const count = dynamicRandomInt(dynamic.trafficMin, dynamic.trafficMax);
  const slots = [];
  let attempts = 0;
  while (slots.length < count && attempts < 120){
    attempts++;
    const hour = dynamicRandomInt(firstHour, lastHour);
    const minute = dynamicRandomInt(0, Math.max(0, Number(cfg.minutesInHour || 60) - 1));
    const ts = start + hour * hourSeconds + minute * minuteSeconds;
    if (slots.some(existing => Math.abs(existing - ts) < hourSeconds * 1.5)) continue;
    slots.push(ts);
  }
  dynamic.trafficDayKey = calendarDayKey(date);
  dynamic.trafficSchedule = slots.sort((a,b)=>a-b).map(ts => ({ts, done:markPastDone && ts <= now}));
  shop.dynamic = dynamic;
  return dynamic.trafficSchedule;
}
function advanceDueRestock(shop, now){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  if (!dynamic.restockEnabled) return {count:0, lastDue:0};
  if (!dynamic.nextRestock) scheduleNextRestock(shop, now);
  let next = Number(dynamic.nextRestock || 0);
  if (!next || next > now) return {count:0, lastDue:0};
  let count = 0;
  let lastDue = 0;
  while (next && next <= now && count < 400){
    lastDue = next;
    count++;
    next = addCalendarDays(next, 1);
  }
  if (next && next <= now){
    const days = Math.floor((now - next) / calendarDaySeconds()) + 1;
    lastDue = next + (days - 1) * calendarDaySeconds();
    count += days;
    next += days * calendarDaySeconds();
  }
  dynamic.nextRestock = next;
  shop.dynamic = dynamic;
  return {count, lastDue};
}
async function initializeDynamicShop(shop, defaults={}, now=calendarTimestamp(), {markPastTraffic=true}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.dynamic = dynamic;
  if (!(shop.items || []).some(item => item.dynamicManaged)) await fillDynamicStock(shop, {replace:false, defaults, now});
  dynamic.initializedAt = Number(now || Date.now());
  dynamic.lastProcessed = Number(now || 0);
  scheduleNextRestock(shop, now);
  generateTrafficSchedule(shop, now, calendarDate(), {markPastDone:markPastTraffic});
  return shop;
}
function humanizeCalendarDelta(timestamp, now=calendarTimestamp()){
  if (!timestamp || !now) return "не запланировано";
  let delta = Math.max(0, Number(timestamp) - Number(now));
  const cfg = calendarTimeConfig();
  const minute = Number(cfg.secondsInMinute || 60);
  const hour = Number(cfg.minutesInHour || 60) * minute;
  const day = Number(cfg.hoursInDay || 24) * hour;
  const days = Math.floor(delta / day); delta -= days * day;
  const hours = Math.floor(delta / hour); delta -= hours * hour;
  const minutes = Math.floor(delta / minute);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
function nextTrafficTimestamp(shop, now=calendarTimestamp()){
  return (shop?.dynamic?.trafficSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) > now).map(entry => Number(entry.ts)).sort((a,b)=>a-b)[0] || 0;
}
function dynamicStatusSummary(shop, now=calendarTimestamp()){
  const dynamic = normalizeDynamicSettings(shop?.dynamic);
  if (!dynamic.enabled) return "Постоянный ассортимент";
  if (!getSimpleCalendar()) return "Обновление включено · Simple Calendar недоступен";
  const nextTraffic = nextTrafficTimestamp(shop, now);
  const trafficText = dynamic.npcTraffic ? (nextTraffic ? `посетители через ${humanizeCalendarDelta(nextTraffic, now)}` : "посетители запланированы на следующий день") : "фоновые покупки отключены";
  const restockText = dynamic.restockEnabled ? (dynamic.nextRestock ? `поставка через ${humanizeCalendarDelta(dynamic.nextRestock, now)}` : "поставка ожидает расписания") : "поставки отключены";
  return `${trafficText} · ${restockText}`;
}
async function ncm_processDynamicInventory({forceTraffic=false, forceRestock=false, shopId=null}={}){
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
    const shops = shopId ? [db.shops?.[shopId]].filter(Boolean) : Object.values(db.shops || {});
    for (const shop of shops){
      const dynamic = normalizeDynamicSettings(shop.dynamic);
      shop.dynamic = dynamic;
      if (!dynamic.enabled) continue;
      if (!dynamic.initializedAt){
        await initializeDynamicShop(shop, db.defaults, now, {markPastTraffic:true});
        changed = true;
        continue;
      }

      // If a long jump crossed one or many deliveries, resolve only the latest restock.
      // Earlier traffic is irrelevant because the later delivery overwrote that shelf state.
      let restockCutoff = 0;
      const dueRestock = advanceDueRestock(shop, now);
      if (forceRestock){
        await restockDynamicShop(shop, {defaults:db.defaults, now});
        scheduleNextRestock(shop, now);
        restockCutoff = now;
        changed = true;
      } else if (dueRestock.count){
        await restockDynamicShop(shop, {defaults:db.defaults, now:dueRestock.lastDue});
        restockCutoff = dueRestock.lastDue;
        changed = true;

        // If a large jump lands before today's delivery, the latest due delivery was yesterday.
        // Collapse yesterday's post-delivery shoppers into a few aggregate customer events rather
        // than replaying every missed hook. The next daily restock still remains the hard reset.
        const todayStart = calendarDayStart(date);
        if (dynamic.npcTraffic && dueRestock.lastDue < todayStart){
          const activeFraction = Math.max(0, Math.min(1, (todayStart - dueRestock.lastDue) / calendarDaySeconds()));
          const typical = dynamicRandomInt(dynamic.trafficMin, dynamic.trafficMax);
          const catchupEvents = Math.max(0, Math.round(typical * activeFraction));
          if (catchupEvents) await runNpcTraffic(shop, catchupEvents, todayStart - 1);
        }
      }

      // Resolve the still-stored schedule first. Events before a catch-up restock are discarded;
      // events after it reduce the freshly delivered stock.
      const oldDue = (dynamic.trafficSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) <= now);
      const actionableOld = oldDue.filter(entry => !restockCutoff || Number(entry.ts || 0) > restockCutoff);
      for (const entry of oldDue) entry.done = true;
      if (actionableOld.length && dynamic.npcTraffic){
        await runNpcTraffic(shop, actionableOld.length, now);
        changed = true;
      }

      if (dynamic.trafficDayKey !== calendarDayKey(date)){
        generateTrafficSchedule(shop, now, date, {markPastDone:false});
        changed = true;
      }

      const dueToday = (dynamic.trafficSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) <= now && (!restockCutoff || Number(entry.ts || 0) > restockCutoff));
      for (const entry of (dynamic.trafficSchedule || [])){
        if (!entry.done && Number(entry.ts || 0) <= now && restockCutoff && Number(entry.ts || 0) <= restockCutoff) entry.done = true;
      }
      if (forceTraffic && dynamic.npcTraffic){
        await runNpcTraffic(shop, 1, now);
        changed = true;
      } else if (dueToday.length && dynamic.npcTraffic){
        for (const entry of dueToday) entry.done = true;
        await runNpcTraffic(shop, dueToday.length, now);
        changed = true;
      }

      dynamic.lastProcessed = now;
    }
    if (changed) await saveAll(db);
    return changed;
  }catch(error){
    console.error("Bodega | Dynamic inventory processing failed", error);
    return false;
  }finally{ calendarProcessing = false; }
}
function processDynamicInventory(options={}) { return transaction(()=>ncm_processDynamicInventory(options)); }
function bindCalendarHooks(){
  if (calendarHookBound) return;
  const bind = () => {
    const sc = getSimpleCalendar();
    if (!sc) return false;
    const hookName = sc.Hooks?.DateTimeChange || "simple-calendar-date-time-change";
    componentHooks.on(hookName, () => processDynamicInventory());
    calendarHookBound = true;
    processDynamicInventory();
    return true;
  };
  if (bind()) return;
  componentHooks.on("simple-calendar-ready", bind);
}
async function addDynamicPoolDocument(pool, doc){
  if (!doc || doc.documentName !== "Item") return false;
  if (pool.some(entry => entry.uuid === doc.uuid)) return false;
  pool.push({uuid:doc.uuid, name:doc.name, img:doc.img});
  return true;
}
function renderDynamicPool(pool){
  return (pool || []).map((entry, index) => `<span class="face-chip" data-dyn-pool-i="${index}"><img class="face" src="${esc(entry.img || 'icons/svg/item-bag.svg')}"><b>${esc(entry.name)}</b><span class="x" data-dyn-pool-rem="${index}" title="Убрать">✕</span></span>`).join("") || `<span class="muted">Список товаров для обновления пока пуст.</span>`;
}
function readDynamicEditorForm(root, shop){
  const dynamic = normalizeDynamicSettings(shop.dynamic);
  const q = selector => root.querySelector(selector);
  dynamic.enabled = !!q(".dyn-enabled")?.checked;
  dynamic.stockSource = q(".dyn-source")?.value || dynamic.stockSource;
  dynamic.stockTable = q(".dyn-table")?.value.trim() || "";
  dynamic.stockPack = q(".dyn-pack")?.value.trim() || "";
  dynamic.minItems = dynamicClampInt(q(".dyn-min-items")?.value, 1, 50);
  dynamic.maxItems = dynamicClampInt(q(".dyn-max-items")?.value, dynamic.minItems, 50);
  dynamic.qtyMin = dynamicClampInt(q(".dyn-qty-min")?.value, 0, 999);
  dynamic.qtyMax = dynamicClampInt(q(".dyn-qty-max")?.value, dynamic.qtyMin, 999);
  dynamic.npcTraffic = !!q(".dyn-traffic")?.checked;
  dynamic.trafficMin = dynamicClampInt(q(".dyn-traffic-min")?.value, 0, 12);
  dynamic.trafficMax = dynamicClampInt(q(".dyn-traffic-max")?.value, dynamic.trafficMin, 12);
  dynamic.restockEnabled = !!q(".dyn-restock")?.checked;
  const cfg = calendarTimeConfig();
  dynamic.restockHour = dynamicClampInt(q(".dyn-restock-hour")?.value, 0, Math.max(0, Number(cfg.hoursInDay || 24)-1));
  dynamic.restockMinute = dynamicClampInt(q(".dyn-restock-minute")?.value, 0, Math.max(0, Number(cfg.minutesInHour || 60)-1));
  dynamic.restockMode = q(".dyn-restock-mode")?.value === "refill" ? "refill" : "rotate";
  shop.dynamic = dynamic;
  return dynamic;
}

// -------------------- Fixer detection & discount (SELL ONLY bonus) --------------------
function unusedLegacyFixerRank(actor){
  const items = actor?.items ?? [];
  let rank = 0;
  for (const it of items){
    const n = String(it.name||"").toLowerCase();
    if (n.includes("operator")) {
      const r = Number(it.system?.rank ?? it.system?.level ?? 0);
      if (r>rank) rank=r;
    }
    const roles = it.type?.toLowerCase?.() || "";
    if ((roles.includes("role") || roles.includes("ability")) && n.includes("fixer")){
      const r2 = Number(it.system?.rank ?? it.system?.level ?? 0);
      if (r2>rank) rank=r2;
    }
  }
  rank = Number(actor.getFlag?.("world","fixerRank") ?? rank) || 0;
  return Math.max(0, rank|0);
}
function rankToDiscount(rank, disc){
  if (rank >= 9) return Math.max(0, Number(disc.t3|0));
  if (rank >= 3) return Math.max(0, Number(disc.t2|0));
  if (rank >= 1) return Math.max(0, Number(disc.t1|0));
  return 0;
}
// SELL-side only: boost vendor offer by Operator discount; clamp to 120%
function applyFixerBonusToSell(basePct, rank, discCfg){
  const b = rankToDiscount(rank, discCfg);
  return Math.min(120, Math.max(0, Math.round((basePct|0) * (100 + b) / 100)));
}
function priceWithFixerBuyDiscount(listPrice, isFixer, rank, discCfg, fixerOnlyFlag){
  if (!fixerOnlyFlag || !isFixer) return Number(listPrice|0);
  const off = rankToDiscount(rank, discCfg);
  return Math.max(0, Math.round(Number(listPrice|0) * (100 - off) / 100));
}

// -------------------- Options dialog --------------------
async function openOptions(){
  requireMarketGM();
  const bodyId = makeUiId("options");
  const db = await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeAdminCSS(accent, bodyId);

  const d = db.defaults ?? {};
  const content = `
  <div id="${bodyId}">
    <div class="wrap edit">
      <div class="title">Магазины — настройки</div>
      <div class="row" style="flex-direction:column; align-items:stretch">
        <label>Компендиумы по умолчанию<br>
          <textarea class="pack" placeholder="package.pack — несколько значений через запятую или с новой строки">${esc(d.packKey||"")}</textarea>
        </label>
        <label>Таблицы по умолчанию (UUID / название / pack::название)<br>
          <textarea class="table" placeholder="Несколько таблиц через запятую или с новой строки">${esc(d.rollTable||"")}</textarea>
        </label>
        <div class="row"><button class="btn" type="button" data-test-pack-default>Проверить компендиумы</button><button class="btn" type="button" data-test-table-default>Проверить таблицы</button></div>
        <label class="row" style="gap:6px;margin-top:6px">
          <input type="checkbox" class="era" ${db.era2045?"checked":""}>
          Использовать <b>красную тему 2045</b> (#E64539)
        </label>
        <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;margin-top:8px">
          <legend style="padding:0 6px">Доступ фиксёров и порог цены</legend>
          <div class="row" style="gap:10px">
            <label class="row" style="gap:6px"><input type="checkbox" class="auto-fixer-lock" ${normalizeAutoFixerLock(d.autoFixerLock).enabled?'checked':''}> Автоматически делать дорогие товары <b>доступными только фиксёрам</b></label>
            <label>От суммы <input type="number" class="auto-fixer-threshold" min="0" max="999999" step="1" value="${normalizeAutoFixerLock(d.autoFixerLock).threshold}" style="width:100px"> эб</label>
          </div>
          <div class="muted" style="margin-top:6px">Для ассортимента 2045 года. Автоматические ограничения учитываются отдельно: отключение этой настройки сохранит ограничения, заданные вручную.</div>
        </fieldset>
        <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;margin-top:8px">
          <legend style="padding:0 6px">Скидки фиксёра (ранг «Деловой хватки»)</legend>
          <div class="row" style="gap:12px">
            <label>Ранг 1–2: <input type="number" class="d1" min="0" max="95" step="1" value="${Number(d.fixerDiscounts?.t1 ?? 10)|0}" style="width:72px"> %</label>
            <label>Ранг 3–8: <input type="number" class="d2" min="0" max="95" step="1" value="${Number(d.fixerDiscounts?.t2 ?? 15)|0}" style="width:72px"> %</label>
            <label>Ранг 9–10: <input type="number" class="d3" min="0" max="95" step="1" value="${Number(d.fixerDiscounts?.t3 ?? 20)|0}" style="width:72px"> %</label>
          </div>
          <div class="muted">Бонусы «Деловой хватки» применяются только при <b>покупке выбранных товаров или продаже торговцу</b>.</div>
        </fieldset>
      </div>
    </div>
  </div>`;

  const dlg = new Dialog({
    title: "Магазины — настройки",
    content,
    buttons: {
      save: {
        label: "Сохранить",
        callback: async (html) => {
          const root = html[0].querySelector(`#${bodyId}`);
          db.defaults = {
            ...(db.defaults || {}),
            packKey: root.querySelector(".pack").value.trim(),
            rollTable: root.querySelector(".table").value.trim(),
            fixerDiscounts: {
              t1: Number(root.querySelector(".d1").value | 0),
              t2: Number(root.querySelector(".d2").value | 0),
              t3: Number(root.querySelector(".d3").value | 0),
            },
            autoFixerLock:normalizeAutoFixerLock({
              enabled:root.querySelector(".auto-fixer-lock").checked,
              threshold:root.querySelector(".auto-fixer-threshold").value
            })
          };
          db.era2045 = !!root.querySelector(".era").checked;
          syncAllAutoFixerLocks(db);
          await saveAll(db);
        },
      },
      close: { label: "Закрыть" },
    },
    render: (html) => {
      document.head.appendChild(style);
      dlg._style = style;

      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);

      forceFooterButtons(app, db.era2045 ? "#E64539" : "#00FFF7");

      autosizeDialog(app, bodyId);
      requestAnimationFrame(() => autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);
      const root = html[0].querySelector(`#${bodyId}`);
      root.querySelector("[data-test-pack-default]")?.addEventListener("click", ()=>{
        const packs = resolveDynamicItemPacks(root.querySelector(".pack").value);
        if (!packs.length) return ui.notifications.warn("По этим ссылкам не найдены компендиумы предметов.");
        ui.notifications.info(`Найдено ${packs.length} компендиумов предметов${packs.length===1?'':'s'}: ${packs.map(pack=>pack.title || pack.collection).join(', ')}`);
      });
      root.querySelector("[data-test-table-default]")?.addEventListener("click", async ()=>{
        const tables = await findDynamicRollTables(root.querySelector(".table").value);
        if (!tables.length) return ui.notifications.warn("По этим ссылкам не найдены таблицы.");
        const table = tables[dynamicRandomInt(0, tables.length-1)];
        const roll = await rollDynamicTable(table);
        if (roll?.results?.length && typeof table.toMessage === "function") await table.toMessage(roll.results, {roll:roll.roll});
        ui.notifications.info(`Найдено ${tables.length} Таблица${tables.length===1?'':'s'}.`);
      });
    },
    close: (appEl) => {
      cleanupDialogVisuals(dlg._style, dlg._mo);
    },
  }, { resizable: true });

  dlg.render(true);
}

// -------------------- helpers for buyback --------------------
function getItemMarketValue(doc){
  const sys = doc.system || {};
  if (sys.price?.market != null) return Math.max(0, Number(sys.price.market|0));
  if (sys.price != null) return Math.max(0, Number(sys.price|0));
  return 0;
}
function getItemKind(doc){
  const t  = String(doc.type||"").toLowerCase();
  const n  = String(doc.name||"").toLowerCase();
  const cat = String(doc.system?.category||doc.system?.type||"").toLowerCase();
  const hay = `${t} ${cat} ${n}`;
  if (hay.includes("ammo")) return "Ammo";
  if (hay.includes("armor")) return "Armor";
  if (hay.includes("clothing") || hay.includes("clothes") || hay.includes("apparel")) return "Clothing";
  if (hay.includes("cyberdeck")) return "Cyberdeck";
  if (hay.includes("cyberware") || hay.includes("cyber")) return "Cyberware";
  if (hay.includes("drug") || hay.includes("chem") || hay.includes("narc")) return "Drug";
  if (hay.includes("upgrade") || hay.includes("mod")) return "Upgrade";
  if (hay.includes("vehicle") || hay.includes("car") || hay.includes("bike")) return "Vehicle";
  if (hay.includes("weapon") || hay.includes("gun") || hay.includes("melee")) return "Weapon";
  return "Gear";
}

// -------------------- Tile binding --------------------
const TILE_FLAG = "binding";
function getTileDocument(tileLike){
  if (!tileLike) return null;
  if (tileLike.documentName === "Tile") return tileLike;
  if (tileLike.document?.documentName === "Tile") return tileLike.document;
  if (tileLike.object?.documentName === "Tile") return tileLike.object.document;
  return null;
}
function selectedTileDocuments(){
  return (canvas?.tiles?.controlled || []).map(getTileDocument).filter(Boolean);
}
function getTileBinding(tileLike){
  const tile = getTileDocument(tileLike);
  if (!tile) return null;
  return tile.getFlag?.(MODULE_ID, TILE_FLAG) || tile.flags?.[MODULE_ID]?.[TILE_FLAG] || null;
}
function bodegaIdFromTile(tileLike){
  return getTileBinding(tileLike)?.shopId || null;
}
async function resolveTileDocument(value){
  if (!value) return null;
  const direct = getTileDocument(value);
  if (direct) return direct;
  const possibleUuid = typeof value === "string" ? value : value.uuid;
  if (possibleUuid) {
    try { const doc = await fromUuid(possibleUuid); if (doc?.documentName === "Tile") return doc; } catch {}
  }
  const possibleId = typeof value === "string" ? value : (value.id ?? value._id);
  if (possibleId) {
    const local = canvas?.scene?.tiles?.get(possibleId);
    if (local?.documentName === "Tile") return local;
  }
  return null;
}
async function findTriggerTile(input){
  const queue = Array.isArray(input) ? [...input] : [input];
  const seen = new Set();
  const nestedKeys = ["tile","tileDocument","triggeringTile","sourceTile","document","entity","object","origin","context","action","value","args"];
  while (queue.length){
    const candidate = queue.shift();
    if (!candidate) continue;
    if (typeof candidate === "object") {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
    }
    const tile = await resolveTileDocument(candidate);
    if (tile) return tile;
    if (typeof candidate === "object") {
      for (const key of nestedKeys) {
        const value = candidate[key];
        if (value == null) continue;
        if (Array.isArray(value)) queue.push(...value); else queue.push(value);
      }
    }
  }
  return selectedTileDocuments()[0] || null;
}
async function bindShopToTiles(shopOrId, tileDocs=null){
  if (!game.user?.isGM) return ui.notifications.warn("Привязать тайлы магазина может только мастер.");
  const db = await loadAll();
  const shopId = typeof shopOrId === "string" ? shopOrId : shopOrId?.id;
  const shop = db.shops?.[shopId];
  if (!shop) return ui.notifications.warn(`Магазин не найден: ${shopId}`);
  const tiles = (tileDocs || selectedTileDocuments()).map(getTileDocument).filter(Boolean);
  if (!tiles.length) return ui.notifications.warn("Сначала выделите один или несколько тайлов инструментом тайлов Foundry.");
  shop.tileUuids ||= [];
  for (const tile of tiles){
    const old = getTileBinding(tile);
    if (old?.shopId && old.shopId !== shop.id) {
      const oldShop = db.shops?.[old.shopId];
      if (oldShop?.tileUuids) oldShop.tileUuids = oldShop.tileUuids.filter(uuid => uuid !== tile.uuid);
    }
    const binding = {shopId:shop.id, shopName:shop.name, sceneId:tile.parent?.id || canvas?.scene?.id || null, boundAt:Date.now(), version:1};
    await tile.setFlag(MODULE_ID, TILE_FLAG, binding);
    if (!shop.tileUuids.includes(tile.uuid)) shop.tileUuids.push(tile.uuid);
  }
  if (shop.sceneOnly && tiles[0]?.parent) {
    shop.sceneId = tiles[0].parent.id;
    shop.sceneName = tiles[0].parent.name || shop.sceneName || "";
  }
  await saveAll(db);
  if (typeof shopOrId === "object" && shopOrId) Object.assign(shopOrId, duplicate(shop));
  ui.notifications.info(`Привязано ${tiles.length} тайл к ${shop.name}.`);
  return tiles.length;
}
async function unbindSelectedTiles(shopOrId){
  if (!game.user?.isGM) return ui.notifications.warn("Отвязать тайлы магазина может только мастер.");
  const db = await loadAll();
  const shopId = typeof shopOrId === "string" ? shopOrId : shopOrId?.id;
  const shop = db.shops?.[shopId];
  if (!shop) return ui.notifications.warn(`Магазин не найден: ${shopId}`);
  const tiles = selectedTileDocuments();
  if (!tiles.length) return ui.notifications.warn("Сначала выделите один или несколько тайлов инструментом тайлов Foundry.");
  let count = 0;
  for (const tile of tiles){
    if (getTileBinding(tile)?.shopId !== shop.id) continue;
    await tile.unsetFlag(MODULE_ID, TILE_FLAG);
    shop.tileUuids = (shop.tileUuids || []).filter(uuid => uuid !== tile.uuid);
    count++;
  }
  await saveAll(db);
  if (typeof shopOrId === "object" && shopOrId) Object.assign(shopOrId, duplicate(shop));
  ui.notifications.info(`Удалено ${count} привязка тайла магазина.`);
  return count;
}
async function unbindAllShopTiles(shopOrId){
  if (!game.user?.isGM) return 0;
  const db = await loadAll();
  const shopId = typeof shopOrId === "string" ? shopOrId : shopOrId?.id;
  const shop = db.shops?.[shopId] || (typeof shopOrId === "object" ? shopOrId : null);
  if (!shop) return 0;
  let count = 0;
  for (const uuid of [...(shop.tileUuids || [])]){
    const tile = await resolveTileDocument(uuid);
    if (tile && getTileBinding(tile)?.shopId === shop.id) { await tile.unsetFlag(MODULE_ID, TILE_FLAG); count++; }
  }
  if (db.shops?.[shop.id]) { db.shops[shop.id].tileUuids = []; await saveAll(db); }
  shop.tileUuids = [];
  return count;
}
async function refreshShopTileBindings(shop, oldId=null){
  requireMarketGM();
  for (const uuid of shop?.tileUuids || []){
    const tile = await resolveTileDocument(uuid);
    const binding = getTileBinding(tile);
    if (!tile || (oldId && binding?.shopId !== oldId && binding?.shopId !== shop.id)) continue;
    await tile.setFlag(MODULE_ID, TILE_FLAG, {shopId:shop.id, shopName:shop.name, sceneId:tile.parent?.id || null, boundAt:binding?.boundAt || Date.now(), version:1});
  }
}
async function openBoundTile(input=null){
  const tile = await findTriggerTile(input);
  if (!tile) return ui.notifications.warn("Не удалось определить тайл, вызвавший магазин.");
  const shopId = bodegaIdFromTile(tile);
  if (!shopId) return ui.notifications.warn("Этот тайл не привязан к магазину.");
  return openShop(shopId);
}
async function createTileHelperMacro(){
  if (!game.user?.isGM) return ui.notifications.warn("Создать макрос тайла может только мастер.");
  const name = "Торговля — открыть магазин тайла";
  const command = `return game.bodega.openBoundTile({\n  args: typeof args === "undefined" ? null : args,\n  tile: typeof tile === "undefined" ? null : tile,\n  token: typeof token === "undefined" ? null : token,\n  actor: typeof actor === "undefined" ? null : actor\n});`;
  let macro = game.macros.getName(name);
  if (macro) {
    await macro.update({type:"script", command, img:"modules/night-city-market/assets/bodega.webp"});
    ui.notifications.info("Макрос открытия магазина обновлён.");
  } else {
    macro = await Macro.create({name, type:"script", command, img:"modules/night-city-market/assets/bodega.webp"});
    ui.notifications.info("Макрос открытия магазина создан.");
  }
  macro?.sheet?.render(true);
  return macro;
}

// -------------------- Admin UI --------------------
async function openAdmin() {
  requireMarketGM();
  const bodyId = makeUiId("manager");
  const db = await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeAdminCSS(accent, bodyId);

  function renderList() {
    const rows = Object.values(db.shops).sort((a,b)=>a.name.localeCompare(b.name)).map(v=>{
      const sc = v.sceneOnly ? (v.sceneName || v.sceneId || "(сцена)") : "Любая сцена";
      const bound = Array.isArray(v.tileUuids) ? v.tileUuids.length : 0;
      const dyn = normalizeDynamicSettings(v.dynamic);
      const managed = (v.items || []).filter(item => item.dynamicManaged).length;
      const vendorActorCount = normalizeVendorActors(v.vendorActors).length;
      const vendorTokenCount = normalizeVendorTokens(v.vendorTokens).length;
      const vendorHud = vendorActorCount || vendorTokenCount ? ` · меню токена ${vendorActorCount ? `${vendorActorCount} Персонаж` : ""}${vendorActorCount && vendorTokenCount ? " + " : ""}${vendorTokenCount ? `${vendorTokenCount} Токен` : ""}` : "";
      const dynBadge = dyn.enabled ? `<span class="stock-badge dynamic">Обновляемый · ${managed}</span>` : `<span class="stock-badge">Постоянный</span>`;
      return `<div class="card manager-card" data-id="${v.id}">
        <div class="manager-card-head">
          <div class="manager-summary"><b>${esc(v.name)}</b> ${dynBadge} <span class="muted">#${esc(v.id)}</span><br><span class="muted">${esc(sc)} · ${bound ? `${bound} Тайл привязан` : "Нет привязки к тайлу"}${vendorHud}</span><br><span class="muted">${esc(dynamicStatusSummary(v))}</span></div>
          <div class="manager-actions">
            <button class="btn" data-bind="${esc(v.id)}"><i class="fas fa-link"></i> Привязать выбранные</button>
            <button class="btn" data-unbind="${esc(v.id)}"><i class="fas fa-unlink"></i> Отвязать выбранные</button>
            <button class="btn" data-edit="${esc(v.id)}"><i class="fas fa-edit"></i> Изменить</button>
            <button class="btn" data-del="${esc(v.id)}"><i class="fas fa-trash"></i> Удалить</button>
          </div>
        </div>
        <div class="tile-script"><span class="muted">Скрипт тайла:</span> <code>game.bodega.openShop("${esc(v.id)}")</code></div>
      </div>`;
    }).join("") || `<div class="muted">Магазинов пока нет. Нажмите <b>Новый магазин</b> для создания.</div>`;
    return rows;
  }

  const content = `
  <div id="${bodyId}">
    <div class="wrap">
      <div class="title">Торговля — магазины</div>
      <div class="manager-toolbar">
        <button class="btn" data-new><i class="fas fa-plus-circle"></i> Новый магазин</button>
        <button class="btn" data-opts><i class="fas fa-sliders-h"></i> Настройки</button>
        <button class="btn" data-helper><i class="fas fa-code"></i> Создать / обновить макрос тайла</button>
        <button class="btn" data-process-dynamic><i class="fas fa-people-carry"></i> Обработать обновления склада</button>
      </div>
      <div class="list" data-list>${renderList()}</div>
      <div class="muted" style="margin-top:6px">
        Для привязанного тайла используйте <b>Торговля — открыть магазин тайла</b> в Monk's Active Tile Triggers. Прямые скрипты магазинов указаны выше.
      </div>
    </div>
  </div>`;

  const dlg = new Dialog({
    title: "Торговля — магазины",
    content,
    buttons: { close: { label: "Закрыть" } },
    render: (html)=>{
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      app.dataset.bodegaMinW = "760";
      app.dataset.bodegaCapW = "980";
      forceFooterButtons(app, accent);
      autosizeDialog(app, bodyId);
      requestAnimationFrame(()=> autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);

      const root = html[0].querySelector(`#${bodyId}`);
      const $list = root.querySelector("[data-list]");

      const refresh = ()=>{ $list.innerHTML = renderList(); autosizeDialog(app, bodyId); };

      root.querySelector("[data-new]").addEventListener("click", ()=> editShop());
      root.querySelector("[data-opts]").addEventListener("click", ()=> openOptions());
      root.querySelector("[data-helper]").addEventListener("click", ()=> createTileHelperMacro());
      root.querySelector("[data-process-dynamic]").addEventListener("click", async ()=> {
        if (!getSimpleCalendar()) return ui.notifications.warn("Simple Calendar недоступен. Обновление склада можно проверить вручную в редакторе магазина.");
        await processDynamicInventory();
        Object.assign(db, await loadAll());
        refresh();
        ui.notifications.info("Обновление склада обработано.");
      });

      $list.addEventListener("click", async (ev)=>{
        const idBind = ev.target.closest("[data-bind]")?.getAttribute("data-bind");
        const idUnbind = ev.target.closest("[data-unbind]")?.getAttribute("data-unbind");
        const idEdit = ev.target.closest("[data-edit]")?.getAttribute("data-edit");
        const idDel  = ev.target.closest("[data-del]")?.getAttribute("data-del");
        if (idBind) { await bindShopToTiles(idBind); Object.assign(db, await loadAll()); refresh(); return; }
        if (idUnbind) { await unbindSelectedTiles(idUnbind); Object.assign(db, await loadAll()); refresh(); return; }
        if (idEdit) return editShop(db.shops[idEdit]);
        if (idDel) {
          const ok = await Dialog.confirm({
            title:"Удалить магазин",
            content:`<p>Удалить <b>${esc(db.shops[idDel]?.name ?? idDel)}</b>?</p>`,
            yes: ()=> true, no: ()=> false, defaultYes: false
          });
          if (!ok) return;
          await unbindAllShopTiles(idDel);
          const freshDb = await loadAll();
          Object.assign(db, freshDb);
          delete db.shops[idDel];
          await saveAll(db);
          ui.notifications.info("Магазин удалён.");
          refresh();
        }
      });

      async function editShop(v=null){
        requireMarketGM();
        const data = v ? duplicate(v) : {
          id: randomID(), name: "Новый магазин", sceneOnly: true,
          sceneId, sceneName: canvas?.scene?.name ?? "",
          packKey: db.defaults?.packKey ?? "",
          rollTable: db.defaults?.rollTable ?? "",
          faces:[],
          vendorActors:[],
          vendorTokens:[],
          items:[],
          tileUuids:[],
          dynamic:defaultDynamicSettings(),
          purse: 0,
          customerDiscounts:[],
          buyback: {
            Ammo:{on:false,pct:50}, Armor:{on:false,pct:50}, Clothing:{on:false,pct:50},
            Cyberdeck:{on:false,pct:40}, Cyberware:{on:false,pct:40}, Drug:{on:false,pct:30},
            Gear:{on:false,pct:50},   Upgrade:{on:false,pct:50}, Vehicle:{on:false,pct:30}, Weapon:{on:false,pct:50}
          }
        };
        data.customerDiscounts = normalizeCustomerDiscounts(data.customerDiscounts);
        const renderCustomerDiscounts = () => data.customerDiscounts.length
          ? data.customerDiscounts.map((entry,i)=>`
              <div class="customer-discount-row" data-customer-discount-i="${i}">
                <img class="face" src="${esc(entry.img || 'icons/svg/mystery-man.svg')}">
                <div class="customer-name" title="${esc(entry.name)}">${esc(entry.name)}</div>
                <label class="discount-control">
                  <input type="number" class="customer-discount-pct" min="0" max="100" step="1" value="${Math.max(0, Math.min(100, Number(entry.pct|0) || 0))}"> % скидки
                </label>
                <span class="x" data-customer-discount-rem title="Убрать скидку постоянного клиента">✕</span>
              </div>`).join("")
          : `<div class="muted">Постоянные клиенты ещё не указаны.</div>`;
        data.vendorActors = normalizeVendorActors(data.vendorActors);
        data.vendorTokens = normalizeVendorTokens(data.vendorTokens);
        const renderVendorActors = () => data.vendorActors.length
          ? data.vendorActors.map((entry,i)=>`<span class="face-chip vendor-binding-chip" data-vendor-actor-i="${i}"><img class="face" src="${esc(entry.img || 'icons/svg/mystery-man.svg')}"><span class="vendor-label" title="${esc(entry.name)}">${esc(entry.name)}</span><span class="stock-badge binding-kind">Персонаж</span><span class="x" data-vendor-actor-rem title="Удалить привязку персонажа продавца">✕</span></span>`).join("")
          : `<span class="muted">Персонаж продавца не привязан.</span>`;
        const renderVendorTokens = () => data.vendorTokens.length
          ? data.vendorTokens.map((entry,i)=>`<span class="face-chip vendor-binding-chip" data-vendor-token-i="${i}"><img class="face" src="${esc(entry.img || 'icons/svg/mystery-man.svg')}"><span class="vendor-label" title="${esc(entry.name)}${entry.sceneName ? ` — ${esc(entry.sceneName)}` : ''}">${esc(entry.name)}${entry.sceneName ? ` <span class="muted">· ${esc(entry.sceneName)}</span>` : ''}</span><span class="stock-badge dynamic binding-kind">Токен</span><span class="x" data-vendor-token-rem title="Удалить привязку отдельного токена">✕</span></span>`).join("")
          : `<span class="muted">Отдельный токен не привязан.</span>`;

        db.shops[data.id] = data; await saveAll(db); // ensure exists immediately
        refresh();

        const content = `
        <div id="${bodyId}">
          <div class="wrap">
            <div class="row">
              <label style="flex:1">Название<br><input type="text" class="v-name" value="${esc(data.name)}"></label>
              <label style="width:240px">ID (для триггеров)<br><input type="text" class="v-id" value="${esc(data.id)}"></label>
            </div>
            <div class="row">
              <label class="row" style="gap:6px">
                <input type="checkbox" class="v-scene" ${data.sceneOnly?"checked":""}> Только на сцене <b>${esc(canvas?.scene?.name ?? "текущая сцена")}</b>
              </label>
            </div>
            <div class="row" style="flex-direction:column; align-items:stretch">
              <label>Компендиумы этого магазина<br><input type="text" class="v-pack" value="${esc(data.packKey||"")}" placeholder="package.pack — несколько значений через запятую или с новой строки"></label>
              <label>Таблицы этого магазина (UUID / название / pack::название)<br>
                <div class="row" style="gap:6px; width:100%">
                  <input style="flex:1" type="text" class="v-table" value="${esc(data.rollTable||"")}" placeholder="Несколько таблиц через запятую или с новой строки">
                  <button class="btn" data-testr>Проверить бросок</button>
                  <button class="btn" data-preview>Предпросмотр</button>
                </div>
              </label>
            </div>

            <!-- Tile Binding -->
            <fieldset style="border:1px solid var(--accent);border-radius:6px;padding:8px;">
              <legend style="padding:0 6px">Привязка к Monk's Active Tiles</legend>
              <div class="row" style="margin-bottom:6px">
                <button type="button" class="btn" data-bind-tile><i class="fas fa-link"></i> Привязать выбранные тайлы</button>
                <button type="button" class="btn" data-unbind-tile><i class="fas fa-unlink"></i> Отвязать выбранные тайлы</button>
                <button type="button" class="btn" data-helper-tile><i class="fas fa-code"></i> Создать / обновить макрос</button>
              </div>
              <div class="muted" data-tile-status>Привязанные тайлы: ${(data.tileUuids||[]).length}</div>
              <div class="tile-script">Скрипт тайла: <code>game.bodega.openShop("${esc(data.id)}")</code></div>
              <div class="muted" style="margin-top:5px">Для привязанного тайла ID магазина в аргументах не нужен: он определяется автоматически.</div>
            </fieldset>

            <!-- Faces -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Портреты продавцов</legend>
              <div class="faces" data-faces>
                ${ (data.faces||[]).map((F,i)=>{ const src = typeof F==="string"?F:(F?.img||""); const nm=(typeof F==="object" && F?.name)?` title="${esc(F.name)}"`:""; return `<span class="face-chip" data-i="${i}"><img class="face" src="${esc(src)}"${nm}><span class="x" title="Убрать">✕</span></span>`; }).join("") || `<span class="muted">Перетащите сюда токен или персонажа…</span>`}
              </div>
              <div class="drop" data-drop-face>Перетащите токен / персонажа</div>
            </fieldset>

            <!-- Vendor Token / Actor HUD Binding -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Открытие через токен продавца</legend>
              <div class="muted">Добавляет кнопку <b>Открыть магазин</b> в меню правого щелчка по токену продавца. Привязка отдельного токена важнее общей привязки персонажа.</div>
              <div style="margin-top:8px"><b>Персонаж продавца</b> <span class="muted">— любой его токен открывает этот магазин.</span></div>
              <div class="vendor-binding-list" data-vendor-actors>${renderVendorActors()}</div>
              <div class="drop" data-drop-vendor-actor>Перетащите НПС или его токен для общей привязки</div>
              <div style="margin-top:10px"><b>Отдельный токен</b> <span class="muted">— только этот токен на этой сцене открывает магазин.</span></div>
              <div class="vendor-binding-list" data-vendor-tokens>${renderVendorTokens()}</div>
              <div class="drop" data-drop-vendor-token>Перетащите конкретный токен НПС</div>
              <div class="row" style="margin-top:6px;align-items:center">
                <button type="button" class="btn" data-bind-selected-vendor-token><i class="fas fa-crosshairs"></i> Привязать выбранный токен</button>
                <span class="muted">Если перетаскивание передаёт персонажа вместо токена, выделите ровно один токен НПС и нажмите эту кнопку.</span>
              </div>
            </fieldset>

            <!-- Buyback & Purse -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Скупка и касса продавца</legend>

              <div class="row" style="gap:12px;margin-bottom:6px">
                <label title="эб для покупки вещей у игроков">
                  Касса продавца (эб)
                  <input type="number" class="v-purse" data-shop="${esc(data.id)}" min="0" step="1" value="${data.purse|0}" style="width:120px">
                </label>
              </div>

              <div style="margin:8px 0 10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)">
                <div><b>Скидки постоянных клиентов</b></div>
                <div class="muted" style="margin-top:2px">Скидка для конкретного персонажа независимо от роли. Перетащите персонажа и укажите процент. Она не открывает товары фиксёра. Если доступны обе скидки, применяется лучшая; они не складываются.</div>
                <div class="customer-discount-list" data-customer-discounts>${renderCustomerDiscounts()}</div>
                <div class="drop" data-customer-discount-drop>Перетащите персонажа игрока для назначения скидки</div>
              </div>

              <div class="bb-grid">
                ${["Ammo","Armor","Clothing","Cyberdeck","Cyberware","Drug","Gear","Upgrade","Vehicle"].map(K=>`
                  <label class="row" style="gap:6px;align-items:center">
                    <input type="checkbox" class="bb-on" data-kind="${K}" ${data.buyback?.[K]?.on?'checked':''}>
                    ${kindLabel(K)}
                    <input type="number" class="bb-pct" data-kind="${K}" min="0" max="100" step="1" value="${Number(data.buyback?.[K]?.pct||0)|0}" style="width:72px"> %
                  </label>
                `).join("")}
              </div>
              <div class="row" style="margin-top:10px">
                ${(()=>{ const K="Weapon"; return `
                  <label class="row" style="gap:6px;align-items:center">
                    <input type="checkbox" class="bb-on" data-kind="${K}" ${data.buyback?.[K]?.on?'checked':''}>
                    ${kindLabel(K)}
                    <input type="number" class="bb-pct" data-kind="${K}" min="0" max="100" step="1" value="${Number(data.buyback?.[K]?.pct||0)|0}" style="width:72px"> %
                  </label>`;})()}
              </div>
            </fieldset>

            <!-- Ledger -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Счёт (контейнер / персонаж)</legend>
              <div class="row" data-ledger-row>
                ${ data.ledgerUuid 
                  ? `<span class="face-chip" data-ledger-chip><span class="muted">Привязано:</span> <b>${esc((await fromUuid(data.ledgerUuid))?.name || data.ledgerUuid)}</b> <span class="x" title="Очистить">✕</span></span>`
                  : `<span class="muted">Перетащите контейнер: его деньги станут кассой продавца.</span>`}
              </div>
              <div class="drop" data-drop-ledger>Перетащите контейнер / персонажа</div>
            </fieldset>

            <!-- Dynamic Inventory -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Обновляемый склад и фоновые покупатели</legend>
              <label class="row"><input type="checkbox" class="dyn-enabled" ${normalizeDynamicSettings(data.dynamic).enabled?'checked':''}> <b>Включить обновление склада</b></label>
              <div class="muted" style="margin:4px 0 8px">Ручной ассортимент и вещи, проданные игроками, защищены. Только <b>обновляемые</b> товары расходуются и пополняются по Simple Calendar.</div>
              <div class="row">
                <label>Источник товаров<br><select class="dyn-source" title="Источник для обновляемого ассортимента">
                  <option value="table" ${normalizeDynamicSettings(data.dynamic).stockSource==='table'?'selected':''}>Таблица</option>
                  <option value="pack" ${normalizeDynamicSettings(data.dynamic).stockSource==='pack'?'selected':''}>Компендиум</option>
                  <option value="pool" ${normalizeDynamicSettings(data.dynamic).stockSource==='pool'?'selected':''}>Ручная подборка</option>
                </select></label>
                <label style="flex:1">Таблицы<br><input type="text" class="dyn-table" value="${esc(normalizeDynamicSettings(data.dynamic).stockTable || data.rollTable || db.defaults.rollTable || '')}" placeholder="UUID / название / pack::название — несколько значений через запятую или с новой строки"></label>
              </div>
              <label>Ключи компендиумов<br><input type="text" class="dyn-pack" value="${esc(normalizeDynamicSettings(data.dynamic).stockPack || data.packKey || db.defaults.packKey || '')}" placeholder="package.pack — несколько значений через запятую или с новой строки"></label>
              <div class="row" style="margin-top:6px">
                <label>Мин. товаров<br><input type="number" class="dyn-min-items" min="1" max="50" value="${normalizeDynamicSettings(data.dynamic).minItems}"></label>
                <label>Макс. товаров<br><input type="number" class="dyn-max-items" min="1" max="50" value="${normalizeDynamicSettings(data.dynamic).maxItems}"></label>
                <label>Мин. количество<br><input type="number" class="dyn-qty-min" min="0" max="999" value="${normalizeDynamicSettings(data.dynamic).qtyMin}"></label>
                <label>Макс. количество<br><input type="number" class="dyn-qty-max" min="0" max="999" value="${normalizeDynamicSettings(data.dynamic).qtyMax}"></label>
              </div>
              <div class="row" style="margin-top:6px">
                <label class="row"><input type="checkbox" class="dyn-traffic" ${normalizeDynamicSettings(data.dynamic).npcTraffic?'checked':''}> Фоновые покупатели НПС</label>
                <label>Мин. посещений в день<br><input type="number" class="dyn-traffic-min" min="0" max="12" value="${normalizeDynamicSettings(data.dynamic).trafficMin}"></label>
                <label>Макс. посещений в день<br><input type="number" class="dyn-traffic-max" min="0" max="12" value="${normalizeDynamicSettings(data.dynamic).trafficMax}"></label>
              </div>
              <div class="row" style="margin-top:6px">
                <label class="row"><input type="checkbox" class="dyn-restock" ${normalizeDynamicSettings(data.dynamic).restockEnabled?'checked':''}> Ежедневная поставка</label>
                <label>Час<br><input type="number" class="dyn-restock-hour" min="0" max="23" value="${normalizeDynamicSettings(data.dynamic).restockHour}"></label>
                <label>Минута<br><input type="number" class="dyn-restock-minute" min="0" max="59" value="${normalizeDynamicSettings(data.dynamic).restockMinute}"></label>
                <label>Режим<br><select class="dyn-restock-mode" title="Что делает ежедневная поставка"><option value="rotate" ${normalizeDynamicSettings(data.dynamic).restockMode==='rotate'?'selected':''}>Сменить и пополнить</option><option value="refill" ${normalizeDynamicSettings(data.dynamic).restockMode==='refill'?'selected':''}>Пополнить полки</option></select></label>
              </div>
              <div class="dyn-pool-tools" data-dyn-pool-tools ${normalizeDynamicSettings(data.dynamic).stockSource==='pool'?'':'hidden'}>
                <label style="display:block;margin-top:8px">Поиск для ручной подборки</label>
                <div class="row" style="margin-top:4px"><div class="dyn-search-wrap"><input type="text" class="dyn-pool-search" autocomplete="off" placeholder="Найти предмет для подборки…"><div class="dyn-search-results" data-dyn-search-results hidden></div></div><button type="button" class="btn" data-dyn-pool-add>Добавить</button></div>
                <div class="drop" data-dyn-pool-drop>Перетащите предметы в подборку обновляемого склада</div>
                <div class="faces" data-dyn-pool>${renderDynamicPool(normalizeDynamicSettings(data.dynamic).stockPool)}</div>
              </div>
              <div class="row" style="margin-top:8px">
                <button type="button" class="btn" data-dyn-test><i class="fas fa-vial"></i> Проверить источник</button>
                <button type="button" class="btn" data-dyn-generate><i class="fas fa-box-open"></i> Создать ассортимент</button>
                <button type="button" class="btn" data-dyn-traffic-now><i class="fas fa-people-arrows"></i> Сымитировать покупателей</button>
                <button type="button" class="btn" data-dyn-restock-now><i class="fas fa-truck-loading"></i> Пополнить сейчас</button>
              </div>
              <div class="muted" data-dyn-status style="margin-top:6px">${esc(dynamicStatusSummary(data))}</div>
            </fieldset>

            <!-- Items -->
            <div class="row" style="margin-top:8px">
              <input type="text" class="v-quick" list="bodega-suggest" placeholder="Поиск предметов в мире и компендиумах…">
              <datalist id="bodega-suggest"></datalist>
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
                  <div>
                    <div class="name" title="${esc(it.name)}">${esc(it.name)}${it.tradeIn || it.stockClass==='tradein' ? "<span class=\"stock-badge tradein\">Выкуплено</span>" : (it.dynamicManaged ? "<span class=\"stock-badge dynamic\">обновляемые</span>" : "<span class=\"stock-badge\">Постоянный</span>")}</div>
                    <div class="muted">Цена <span class="price-eb"><b>${it.price|0}</b> <span class="eb">эб</span></span></div>
                  </div>
                </div>
                <div class="row item-controls" style="align-items:center">
                  <label>Кол-во
                    <input type="number" class="qty" min="0" step="1" value="${(it.infinite?0:(it.qty??1))|0}" style="width:72px" ${it.infinite?'disabled':''}>
                  </label>
                  <label class="row" style="gap:4px" title="Неограниченный запас">
                    <input type="checkbox" class="inf" ${it.infinite?'checked':''}> ∞
                  </label>
                  <label>Цена
                    <input type="number" class="price" min="0" max="999999" step="1" value="${it.price|0}" style="width:100px">
                  </label>
                  <label class="row fx-only" style="gap:6px" title="Видно только фиксёрам">
                    <input type="checkbox" class="fixeronly" ${it.fixerOnly?'checked':''}>
                    <span class="muted">доступными только фиксёрам</span>
                  </label>
                  <label class="row fx-min" style="gap:6px" title="Минимальный ранг «Деловой хватки» (пусто = любой фиксёр)">
                    <span class="muted">Мин.&nbsp;ранг</span>
                    <input type="number" class="fixermin" min="1" max="10" step="1" value="${it.fixerMinRank ?? ""}" style="width:64px">
                  </label>
                  <button class="btn del" data-rem="${i}" title="Удалить" style="margin-left:auto"><i class="fas fa-trash"></i></button>
                </div>
              </div>
            </div>
          `).join("");
        }

        const edDlg = new Dialog({
          title: `Изменить магазин — ${data.name}`,
          content,
          buttons: {
            save: { label:"Сохранить", callback: async (html)=>{
              const rootEd = html[0].querySelector(`#${bodyId}`);
              data.name      = rootEd.querySelector(".v-name").value.trim() || data.name;
              const newId    = rootEd.querySelector(".v-id").value.trim()   || data.id;
              data.sceneOnly = rootEd.querySelector(".v-scene").checked;
              if (data.sceneOnly) { data.sceneId = sceneId; data.sceneName = canvas?.scene?.name ?? ""; }
              data.packKey   = rootEd.querySelector(".v-pack").value.trim();
              data.rollTable = rootEd.querySelector(".v-table").value.trim();
              readDynamicEditorForm(rootEd, data);
              if (data.dynamic.enabled && !data.dynamic.initializedAt && getSimpleCalendar()){
                await initializeDynamicShop(data, db.defaults, calendarTimestamp(), {markPastTraffic:true});
              }

              const oldId = data.id;
              if (newId !== data.id) { delete db.shops[data.id]; data.id = newId; }
              db.shops[data.id] = data; await saveAll(db);
              if (newId !== oldId) await refreshShopTileBindings(data, oldId);
              refresh();
            }},
            close: { label:"Закрыть" }
          },
          render: (html)=>{
            const style2 = document.createElement("style"); style2.textContent = makeAdminCSS(accent, bodyId);
            document.head.appendChild(style2); edDlg._style = style2;

            const app2 = html[0].closest('.app');
            app2.classList.add(`dialog-host-${bodyId}`);
            forceFooterButtons(app2, accent);

            const rootEd = html[0].querySelector(`#${bodyId}`);
            const $items    = rootEd.querySelector("[data-items]");
            const $drop     = rootEd.querySelector("[data-drop]");
            const $dropFace = rootEd.querySelector("[data-drop-face]");
            const $faces    = rootEd.querySelector("[data-faces]");
            const $vendorActors = rootEd.querySelector("[data-vendor-actors]");
            const $vendorTokens = rootEd.querySelector("[data-vendor-tokens]");
            const $dropVendorActor = rootEd.querySelector("[data-drop-vendor-actor]");
            const $dropVendorToken = rootEd.querySelector("[data-drop-vendor-token]");
            const $bindSelectedVendorToken = rootEd.querySelector("[data-bind-selected-vendor-token]");
            const $datalist = rootEd.querySelector("#bodega-suggest");
            const $quick    = rootEd.querySelector(".v-quick");
            const $packIn   = rootEd.querySelector(".v-pack");
            const $tableIn  = rootEd.querySelector(".v-table");
            const $dropLedger = rootEd.querySelector("[data-drop-ledger]");
            const $ledgerRow  = rootEd.querySelector("[data-ledger-row]");
            const $customerDiscountList = rootEd.querySelector("[data-customer-discounts]");
            const $customerDiscountDrop = rootEd.querySelector("[data-customer-discount-drop]");
            const $dynPool = rootEd.querySelector("[data-dyn-pool]");
            const $dynDrop = rootEd.querySelector("[data-dyn-pool-drop]");
            const $dynSearch = rootEd.querySelector(".dyn-pool-search");
            const $dynSearchResults = rootEd.querySelector("[data-dyn-search-results]");
            const $dynPoolTools = rootEd.querySelector("[data-dyn-pool-tools]");
            const $dynStatus = rootEd.querySelector("[data-dyn-status]");
            const dynSearchIndex = [];

            rootEd.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); }}, true);

            async function buildSuggestions(){
              const seen = new Set(); const options = []; const seenUuid = new Set();
              for (const it of game.items){
                const n=it.name?.trim(); if(!n) continue;
                const k=n.toLowerCase(); if(!seen.has(k)){ seen.add(k); options.push(n); }
                if (it.uuid && !seenUuid.has(it.uuid)){ seenUuid.add(it.uuid); dynSearchIndex.push({uuid:it.uuid,name:n,img:it.img||"icons/svg/item-bag.svg",source:"Мир"}); }
              }
              for (const p of game.packs.filter(p=>p.documentName==="Item")){
                try{
                  const idx=await p.getIndex({fields:["name","img"]});
                  for (const e of idx){
                    const n=e.name?.trim(); if(!n) continue;
                    const k=n.toLowerCase(); if(!seen.has(k)){ seen.add(k); options.push(n); }
                    const uuid=`Compendium.${p.collection}.Item.${e._id}`;
                    if (!seenUuid.has(uuid)){ seenUuid.add(uuid); dynSearchIndex.push({uuid,name:n,img:e.img||"icons/svg/item-bag.svg",source:p.title||p.collection}); }
                  }
                }catch{}
              }
              $datalist.innerHTML = options.sort((a,b)=>a.localeCompare(b)).map(n=>`<option value="${esc(n)}"></option>`).join("");
              dynSearchIndex.sort((a,b)=>a.name.localeCompare(b.name));
              if ($dynSearch?.value.trim()) renderDynamicSearchResults();
            }
            buildSuggestions();

            function hideDynamicSearchResults(){ if ($dynSearchResults){ $dynSearchResults.hidden = true; $dynSearchResults.innerHTML = ""; } }
            function renderDynamicSearchResults(){
              if (!$dynSearchResults || !$dynSearch) return;
              const query = $dynSearch.value.trim().toLowerCase();
              if (!query){ hideDynamicSearchResults(); return; }
              const hits = dynSearchIndex
                .filter(entry => entry.name.toLowerCase().includes(query))
                .sort((a,b)=>{
                  const aa=a.name.toLowerCase().startsWith(query)?0:1, bb=b.name.toLowerCase().startsWith(query)?0:1;
                  return aa-bb || a.name.localeCompare(b.name);
                })
                .slice(0,80);
              if (!hits.length){ $dynSearchResults.innerHTML = "<div class=\"muted\" style=\"padding:6px\">Предметы не найдены.</div>"; $dynSearchResults.hidden = false; return; }
              $dynSearchResults.innerHTML = hits.map(entry => `<button type="button" class="dyn-search-hit" data-dyn-search-uuid="${esc(entry.uuid)}"><img src="${esc(entry.img)}"><span>${esc(entry.name)}</span><span class="src">${esc(entry.source)}</span></button>`).join("");
              $dynSearchResults.hidden = false;
            }
            $dynSearch?.addEventListener("input", renderDynamicSearchResults);
            $dynSearch?.addEventListener("focus", renderDynamicSearchResults);

            // Ledger drag/drop and clear
            async function onDropLedger(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d; try{ d=JSON.parse(raw); }catch{}
              if (!d || (d.type!=="Actor" && d.type!=="Token")) return ui.notifications.warn("Перетащите контейнер или персонажа игрока.");
              let a=null;
              if (d.type==="Token"){ const tok = await fromUuid(d.uuid || `Scene.${sceneId}.Token.${d.id}`); a = tok?.actor; }
              else { a = await fromUuid(d.uuid || `Actor.${d.id}`); }
              if (!a) return ui.notifications.warn("Не удалось найти персонажа.");

              data.ledgerUuid = a.uuid;
              await commit();
              $ledgerRow.innerHTML = `<span class="face-chip" data-ledger-chip><span class="muted">Привязано:</span> <b>${esc(a.name)}</b> <span class="x" title="Очистить">✕</span></span>`;
              autosizeDialog(app2, bodyId);
            }
            function dragOver2(e){ e.preventDefault(); e.currentTarget.classList.add("drag"); }
            function dragLeave2(e){ e.preventDefault(); e.currentTarget.classList.remove("drag"); }
            $dropLedger?.addEventListener("dragover", dragOver2);
            $dropLedger?.addEventListener("dragleave", dragLeave2);
            $dropLedger?.addEventListener("drop", onDropLedger);
            $ledgerRow?.addEventListener("click", async (ev)=>{
              if (!ev.target.closest(".x")) return;
              data.ledgerUuid = null;
              await commit();
              $ledgerRow.innerHTML = `<span class="muted">Перетащите контейнер или персонажа: его деньги станут кассой продавца.</span>`;
            });

            function refreshVendorBindings(){
              data.vendorActors = normalizeVendorActors(data.vendorActors);
              data.vendorTokens = normalizeVendorTokens(data.vendorTokens);
              if ($vendorActors) $vendorActors.innerHTML = renderVendorActors();
              if ($vendorTokens) $vendorTokens.innerHTML = renderVendorTokens();
            }
            async function resolveDroppedVendorActor(d){
              if (!d || (d.type !== "Actor" && d.type !== "Token")) return null;
              if (d.type === "Actor") return await fromUuid(d.uuid || `Actor.${d.id}`);
              const tok = await fromUuid(d.uuid || `Scene.${sceneId}.Token.${d.id}`);
              if (!tok) return null;
              return game.actors?.get(tok.actorId) || tok.actor || null;
            }
            async function onDropVendorActor(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw=e.dataTransfer.getData("text/plain"); if(!raw) return;
              let d=null; try{ d=JSON.parse(raw); }catch{}
              const actor = await resolveDroppedVendorActor(d);
              if (!actor) return ui.notifications.warn("Перетащите НПС или его токен для общей привязки магазина.");
              const actorId = String(actor.id || ""); const actorUuid = String(actor.uuid || "");
              // One Actor-wide storefront at a time. Exact Token overrides remain untouched.
              for (const [otherId, otherShop] of Object.entries(db.shops || {})){
                if (otherId === data.id) continue;
                otherShop.vendorActors = normalizeVendorActors(otherShop.vendorActors).filter(entry =>
                  !((actorId && entry.actorId === actorId) || (actorUuid && entry.actorUuid === actorUuid))
                );
              }
              data.vendorActors = normalizeVendorActors(data.vendorActors);
              const hit = data.vendorActors.find(entry => (actorId && entry.actorId === actorId) || (actorUuid && entry.actorUuid === actorUuid));
              const record = {actorId, actorUuid, name:actor.name, img:actor.img || actor.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg"};
              if (hit) Object.assign(hit, record); else data.vendorActors.push(record);
              await commit(); refreshVendorBindings(); autosizeDialog(app2, bodyId);
              ui.notifications.info(`${actor.name} теперь открывает ${data.name} через меню токена.`);
            }
            async function bindSpecificVendorToken(tokenLike){
              const tok = vendorTokenDocument(tokenLike);
              if (!tok?.uuid) return ui.notifications.warn("Не удалось найти размещённый токен.");
              const tokenUuid=String(tok.uuid); const tokenId=String(tok.id || tok._id || ""); const boundSceneId=String(tok.parent?.id || sceneId || "");
              if (!boundSceneId || !tokenId) return ui.notifications.warn("Для отдельной привязки нужен токен, размещённый на сцене.");
              // One exact Token storefront at a time. Actor-wide binding can coexist as a fallback.
              for (const [otherId, otherShop] of Object.entries(db.shops || {})){
                if (otherId === data.id) continue;
                otherShop.vendorTokens = normalizeVendorTokens(otherShop.vendorTokens).filter(entry =>
                  !((entry.tokenUuid && entry.tokenUuid === tokenUuid) || (entry.sceneId === boundSceneId && entry.tokenId === tokenId))
                );
              }
              data.vendorTokens = normalizeVendorTokens(data.vendorTokens);
              const hit = data.vendorTokens.find(entry => (entry.tokenUuid && entry.tokenUuid === tokenUuid) || (entry.sceneId === boundSceneId && entry.tokenId === tokenId));
              const actor = game.actors?.get(tok.actorId) || tok.actor || null;
              const record = {
                tokenUuid, tokenId, sceneId:boundSceneId,
                actorId:String(tok.actorId || actor?.id || ""), actorUuid:String(actor?.uuid || ""),
                name:tok.name || actor?.name || "Токен продавца", sceneName:tok.parent?.name || canvas?.scene?.name || "",
                img:tok.texture?.src || actor?.img || "icons/svg/mystery-man.svg"
              };
              if (hit) Object.assign(hit, record); else data.vendorTokens.push(record);
              await commit(); refreshVendorBindings(); autosizeDialog(app2, bodyId);
              ui.notifications.info(`${record.name} теперь открывает ${data.name} через этот токен.`);
              return record;
            }
            async function onDropVendorToken(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const d = bodegaDragEventData(e);
              const tok = await resolveSpecificVendorTokenDrop(d);
              if (!tok) return ui.notifications.warn("Не удалось определить конкретный токен. Выделите один токен НПС и нажмите «Привязать выбранный токен».");
              return bindSpecificVendorToken(tok);
            }
            async function bindSelectedVendorToken(){
              const selected = Array.from(canvas?.tokens?.controlled || []);
              if (selected.length !== 1) return ui.notifications.warn("Выделите ровно один токен НПС на текущей сцене, затем нажмите «Привязать выбранный токен».");
              return bindSpecificVendorToken(selected[0]);
            }
            for (const drop of [$dropVendorActor,$dropVendorToken]){
              drop?.addEventListener("dragover", dragOver2);
              drop?.addEventListener("dragleave", dragLeave2);
            }
            $dropVendorActor?.addEventListener("drop", onDropVendorActor);
            $dropVendorToken?.addEventListener("drop", onDropVendorToken);
            $bindSelectedVendorToken?.addEventListener("click", bindSelectedVendorToken);
            $vendorActors?.addEventListener("click", async ev => {
              const row=ev.target.closest("[data-vendor-actor-i]");
              if (!row || !ev.target.closest("[data-vendor-actor-rem]")) return;
              const idx=Number(row.getAttribute("data-vendor-actor-i")); if(!Number.isInteger(idx)) return;
              data.vendorActors.splice(idx,1); await commit(); refreshVendorBindings(); autosizeDialog(app2, bodyId);
            });
            $vendorTokens?.addEventListener("click", async ev => {
              const row=ev.target.closest("[data-vendor-token-i]");
              if (!row || !ev.target.closest("[data-vendor-token-rem]")) return;
              const idx=Number(row.getAttribute("data-vendor-token-i")); if(!Number.isInteger(idx)) return;
              data.vendorTokens.splice(idx,1); await commit(); refreshVendorBindings(); autosizeDialog(app2, bodyId);
            });

            function refreshCustomerDiscounts(){
              data.customerDiscounts = normalizeCustomerDiscounts(data.customerDiscounts);
              if ($customerDiscountList) $customerDiscountList.innerHTML = renderCustomerDiscounts();
            }
            async function onDropCustomerDiscount(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw); }catch{}
              if (!d || (d.type!=="Actor" && d.type!=="Token")) return ui.notifications.warn("Перетащите персонажа игрока или его токен для скидки.");
              let actor=null;
              if (d.type === "Token"){
                const tok = await fromUuid(d.uuid || `Scene.${sceneId}.Token.${d.id}`);
                actor = tok?.actor || null;
              } else actor = await fromUuid(d.uuid || `Actor.${d.id}`);
              if (!actor) return ui.notifications.warn("Не удалось найти персонажа.");
              data.customerDiscounts = normalizeCustomerDiscounts(data.customerDiscounts);
              const hit = data.customerDiscounts.find(entry =>
                (entry.actorUuid && entry.actorUuid === actor.uuid) ||
                (entry.actorId && entry.actorId === actor.id)
              );
              if (hit){
                hit.actorUuid = actor.uuid; hit.actorId = actor.id; hit.name = actor.name; hit.img = actor.img || hit.img;
                ui.notifications.info(`${actor.name} уже имеет скидку постоянного клиента.`);
              } else {
                data.customerDiscounts.push({actorUuid:actor.uuid, actorId:actor.id, name:actor.name, img:actor.img || "icons/svg/mystery-man.svg", pct:10});
              }
              await commit(); refreshCustomerDiscounts(); autosizeDialog(app2, bodyId);
            }
            $customerDiscountDrop?.addEventListener("dragover", dragOver2);
            $customerDiscountDrop?.addEventListener("dragleave", dragLeave2);
            $customerDiscountDrop?.addEventListener("drop", onDropCustomerDiscount);
            $customerDiscountList?.addEventListener("input", async (ev)=>{
              if (!ev.target.classList.contains("customer-discount-pct")) return;
              const row = ev.target.closest("[data-customer-discount-i]");
              const idx = Number(row?.getAttribute("data-customer-discount-i"));
              if (!Number.isInteger(idx) || !data.customerDiscounts[idx]) return;
              data.customerDiscounts[idx].pct = Math.max(0, Math.min(100, Number(ev.target.value|0)));
              await commit();
            });
            $customerDiscountList?.addEventListener("click", async (ev)=>{
              if (!ev.target.closest("[data-customer-discount-rem]")) return;
              const row = ev.target.closest("[data-customer-discount-i]");
              const idx = Number(row?.getAttribute("data-customer-discount-i"));
              if (!Number.isInteger(idx) || !data.customerDiscounts[idx]) return;
              data.customerDiscounts.splice(idx,1);
              await commit(); refreshCustomerDiscounts(); autosizeDialog(app2, bodyId);
            });

            async function commit(){ db.shops[data.id]=data; await saveAll(db); refresh(); }
            function refreshDynamicPool(){ if ($dynPool) $dynPool.innerHTML = renderDynamicPool(normalizeDynamicSettings(data.dynamic).stockPool); }
            function refreshDynamicStatus(){ if ($dynStatus) $dynStatus.textContent = dynamicStatusSummary(data); }
            function syncDynamicSourceUI(){ if ($dynPoolTools) $dynPoolTools.hidden = rootEd.querySelector(".dyn-source")?.value !== "pool"; }
            syncDynamicSourceUI();
            async function persistDynamicForm({initialize=false}={}){
              readDynamicEditorForm(rootEd, data);
              if (initialize && data.dynamic.enabled && !data.dynamic.initializedAt && getSimpleCalendar()){
                await initializeDynamicShop(data, db.defaults, calendarTimestamp(), {markPastTraffic:true});
              }
              await commit();
              refreshDynamicStatus();
              syncDynamicSourceUI();
            }
            for (const selector of [".dyn-enabled",".dyn-source",".dyn-table",".dyn-pack",".dyn-min-items",".dyn-max-items",".dyn-qty-min",".dyn-qty-max",".dyn-traffic",".dyn-traffic-min",".dyn-traffic-max",".dyn-restock",".dyn-restock-hour",".dyn-restock-minute",".dyn-restock-mode"]){
              rootEd.querySelector(selector)?.addEventListener("change", async ()=> persistDynamicForm({initialize:true}));
            }

            rootEd.querySelector(".v-purse")?.addEventListener("input", async (e)=>{
              data.purse = Math.max(0, Number(e.target.value|0));
              await commit();
            });

            rootEd.addEventListener("change", async (e)=>{
              if (e.target.classList.contains("bb-on")){
                const k = e.target.getAttribute("data-kind");
                data.buyback ||= {};
                data.buyback[k] = data.buyback[k] || {on:false,pct:0};
                data.buyback[k].on = !!e.target.checked;
                await commit();
              }
            });
            rootEd.addEventListener("input", async (e)=>{
              if (e.target.classList.contains("bb-pct")){
                const k = e.target.getAttribute("data-kind");
                data.buyback ||= {};
                data.buyback[k] = data.buyback[k] || {on:false,pct:0};
                data.buyback[k].pct = Math.max(0, Math.min(120, Number(e.target.value|0)));
                await commit();
              }
            });

            rootEd.addEventListener("input", async (ev)=>{
              const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i"));
              if (Number.isNaN(idx) || !data.items[idx]) return;
              const it = data.items[idx];
              if (ev.target.classList.contains("price")){ it.price = Math.max(0, Number(ev.target.value|0)); if (it.autoFixerLocked) syncAutoFixerLock(it, db.defaults, {newItem:false}); await commit(); }
              if (ev.target.classList.contains("qty"))  { it.qty   = Math.max(0, Number(ev.target.value|0)); await commit(); }
              if (ev.target.classList.contains("fixermin")){
                const raw = ev.target.value.trim();
                it.fixerMinRank = raw==="" ? null : Math.max(1, Math.min(10, Number(raw|0)));
                await commit();
              }
            });

            rootEd.addEventListener("change", async (ev)=>{
              if (ev.target.classList.contains("inf")){
                const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i")); if (Number.isNaN(idx)) return;
                const it = data.items[idx]; it.infinite = ev.target.checked;
                const q = card.querySelector(".qty"); if (q){ q.disabled = it.infinite; if (it.infinite) q.value = 0; }
                await commit();
              }
              if (ev.target.classList.contains("fixeronly")){
                const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i")); if (Number.isNaN(idx)) return;
                data.items[idx].fixerOnly = !!ev.target.checked;
                data.items[idx].autoFixerLocked = false;
                await commit();
              }
            });

            async function doQuickAdd(){
              const name = $quick.value.trim(); if (!name) return;
              const packKey = $packIn.value.trim() || db.defaults.packKey;
              let doc = null; if (packKey) doc = await findItemByNameFromPacks(packKey, name);
              if (!doc) doc = await findItemAnywhere(name);
              if (!doc) return ui.notifications.warn(`Предмет не найден: ${name}`);
              const price = (doc.system?.price?.market != null) ? Number(doc.system.price.market) : (Number(doc.system?.price) || 0);
              const item = { uuid: doc.uuid, name: doc.name, img: doc.img, price: Math.max(0, price|0), packageSize:marketPackageSizeFromData(doc), marketPackagePrice:Math.max(0, price|0), qty: 1, infinite: false, fixerOnly:false, fixerMinRank:null, autoFixerLocked:false, dynamicManaged:false, tradeIn:false, stockClass:"static" };
              data.items.push(syncAutoFixerLock(item, db.defaults, {newItem:true}));
              if ($items) $items.innerHTML = renderItems();
              $quick.value = "";
              await commit(); autosizeDialog(app2, bodyId);
            }

            rootEd.addEventListener("click", async (ev)=>{
              const dynSearchUuid = ev.target.closest("[data-dyn-search-uuid]")?.getAttribute("data-dyn-search-uuid");
              if (dynSearchUuid){
                const doc = await byUUID(dynSearchUuid);
                if (!doc) return ui.notifications.warn("Не удалось найти предмет.");
                data.dynamic = normalizeDynamicSettings(data.dynamic);
                await addDynamicPoolDocument(data.dynamic.stockPool, doc);
                if ($dynSearch) $dynSearch.value = "";
                hideDynamicSearchResults();
                await commit(); refreshDynamicPool(); autosizeDialog(app2, bodyId); return;
              }
              const dynRemove = ev.target.closest("[data-dyn-pool-rem]")?.getAttribute("data-dyn-pool-rem");
              if (dynRemove != null){
                data.dynamic = normalizeDynamicSettings(data.dynamic);
                data.dynamic.stockPool.splice(Number(dynRemove), 1);
                await commit(); refreshDynamicPool(); return;
              }
              if (ev.target.closest("[data-dyn-pool-add]")){
                const name = $dynSearch?.value.trim();
                if (!name) return;
                const packRef = rootEd.querySelector(".dyn-pack")?.value.trim() || data.packKey || db.defaults.packKey || "";
                let doc = null;
                for (const pack of resolveDynamicItemPacks(packRef)){ doc = await findItemByNameFromPack(pack.collection, name); if (doc) break; }
                if (!doc) doc = await findItemAnywhere(name);
                if (!doc) return ui.notifications.warn(`Предмет не найден: ${name}`);
                data.dynamic = normalizeDynamicSettings(data.dynamic);
                await addDynamicPoolDocument(data.dynamic.stockPool, doc);
                if ($dynSearch) $dynSearch.value = "";
                hideDynamicSearchResults();
                await commit(); refreshDynamicPool(); autosizeDialog(app2, bodyId); return;
              }
              if (ev.target.closest("[data-dyn-test]")){
                readDynamicEditorForm(rootEd, data);
                const doc = await chooseDynamicSourceDocument(data, db.defaults);
                if (!doc) return ui.notifications.warn("Источник обновления не дал ни одного предмета.");
                return ui.notifications.info(`Источник обновления найден: ${doc.name}`);
              }
              if (ev.target.closest("[data-dyn-generate]")){
                readDynamicEditorForm(rootEd, data);
                data.dynamic.enabled = true;
                await fillDynamicStock(data, {replace:true, defaults:db.defaults, now:calendarTimestamp()});
                if (getSimpleCalendar() && !data.dynamic.initializedAt) await initializeDynamicShop(data, db.defaults, calendarTimestamp(), {markPastTraffic:true});
                await commit(); if ($items) $items.innerHTML = renderItems(); refreshDynamicStatus(); autosizeDialog(app2, bodyId);
                return ui.notifications.info(`Создано ${(data.items||[]).filter(item=>item.dynamicManaged).length} товаров для ${data.name}.`);
              }
              if (ev.target.closest("[data-dyn-traffic-now]")){
                readDynamicEditorForm(rootEd, data);
                const result = await runNpcTraffic(data, 1, calendarTimestamp());
                await commit(); if ($items) $items.innerHTML = renderItems(); refreshDynamicStatus();
                return ui.notifications.info(`Фоновые покупатели купили ${result.units} ед.${result.units===1?'':'s'} у ${data.name}.`);
              }
              if (ev.target.closest("[data-dyn-restock-now]")){
                readDynamicEditorForm(rootEd, data);
                await restockDynamicShop(data, {defaults:db.defaults, now:calendarTimestamp()});
                if (getSimpleCalendar()) scheduleNextRestock(data, calendarTimestamp());
                await commit(); if ($items) $items.innerHTML = renderItems(); refreshDynamicStatus(); autosizeDialog(app2, bodyId);
                return ui.notifications.info(`${data.name} пополнен.`);
              }
              if (ev.target.closest("[data-bind-tile]")) {
                await commit();
                await bindShopToTiles(data);
                const fresh = await loadAll(); Object.assign(db, fresh); Object.assign(data, duplicate(fresh.shops?.[data.id] || data));
                const status = rootEd.querySelector("[data-tile-status]"); if (status) status.textContent = `Привязанные тайлы: ${(data.tileUuids||[]).length}`;
                return;
              }
              if (ev.target.closest("[data-unbind-tile]")) {
                await unbindSelectedTiles(data);
                const fresh = await loadAll(); Object.assign(db, fresh); Object.assign(data, duplicate(fresh.shops?.[data.id] || data));
                const status = rootEd.querySelector("[data-tile-status]"); if (status) status.textContent = `Привязанные тайлы: ${(data.tileUuids||[]).length}`;
                return;
              }
              if (ev.target.closest("[data-helper-tile]")) return createTileHelperMacro();
              const i = ev.target.closest("[data-rem]")?.getAttribute("data-rem");
              if (i != null) { data.items.splice(Number(i),1); if ($items) $items.innerHTML = renderItems(); await commit(); autosizeDialog(app2, bodyId); }
              if (ev.target.closest("[data-qadd]")) return doQuickAdd();
              if (ev.target.closest("[data-testr]")){
                const ref = $tableIn.value.trim() || db.defaults.rollTable;
                const tables = await findDynamicRollTables(ref);
                if (!tables.length) return ui.notifications.warn("По этим ссылкам не найдены таблицы.");
                const t = tables[dynamicRandomInt(0, tables.length-1)];
                const roll = await rollDynamicTable(t);
                if (roll?.results?.length && typeof t.toMessage === "function") await t.toMessage(roll.results, {roll:roll.roll});
                if (tables.length > 1) ui.notifications.info(`Найдено ${tables.length} таблиц; выпало ${t.name}.`);
              }
              if (ev.target.closest("[data-preview]")){
                await commit();
                openShop(data.id);
              }
              if (ev.target.closest(".face-chip[data-i] .x")){
                const chip = ev.target.closest(".face-chip[data-i]");
                const idx = Number(chip?.getAttribute("data-i"));
                if (Number.isInteger(idx)) { data.faces.splice(idx,1); await commit(); renderFaces(); }
              }
            });

            function renderFaces(){
              $faces.innerHTML = (data.faces?.length ? data.faces.map((F,i)=> {
                const src = typeof F==="string"?F:(F?.img||"");
                const nm = (typeof F==="object" && F?.name) ? ` title="${esc(F.name)}"` : "";
                return `<span class="face-chip" data-i="${i}"><img class="face" src="${esc(src)}"${nm}><span class="x" title="Убрать">✕</span></span>`;
              }).join("") : `<span class="muted">Перетащите сюда токен или персонажа…</span>`);
            }

            function dragOver(e){ e.preventDefault(); e.currentTarget.classList.add("drag"); }
            function dragLeave(e){ e.preventDefault(); e.currentTarget.classList.remove("drag"); }
            async function onDropItem(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw);}catch{}
              if (!d || d.type!=="Item") return;
              const uuid = d.uuid || (d.pack ? `${d.pack}.Item.${d.id}` : `Item.${d.id}`);
              const doc  = await fromUuid(uuid); if (!doc) return;
              const price = (doc.system?.price?.market != null) ? Number(doc.system.price.market) : (Number(doc.system?.price) || 0);
              const item = { uuid, name: doc.name, img: doc.img, price: Math.max(0, price|0), packageSize:marketPackageSizeFromData(doc), marketPackagePrice:Math.max(0, price|0), qty: 1, infinite: false, fixerOnly:false, fixerMinRank:null, autoFixerLocked:false, dynamicManaged:false, tradeIn:false, stockClass:"static" };
              data.items.push(syncAutoFixerLock(item, db.defaults, {newItem:true}));
              if ($items) $items.innerHTML = renderItems(); await commit(); autosizeDialog(app2, bodyId);
            }
            $drop.addEventListener("dragover", dragOver);
            $drop.addEventListener("dragleave", dragLeave);
            $drop.addEventListener("drop", onDropItem);

            async function onDropDynamicPool(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw); }catch{}
              if (!d || d.type!=="Item") return ui.notifications.warn("Перетащите предмет в подборку обновляемого склада.");
              const uuid = d.uuid || (d.pack ? `${d.pack}.Item.${d.id}` : `Item.${d.id}`);
              const doc = await fromUuid(uuid);
              if (!doc) return ui.notifications.warn("Не удалось найти предмет.");
              data.dynamic = normalizeDynamicSettings(data.dynamic);
              await addDynamicPoolDocument(data.dynamic.stockPool, doc);
              await commit(); refreshDynamicPool(); autosizeDialog(app2, bodyId);
            }
            $dynDrop?.addEventListener("dragover", dragOver);
            $dynDrop?.addEventListener("dragleave", dragLeave);
            $dynDrop?.addEventListener("drop", onDropDynamicPool);

            async function onDropFace(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw);}catch{}
              if (!d) return;
              let img=null, name=null;
              try{
                if (d.type==="Token"){
                  const tok = await fromUuid(d.uuid || `Scene.${sceneId}.Token.${d.id}`);
                  img  = tok?.texture?.src || tok?.document?.texture?.src || tok?.actor?.img || tok?.actor?.prototypeToken?.texture?.src;
                  name = tok?.document?.name || tok?.name || tok?.actor?.name || null;
                } else if (d.type==="Actor"){
                  const a = await fromUuid(d.uuid || `Actor.${d.id}`);
                  img  = a?.img || a?.prototypeToken?.texture?.src;
                  name = a?.name || null;
                }
              }catch{}
              if (!img) return ui.notifications.warn("Перетащите токен или персонажа.");
              data.faces = data.faces || [];
              data.faces.push({ img, name: name || "" });
              await commit(); renderFaces(); autosizeDialog(app2, bodyId);
            }
            $dropFace.addEventListener("dragover", dragOver);
            $dropFace.addEventListener("dragleave", dragLeave);
            $dropFace.addEventListener("drop", onDropFace);

            renderFaces();
            autosizeDialog(app2, bodyId);
            requestAnimationFrame(()=> autosizeDialog(app2, bodyId));
            edDlg._mo = observeResize(app2, bodyId);
          },
          close: (appEl)=>{
            cleanupDialogVisuals(edDlg._style, edDlg._mo);
            refresh();
          }
        });
        edDlg.render(true);
      }
    },
    close: (appEl)=> {
      cleanupDialogVisuals(style, dlg._mo);
    }
  });

  dlg.render(true);
}

// -------- helper: guess name for legacy string-only faces --------
function guessNameForImage(img){
  const toks = canvas?.tokens?.placeables ?? [];
  const tHit = toks.find(t => (t?.document?.texture?.src || t?.texture?.src) === img);
  if (tHit) return tHit.document?.name || tHit.name || tHit.actor?.name || "";
  const aHit = game.actors?.find(a => a?.img === img || a?.prototypeToken?.texture?.src === img);
  return aHit?.name || "";
}

// -------------------- Player shop --------------------
async function openShop(shopId, options={}){
  const bodyId = makeUiId("shop");
  const db = await loadAll();
  const shop = db.shops?.[shopId];
  if(!shop) return ui.notifications.warn(`Магазин не найден: ${shopId}`);
  if (shop.sceneOnly && sceneId && shop.sceneId && sceneId !== shop.sceneId && !isGM)
    return ui.notifications.warn("Магазин недоступен на этой сцене.");

  const items = shop.items||[];
  const buyer = options?.buyer || vendorBuyerFromContext(options?.vendorToken) || canvas.tokens.controlled[0]?.actor || game.user.character;
  if(!buyer) return ui.notifications.warn("Выделите токен покупателя или назначьте персонажа игроку перед открытием магазина.");

  const rank = getFixerRank(buyer);
  const discCfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const isFixer = rank>0;
  const preferredCustomer = getPreferredCustomerDiscount(shop, buyer);

  const ledger = await resolveLedger(shop);
  const ledgerPurse = ledger ? Number(ledger.system?.wealth?.value|0) : null;
  const purse = ledgerPurse != null ? ledgerPurse : Math.max(0, Number(shop.purse|0));
  const bb = shop.buyback || {};

  const sellableDocs = (buyer.items ?? []).filter(it => {
    if (saleBlocked(it,buyer) || !acceptsBuyback(shop,it)) return false;
    const sys = it.system ?? {};
    const equippedState = String(sys.equipped ?? "").toLowerCase();
    const isInstalled   = !!sys.isInstalled;
    const isUpgraded    = !!sys.isUpgraded;
    const allowedEquip =
      equippedState === "" || equippedState === "carried" || equippedState === "owned";
    const kind = getItemKind(it);
    return allowedEquip && !isInstalled && !isUpgraded && bb[kind]?.on && getItemMarketValue(it) > 0;
  });
  const sellables = await Promise.all(sellableDocs.map(async it => {
    const kind     = getItemKind(it);
    const basePct  = (bb[kind]?.on ? (bb[kind]?.pct ?? 0) : 0);
    const finalPct = applyFixerBonusToSell(basePct, rank, discCfg);
    const packageInfo = await resolveMarketPackageInfo(it);
    const baseVal  = packageInfo.marketPrice;
    const packageSize = packageInfo.packageSize;
    const offerPack = packageInfo.verified ? Math.max(0, Math.floor(baseVal * finalPct / 100)) : 0;
    const qtyAvail = readStackQty(it);
    return {
      it, kind, baseVal, basePct, finalPct, offer:offerPack, offerPack, packageSize, qtyAvail,
      packageVerified:!!packageInfo.verified,
      packageProvenance:packageInfo.provenance || "unknown"
    };
  }));

  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style");
  style.textContent = makePlayerCSS(accent, bodyId);


  const visible = items.filter(it=>{
    if (!it.fixerOnly) return true;
    if (!isFixer) return false;
    const minR = (it.fixerMinRank==null || it.fixerMinRank==="") ? null : Number(it.fixerMinRank|0);
    return (minR==null) ? true : (rank >= minR);
  });

  const headerPurseHTML = `
  <div class="muted" style="font-size:14px;margin-top:2px">
    Касса продавца: <b class="purse-val">${purse|0}</b> <span class="eb">эб</span>
  </div>`;

  const fixerTag = isFixer
    ? `<div class="fixer-tag"><b>Фиксёр:</b> Вам доступны товары для фиксёров.</div>`
    : "";
  const preferredTag = preferredCustomer && preferredCustomer.pct > 0
    ? `<div class="fixer-tag"><b>Постоянный клиент:</b> ${Math.max(0, Math.min(100, Number(preferredCustomer.pct|0)))}% скидки на покупки здесь.</div>`
    : "";

// Faces (same as 2.0.3)
const facesHTML = (shop.faces?.length)
  ? `<div class="faces faces-large" title="Продавцы">${
      shop.faces.map(F=>{
        const src  = typeof F==="string" ? F : (F?.img||"");
        const name = typeof F==="object" ? (F?.name||"") : guessNameForImage(src);
        const label = name ? `<div class="face-label">${esc(name)}</div>` : "";
        return `<div class="face-block"><img class="face-lg" src="${esc(src)}">${label}</div>`;
      }).join("")
    }</div>`
  : "";

// Items list (player view layout)
const itemsListHTML = visible.length ? visible.map((it,i)=>{
  const soldOut = !it.infinite && (Number(it.qty|0) <= 0);
  const pricing = bodegaBuyPricing(it.price|0, shop, buyer, isFixer, rank, discCfg, !!it.fixerOnly);
  const finalPrice = pricing.price;
  const hasDiscount = finalPrice < (it.price|0);

  const priceLine =
    `<span class="muted price-line">` +
      (hasDiscount
        ? `<del>${it.price|0} <span class="eb">эб</span></del> <b>${finalPrice}</b> <span class="eb">эб</span> <i>(${pricing.appliedPct}% скидки)</i>`
        : `<b>${finalPrice}</b> <span class="eb">эб</span>`) +
      ` — ${it.infinite ? "<span class=\"stock-live\">∞ в наличии</span>" : `<span class="stock-live">${it.qty|0} осталось</span>`}` +
      (Number(it.packageSize || 1) > 1 ? ` — <i>${Number(it.packageSize|0)} ед. за покупку</i>` : '') +
      (it.fixerOnly
        ? " — <i>Fixer-only" + (it.fixerMinRank ? ` (мин. <b>${it.fixerMinRank}</b>)` : "") + "</i>"
        : "") +
      (it.tradeIn || it.stockClass === "tradein" ? ` — <span class="stock-badge tradein">Выкуплено</span>` : (it.dynamicManaged ? ` — <span class="stock-badge dynamic">обновляемые</span>` : "")) +
    `</span>`;

  return `
    <div class="card bodega-stock-row" data-bodega-item-key="${esc(dynamicItemKey(it))}" data-bodega-stock-class="${esc(it.stockClass || (it.dynamicManaged ? 'dynamic' : 'static'))}">
      <div class="item-row">
        <div class="item-left">
          <img class="thumb" src="${it.img || 'icons/svg/box.svg'}">
          <div>
            <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
            ${priceLine}
          </div>
        </div>
        <div class="buy-controls">
          <label class="qty-label">КОЛ-ВО <input class="qty-buy" type="number" min="1" ${it.infinite ? '' : `max="${Math.max(1, Number(it.qty|0))}"`} value="1" ${soldOut ? 'disabled' : ''}></label>
          <button class="btn buy" data-i="${i}" ${soldOut ? 'disabled' : ''}>
            <i class="fas fa-shopping-cart"></i> ${soldOut ? "Распродано" : "Купить"}
          </button>
        </div>
      </div>
    </div>`;
}).join("") : `<div class="muted">В магазине нет товаров.</div>`;

// Sell block
const sellBlockHTML = sellables.length ? `
  <div class="card">
    <div class="title">Продать торговцу</div>
    <div class="muted" style="margin-bottom:6px">
      Касса продавца: <b class="purse-val">${purse|0}</b> <span class="eb">эб</span>.
      ${isFixer ? `Ваш ранг «Деловой хватки» повышает цену выкупа.` : `Без бонуса «Деловой хватки».`}
    </div>
    <div class="list" data-sell-list>
      ${sellables.map((s,idx)=>`
        <div class="item-row" data-sell-i="${idx}">
          <div class="item-left">
            <img class="thumb" src="${s.it.img || 'icons/svg/box.svg'}">
            <div>
              <div class="name" title="${esc(s.it.name)}">${esc(s.it.name)}</div>
              <div class="muted">
                ${!s.packageVerified
                  ? `<span class="stock-badge tradein">НУЖНА ПРОВЕРКА МАСТЕРА</span> • Исходный размер упаковки не подтверждён`
                  : (s.packageSize > 1
                    ? `Упаковка <b>${s.packageSize}</b> за <b>${s.baseVal|0}</b> <span class="eb">эб</span> • Предложение <b>${s.offerPack|0}</b> <span class="eb">эб</span> за полную упаковку (${s.finalPct|0}%)`
                    : `Стоимость <b>${s.baseVal|0}</b> <span class="eb">эб</span> • Предложение <b>${s.offerPack|0}</b> <span class="eb">эб</span> (${s.finalPct|0}%)`)} • 
                <i>В наличии: ${s.qtyAvail}${s.packageVerified && s.packageSize > 1 ? " отдельных единиц" : ''}</i>
              </div>
            </div>
          </div>
          <div class="buy-controls sell-controls">
  <label class="qty-label">КОЛ-ВО
    <input class="qty-sell" type="number" min="1" max="${s.qtyAvail}" value="${Math.min(1, s.qtyAvail)}">
  </label>
  <button class="btn sell" data-sell ${s.packageVerified ? '' : "title=\"Попросить мастера проверить исходный размер упаковки и подтвердить скупку.\""}>${s.packageVerified ? "Продать" : "Проверка мастера"}</button>
</div>

        </div>
      `).join("")}
    </div>
  </div>` : `<div class="card empty-note"><div class="empty-text">Торговец не заинтересован в ваших вещах.</div></div>`
;

// SINGLE content (keep only this one)
const content = `
<div id="${bodyId}">
  <div class="wrap" data-shop="${esc(shop.id)}">
    <div class="title">${esc(shop.name)}</div>
    <div class="shop-header">
      ${facesHTML}
      <div class="shop-head-center">
        <div class="buyer-line">Покупатель: ${esc(buyer.name)}</div>
        ${headerPurseHTML}
      </div>
    </div>
    ${fixerTag}
    ${preferredTag}
    <div class="list" data-list>
      ${itemsListHTML}
    </div>
    ${sellBlockHTML}
  </div>
</div>`;


  const dlg = new Dialog({
    title: "Магазин",
    content,
    buttons: { close: { label:"Закрыть" } },
    width: 820,
    render: (html)=>{
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      forceFooterButtons(app, accent);
      const root = html[0].querySelector(`#${bodyId}`);

      // BUY handler: every purchase is GM-authoritative and serialized per Bodega.
      root.querySelector("[data-list]")?.addEventListener("click", async (ev)=>{
        const buyButton = ev.target.closest(".buy");
        const iStr = buyButton?.getAttribute("data-i");
        if (iStr == null) return;
        const row = buyButton.closest(".bodega-stock-row");
        if (!row || row.dataset.busy === "1" || buyButton.dataset.soldOut === "1") return;

        const visibleNow = (shop.items||[]).filter(it=>{
          if (!it.fixerOnly) return true;
          if (!isFixer) return false;
          const minR = (it.fixerMinRank==null || it.fixerMinRank==="") ? null : Number(it.fixerMinRank|0);
          return (minR==null) ? true : (rank >= minR);
        });
        const visibleIndex = Number(iStr);
        const it = visibleNow[visibleIndex];
        if (!it) return ui.notifications.warn("Товар изменился. Откройте магазин заново.");
        const sourceIndex = shop.items.indexOf(it);
        if (!it.infinite && Number(it.qty|0) <= 0) return ui.notifications.warn(`${it.name} закончился.`);

        const qtyInput = row.querySelector(".qty-buy");
        const requested = Math.max(1, Number(qtyInput?.value ?? 1) | 0);
        const available = it.infinite ? Number.POSITIVE_INFINITY : Math.max(0, Number(it.qty|0));
        const qty = it.infinite ? requested : Math.min(requested, available);
        if (!qty) return ui.notifications.warn(`${it.name} закончился.`);

        const payload = {
          nonce:bodegaNonce(),
          userId:game.user?.id || null,
          shopId:shop.id,
          buyerUuid:buyer.uuid,
          index:sourceIndex,
          itemKey:dynamicItemKey(it),
          stockClass:String(it.stockClass || (it.dynamicManaged ? "dynamic" : "static")),
          price:Math.max(0, Number(it.price|0)),
          qty
        };

        row.dataset.busy = "1";
        buyButton.disabled = true;
        buyButton.innerHTML = "<i class=\"fas fa-spinner fa-spin\"></i> Обработка";
        if (qtyInput) qtyInput.disabled = true;

        const finish = (result) => {
          row.dataset.busy = "";
          if (Number.isFinite(result?.qtyRemaining)) updateOpenShopStock(shop.id, result.itemKey || payload.itemKey, result.stockClass || payload.stockClass, result.qtyRemaining);
          if (result?.ok){
            if (it.infinite){ buyButton.disabled = false; buyButton.innerHTML = "<i class=\"fas fa-shopping-cart\"></i> Купить"; if (qtyInput) qtyInput.disabled = false; }
            ui.notifications.info(`${it.name} ×${result.qtyPurchased || qty} куплено.`);
          } else {
            if (buyButton.dataset.soldOut !== "1"){ buyButton.disabled = false; buyButton.innerHTML = "<i class=\"fas fa-shopping-cart\"></i> Купить"; if (qtyInput) qtyInput.disabled = false; }
            ui.notifications.warn(result?.message || "Покупка не удалась.");
          }
        };

        if (game.user?.isGM){
          try { finish(await gmProcessPurchase(payload)); }
          catch(error){ console.error(error); finish({ok:false,message:"Ошибка покупки. Проверьте консоль."}); }
          return;
        }

        let acked = false;
        const onAck = (message) => {
          if (message?.nonce !== payload.nonce) return;
          if (message.userId && message.userId !== game.user?.id) return;
          if (message.op !== "purchase-done" && message.op !== "purchase-failed") return;
          acked = true;
          marketSocket.off(SOCKET, onAck);
          finish({
            ok:message.op === "purchase-done",
            message:message.message,
            itemKey:message.itemKey, stockClass:message.stockClass,
            qtyRemaining:message.qtyRemaining, qtyPurchased:message.qtyPurchased,
            total:message.total, purse:message.purse
          });
        };
        marketSocket.on(SOCKET, onAck);
        marketSocket.emit(SOCKET, {op:"gm-purchase", payload});

        setTimeout(() => {
          if (acked) return;
          marketSocket.off(SOCKET, onAck);
          finish({ok:false, message:"Мастер не подтвердил покупку. Дождитесь ответа перед повтором."});
        }, 4500);
      });

      // SELL handler: execute on the GM, then fall back to a chat approval card if no ACK arrives.
      root.querySelector("[data-sell-list]")?.addEventListener("click", async (ev) => {
        const row = ev.target.closest("[data-sell-i]");
        if (!row || !ev.target.closest(".sell")) return;
        if (row.dataset.busy === "1") return;
        row.dataset.busy = "1";
        row.querySelector(".sell")?.setAttribute("disabled", "true");

        const idx = Number(row.getAttribute("data-sell-i")|0);
        const entry = sellables[idx];
        if (!entry) {
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
          return;
        }
        if (!entry.packageVerified) {
          const freshReview = buyer.items.get(entry.it.id)
            || buyer.items.find(i => i.name === entry.it.name && getItemMarketValue(i) === entry.baseVal);
          if (!freshReview) {
            ui.notifications.warn("Предмет изменился. Откройте магазин заново.");
            row.dataset.busy = "";
            row.querySelector(".sell")?.removeAttribute("disabled");
            return;
          }

          const qtyInput = Number(row.querySelector(".qty-sell")?.value ?? 1) | 0;
          const qty = Math.max(1, Math.min(readStackQty(freshReview), qtyInput || 1));
          const payload = {
            nonce:bodegaNonce(),
            userId:game.user?.id || null,
            shopId:shop.id,
            sellerUuid:buyer.uuid, userId:game.user.id,
            itemId:freshReview.id,
            itemName:freshReview.name,
            baseVal:Math.max(0, getItemMarketValue(freshReview)|0),
            qty
          };

          const reviewButton = row.querySelector(".sell");
          const reviewQty = row.querySelector(".qty-sell");
          if (reviewButton) reviewButton.innerHTML = "<i class=\"fas fa-user-check\"></i> Ожидание мастера";
          if (reviewQty) reviewQty.disabled = true;

          const finishReview = (result) => {
            if (result?.ok) {
              row.remove();
              ui.notifications.info(`Мастер завершил скупку на сумму ${freshReview.name}.`);
              return;
            }
            row.dataset.busy = "";
            if (reviewButton) {
              reviewButton.disabled = false;
              reviewButton.innerHTML = "Проверка мастера";
            }
            if (reviewQty) reviewQty.disabled = false;
            if (result?.message) ui.notifications.warn(result.message);
          };

          if (game.user?.isGM) {
            await openGMReviewBuyback(payload, finishReview);
            return;
          }

          if (!game.users?.activeGM) {
            finishReview({ok:false, message:"Нет подключённого мастера для проверки скупки."});
            return;
          }

          let acked = false;
          const onReviewAck = (message) => {
            if (message?.nonce !== payload.nonce) return;
            if (message.userId && message.userId !== game.user?.id) return;
            if (message.op !== "buyback-done" && message.op !== "buyback-failed") return;
            acked = true;
            marketSocket.off(SOCKET, onReviewAck);
            finishReview({ok:message.op === "buyback-done", message:message.message});
          };
          marketSocket.on(SOCKET, onReviewAck);
          marketSocket.emit(SOCKET, {op:"gm-buyback-review", payload});
          ui.notifications.info("Запрос отправлен мастеру для проверки упаковки.");

          return;
        }

        const fresh = buyer.items.get(entry.it.id)
          || buyer.items.find(i => i.name === entry.it.name && getItemMarketValue(i) === entry.baseVal);
        if (!fresh) {
          ui.notifications.warn("Предмет изменился. Откройте магазин заново.");
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
          return;
        }

        const rankNow = getFixerRank(buyer);
        const finalPct = applyFixerBonusToSell(entry.basePct, rankNow, discCfg);
        const packageInfoNow = await resolveMarketPackageInfo(fresh);
        if (!packageInfoNow.verified) {
          ui.notifications.warn("Исходная упаковка не подтверждена. Требуется ручная проверка мастера.");
          row.dataset.busy = "";
          row.querySelector(".sell")?.setAttribute("disabled", "true");
          row.querySelector(".qty-sell")?.setAttribute("disabled", "true");
          return;
        }
        const qtyInput = Number(row.querySelector(".qty-sell")?.value ?? 1) | 0;
        const qty = Math.max(1, Math.min(readStackQty(fresh), qtyInput || 1));
        const offerTotal = proportionalBuybackTotal(packageInfoNow.marketPrice, finalPct, qty, packageInfoNow.packageSize);
        if (offerTotal <= 0) {
          ui.notifications.warn(`Цена скупки этого количества меньше 1 эб. Продайте больше за одну сделку.`);
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
          return;
        }

        const payload = {
          nonce:bodegaNonce(),
          shopId:shop.id,
          sellerUuid:buyer.uuid, userId:game.user.id,
          itemId:fresh.id,
          itemName:fresh.name,
          baseVal:packageInfoNow.marketPrice,
          packageSize:packageInfoNow.packageSize,
          qty
        };

        if (game.user?.isGM) {
          const result = await gmProcessBuyback(payload);
          if (result?.ok) row.remove();
          else {
            row.dataset.busy = "";
            row.querySelector(".sell")?.removeAttribute("disabled");
          }
          return;
        }

        let acked = false;
        const onAck = (message) => {
          if (message?.nonce !== payload.nonce) return;
          if (message.op !== "buyback-done" && message.op !== "buyback-failed") return;
          acked = true;
          marketSocket.off(SOCKET, onAck);
          if (message.op === "buyback-done") {
            row.remove();
            ui.notifications.info("Мастер завершил продажу.");
          } else {
            row.dataset.busy = "";
            row.querySelector(".sell")?.removeAttribute("disabled");
            ui.notifications.warn(message.message || "Мастер не смог завершить скупку.");
          }
        };
        marketSocket.on(SOCKET, onAck);
        marketSocket.emit(SOCKET, {op:"gm-buyback", payload});
        ui.notifications.info("Продажа отправлена мастеру.");

        setTimeout(async () => {
          if (acked) return;
          marketSocket.off(SOCKET, onAck);
          const link = `<button type="button" class="button" data-bodega-approve="${b2a(payload)}"><i class="fas fa-check"></i> Одобрить</button>`;
          await ChatMessage.create({
            speaker:ChatMessage.getSpeaker({alias:"Магазин"}),
            content:`<b>Одобрить скупку (резервный запрос)</b>: <b>${esc(fresh.name)}</b> ×${qty}${packageInfoNow.packageSize > 1 ? ` отдельных единиц (${packageInfoNow.packageSize}/рыночная упаковка)` : ''} за <b>${offerTotal}</b> эб. ${link}`
          });
          ui.notifications.warn("Нет ответа мастера — запрос подтверждения отправлен в чат.");
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
        }, 1000);
      });
    },
    close: () => {
      cleanupDialogVisuals(style);
    }
  });

  dlg.render(true);
}

// -------------------- item/wealth helpers --------------------
async function adjustWealth(actor, delta, reason="Операция магазина"){
  const w = foundry.utils.deepClone(actor.system?.wealth ?? {});
  const before = w.value ?? 0;
  w.value = before + (delta|0);
  w.transactions = (w.transactions ?? []);
  const dir = delta>=0 ? "Увеличено" : "Уменьшено";
  w.transactions.push([`${dir} на ${Math.abs(delta|0)} получателю ${w.value|0}`, reason]);
  await actor.update({"system.wealth": w});
}
async function giveItem(actor, itemDoc){
  const data = itemDoc.toObject(); delete data._id;
  return actor.createEmbeddedDocuments("Item", [data]);
}
async function giveFromShop(actor, shopItem){
  let doc = shopItem.uuid ? await byUUID(shopItem.uuid) : null;
  if (doc) return giveItem(actor, doc);
  if (shopItem.raw){
    const data = foundry.utils.duplicate(shopItem.raw);
    delete data._id;
    return actor.createEmbeddedDocuments("Item", [data]);
  }
  ui.notifications.warn("Предмет больше недоступен для продажи.");
  return null;
}
async function byUUID(uuid){ try{ return await fromUuid(uuid); }catch{ return null; } }

// -------------------- RollTable resolver/draw --------------------
async function findRollTable(ref){
  const tables = await findDynamicRollTables(ref);
  return tables[0] || null;
}
async function findRollTables(ref){ return findDynamicRollTables(ref); }
async function drawFromTable(ref){
  const tables = await findDynamicRollTables(ref); if (!tables.length) return null;
  const t = tables[dynamicRandomInt(0, tables.length-1)];
  const roll = await rollDynamicTable(t);
  for (const result of dynamicShuffle(roll?.results || [])){
    const doc = await resolveDynamicTableResultDocument(result);
    if (doc) return doc;
  }
  return null;
}

// -------------------- Module API and lifecycle --------------------
function parseShopId(input) {
  if (input == null) return null;
  if (typeof input === "string") {
    const match = input.match(/id\s*=\s*([^,;]+)$/i);
    return String(match ? match[1] : input).replace(/[<>"'()\[\]\s]/g, "") || null;
  }
  if (Array.isArray(input)) return parseShopId(input[0]?.id ?? input[0]);
  if (typeof input === "object") return parseShopId(input.id);
  return null;
}

async function launch(input = null) {
  const tile = await findTriggerTile(input);
  const boundId = tile ? bodegaIdFromTile(tile) : null;
  if (boundId) return openShop(boundId);
  const shopId = parseShopId(input);
  if (shopId) return openShop(shopId);
  if (!game.user?.isGM) return ui.notifications.warn("Тайл не привязан к магазину. Попросите мастера настроить его.");
  return openAdmin();
}

function exposeAPI() {
  const api = {
    version:MODULE_VERSION,
    openAdmin,
    openOptions,
    openShop,
    openBoundTile,
    openVendorToken:openShopFromVendorToken,
    resolveVendorToken:resolveBodegaForVendorToken,
    resolveVendorTokenSync:resolveBodegaForVendorTokenSync,
    rebindVendorInteraction:()=>bindPlayerVendorCanvasInteraction(),
    playerVendorInteractionMode,
    openTile:(tile) => { const id = bodegaIdFromTile(tile); return id ? openShop(id) : ui.notifications.warn("Этот тайл не привязан к магазину."); },
    bindSelectedTiles:bindShopToTiles,
    unbindSelectedTiles,
    createTileHelperMacro,
    launch,
    bind:bindBodegaBridge,
    loadAll,
    saveAll,
    findItemAnywhere,
    findItemByNameFromPacks,
    resolveItemPacks:resolveDynamicItemPacks,
    findRollTable,
    findRollTables,
    drawFromTable,
    adjustWealth:(...args)=>{requireMarketGM();return adjustWealth(...args);},
    readStackQty,
    writeStackQty:(...args)=>{requireMarketGM();return writeStackQty(...args);},
    giveFromShopQty:(...args)=>{requireMarketGM();return giveFromShopQty(...args);},
    quoteBuy:(shop,item,buyer,db)=>{ const rank=getFixerRank(buyer); return bodegaBuyPricing(item.price|0,shop,buyer,rank>0,rank,db.defaults?.fixerDiscounts??defaultDB().defaults.fixerDiscounts,!!item.fixerOnly); },
    quoteSell:async(shop,item,buyer,db,qty=1)=>{ const kind=getItemKind(item),bb=shop.buyback?.[kind]; if(!bb?.on||saleBlocked(item,buyer)||!acceptsBuyback(shop,item))return null; const pack=await resolveMarketPackageInfo(item); const pct=applyFixerBonusToSell(bb.pct|0,getFixerRank(buyer),db.defaults?.fixerDiscounts??defaultDB().defaults.fixerDiscounts); return {verified:pack.verified,size:pack.packageSize,market:pack.marketPrice,pct,total:proportionalBuybackTotal(pack.marketPrice,pct,qty,pack.packageSize)}; },
    reviewBuyback:payload=>new Promise(resolve=>openGMReviewBuyback(payload,resolve)),
    gmProcessBuyback,
    gmProcessPurchase,
    processDynamicInventory,
    generateDynamicStock:async (shopId, replace=false) => {
      requireMarketGM();
      const db = await loadAll(); const shop = db.shops?.[shopId]; if (!shop) return null;
      shop.dynamic = normalizeDynamicSettings(shop.dynamic); shop.dynamic.enabled = true;
      await fillDynamicStock(shop, {replace, defaults:db.defaults, now:calendarTimestamp()});
      if (getSimpleCalendar() && !shop.dynamic.initializedAt) await initializeDynamicShop(shop, db.defaults, calendarTimestamp(), {markPastTraffic:true});
      await saveAll(db); return shop;
    },
    runCustomerCycle:async (shopId) => {
      requireMarketGM();
      const db = await loadAll(); const shop = db.shops?.[shopId]; if (!shop) return null;
      const result = await runNpcTraffic(shop, 1, calendarTimestamp()); await saveAll(db); return result;
    },
    restockNow:async (shopId) => {
      requireMarketGM();
      const db = await loadAll(); const shop = db.shops?.[shopId]; if (!shop) return null;
      await restockDynamicShop(shop, {defaults:db.defaults, now:calendarTimestamp()}); if (getSimpleCalendar()) scheduleNextRestock(shop, calendarTimestamp()); await saveAll(db); return shop;
    }
  };
  game.bodega = api;
  globalThis.Bodega = api;
}

componentHooks.once("init", () => {
  ensureSetting();
});

componentHooks.once("ready", () => {
  isGM = !!game.user?.isGM;
  sceneId = canvas?.scene?.id ?? null;
  exposeAPI();
  bindBodegaBridge();
  bindCalendarHooks();
  bindPlayerVendorCanvasInteraction();
  console.log(`Bodega | Ready v${MODULE_VERSION}. Existing bodega.db shop data is available.`);
});

componentHooks.on("canvasReady", (canvasInstance) => {
  sceneId = canvasInstance?.scene?.id ?? canvas?.scene?.id ?? null;
  bindPlayerVendorCanvasInteraction();
});

componentHooks.on("renderTokenHUD", async (hud, html) => {
  try{
    const token = vendorTokenDocument(hud?.object || hud?.document || hud);
    if (!token) return;
    const match = await resolveBodegaForVendorToken(token);
    if (!match) return;
    const root = html?.[0] || html;
    if (!root?.querySelector || root.querySelector(".bodega-token-hud")) return;
    ensureVendorHudStyle();
    const button = document.createElement("div");
    button.className = "control-icon bodega-token-hud";
    button.title = `Открыть магазин — ${match.shop.name}`;
    button.dataset.tooltip = `Открыть магазин — ${match.shop.name}`;
    button.innerHTML = '<i class="fas fa-store" aria-hidden="true"></i>';
    button.addEventListener("click", async ev => {
      ev.preventDefault(); ev.stopPropagation();
      await openShopFromVendorToken(token);
    });
    const right = root.querySelector(".col.right") || root.querySelector(".right");
    const left = root.querySelector(".col.left") || root.querySelector(".left");
    (right || left || root).appendChild(button);
  }catch(err){ console.warn("Bodega | Token HUD binding render failed", err); }
});

componentHooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokenControls = controls.find(control => control.name === "token");
  if (!tokenControls) return;
  tokenControls.tools ||= [];
  if (tokenControls.tools.some(tool => tool.name === "bodega-manager")) return;
  tokenControls.tools.push({
    name:"bodega-manager",
    title:"Торговля — магазины",
    icon:"fas fa-store",
    button:true,
    visible:true,
    onClick:() => openAdmin()
  });
});

})();

function getFixerRank(actor) { return fixerRank(actor); }
