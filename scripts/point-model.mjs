import {lifestyleItem,intrinsicAttack,textName} from './core.mjs';
export const PRESETS={
  street:{label:'Уличная лавка',description:'Бытовое снаряжение, одежда и обычные патроны. Без оружия и отличного качества.',part:'bodega',icon:'store',img:'modules/night-city-market/assets/bodega.webp',types:['gear','clothing','ammo'],weights:{gear:3,clothing:1,ammo:1},stockCount:40,maxPrice:100,qty:4,purse:1000},
  weapons:{label:'Оружейник',description:'Оружие, патроны, броня и их улучшения. Без бытовых вещей и имплантов.',part:'bodega',icon:'gun',img:'modules/night-city-market/assets/bodega.webp',types:['weapon','ammo','armor','itemUpgrade'],weights:{weapon:4,ammo:2,armor:1,itemUpgrade:1},stockCount:64,maxPrice:1000,qty:3,purse:3000},
  diner:{label:'Кафе',description:'Еда и напитки. Без бытовой техники и препаратов.',part:'diner',icon:'mug-hot',img:'systems/cyberpunk-red-core/icons/compendium/cargo-containers-and-cube-hotels/koff-popper.svg',types:['gear'],stockCount:24,maxPrice:50,qty:1,purse:0},
  vendit:{label:'Автомат с едой',description:'Упакованная еда и напитки. Без техники и препаратов.',part:'vendit',icon:'cash-register',img:'modules/night-city-market/assets/Vendit.webp',types:['gear'],stockCount:16,maxPrice:50,qty:8,purse:0}
};
export const priceOf=item=>Number(item?.system?.price?.market??item?.system?.price??0);
export function stockCount(value,preset){
  const count=Number(value??preset.stockCount);
  if(!Number.isInteger(count)||count<1||count>120)throw Error('Укажите от 1 до 120 разных товаров.');
  return count;
}
export const stockKey=item=>[item.type,textName(item.flags?.babele?.originalName||item.name),item.system?.quality||'',item.system?.weaponType||item.system?.type||'',item.system?.variety||''].join(':');
const subgroup=item=>item.type==='weapon'?item.system?.weaponType||'other':item.type==='ammo'?item.system?.variety||'other':item.type==='itemUpgrade'?item.system?.type||'other':item.type==='armor'?(item.system?.isShield?'shield':item.system?.isHeadLocation?'head':'body'):item.system?.style||'other';
export function pickStock(candidates,preset,random=Math.random,count=preset.stockCount){
  const limit=stockCount(count,preset),unique=new Map();
  for(const item of candidates)if(!unique.has(stockKey(item)))unique.set(stockKey(item),item);
  const pool=[...unique.values()].map(item=>({item,order:random()})).sort((a,b)=>a.order-b.order).map(e=>e.item);
  // Round-robin within each type avoids filling a gun shop with one ammunition variety.
  const groups=new Map(preset.types.map(type=>[type,new Map()]));
  for(const item of pool){const group=groups.get(item.type);if(!group)continue;const key=subgroup(item);if(!group.has(key))group.set(key,[]);group.get(key).push(item);}
  const queues=new Map();
  for(const [type,group] of groups){const queue=[];while([...group.values()].some(g=>g.length))for(const bucket of group.values())if(bucket.length)queue.push(bucket.shift());queues.set(type,queue);}
  const selected=[];
  const take=type=>{const queue=queues.get(type);if(selected.length<limit&&queue.length)selected.push(queue.shift());};
  for(const type of preset.types)take(type);
  while(selected.length<limit&&[...queues.values()].some(q=>q.length))for(const type of preset.types)for(let n=0;n<(preset.weights?.[type]||1);n++)take(type);
  return selected;
}
export function eligibleStock(item,preset){
  if(!item||!preset.types.includes(item.type)||!Number.isFinite(priceOf(item))||priceOf(item)<=0||priceOf(item)>preset.maxPrice)return false;
  if(lifestyleItem(item)||intrinsicAttack(item)||item.system?.installedItems?.list?.length||item.flags?.['night-city-market']?.coveredServing)return false;
  // Elflines virtual equipment has CPR document types, but is not physical merchandise.
  if(/^ELO(?:\s|$)/i.test(item.system?.source?.book||''))return false;
  const name=textName(item.flags?.babele?.originalName||item.name);
  if(/^(?:тест|test|audit)(?:\s|$)/i.test(name))return false;
  if(preset===PRESETS.street){
    if(item.system?.quality==='excellent')return false;
    if(item.type==='ammo'&&(item.system?.type!=='basic'||!['arrow','heavyPistol','medPistol','rifle','shotgunShell','shotgunSlug','vHeavyPistol'].includes(item.system?.variety)))return false;
  }
  if(item.type==='itemUpgrade'&&!['weapon','armor'].includes(item.system?.type))return false;
  if(['diner','vendit'].includes(preset.part)){
    if(/(?:maker|popper|purifier|filter|tank|well|machine|аппарат|кофевар|коффовар|фильтр|очистител|резервуар)/.test(name))return false;
    return /(?:^| )(?:coffee|tea|soda|beer|food|meal|snack|kibble|prepak|burrito|water|mre|triti fizz|koff pops)(?: |$)/.test(name)||/(?:^| )(?:кофе|чай|газировка|пиво|еда|пищевой|киббл|полуфабрикат\S*|буррито|вода|бутерброд\S*|лапша|шоколад\S*|сок|сухпаек|трити физз|пастилки коффо)(?: |$)/.test(name);
  }
  return true;
}
export function acceptsBuyback(shop,item){
  const preset=PRESETS[shop?.quick?.presetId];
  return !preset||preset.part!=='bodega'||eligibleStock(item,preset);
}
export function stockEntry(doc,preset,index){
  return {id:`menu${index}`,uuid:doc.uuid,name:doc.name,img:doc.img,type:doc.type,stockKey:stockKey(doc),price:priceOf(doc),qty:preset.qty,infinite:preset.part==='diner',stockClass:'static',dynamicManaged:false,fixerOnly:false,packageSize:Math.max(1,Number(doc.system?.amount)||1),marketPackagePrice:priceOf(doc),categoryId:'menu'};
}
export function appendStock(point,docs,presetId,count,knownKeys=new Map()){
  const preset=PRESETS[presetId],limit=stockCount(count,preset);
  const existing=new Set(point.items.flatMap(i=>[i.uuid,i.stockKey,knownKeys.get(i.uuid)].filter(Boolean)));
  let added=0;
  for(const doc of docs){
    if(point.items.length>=limit)break;
    const key=stockKey(doc);if(!eligibleStock(doc,preset)||existing.has(doc.uuid)||existing.has(key))continue;
    const entry=stockEntry(doc,preset,point.items.length);entry.id=`stock-${doc.id||doc._id||point.items.length}-${point.items.length}`;
    if(point.categories?.length)entry.categoryId=point.categories[0].id;
    point.items.push(entry);existing.add(doc.uuid);existing.add(key);added++;
    if(point.quick){point.quick.targets??=[];point.quick.targets.push({uuid:entry.uuid,name:entry.name,stockClass:entry.stockClass,qty:entry.qty});}
  }
  return {added,total:point.items.length,target:limit};
}
export function pointData({id,name,presetId,items,scene,dayKey,restock=true,source=null,count}){
  const preset=PRESETS[presetId];if(!preset)throw Error('Шаблон не найден.');
  const data=source?structuredClone(source):{items:[],purse:preset.purse,buyback:{},faces:[],customerDiscounts:[]};
  Object.assign(data,{id,name,sceneOnly:true,sceneId:scene.id,sceneName:scene.name,tileUuid:'',tileUuids:[],vendorActors:[],vendorTokens:[]});
  if(!source){
    data.items=items.map((doc,index)=>stockEntry(doc,preset,index));
    if(preset.part==='bodega')for(const type of preset.types.filter(t=>t!=='itemUpgrade'))data.buyback[type[0].toUpperCase()+type.slice(1)]={on:true,pct:50};
    if(preset.part==='diner')Object.assign(data,{subtitle:'Меню заведения',deliveryMode:'inventory',publicChat:true,categories:[{id:'menu',label:'Еда и напитки',ruleType:'foodTier',requiredTier:'generic-prepak',minMonthly:300,draws:0,tableRef:''}]});
  }
  // Copies have separate stock, timers, bindings and a fresh identity.
  data.dynamic={...(data.dynamic??{}),enabled:false,initializedAt:0,nextRestock:0,nextCycle:0,trafficSchedule:[]};
  data.quick={presetId,stockCount:stockCount(count??source?.quick?.stockCount,preset),restock:!!restock&&preset.part!=='diner',dayKey,markerUuid:'',targets:data.items.map(i=>({uuid:i.uuid,name:i.name,stockClass:i.stockClass,qty:Number(i.qty)||0}))};
  return data;
}
export function refillPoint(point,dayKey,{force=false}={}){
  if(!point.quick||(!force&&(!point.quick.restock||point.quick.dayKey===dayKey)))return false;
  for(const target of point.quick.targets??[]){
    const item=point.items.find(i=>!i.tradeIn&&(i.uuid||i.name)===(target.uuid||target.name));
    if(item&&!item.infinite)item.qty=Math.max(Number(item.qty)||0,Number(target.qty)||0);
  }
  point.quick.dayKey=dayKey;return true;
}
export function canvasPoint(event,canvas){
  const rect=canvas.app.view.getBoundingClientRect(),screen=canvas.app.renderer.screen;
  return canvas.stage.worldTransform.applyInverse({x:(event.clientX-rect.left)*screen.width/rect.width,y:(event.clientY-rect.top)*screen.height/rect.height});
}
