// Only fields changed by the editor are applied to the latest stock snapshot.
// Purchases, restocking, bindings and imported metadata must survive an open form.
export function boundedNumber(value, min=0, max=1000000000) {
  const n=Number(value); if(!Number.isFinite(n)||n<min||n>max)throw Error(`Введите число от ${min} до ${max}.`);
  return n;
}
export function imagePath(value) {
  const path=String(value??'').trim();
  if(path && (/^(?:javascript|data|file|vbscript):/i.test(path)||/[<>"\x00-\x1f]/.test(path)))throw Error('Укажите путь к изображению Foundry или ссылку http/https.');
  return path;
}
export function pointPatch(current, changes, part) {
  const next=structuredClone(current);
  for(const [key,value] of Object.entries(changes)){
    if(key==='name'){next.name=String(value).trim().slice(0,100);if(!next.name)throw Error('Введите название точки.');}
    else if(key==='subtitle')next.subtitle=String(value).slice(0,1000);
    else if(key==='img')next.img=imagePath(value);
    else if(['sceneId','sceneName'].includes(key))next[key]=String(value||'');
    else if(key==='sceneOnly')next.sceneOnly=!!value;
    else if(part==='diner'&&key==='deliveryMode'){if(!['inventory','chat'].includes(value))throw Error('Неизвестный способ выдачи.');next.deliveryMode=value;}
    else if(part==='diner'&&key==='publicChat')next.publicChat=!!value;
    else if(part==='bodega'&&key.startsWith('buyback.')){
      const [,kind,field]=key.split('.');if(!['Weapon','Ammo','Armor','Cyberware','Gear','Clothing','Drug','Other'].includes(kind)||!['pct','on'].includes(field))throw Error('Неизвестный параметр скупки.');
      next.buyback??={};next.buyback[kind]??={on:false,pct:50};next.buyback[kind][field]=field==='on'?!!value:boundedNumber(value,0,100);
    }
    else throw Error('Этот параметр не поддерживается редактором.');
  }
  return next;
}
export function productPatch(current, changes, part, categories=[]) {
  const next=structuredClone(current);
  for(const [key,value] of Object.entries(changes)){
    if(['price','qty'].includes(key))next[key]=Math.floor(boundedNumber(value));
    else if(key==='infinite'&&part!=='diner')next.infinite=!!value;
    else if(key==='categoryId'&&part==='diner'){if(!categories.some(c=>c.id===value))throw Error('Категория больше не существует.');next.categoryId=value;}
    else throw Error('Этот параметр товара не поддерживается.');
  }
  return next;
}
export function categoryPatch(current,changes){
  const next=structuredClone(current);
  for(const [key,value] of Object.entries(changes)){
    if(key==='label'){next.label=String(value).trim().slice(0,100);if(!next.label)throw Error('Введите название категории.');}
    else if(key==='ruleType'&&['foodTier','monthlyBudget','alwaysPay','alwaysIncluded'].includes(value))next.ruleType=value;
    else if(key==='requiredTier'&&['kibble','generic-prepak','good-prepak','fresh-food'].includes(value))next.requiredTier=value;
    else if(key==='minMonthly')next.minMonthly=boundedNumber(value);
    else throw Error('Неизвестный параметр категории.');
  }
  return next;
}
export function changedFields(form) {
  return Object.fromEntries([...form.querySelectorAll('[data-field]')].filter(el=>{
    const value=el.type==='checkbox'?String(el.checked):el.value;
    return value!==el.dataset.initial;
  }).map(el=>[el.dataset.field,el.type==='checkbox'?el.checked:el.value]));
}
