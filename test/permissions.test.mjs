import test from 'node:test';
import assert from 'node:assert/strict';

const hooks=new Map(),socketListeners=new Set(),settings=new Map(),writes=[],warnings=[],dialogs=[];
let reads=0,requestId=0;
function collection(values=[]){values.get=id=>values.find(x=>x.id===id);return values;}
const player={id:'player',active:true,isGM:false,viewedScene:'scene'},gm={id:'gm',active:true,isGM:true,viewedScene:'scene'};
const users=collection([player,gm]);users.activeGM=gm;
function htmlStub(){
  const handlers=new Map();
  const chain={on(event,...args){handlers.set(`${event}:${args.length>1?args[0]:''}`,args.at(-1));return chain;},find(){return chain;},each(){return chain;},prop(){return chain;},after(){return chain;},text(){return chain;},removeClass(){return chain;},length:0};
  chain[0]={querySelector:()=>null};chain.handlers=handlers;return chain;
}
globalThis.Hooks={on(event,fn){const list=hooks.get(event)||[];list.push(fn);hooks.set(event,list);},once(event,fn){this.on(event,fn);},callAll(){}};
globalThis.Application=class{constructor(){this.element=htmlStub();this.rendered=false;}activateListeners(){}render(){this.rendered=true;return this;}bringToTop(){}async close(){this.rendered=false;}};
globalThis.Dialog=class{constructor(data,options){this.data=data;this.options=options;dialogs.push(this);}render(){return this;}static async confirm(){return false;}};
globalThis.FilePicker=class{constructor(){throw Error('Player must not reach FilePicker');}};
globalThis.Token=class{};globalThis.Tile=class{};
globalThis.document={body:{dataset:{}},head:{appendChild(){}},addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null,createElement:()=>({style:{},remove(){}})};
globalThis.window={innerWidth:1440,innerHeight:900};
globalThis.canvas={scene:{id:'scene',name:'Test scene',grid:{size:100},tokens:[],tiles:[]},tokens:{controlled:[]},tiles:{controlled:[]}};
globalThis.foundry={utils:{deepClone:structuredClone,mergeObject:(a,b)=>({...a,...b}),randomID:()=>`request-${++requestId}`}};
globalThis.randomID=foundry.utils.randomID;globalThis.duplicate=structuredClone;
globalThis.ui={notifications:{warn:message=>{warnings.push(message);},error:message=>{warnings.push(message);},info(){}},sidebar:{activateTab(){throw Error('Unexpected admin item-directory action');}},items:{renderPopout(){}}};
globalThis.game={user:player,users,actors:collection(),scenes:collection(),items:collection(),packs:[],macros:collection(),modules:new Map(),system:{id:'cyberpunk-red-core'},time:{worldTime:0},settings:{settings:new Map(),register(ns,key,definition){this.settings.set(`${ns}.${key}`,definition);if(!settings.has(key))settings.set(key,structuredClone(definition.default));},get(_ns,key){reads++;return settings.get(key)??{};},async set(_ns,key,value){writes.push(key);settings.set(key,structuredClone(value));return value;}},socket:{on(_channel,fn){socketListeners.add(fn);},off(_channel,fn){socketListeners.delete(fn);},emit(_channel,packet){
  if(packet.component==='bodega'&&['gm-purchase','gm-buyback'].includes(packet.data.op))queueMicrotask(()=>{
    const response={protocol:'ncm-1',component:'bodega',data:{op:packet.data.op==='gm-purchase'?'purchase-done':'buyback-done',nonce:packet.data.payload.nonce}};
    for(const listener of socketListeners)listener(response,gm.id);
  });
  if(packet.component==='trade'&&packet.data.op==='transfer-request')queueMicrotask(()=>{
    const response={protocol:'ncm-1',component:'trade',data:{op:'transfer-response',requestId:packet.data.requestId,userId:player.id,ok:true}};
    for(const listener of socketListeners)listener(response,gm.id);
  });
}}};

