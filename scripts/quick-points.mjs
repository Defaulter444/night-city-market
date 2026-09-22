import {ID,transaction} from './core.mjs';
import {PRESETS,eligibleStock,pickStock,pointData,refillPoint,canvasPoint,stockCount,stockKey,appendStock} from './point-model.mjs';
import {DEPARTMENTS,readDepartment,getPoint} from './commerce.mjs';
import {currentWorldDayKey} from '../vendor/diner.mjs';
export {PRESETS};
function assertGM(){if(!game.user.isGM)throw Error('Размещение и настройка точек доступны Мастеру.');if(game.users.activeGM&&game.users.activeGM.id!==game.user.id)throw Error('Выполните действие с клиента основного Мастера.');}
export async function suggestStock(presetId,{count,exclude=new Set()}={}){
  assertGM();const preset=PRESETS[presetId];if(!preset)throw Error('Неизвестный шаблон.');
  const limit=stockCount(count,preset);
  const candidates=[...game.items].filter(item=>eligibleStock(item,preset));
  const packs=game.packs.filter(p=>p.documentName==='Item'&&(p.metadata.packageName==='cyberpunk-red-core'||/^cpr-|cyberpunk-red/.test(p.metadata.packageName??'')));
  for(const pack of packs){
    try{
      const index=await pack.getIndex({fields:['type','system.price','system.amount','system.quality','system.weaponType','system.type','system.variety','system.style','system.isShield','system.isHeadLocation','system.source','system.installedItems','flags.babele.originalName','flags.night-city-agent.lifestyle','flags.night-city-market.coveredServing']});
      for(const entry of index)if(eligibleStock(entry,preset))candidates.push({...entry,uuid:`Compendium.${pack.collection}.${entry._id}`,_catalog:{pack,id:entry._id}});
    }catch(error){console.warn('Торговля | Источник недоступен',pack.collection,error);}
  }
  let remaining=candidates.filter(i=>!exclude.has(i.uuid)&&!exclude.has(stockKey(i)));
  const result=[],seen=new Set(exclude);
  while(result.length<limit&&remaining.length){
    const batch=pickStock(remaining,preset,Math.random,limit-result.length),tried=new Set(batch);
    remaining=remaining.filter(i=>!tried.has(i));
    if(!batch.length)break;
    // Load only chosen documents, in small batches; validate again after translation/migration.
    for(let offset=0;offset<batch.length;offset+=8){
      const loaded=await Promise.allSettled(batch.slice(offset,offset+8).map(ref=>ref._catalog?ref._catalog.pack.getDocument(ref._catalog.id):Promise.resolve(ref)));
      for(const entry of loaded){
        if(entry.status!=='fulfilled'||!eligibleStock(entry.value,preset))continue;
        const doc=entry.value,key=stockKey(doc);if(seen.has(doc.uuid)||seen.has(key))continue;
        seen.add(doc.uuid);seen.add(key);result.push(doc);
      }
    }
    remaining=remaining.filter(i=>!seen.has(i.uuid)&&!seen.has(stockKey(i)));
  }
  return result;
}
export async function preparePoint({presetId,name,restock=true,sourceId=null,empty=false,count}){
  assertGM();const preset=PRESETS[presetId];if(!preset)throw Error('Шаблон не найден.');
  const source=sourceId?getPoint(preset.part,sourceId):null;
  if(sourceId&&!source)throw Error('Точка для копирования больше не существует.');
  const limit=stockCount(count??source?.quick?.stockCount,preset),items=source||empty?[]:await suggestStock(presetId,{count:limit});
  if(!source&&!empty&&!items.length)throw Error('Подходящих предметов не найдено. Выберите пустую точку и перетащите в неё товары.');
  return {presetId,name:String(name||source?.name||preset.label).trim().slice(0,100),restock:!!restock,source,items,count:limit};
}
export async function expandAssortment(part,id,{count}={}){
  assertGM();const snapshot=getPoint(part,id),presetId=snapshot?.quick?.presetId,preset=PRESETS[presetId];
  if(!preset||preset.part!==part)throw Error('Автоподбор доступен для точек, созданных из шаблона.');
  const limit=stockCount(count,preset),knownKeys=new Map(),exclude=new Set();
  for(const item of snapshot.items??[]){
    if(item.uuid)exclude.add(item.uuid);
    let key=item.stockKey;
    if(!key){try{const doc=item.raw||(item.uuid?await fromUuid(item.uuid):null);if(doc)key=stockKey(doc);}catch{}}
    if(key){exclude.add(key);knownKeys.set(item.uuid,key);}
  }
  const missing=Math.max(0,limit-(snapshot.items?.length||0));
  const docs=missing?await suggestStock(presetId,{count:missing,exclude}):[];
  return transaction(async()=>{
    assertGM();const spec=DEPARTMENTS[part],db=readDepartment(part),point=db[spec.collection]?.[id];
    if(!point||point.quick?.presetId!==presetId)throw Error('Точка изменилась. Откройте её заново.');
    // Merge into fresh stock: purchases and hand-edited prices may have changed while loading packs.
    const result=appendStock(point,docs,presetId,limit,knownKeys);point.quick.stockCount=limit;
    await game.settings.set(ID,spec.key,db);Hooks.callAll('nightCityMarketChanged');return result;
  });
}
export async function createPoint(prepared,{scene=canvas.scene,x,y,token=null}={}){
  assertGM();if(!scene)throw Error('Откройте сцену для размещения.');
  if(!token&&(!Number.isFinite(x)||!Number.isFinite(y)))throw Error('Укажите место на карте.');
  if(token&&(token.parent.id!==scene.id||token.getFlag(ID,'point')||game.bodega.resolveVendorTokenSync(token)))throw Error('Токен недоступен или уже привязан к торговой точке.');
  return transaction(async()=>{
    const preset=PRESETS[prepared.presetId],spec=DEPARTMENTS[preset.part],db=readDepartment(preset.part);
    const id=foundry.utils.randomID();let name=prepared.name,count=2;
    const names=new Set(Object.values(db[spec.collection]??{}).map(p=>p.name));while(names.has(name))name=`${prepared.name} ${count++}`;
    const point=pointData({...prepared,id,name,scene,dayKey:currentWorldDayKey()});
    let marker=token,created=false;
    try{
      if(!marker){
        const size=scene.grid.size||100;
        [marker]=await scene.createEmbeddedDocuments('Tile',[{x,y,width:size,height:size,texture:{src:preset.img},flags:{[ID]:{point:{part:preset.part,id},label:name}},hidden:false}]);created=true;
      }else await marker.setFlag(ID,'point',{part:preset.part,id});
      point.quick.markerUuid=marker.uuid;
      if(marker.documentName==='Tile'){
        point.tileUuids=[marker.uuid];if(preset.part==='vendit'){point.tileUuid=marker.uuid;await marker.setFlag(ID,'venditId',id);}
        if(preset.part==='diner')await marker.setFlag(ID,'dinerId',id);
      }
      db[spec.collection]??={};db[spec.collection][id]=point;await game.settings.set(ID,spec.key,db);
      Hooks.callAll('nightCityMarketChanged');return {part:preset.part,point,marker};
    }catch(error){if(created&&marker)await marker.delete();else if(marker)await marker.unsetFlag(ID,'point');throw error;}
  });
}
let placement=null;
export function cancelPlacement(){if(placement)placement.cancel();}
export function startPlacement(prepared,{repeat=false,onPlaced=()=>{},onEnd=()=>{}}={}){
  assertGM();cancelPlacement();if(!canvas.ready||!canvas.scene)throw Error('Откройте сцену.');
  const view=canvas.app.view,scene=canvas.scene,oldCursor=view.style.cursor;let busy=false,ended=false;
  const bar=document.createElement('div');bar.className='ncm-placement';bar.textContent=`${prepared.name} · Щёлкните на карте${repeat?' — можно несколько раз':''}. Esc — закончить.`;document.body.append(bar);view.style.cursor='crosshair';
  const cancel=()=>{if(ended)return;ended=true;view.removeEventListener('pointerdown',click,true);document.removeEventListener('keydown',key,true);view.style.cursor=oldCursor;bar.remove();placement=null;onEnd();};
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel();}};
  const click=async e=>{
    if(e.button===2){e.preventDefault();e.stopImmediatePropagation();cancel();return;}
    if(e.button!==0)return;e.preventDefault();e.stopImmediatePropagation();if(busy)return;
    if(canvas.scene?.id!==scene.id){cancel();return;}
    const point=canvasPoint(e,canvas);if(!canvas.dimensions.sceneRect.contains(point.x,point.y)){ui.notifications.warn('Выберите место внутри карты сцены.');return;}
    const size=scene.grid.size||100,rect=canvas.dimensions.sceneRect;
    const x=Math.max(rect.x,Math.min(rect.x+rect.width-size,Math.floor((point.x-rect.x)/size)*size+rect.x));
    const y=Math.max(rect.y,Math.min(rect.y+rect.height-size,Math.floor((point.y-rect.y)/size)*size+rect.y));
    busy=true;try{const result=await createPoint(prepared,{scene,x,y});onPlaced(result);ui.notifications.info(`Размещено: ${result.point.name}`);if(!repeat)cancel();}catch(error){ui.notifications.error(error.message);}finally{busy=false;}
  };
  placement={cancel};view.addEventListener('pointerdown',click,true);document.addEventListener('keydown',key,true);
}
export async function refill(part,id,{force=true}={}){
  assertGM();return transaction(async()=>{const spec=DEPARTMENTS[part],db=readDepartment(part),point=db[spec.collection]?.[id];if(!point?.quick)throw Error('Для этой точки настройте поставки в дополнительных параметрах.');if(refillPoint(point,currentWorldDayKey(),{force}))await game.settings.set(ID,spec.key,db);});
}
export async function setRestock(part,id,enabled){
  assertGM();return transaction(async()=>{const spec=DEPARTMENTS[part],db=readDepartment(part),point=db[spec.collection]?.[id];if(!point?.quick)throw Error('Быстрая точка не найдена.');point.quick.restock=!!enabled;point.quick.dayKey=currentWorldDayKey();await game.settings.set(ID,spec.key,db);});
}
export async function updateProduct(part,id,index,patch,identity){
  assertGM();return transaction(async()=>{const spec=DEPARTMENTS[part],db=readDepartment(part),shop=db[spec.collection]?.[id],item=shop?.items[index];if(!item||(item.uuid||item.name)!==identity)throw Error('Ассортимент изменился. Откройте точку заново.');
    for(const key of ['price','qty'])if(key in patch){const value=Number(patch[key]);if(!Number.isFinite(value)||value<0||value>10000000)throw Error('Введите неотрицательное число.');item[key]=Math.floor(value);}
    if('qty' in patch&&shop.quick){const target=shop.quick.targets.find(t=>(t.uuid||t.name)===identity);if(target)target.qty=item.qty;}
    await game.settings.set(ID,spec.key,db);
  });
}
export async function addProduct(part,id,doc){
  assertGM();if(doc?.documentName!=='Item'||!['gear','drug','ammo','weapon','armor','clothing','cyberware','itemUpgrade','cyberdeck'].includes(doc.type))throw Error('Перетащите предмет снаряжения.');
  return transaction(async()=>{const spec=DEPARTMENTS[part],db=readDepartment(part),shop=db[spec.collection]?.[id];if(!shop)throw Error('Точка не найдена.');
    if(shop.items.some(i=>i.uuid===doc.uuid))throw Error('Этот предмет уже есть в ассортименте.');
    const presetId=part==='bodega'?'street':part;const entry=pointData({id:'temporary',name:'',presetId,items:[doc],scene:canvas.scene??{},dayKey:''}).items[0];entry.id=foundry.utils.randomID();entry.categoryId=shop.categories?.[0]?.id||'menu';shop.items.push(entry);
    if(shop.quick)shop.quick.targets.push({uuid:entry.uuid,name:entry.name,qty:entry.qty});await game.settings.set(ID,spec.key,db);
  });
}
let markerView=null;
let nativeMarkersBound=false;
export function bindNativeMarkers(open){
  if(nativeMarkersBound)return;nativeMarkersBound=true;
  // Foundry's pointer handler runs before the DOM double-click. Consume only our
  // markers there, otherwise a character sheet also opens over the shop.
  for(const name of ['Token','Tile']){
    const type={Token,Tile}[name];if(!type?.prototype?._onClickLeft2)continue;
    const handler=function(wrapped,event){const ref=this.document.getFlag(ID,'point'),native=event?.nativeEvent??event?.data?.originalEvent??event;
      if(ref&&!native?.altKey){open({tab:ref.part,id:ref.id});return;}return wrapped(event);};
    if(typeof libWrapper!=='undefined')libWrapper.register(ID,`${name}.prototype._onClickLeft2`,handler,'MIXED');
    else{const original=type.prototype._onClickLeft2;type.prototype._onClickLeft2=function(event){return handler.call(this,original.bind(this),event);};}
  }
}
export function bindMapOpen(open){
  bindNativeMarkers(open);
  if(markerView)markerView.view.removeEventListener('dblclick',markerView.handler,true);
  if(!canvas.ready)return;
  const view=canvas.app.view,handler=e=>{
    if(placement||e.button!==0||e.altKey)return;const p=canvasPoint(e,canvas),size=canvas.scene.grid.size||100;
    const docs=[...canvas.scene.tokens,...canvas.scene.tiles].filter(d=>d.getFlag(ID,'point')&&(game.user.isGM||!d.hidden));
    const hit=docs.reverse().find(d=>{const token=d.documentName==='Token';return p.x>=d.x&&p.y>=d.y&&p.x<d.x+d.width*(token?size:1)&&p.y<d.y+d.height*(token?size:1);});
    if(hit){e.preventDefault();e.stopImmediatePropagation();const ref=hit.getFlag(ID,'point');open({tab:ref.part,id:ref.id});}
  };view.addEventListener('dblclick',handler,true);markerView={view,handler};
}
let refillTimer=null;
export function scheduleRefill(){
  clearTimeout(refillTimer);refillTimer=setTimeout(async()=>{
    if(!game.user.isGM||game.users.activeGM?.id!==game.user.id)return;
    try{await transaction(async()=>{const day=currentWorldDayKey();for(const part of ['bodega','vendit']){const spec=DEPARTMENTS[part],db=readDepartment(part);let changed=false;for(const point of Object.values(db[spec.collection]??{}))changed=refillPoint(point,day)||changed;if(changed)await game.settings.set(ID,spec.key,db);}});}catch(error){console.error('Торговля | Автопополнение',error);}
  },300);
}
