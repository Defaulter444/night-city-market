import test from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS,eligibleStock,pickStock,pointData,refillPoint,canvasPoint} from '../scripts/point-model.mjs';
const doc=(name,type,price,extra={})=>({uuid:'Item.test',name,type,img:'x.webp',system:{price:{market:price},amount:10},...extra});
test('preset assortment respects prices, departments and excludes lifestyle',()=>{
  assert(eligibleStock(doc('Лёгкий бронежилет','armor',100),PRESETS.weapons));
  assert(!eligibleStock(doc('Боргброня','armor',5000),PRESETS.weapons));
  assert(!eligibleStock(doc('Дробовик','weapon',500),PRESETS.street));
  assert(eligibleStock(doc('Кофе','gear',10),PRESETS.diner));
  assert(!eligibleStock(doc('Граната','gear',50),PRESETS.diner));
  assert(!eligibleStock(doc('Образ жизни: киббл','gear',50),PRESETS.vendit));
  assert(!eligibleStock(doc('ТЕСТ — товар','gear',50),PRESETS.street));
});
test('weapon preset includes available weapon, ammunition and armor even in ammo-heavy catalog',()=>{
  const pool=[...Array.from({length:30},(_,i)=>doc('Патрон '+i,'ammo',10)),doc('Пистолет','weapon',100),doc('Броня','armor',100)];
  const stock=pickStock(pool,PRESETS.weapons,()=>.5);assert.equal(stock.length,32);assert.deepEqual(new Set(stock.map(i=>i.type)),new Set(['weapon','ammo','armor']));
});
test('quick points retain UUID, package count and source price',()=>{
  const point=pointData({id:'a',name:'Лавка',presetId:'street',items:[doc('Патроны','ammo',50)],scene:{id:'s',name:'Карта'},dayKey:'day1'});
  assert.equal(point.items[0].packageSize,10);assert.equal(point.items[0].price,50);assert.equal(point.items[0].qty,4);assert.equal(point.items[0].uuid,'Item.test');assert(point.sceneOnly);assert.equal(point.sceneId,'s');
});
test('copies preserve custom stock but have independent identity, scene, bindings and quantities',()=>{
  const source={id:'old',name:'Old',sceneId:'oldScene',tileUuid:'oldTile',tileUuids:['oldTile'],vendorActors:['actor'],items:[{uuid:null,name:'Custom',qty:3,raw:{system:{condition:5}}}],dynamic:{enabled:true},quick:{dayKey:'old'}};
  const before=structuredClone(source),copy=pointData({source,id:'new',name:'Новая',presetId:'street',scene:{id:'s'},dayKey:'newDay'});
  assert.deepEqual(source,before);assert.equal(copy.id,'new');assert.equal(copy.tileUuid,'');assert.deepEqual(copy.vendorActors,[]);assert.equal(copy.quick.dayKey,'newDay');assert(!copy.dynamic.enabled);
  copy.items[0].qty=0;assert.equal(source.items[0].qty,3);assert.equal(copy.items[0].raw.system.condition,5);
});
test('daily refill tops up baseline stock once and leaves resale stock untouched',()=>{
  const point=pointData({id:'a',name:'A',presetId:'street',items:[doc('Патроны','ammo',50)],scene:{id:'s'},dayKey:'day1'});
  point.items[0].qty=1;point.items.push({name:'Принятое',qty:1,tradeIn:true});
  assert(!refillPoint(point,'day1'));assert.equal(point.items[0].qty,1);
  assert(refillPoint(point,'day2'));assert.equal(point.items[0].qty,4);assert.equal(point.items[1].qty,1);
  point.items[0].qty=8;assert(refillPoint(point,'day3'));assert.equal(point.items[0].qty,8);
  point.quick.restock=false;assert(!refillPoint(point,'day4'));point.items[0].qty=0;assert(refillPoint(point,'day4',{force:true}));assert.equal(point.items[0].qty,4);
});
test('cursor placement accounts for view scaling, pan and zoom',()=>{
  const canvas={app:{view:{getBoundingClientRect:()=>({left:100,top:50,width:500,height:300})},renderer:{screen:{width:1000,height:600}}},stage:{worldTransform:{applyInverse:p=>({x:(p.x-100)/2,y:(p.y-80)/2})}}};
  assert.deepEqual(canvasPoint({clientX:350,clientY:200},canvas),{x:200,y:110});
});