const {openMarket}=await import('../scripts/main.mjs');
const {sidebar,settingsView,editorView,saveSettings,saveEditor,removeProduct,addCategory}=await import('../scripts/streetlife.mjs');
const {canOpenMarketTab,requireMarketGM,validatedPacket,transaction}=await import('../scripts/core.mjs');
const points=await import('../scripts/quick-points.mjs');
const {buy,sell}=await import('../scripts/commerce.mjs');
// Exercise the actual exposed vendor APIs, not copies of their private functions.
for(const callback of hooks.get('init')||[])await callback();
for(const callback of [...(hooks.get('ready')||[])])await callback();

test('Player navigation has no settings or management, including a forged GM render argument',()=>{
  game.user=player;
  const html=sidebar('home',true);
  assert.doesNotMatch(html,/data-tab="(?:settings|quick)"/);
  for(const tab of ['home','trade','bodega','diner','vendit','help']){
    assert.equal(canOpenMarketTab(tab),true,tab);assert.ok(openMarket({tab}),tab);
  }
  assert.equal(canOpenMarketTab('__proto__'),false);
  for(const tab of ['settings','quick'])assert.equal(openMarket({tab}),undefined,tab);
  const before=reads;
  assert.throws(()=>settingsView(true),/Мастеру/);
  assert.throws(()=>editorView('bodega',{id:'shop'}),/Мастеру/);
  assert.equal(reads,before,'denied views do not read admin databases');
});

test('Forged button, forced/stale window state and direct admin action cannot open GM controls',async()=>{
  game.user=player;const app=openMarket({tab:'home'}),html=htmlStub();
  app.activateListeners(html);
  const click=html.handlers.get('click:button[type="button"]');
  for(const dataset of [{tab:'settings'},{tab:'quick'},{editorTab:'stock'},{preset:'street'}])click({currentTarget:{dataset,closest:()=>null}});
  assert.equal(app.tab,'home');assert.equal(app.editing,false);
  app.tab='settings';app.editing=true;app.copySource={id:'private-shop'};
  const content=await app.content();
  assert.equal(app.tab,'home');assert.equal(app.editing,false);assert.equal(app.copySource,null);
  assert.doesNotMatch(content,/sl-settings-form|sl-editor-form|ncm-quick-form/);
  await app.action('pick-cover');await app.action('item-directory');
  assert.throws(()=>app.quickContent(),/Мастеру/);
});

test('Direct settings, stock and placement mutations reject players before persistence',async()=>{
  game.user=player;const before=writes.length;
  for(const call of [()=>saveSettings(null),()=>saveEditor(null),()=>removeProduct('bodega','shop',0,'x'),()=>addCategory('diner'),()=>points.preparePoint({presetId:'street'}),()=>points.createPoint({},{}),()=>points.refill('bodega','shop'),()=>points.setRestock('bodega','shop',true),()=>points.updateProduct('bodega','shop',0,{},'x'),()=>points.addProduct('bodega','shop',{}),()=>points.expandAssortment('bodega','shop',{})])await assert.rejects(call,/Мастер|Мастеру/);
  assert.equal(writes.length,before);
});

test('Legacy admin APIs reject direct player calls before reading settings, dialogs or side effects',async()=>{
  game.user=player;const before={reads,writes:writes.length,dialogs:dialogs.length};
  const calls={
    'bodega.openAdmin':()=>game.bodega.openAdmin(),
    'bodega.openOptions':()=>game.bodega.openOptions(),
    'bodega.saveAll':()=>game.bodega.saveAll({}),
    'bodega.generateDynamicStock':()=>game.bodega.generateDynamicStock('shop'),
    'bodega.runCustomerCycle':()=>game.bodega.runCustomerCycle('shop'),
    'bodega.restockNow':()=>game.bodega.restockNow('shop'),
    'bodega.adjustWealth':()=>game.bodega.adjustWealth({},100),
    'bodega.writeStackQty':()=>game.bodega.writeStackQty({},100),
    'bodega.giveFromShopQty':()=>game.bodega.giveFromShopQty({},{}),
    'vendit.openManager':()=>game.vendit.openManager(),
    'vendit.openOptions':()=>game.vendit.openOptions(),
    'vendit.openDynamicManager':()=>game.vendit.openDynamicManager(),
    'vendit.openDynamicConfig':()=>game.vendit.openDynamicConfig('shop'),
    'vendit.saveDB':()=>game.vendit.saveDB({}),
    'vendit.generate':()=>game.vendit.generate('shop'),
    'vendit.bindSelectedTile':()=>game.vendit.bindSelectedTile('shop'),
    'diner.openManager':()=>game.dinerManager.openManager(),
    'diner.edit':()=>game.dinerManager.edit('shop'),
    'diner.createMenuItem':()=>game.dinerManager.createMenuItem({}),
    'diner.openLifestyleOverride':()=>game.dinerManager.openLifestyleOverride({})
  };
  for(const [name,call]of Object.entries(calls))await assert.rejects(Promise.resolve().then(call),/Мастеру/,name);
  assert.equal(reads,before.reads);assert.equal(writes.length,before.writes);assert.equal(dialogs.length,before.dialogs);
});

