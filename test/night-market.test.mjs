import test from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS,NIGHT_SECTIONS,NIGHT_ORDER,rollNightSections,nightPreset,presetFor,eligibleStock,nightGearSection,pointData,acceptsBuyback} from '../scripts/point-model.mjs';
import {nightAccess,isNightHour,reputationOf} from '../scripts/night-market.mjs';
const doc=(name,type,price,extra={})=>({uuid:'Item.'+name,name,type,img:'x.webp',system:{price:{market:price},amount:1},...extra});
const seq=(...v)=>{let i=0;return()=>v[i++%v.length];};

test('Core night market rolls two different d6 sections',()=>{
  for(let i=0;i<300;i++){const [a,b]=rollNightSections();assert.ok(NIGHT_ORDER.includes(a)&&NIGHT_ORDER.includes(b));assert.notEqual(a,b);}
  assert.deepEqual(rollNightSections(seq(0,0,0.99)),['food','survival']);
  assert.deepEqual(rollNightSections(()=>0.5),['cyber','fashion']);
});

test('stock follows the rolled sections: gear is split into food, electronics and survival',()=>{
  const arms=nightPreset(['arms','fashion']);
  assert.deepEqual(new Set(arms.types),new Set(['weapon','ammo','armor','itemUpgrade','clothing']));
  assert(eligibleStock(doc('Штурмовая винтовка','weapon',500),arms));
  assert(!eligibleStock(doc('Фонарик','gear',20),arms));
  const food=nightPreset(['food','tech']);
  assert(eligibleStock(doc('Пиво','gear',10),food));assert(eligibleStock(doc('Агент','gear',100),food));
  assert(eligibleStock(doc('Black Lace','drug',50),food));assert(!eligibleStock(doc('Верёвка','gear',20),food));
  assert(eligibleStock(doc('Верёвка','gear',20),nightPreset(['survival','cyber'])));
  assert.equal(nightGearSection('кибердека щепка'),'tech');assert.equal(nightGearSection('кофе'),'food');assert.equal(nightGearSection('верёвка'),'survival');
  assert(!eligibleStock(doc('Металгир','armor',6000),arms));
  assert.equal(nightPreset([]),PRESETS.night);
  for(const s of NIGHT_ORDER)assert.ok(NIGHT_SECTIONS[s].label);
});

test('a night market point keeps its sections, entry threshold and fixer; copies keep them too',()=>{
  const night={sections:['arms','cyber'],rep:4,fixer:'Падре'};
  const point=pointData({id:'n',name:'Чёрный базар',presetId:'night',items:[doc('Пистолет','weapon',100)],scene:{id:'s',name:'Доки'},dayKey:'d1',night});
  assert.deepEqual(point.nightMarket,{sections:['arms','cyber'],rep:4,fixer:'Падре',referrals:[]});
  assert.equal(point.items[0].qty,PRESETS.night.qty);
  assert.deepEqual(presetFor(point).sections,['arms','cyber']);
  assert(acceptsBuyback(point,doc('Пистолет','weapon',100)));assert(!acceptsBuyback(point,doc('Пиво','gear',10)));
  const copy=pointData({id:'c',name:'Копия',presetId:'night',source:point,scene:{id:'s2'},dayKey:'d2'});
  assert.deepEqual(copy.nightMarket.sections,['arms','cyber']);
});

test('entry: GM always; players only at night with reputation or a fixer referral',()=>{
  const shop={nightMarket:{rep:4,fixer:'Падре',referrals:['friend']}};
  const actor=(id,rep)=>({id,system:{reputation:{value:rep}}});
  assert.equal(nightAccess(shop,actor('a',0),{isGM:true,hour:12}).open,true);
  assert.match(nightAccess(shop,actor('a',9),{hour:12}).reason,/21:00/);
  assert.equal(nightAccess(shop,actor('a',4),{hour:23}).open,true);
  const refused=nightAccess(shop,actor('a',2),{hour:2});assert.equal(refused.open,false);assert.equal(refused.referral,true);assert.match(refused.reason,/репутации 4\+.*Падре.*2/);
  assert.equal(nightAccess(shop,actor('friend',0),{hour:22}).open,true);
  assert.equal(nightAccess({},actor('a',0),{hour:12}).open,true);
  assert.ok(isNightHour(21)&&isNightHour(5)&&!isNightHour(6)&&!isNightHour(20));
  assert.equal(reputationOf({system:{reputation:3}}),3);assert.equal(reputationOf(null),0);
});
