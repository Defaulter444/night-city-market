import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transaction,onceTransaction,validatedPacket,fixerRank,foodTierId,lifestyleItem,intrinsicAttack,requireCustomer,requireProximity,kindLabel,saleBlocked,componentHooks} from '../scripts/core.mjs';
import {isTradeableItem,bundleItemIds} from '../vendor/trade-rules.mjs';
test('Russian and original food plans, Agent metadata, ordinary food packs',()=>{
  for(const [name,id]of [['Образ жизни: на киббле','kibble'],['Образ жизни: на обычных полуфабрикатах','generic-prepak'],['Образ жизни: на хороших полуфабрикатах','good-prepak'],['Образ жизни: на свежей еде','fresh-food'],['Generic Prepak 300eb/Month','generic-prepak']])assert.equal(foodTierId({name}),id,name);
  assert.equal(foodTierId({name:'Переименованный рацион',flags:{'night-city-agent':{lifestyle:{kind:'food',monthly:600}}}}),'good-prepak');
  assert.equal(foodTierId({name:'Kibble Pack'}),'none');
});
test('Russian housing and lifestyle cannot be transferred; ordinary gear can',()=>{
  for(const name of ['Жильё: куб-отель','Жильё: грузовой контейнер','Образ жизни: на киббле','Cube Hotel 500eb/Month'])assert.equal(isTradeableItem({name,type:'gear',system:{amount:1}}),false,name);
  assert.equal(isTradeableItem({name:'Пакет киббла',type:'gear',system:{amount:1}}),true);
});
test('Intrinsic attacks protected in both languages',()=>{
  for(const name of ['Безоружный','Метательное оружие','Unarmed','Thrown Weapon'])assert.equal(intrinsicAttack({name,type:'weapon'}),true);
  assert.equal(intrinsicAttack({name:'Тяжёлый пистолет',type:'weapon'}),false);
});
test('Fixer detected only from role documents; originalName retained',()=>{
  assert.equal(fixerRank({items:[{name:'Фиксер',type:'role',system:{rank:6}}]}),6);
  assert.equal(fixerRank({items:[{name:'Другая роль',type:'role',system:{rank:4},flags:{babele:{originalName:'Fixer'}}}]}),4);
  assert.equal(fixerRank({items:[{name:'Фиксер',type:'gear',system:{rank:10}}]}),0);
});
test('Installed cyberware and equipped armor remain protected',()=>{
  const chrome={id:'child',name:'Киберглаз',type:'cyberware',system:{amount:1}};
  assert.equal(isTradeableItem(chrome,{items:[chrome],system:{installedItems:{list:['child']}}}),false);
  assert.equal(isTradeableItem({...chrome,id:'loose'},{items:[],system:{installedItems:{list:[]}}}),true);
  assert.equal(isTradeableItem({type:'armor',system:{amount:1,equipped:'equipped'}}),false);
});
test('Weapon bundle recursively follows attachments and handles cycles',()=>{
  assert.deepEqual(bundleItemIds({items:[{id:'gun',system:{installedItems:{list:['scope']}}},{id:'scope',system:{installedItems:{list:['gun']}}}]},'gun'),['gun','scope']);
});
test('Socket components isolated and sender identity supplied by server',()=>{
  const users=new Map([['p',{active:true,isGM:false}],['gm',{active:true,isGM:true}]]);
  const packet={protocol:'ncm-1',component:'bodega',data:{op:'gm-purchase',payload:{userId:'gm',buyerUuid:'Actor.a'}}};
  assert.equal(validatedPacket('bodega',packet,'p',users).payload.userId,'p');
  assert.equal(packet.data.payload.userId,'gm');
  assert.equal(validatedPacket('vendit',packet,'p',users),null);
  assert.equal(validatedPacket('bodega',packet,'missing',users),null);
});
test('Players cannot write stock, purse or forge successful responses',()=>{
  const users=new Map([['p',{active:true,isGM:false}],['gm',{active:true,isGM:true}]]);
  for(const op of ['stock','purse','ledger-wealth','purchase-done','stock-ui']){
    const packet={protocol:'ncm-1',component:'bodega',data:{op}};
    assert.equal(validatedPacket('bodega',packet,'p',users),null,op);
    assert.equal(validatedPacket('bodega',packet,'gm',users).op,op);
  }
});
test('One queue prevents overspending across different departments and recovers after failure',async()=>{
  let funds=30;const buy=()=>transaction(async()=>{if(funds<20)return false;const before=funds;await Promise.resolve();funds=before-20;return true;});
  assert.deepEqual(await Promise.all([buy(),buy()]),[true,false]);assert.equal(funds,10);
  await assert.rejects(transaction(()=>{throw Error('storage');}));assert.equal(await transaction(()=>7),7);
});
test('Concurrent duplicate purchase executes once; rejected operation can retry',async()=>{
  let calls=0;const buy=()=>onceTransaction('test:request1',async()=>{calls++;return {ok:true};});
  await Promise.all([buy(),buy()]);assert.equal(calls,1);
  await onceTransaction('test:retry',()=>({ok:false}));
  assert.equal((await onceTransaction('test:retry',()=>({ok:true}))).ok,true);
});
test('GM checks actor ownership and scene at transaction time',()=>{
  const users=new Map([['p',{id:'p',isGM:false,viewedScene:'scene1'}],['gm',{id:'gm',isGM:true}]]);users.activeGM=users.get('gm');
  globalThis.game={user:users.get('gm'),users};
  const actor={documentName:'Actor',testUserPermission:u=>u.id==='p'};
  requireCustomer(actor,'p',{sceneId:'scene1'});
  requireCustomer(actor,'p',{sceneId:'scene2',sceneOnly:false});
  assert.throws(()=>requireCustomer(actor,'missing',{}));
  assert.throws(()=>requireCustomer(actor,'p',{sceneId:'scene2'}));
  assert.throws(()=>requireCustomer({...actor,testUserPermission:()=>false},'p',{}));
  game.user=users.get('p');assert.throws(()=>requireCustomer(actor,'p',{}));
});
test('Bound vending machines enforce proximity on GM from persistent scene data',async()=>{
  const user={id:'p',viewedScene:'s'};globalThis.game={users:new Map([['p',user]])};
  const token={actorId:'a',x:100,y:100,width:1,height:1};
  globalThis.fromUuid=async()=>({x:100,y:100,width:100,height:100,parent:{id:'s',grid:{size:100},tokens:[token]}});
  await requireProximity({tileUuid:'Scene.s.Tile.t'},{id:'a'},'p',2);
  token.x=800;await assert.rejects(requireProximity({tileUuid:'Scene.s.Tile.t'},{id:'a'},'p',2));
  await assert.rejects(requireProximity({tileUuid:'Scene.s.Tile.t'},{id:'different'},'p',2));
  globalThis.fromUuid=async()=>({documentName:'Token',x:100,y:100,width:1,height:1,parent:{id:'s',grid:{size:100},tokens:[token]}});
  token.x=100;await requireProximity({quick:{markerUuid:'Scene.s.Token.v'}},{id:'a'},'p',2);
  token.x=800;await assert.rejects(requireProximity({quick:{markerUuid:'Scene.s.Token.v'}},{id:'a'},'p',2));
});
test('Category display translations do not change buyback data keys',()=>{assert.equal(kindLabel('Weapon'),'Оружие');assert.equal(kindLabel('Gear'),'Снаряжение');});
test('Buyback protects lifestyle, included meals and weapon attachments in UI and GM processor',()=>{
  const actor={items:[],system:{installedItems:{list:[]}}};
  assert.equal(saleBlocked({name:'Образ жизни: на киббле'},actor),true);
  assert.equal(saleBlocked({flags:{'night-city-market':{coveredServing:true}}},actor),true);
  assert.equal(saleBlocked({id:'gun',system:{installedItems:{list:['scope']}}},actor),true);
  assert.equal(saleBlocked({id:'gear',name:'Верёвка',system:{equipped:'carried'}},actor),false);
});
test('Bundled hooks stay inactive while any original component is enabled',()=>{
  let callback,calls=0;globalThis.Hooks={on:(_e,fn)=>{callback=fn;}};
  globalThis.game={modules:new Map([['bodega',{active:true}]])};
  componentHooks.on('ready',()=>calls++);callback();assert.equal(calls,0);
  game.modules.get('bodega').active=false;callback();assert.equal(calls,1);
});
