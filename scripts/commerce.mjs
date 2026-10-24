import {ID,componentSocket} from './core.mjs';
import {requestVenditPurchase} from '../vendor/vendit.mjs';
import {requestOrder,quoteOrder} from '../vendor/diner.mjs';
import {nightAccess,marketHour} from './night-market.mjs';
export {quoteOrder};
export const DEPARTMENTS={bodega:{key:'bodegaDb',collection:'shops',title:'Магазины',icon:'store'},diner:{key:'dinerDb',collection:'diners',title:'Кафе',icon:'mug-hot'},vendit:{key:'venditDb',collection:'vendits',title:'Автоматы',icon:'cash-register'}};
export function readDepartment(part){const spec=DEPARTMENTS[part];if(!spec)throw Error('Неизвестный раздел');return foundry.utils.deepClone(game.settings.get(ID,spec.key));}
export function canVisit(shop,user=game.user,scene=canvas.scene){return !!shop&&(user.isGM||shop.sceneOnly===false||!shop.sceneId||shop.sceneId===scene?.id);}
export function getPoint(part,id){const spec=DEPARTMENTS[part];return readDepartment(part)[spec.collection]?.[id];}
const bridge=componentSocket('bodega');
function bodegaRequest(op,payload){
  if(!game.users.activeGM)throw Error('Для сделки нужен подключённый Мастер.');
  if(game.users.activeGM.id===game.user.id){
    if(op==='gm-purchase')return game.bodega.gmProcessPurchase(payload);
    if(op==='gm-buyback-review')return game.bodega.reviewBuyback(payload);
    return game.bodega.gmProcessBuyback(payload);
  }
  return new Promise((resolve,reject)=>{
    const finish=msg=>{if(msg.nonce!==payload.nonce||!/(?:purchase|buyback)-(?:done|failed)/.test(msg.op))return;clearTimeout(timer);bridge.off('',finish);resolve({...msg,ok:msg.op.endsWith('-done')});};
    const timer=setTimeout(()=>{bridge.off('',finish);reject(Error('Ответ Мастера не получен. Проверьте чек и инвентарь перед повтором.'));},op==='gm-buyback-review'?300000:15000);
    bridge.on('',finish);bridge.emit('',{op,payload});
  });
}
export async function buy(part,id,index,actor,qty=1){
  if(!actor?.testUserPermission(game.user,'OWNER'))throw Error('Выберите своего персонажа.');
  const shop=getPoint(part,id),item=shop?.items?.[index];
  if(!canVisit(shop)||!item)throw Error('Точка или товар больше недоступны.');
  const night=nightAccess(shop,actor,{isGM:game.user.isGM,hour:marketHour()});if(!night.open)throw Error(night.reason);
  if(part==='diner')return requestOrder(id,item.id,actor);
  if(part==='vendit')return requestVenditPurchase({shopId:id,index,itemUuid:item.uuid,buyerUuid:actor.uuid});
  return bodegaRequest('gm-purchase',{nonce:foundry.utils.randomID(),userId:game.user.id,shopId:id,index,itemKey:item.uuid||item.name,stockClass:item.stockClass,price:item.price,buyerUuid:actor.uuid,qty});
}
export async function sell(id,itemId,actor,qty=1){
  const db=readDepartment('bodega'),shop=db.shops?.[id],item=actor?.items.get(itemId);
  if(!actor?.testUserPermission(game.user,'OWNER')||!canVisit(shop)||!item)throw Error('Предмет недоступен.');
  const night=nightAccess(shop,actor,{isGM:game.user.isGM,hour:marketHour()});if(!night.open)throw Error(night.reason);
  const quote=await game.bodega.quoteSell(shop,item,actor,db,qty);
  if(!quote)throw Error('Торговец не покупает этот предмет.');
  return bodegaRequest(quote.verified?'gm-buyback':'gm-buyback-review',{nonce:foundry.utils.randomID(),userId:game.user.id,shopId:id,sellerUuid:actor.uuid,itemId,qty});
}
