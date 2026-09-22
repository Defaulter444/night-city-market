import test from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS,eligibleStock,pickStock,stockCount,stockKey,pointData,appendStock,acceptsBuyback,refillPoint} from '../scripts/point-model.mjs';
const doc=(name,type,price,system={})=>({uuid:`Item.${name}`,name,type,system:{price:{market:price},...system}});
test('merchant profiles reject unrelated, premium street, special ammo and virtual merchandise',()=>{
  const checks=[
    [doc('Tent','gear',50),'weapons',false],
    [doc('Scope','itemUpgrade',100,{type:'weapon'}),'weapons',true],
    [doc('Deck chip','itemUpgrade',100,{type:'cyberdeck'}),'weapons',false],
    [doc('Smartgun','weapon',1000,{quality:'excellent'}),'weapons',true],
    [doc('Combat Knife','weapon',100,{quality:'excellent'}),'street',false],
    [doc('Posh coat','clothing',50,{quality:'excellent'}),'street',false],
    [doc('Basic bullets','ammo',10,{type:'basic',variety:'heavyPistol'}),'street',true],
    [doc('Smart bullets','ammo',100,{type:'smart',variety:'heavyPistol'}),'street',false],
    [doc('Rocket','ammo',100,{type:'basic',variety:'rocket'}),'street',false],
    [doc('Longsword','weapon',50,{source:{book:'ELO'}}),'weapons',false],
    [doc('Unarmed','weapon',1),'weapons',false],
  ];
  for(const [item,profile,expected]of checks){assert.equal(eligibleStock(item,PRESETS[profile]),expected,item.name);assert.equal(acceptsBuyback({quick:{presetId:profile}},item),expected,`buyback ${item.name}`);}
  assert(acceptsBuyback({buyback:{Gear:{on:true}}},doc('Custom','gear',10000)),'custom stores retain their own rules');
});
test('food matches complete words and packaged food, not machines or drugs',()=>{
  for(const name of ['Coffee','Tea','MRE','Food Stick','Triti-Fizz','Koff Pops','Сухпаёк','Пищевой батончик','Пастилки коффо'])assert(eligibleStock(doc(name,'gear',10),PRESETS.diner),name);
  for(const name of ['Steam cleaner','Water Purifier','Koff Popper','Coffee Maker','Коффоварка'])assert(!eligibleStock(doc(name,'gear',10),PRESETS.diner),name);
  assert(!eligibleStock(doc('Tea','drug',10),PRESETS.diner));
});
test('large assortment preserves type balance and weapon/ammo variety with strict requested count',()=>{
  const pool=[];
  for(const type of ['weapon','ammo','armor','itemUpgrade'])for(let i=0;i<100;i++)pool.push(doc(type+i,type,100,type==='weapon'?{weaponType:['shotgun','heavyPistol','rifle','smg'][i%4]}:type==='ammo'?{variety:['rifle','heavyPistol','arrow'][i%3]}:{type:'weapon'}));
  const selected=pickStock(pool,PRESETS.weapons,()=>.5);
  assert.equal(selected.length,64);assert.equal(new Set(selected.map(stockKey)).size,64);
  assert(selected.filter(i=>i.type==='weapon').length>=25);
  assert.equal(new Set(selected.filter(i=>i.type==='weapon').map(i=>i.system.weaponType)).size,4);
  assert.equal(new Set(selected.filter(i=>i.type==='ammo').map(i=>i.system.variety)).size,3);
  assert.equal(pickStock(pool,PRESETS.weapons,()=>.5,1).length,1);
  assert.equal(pickStock(pool,PRESETS.weapons,()=>.5,120).length,120);
  for(const bad of [0,-1,121,1.5,NaN,'x'])assert.throws(()=>stockCount(bad,PRESETS.street));
});
test('duplicate world/compendium documents collapse but quality variants survive',()=>{
  const base=doc('Pistol','weapon',100,{quality:'standard'}),translated={...base,uuid:'Compendium.guns.p',name:'Пистолет',flags:{babele:{originalName:'Pistol'}}},excellent=doc('Pistol','weapon',500,{quality:'excellent'});
  assert.equal(pickStock([base,translated,excellent],PRESETS.weapons).length,2);
});
test('additive expansion preserves purchases, cash, manual items and existing restock targets',()=>{
  const gun=doc('Pistol','weapon',100,{quality:'standard'}),newGun=doc('Shotgun','weapon',500),point=pointData({id:'p',name:'Gun store',presetId:'weapons',items:[gun],scene:{id:'s'},dayKey:'one'});
  point.items[0].qty=1;point.items[0].price=77;point.purse=777;point.extra={mission:'preserve'};
  point.items.push({uuid:'Item.manual',name:'Custom',price:13,qty:2,tradeIn:true});
  const old=structuredClone(point);
  const result=appendStock(point,[gun,newGun,doc('Tent','gear',50)],'weapons',64);
  assert.equal(result.added,1);assert.deepEqual(point.items.slice(0,2),old.items);assert.equal(point.purse,777);assert.deepEqual(point.extra,old.extra);assert.deepEqual(point.quick.targets[0],old.quick.targets[0]);
  assert.equal(appendStock(point,[newGun],'weapons',64).added,0);
  point.items[2].qty=0;refillPoint(point,'two');assert.equal(point.items[2].qty,3);assert.equal(point.items[1].qty,2);
  assert.equal(appendStock(point,[doc('Other','weapon',100)],'weapons',1).added,0);assert.equal(point.items.length,3);
});
test('legacy entries deduplicate through resolved source without rewriting stored entries',()=>{
  const gun=doc('Pistol','weapon',100),copy={...gun,uuid:'Compendium.guns.p'};
  const point={items:[{uuid:gun.uuid,name:'My pistol',price:333,qty:2}],quick:{targets:[]}};
  assert.equal(appendStock(point,[copy],'weapons',40,new Map([[gun.uuid,stockKey(gun)]])).added,0);
  assert.equal(point.items[0].price,333);
});
