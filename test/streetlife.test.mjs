import test from 'node:test';
import assert from 'node:assert/strict';
import {pointPatch,productPatch,imagePath,boundedNumber,changedFields} from '../scripts/streetlife-model.mjs';

test('Saving an open appearance form preserves purchases, balance, bindings and unknown fields',()=>{
  const current={id:'shop',name:'Old',items:[{uuid:'Item.a',qty:3,price:50,flags:{custom:true}}],purse:320,vendorActors:['a'],quick:{markerUuid:'Scene.s.Tile.t'},custom:{nested:1}};
  const next=pointPatch(current,{name:'New',subtitle:'Description',img:'worlds/1/shop.webp'},'bodega');
  assert.equal(next.items[0].qty,3);assert.equal(next.purse,320);assert.deepEqual(next.vendorActors,['a']);assert.deepEqual(next.custom,{nested:1});assert.equal(current.name,'Old');
});
test('Price-only stock edits preserve current quantities and package provenance',()=>{
  const next=productPatch({price:50,qty:2,packageSize:10,flags:{source:'DLC'},raw:{system:{damage:'2d6'}}},{price:'60'},'bodega');
  assert.equal(next.qty,2);assert.equal(next.price,60);assert.equal(next.packageSize,10);assert.equal(next.raw.system.damage,'2d6');
});
test('Editor rejects invalid prices and unsafe images before persistence',()=>{
  for(const bad of ['NaN','Infinity',-2])assert.throws(()=>boundedNumber(bad));
  for(const bad of ['javascript:alert(1)','data:image/svg+xml,x','file:///C:/secret','worlds/"x'])assert.throws(()=>imagePath(bad));
  assert.equal(imagePath('worlds/1/Фото кафе.webp'),'worlds/1/Фото кафе.webp');
  assert.throws(()=>pointPatch({name:'Old'},{purse:500},'bodega'));
});
test('Rules changes retain other categories and reject missing diner categories',()=>{
  const current={buyback:{Weapon:{on:true,pct:50},Gear:{on:true,pct:30}},items:[]};
  const next=pointPatch(current,{'buyback.Weapon.pct':'60'},'bodega');assert.equal(next.buyback.Gear.pct,30);
  assert.throws(()=>productPatch({categoryId:'a'},{categoryId:'b'},'diner',[{id:'a'}]));
  assert.throws(()=>pointPatch(current,{'buyback.Weapon.pct':101},'bodega'));
});
test('Form change detection includes checkbox edits but never sends unchanged stock',()=>{
  const form={querySelectorAll:()=>[{dataset:{field:'price',initial:'50'},value:'50',type:'number'},{dataset:{field:'qty',initial:'10'},value:'10',type:'number'},{dataset:{field:'infinite',initial:'false'},checked:true,type:'checkbox'}]};
  assert.deepEqual(changedFields(form),{infinite:true});
});