test('GM still opens legacy settings and managers and can save their database',async()=>{
  game.user=gm;
  for(const open of [game.bodega.openAdmin,game.bodega.openOptions,game.vendit.openManager,game.vendit.openOptions,game.vendit.openDynamicManager,game.dinerManager.openManager]){
    const count=dialogs.length;await open();assert.equal(dialogs.length,count+1);
  }
  const db=structuredClone(settings.get('bodegaDb'));db.permissionTest='GM write';
  await game.bodega.saveAll(db);assert.equal(settings.get('bodegaDb').permissionTest,'GM write');
});

test('GM retains settings and role is checked again when queued settings save runs',async()=>{
  game.user=gm;
  assert.match(sidebar('home'),/data-tab="settings"/);assert.match(sidebar('home'),/data-tab="quick"/);
  assert.ok(openMarket({tab:'settings'}));assert.match(settingsView(),/sl-settings-form/);
  const form={querySelectorAll:()=>[{dataset:{field:'interactionRangeSquares',initial:'2'},value:'3',type:'number'}]};
  await saveSettings(form);assert.equal(settings.get('venditDb').defaults.interactionRangeSquares,3);
  let release;const blocked=transaction(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
  const before=writes.length,pending=saveSettings(form);game.user=player;release();await blocked;
  await assert.rejects(pending,/Мастеру/);assert.equal(writes.length,before);
  assert.throws(requireMarketGM,/Мастеру/);
});

test('Forged admin socket messages are rejected while customer requests retain actual sender',()=>{
  game.user=player;
  for(const component of ['bodega','vendit','diner'])for(const op of ['saveDB','saveAll','settings','generate','stock','purse','purchase-done']){
    const packet={protocol:'ncm-1',component,data:{op,userId:gm.id,payload:{userId:gm.id}}};
    assert.equal(validatedPacket(component,packet,player.id,new Map(users.map(u=>[u.id,u]))),null,`${component}/${op}`);
  }
  const packet={protocol:'ncm-1',component:'bodega',data:{op:'gm-purchase',payload:{userId:gm.id}}};
  assert.equal(validatedPacket('bodega',packet,player.id,new Map(users.map(u=>[u.id,u]))).payload.userId,player.id);
});

test('Player purchases, sales and personal transfers still use the GM request pipeline',async()=>{
  game.user=player;
  const item={id:'rope',name:'Rope',type:'gear',system:{amount:2}},actor={id:'actor',uuid:'Actor.actor',testUserPermission:user=>user.id===player.id,items:new Map([['rope',item]])};
  const db=settings.get('bodegaDb');db.shops={shop:{id:'shop',sceneId:'scene',items:[{uuid:'Item.rope',name:'Rope',price:20,qty:4}]}};
  const originalQuote=game.bodega.quoteSell;game.bodega.quoteSell=async()=>({verified:true});
  try{assert.equal((await buy('bodega','shop',0,actor)).ok,true);assert.equal((await sell('shop','rope',actor)).ok,true);}finally{game.bodega.quoteSell=originalQuote;}
  assert.equal((await game.choomTrade.requestTransfer({sourceActorUuid:actor.uuid,targetActorUuid:'Actor.friend',itemId:'rope'})).ok,true);
});
