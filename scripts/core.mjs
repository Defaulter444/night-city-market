export const ID = 'night-city-market';
const CHANNEL = `module.${ID}`;
let queue = Promise.resolve();
const completed = new Map();
export const originalModules=['choom-trade','bodega','diner-manager','vendit'];
export function activeOriginals(){return originalModules.filter(id=>game.modules?.get(id)?.active);}
/** Check the current role at each entry point, never a rendered/cached GM flag. */
export function requireMarketGM(){
  if(!globalThis.game?.user?.isGM)throw Error('Настройки и управление торговлей доступны только Мастеру.');
  return true;
}
export function canOpenMarketTab(tab,user=globalThis.game?.user){
  return ['home','trade','bodega','diner','vendit','help'].includes(tab)
    || (!!user?.isGM&&['settings','quick'].includes(tab));
}
// Register normally, but leave the originals' APIs and listeners alone on conflict.
export const componentHooks={
  on(event,callback){if(event==='getSceneControlButtons')return null;return Hooks.on(event,(...args)=>{if(!activeOriginals().length)return callback(...args);});},
  once(event,callback){return Hooks.once(event,(...args)=>{if(!activeOriginals().length)return callback(...args);});}
};
export function fitDialog(app){
  if(!app)return;
  app.style.maxWidth=`${Math.max(280,window.innerWidth-24)}px`;
  app.style.maxHeight=`${Math.max(240,window.innerHeight-24)}px`;
  const rect=app.getBoundingClientRect();
  app.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-rect.width-12))}px`;
  app.style.top=`${Math.max(12,Math.min(rect.top,window.innerHeight-rect.height-12))}px`;
}

/** All four departments use one GM transaction queue, including local GM purchases. */
export function transaction(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}
export function onceTransaction(key, task) {
  if (!key) return transaction(task);
  if (!completed.has(key)) {
    const result=transaction(task);
    completed.set(key, result);
    result.then(value=>{if(!value?.ok)completed.delete(key);},()=>completed.delete(key));
    if (completed.size > 1000) completed.delete(completed.keys().next().value);
  }
  return completed.get(key);
}

const requests = {
  trade: new Set(['transfer-request']),
  bodega: new Set(['gm-purchase', 'gm-buyback', 'gm-buyback-review']),
  diner: new Set(['order']),
  vendit: new Set(['purchase'])
};
/** Foundry 12 supplies senderId server-side. Never accept userId claimed by a client. */
export function validatedPacket(component, packet, senderId, users) {
  if (packet?.protocol !== 'ncm-1' || packet.component !== component) return null;
  const sender = users.get(senderId);
  if (!sender?.active || !packet.data || typeof packet.data !== 'object') return null;
  const data = structuredClone(packet.data);
  if (requests[component]?.has(data.op)) {
    data.userId = senderId;
    if (data.payload) data.payload.userId = senderId;
  } else if (!sender.isGM) return null;
  return data;
}
export function componentSocket(component) {
  const callbacks = new Map();
  return {
    on(_channel, callback) {
      const wrapped = (packet, senderId) => {
        const data = validatedPacket(component, packet, senderId, game.users);
        if (data) return callback(data, senderId);
      };
      callbacks.set(callback, wrapped);
      game.socket.on(CHANNEL, wrapped);
    },
    off(_channel, callback) {
      const wrapped = callbacks.get(callback);
      if (wrapped) game.socket.off(CHANNEL, wrapped);
      callbacks.delete(callback);
    },
    emit(_channel, data) {
      const packet = {protocol:'ncm-1', component, data};
      if (requests[component]?.has(data.op)) {
        const gm = game.users.activeGM;
        if (!gm) { ui.notifications.warn('Для торговли нужен подключённый мастер.'); return; }
        game.socket.emit(CHANNEL, packet, {recipients:[gm.id]});
      } else game.socket.emit(CHANNEL, packet);
    }
  };
}

export const textName = value => String(value ?? '').toLowerCase().replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export const kindLabel = kind => ({Ammo:'Боеприпасы',Armor:'Броня',Clothing:'Одежда',Cyberdeck:'Кибердеки',Cyberware:'Киберимпланты',Drug:'Препараты / еда',Gear:'Снаряжение',Upgrade:'Улучшения',Vehicle:'Транспорт',Weapon:'Оружие'})[kind]??kind;
export function saleBlocked(item,actor){
  if(lifestyleItem(item)||intrinsicAttack(item)||item?.flags?.[ID]?.coveredServing)return true;
  if(item?.system?.equipped==='equipped'||item?.system?.installedItems?.list?.length)return true;
  return !!actor?.system?.installedItems?.list?.includes(item.id)||[...(actor?.items??[])].some(parent=>parent.system?.installedItems?.list?.includes(item.id));
}
export function requireCustomer(actor,userId,shop) {
  if(!game.user?.isGM || (game.users.activeGM && game.users.activeGM.id!==game.user.id)) throw Error('Операцию выполняет только основной мастер.');
  const user=game.users.get(userId);
  if(!user || !actor || actor.documentName!=='Actor') throw Error('Не найден покупатель или отправитель запроса.');
  if(!user.isGM && !actor.testUserPermission(user,'OWNER')) throw Error('Нет прав владельца этого персонажа.');
  if(!user.isGM && shop?.sceneOnly !== false && shop?.sceneId && user.viewedScene!==shop.sceneId) throw Error('Торговая точка недоступна на текущей сцене.');
}
export async function requireProximity(shop,buyer,userId,range=2) {
  const markerUuid=shop.tileUuid||shop.quick?.markerUuid;
  if(game.users.get(userId)?.isGM || !markerUuid)return;
  const tile=await fromUuid(markerUuid);
  if(!tile?.parent)throw Error('Тайл автомата не найден. Обратитесь к мастеру.');
  const scene=tile.parent,user=game.users.get(userId);
  if(user?.viewedScene!==scene.id)throw Error('Автомат находится на другой сцене.');
  const size=Number(scene.grid?.size)||100;
  const unit=tile.documentName==='Token'?size:1;
  const center={x:tile.x+tile.width*unit/2,y:tile.y+tile.height*unit/2};
  const tokens=[...scene.tokens].filter(t=>t.actorId===buyer.id||t.actor?.uuid===buyer.uuid);
  const near=t=>Math.hypot(t.x+t.width*size/2-center.x,t.y+t.height*size/2-center.y)/size<=Math.max(0,Number(range)||0);
  if(!tokens.some(near))throw Error('Подведите токен своего персонажа ближе к автомату.');
}
export function foodTierId(item) {
  const explicit = item?.flags?.[ID]?.foodTier;
  if (explicit) return explicit;
  const data = item?.flags?.['night-city-agent']?.lifestyle;
  if (data?.kind === 'food') return ({100:'kibble',300:'generic-prepak',600:'good-prepak',1500:'fresh-food'})[Number(data.monthly)] ?? 'none';
  const n = textName(item?.flags?.babele?.originalName || item?.name);
  if(/kibble pack|пачка киббл|пакет киббл|упаковка киббл/.test(n))return 'none';
  if (/fresh food|свеж(?:ая|ей|ие|ую) (?:ед|пищ|продукт)/.test(n)) return 'fresh-food';
  if (/good pre ?pa(?:k|ck)|хорош(?:их|ие|иех) полуфабрикат|качественн.*полуфабрикат/.test(n)) return 'good-prepak';
  if (/generic pre ?pa(?:k|ck)|обычн.*полуфабрикат/.test(n)) return 'generic-prepak';
  if (/kibble|киббл|кибл/.test(n)) return 'kibble';
  return 'none';
}
export function housingItem(item) {
  if(item?.flags?.['night-city-agent']?.lifestyle?.kind === 'housing') return true;
  const n=textName(item?.flags?.babele?.originalName || item?.name);
  return /^(?:жилье|housing)\b/.test(n) || /living (?:on the street|in a vehicle)|cube hotel|cargo container|studio apartment|two bedroom apartment|(?:upscale|corporate) conapt|beaverville (?:house|mcmansion)|luxury penthouse|куб отель|грузовой контейнер|квартира студия|двуспальная квартира|двухкомнатная квартира|конапт|роскошный пентхаус|дом в бивервилле|особняк в бивервилле/.test(n);
}
export function lifestyleItem(item) {
  return !!item?.flags?.['night-city-agent']?.lifestyle || foodTierId(item)!=='none' && /образ жизни|lifestyle|eb\s*\/\s*month|эб\s*\/\s*мес/i.test(item?.name||'') || housingItem(item) || /(?:eb|эб|€\$)\s*\/\s*(?:month|мес)/i.test(item?.name||'');
}
export function intrinsicAttack(item) {
  if(item?.type!=='weapon') return false;
  const n=textName(item?.flags?.babele?.originalName || item?.name);
  return ['unarmed','thrown weapon','без оружия','безоружный','безоружная атака','метательное оружие','рукопашная атака'].includes(n);
}
export function fixerRank(actor) {
  let rank=0;
  for(const item of actor?.items??[]) {
    if(!['role','roleAbility'].includes(item.type)) continue;
    const n=textName(item?.flags?.babele?.originalName || item.name);
    const abilities=(item.system?.abilities??[]);
    const matching=/^(?:fixer|operator|фиксер|делец|оператор|деловая хватка)$/.test(n) || (Array.isArray(abilities)&&abilities.some(a=>/^(?:operator|делец|оператор|деловая хватка)$/.test(textName(a.name))));
    if(matching) rank=Math.max(rank,Number(item.system?.rank??0));
  }
  return Math.max(0,Math.min(10,rank||0));
}
