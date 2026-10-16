import {art,sidebar,clockText,hero,homeView,actorCard,shopAside,productCategory,editorView,saveEditor,addCategory,removeProduct,settingsView,saveSettings,helpView} from './streetlife.mjs';
import {ID,activeOriginals,saleBlocked,fixerRank,requireMarketGM,canOpenMarketTab} from './core.mjs';
import '../vendor/trade.mjs';
import '../vendor/bodega.mjs';
import {DEPARTMENTS,readDepartment,getPoint,canVisit,buy,sell,quoteOrder} from './commerce.mjs';
import {eligibleItems,itemAmount,bundleItemIds} from '../vendor/trade-rules.mjs';
import {PRESETS,preparePoint,createPoint,startPlacement,cancelPlacement,bindNativeMarkers,bindMapOpen,scheduleRefill,refill,setRestock,updateProduct,addProduct,expandAssortment} from './quick-points.mjs';
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const money=n=>`${Number(n||0).toLocaleString('ru-RU')} €$`;
const icon=n=>`<i class="fas fa-${n}" aria-hidden="true"></i>`;
const picture=(src,name)=>`<img src="${esc(src||'modules/night-city-market/assets/bodega.webp')}" alt="" title="${esc(name)}" loading="lazy">`;
const options=(list,value)=>list.map(([id,name])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(name)}</option>`).join('');
function ownActors(){return game.actors.filter(a=>a.type==='character'&&a.testUserPermission(game.user,'OWNER'));}
function defaultBuyer(){return canvas.tokens?.controlled.map(t=>t.actor).find(a=>a?.type==='character'&&a.isOwner)||game.user.character||ownActors()[0];}
let app=null,legacy={};
class MarketWindow extends Application {
  static get defaultOptions(){return foundry.utils.mergeObject(super.defaultOptions,{id:'night-city-market-window',title:'StreetLife — Найт-Сити',width:Math.min(1580,window.innerWidth-36),height:Math.min(900,window.innerHeight-48),resizable:true,classes:['ncm-app']});}
  constructor(){super();this.tab='home';this.selected={};this.buyerId=defaultBuyer()?.id;this.mode='buy';this.query='';this.message='';this.busy=false;this.onlyScene=true;this.quickPreset='street';this.copySource=null;this.targetId='';this.editing=false;this.editorSection='main';this.category='';this.inspected=0;}
  get buyer(){const a=game.actors.get(this.buyerId);return a?.testUserPermission(game.user,'OWNER')?a:null;}
  async _renderInner(){return $(await this.content());}
  async content(){
    const actors=ownActors(),gm=game.user.isGM;
    if(!canOpenMarketTab(this.tab)){this.tab='home';this.editing=false;}
    if(!gm){this.editing=false;this.copySource=null;}
    if(!actors.some(a=>a.id===this.buyerId))this.buyerId=defaultBuyer()?.id;
    let body='';
    if(this.editing&&gm&&DEPARTMENTS[this.tab]){const shop=getPoint(this.tab,this.selected[this.tab]);if(shop)body=editorView(this.tab,shop,this.editorSection);else this.editing=false;}
    if(!body)body=this.tab==='home'?homeView(gm):this.tab==='settings'?settingsView():this.tab==='help'?helpView():this.tab==='quick'?this.quickContent():this.tab==='trade'?this.tradeContent():await this.shopContent();
    return `<main class="ncm-shell">${sidebar(this.tab)}<section class="sl-workspace"><header class="sl-topbar"><strong>StreetLife <small>Cyberpunk RED</small></strong><span>${icon('location-dot')} ${esc(canvas.scene?.name||'Найт-Сити')}</span><span>${icon('calendar-days')} <time data-game-time>${esc(clockText())}</time></span><span class="${game.users.activeGM?'sl-ok':''}">${icon('circle')} ${game.users.activeGM?'Мастер в сети':'Мастер не подключён'}</span></header><div class="sl-customer"><label>Персонаж<select name="buyer" aria-label="Персонаж" ${(this.editing||this.tab==='settings')?'disabled':''}>${options([['','Выберите персонажа'],...actors.map(a=>[a.id,a.name])],this.buyerId)}</select></label><div>${icon('wallet')} На счету <strong>${this.buyer?money(this.buyer.system.wealth?.value):'—'}</strong></div></div><div class="ncm-body">${body}</div><footer class="ncm-status" role="status"><span>${icon('circle-info')} ${esc(this.message||'StreetLife · Люди. Сделки. Истории.')}</span><button type="button" data-action="help" title="Как пользоваться">${icon('circle-question')}</button></footer></section></main>`;
  }

  async shopContent(){
    const part=this.tab,spec=DEPARTMENTS[part],db=readDepartment(part),gm=game.user.isGM;
    const all=Object.values(db[spec.collection]??{}).filter(p=>canVisit(p));
    const points=all.filter(p=>!gm||!this.onlyScene||!p.sceneId||p.sceneId===canvas.scene?.id);
    if(!points.some(p=>p.id===this.selected[part]))this.selected[part]=points[0]?.id;
    const shop=points.find(p=>p.id===this.selected[part]);
    const pointSelector=`<div class="sl-point-switch"><label>${spec.title}<select name="pointSelect" aria-label="Торговая точка">${options(points.map(p=>[p.id,p.name]),shop?.id)}</select></label>${gm?'<label class="ncm-check"><input type="checkbox" name="onlyScene" '+(this.onlyScene?'checked':'')+'> На текущей сцене</label><button type="button" data-tab="quick">'+icon('plus')+' Создать точку</button>':''}</div>`;
    if(!shop)return `<section class="sl-store">${pointSelector}<div class="ncm-empty"><div>${icon(spec.icon)}<h2>Здесь начинается улица</h2><p>${gm?'Выберите готовый набор и разместите торговую точку щелчком на карте.':'Здесь появятся доступные на сцене магазины и заведения.'}</p>${gm?'<button type="button" class="primary" data-tab="quick">Создать точку</button>':''}</div></div></section>`;

    const rows=[],categories=new Set();let hint='';
    if(part==='diner'&&this.buyer){const l=game.dinerManager.inspectLifestyle(this.buyer);hint=`Рацион: ${l.foodTier?.label||l.foodTier?.name||'не указан'}`;}
    else hint=shop.quick?.restock?'Запасы пополняются при смене игрового дня':'Ассортимент и цены заведения';
    if(this.mode==='sell'&&part==='bodega'&&this.buyer){
      for(const item of this.buyer.items){if(saleBlocked(item,this.buyer))continue;const q=await game.bodega.quoteSell(shop,item,this.buyer,db,1);if(!q)continue;
        rows.push(`<article class="ncm-product" data-search="${esc(item.name.toLocaleLowerCase('ru'))}" data-sell-row data-market="${q.market}" data-pct="${q.pct}" data-size="${q.size}">${picture(item.img,item.name)}<div class="ncm-product-name"><strong>${esc(item.name)}</strong><small>${q.verified?'Цена скупки за единицу':'Цену подтвердит Мастер'}</small></div><label class="ncm-quantity">Кол-во<input type="number" name="qty" min="1" max="${itemAmount(item)}" value="1" step="1" aria-label="Количество ${esc(item.name)}"></label><strong class="ncm-price" data-sale-total>${money(q.total)}</strong><button type="button" data-sell="${item.id}" ${!game.users.activeGM?'disabled':''}>${q.verified?'Продать':'Мастеру'}</button></article>`);
      }
    }else{
      for(const [index,item] of (shop.items??[]).entries()){
        const category=await productCategory(item,shop,part);categories.add(category);
        let price=item.price,blocked='',extra='';
        if(part==='bodega'&&this.buyer){const q=game.bodega.quoteBuy(shop,item,this.buyer,db);price=q.price??price;blocked=item.fixerOnly&&!fixerRank(this.buyer)?'Только для фиксера':'';}
        if(part==='diner'&&this.buyer){const q=quoteOrder(db,shop,item,this.buyer);price=q.cost??price;blocked=q.blocked?q.reason:'';extra=q.covered?'Включено в рацион':'';}
        const unlimited=part==='diner'||item.infinite;const out=!unlimited&&Number(item.qty)<=0;
        const packageSize=Math.max(1,Number(item.packageSize)||1);
        rows.push(`<article class="ncm-product ${index===this.inspected?'selected':' '}" data-index="${index}" data-category="${esc(category)}" data-identity="${esc(item.uuid||item.name)}" data-search="${esc(item.name?.toLocaleLowerCase('ru'))}"><button type="button" class="sl-product-icon" data-inspect="${index}" title="Подробнее: ${esc(item.name)}">${picture(item.img,item.name)}</button><div class="ncm-product-name"><strong>${esc(item.name)}</strong><small>${esc(category)} · ${esc(blocked||extra||`${unlimited?'Без ограничения':`В наличии: ${item.qty??0}`}${packageSize>1?` · ${packageSize} шт. в упаковке`:''}`)}</small></div>${part==='bodega'?`<label class="ncm-quantity">Упаковок<input name="qty" type="number" min="1" max="${unlimited?9999:Math.max(1,item.qty||1)}" value="1" step="1" aria-label="Количество ${esc(item.name)}"></label>`:''}<strong class="ncm-price">${money(price)}</strong><button type="button" data-buy="${index}" ${!this.buyer||out||blocked||!game.users.activeGM?'disabled':''}>${out?'Нет в наличии':part==='diner'?'Заказать':'Купить'}</button></article>`);
      }
    }
    const cover=shop.img&& !/icons\/|koff-popper|assets\/(?:bodega|Vendit)/i.test(shop.img)?shop.img:art(part);
    return `<section class="sl-store">${pointSelector}<div class="sl-store-hero" style="background-image:url(&quot;${esc(cover)}&quot;)"><div><small>${esc(spec.title)} / ${esc(shop.sceneName||'Найт-Сити')}</small><h1>${esc(shop.name)}</h1><p>${esc(hint)}</p></div>${gm?'<button type="button" data-action="advanced">'+icon('sliders')+' Настроить точку</button>':''}</div><div class="sl-store-columns"><section class="ncm-detail"><div class="ncm-toolbar"><label class="ncm-search">${icon('magnifying-glass')}<input type="search" name="search" value="${esc(this.query)}" placeholder="Найти товар" aria-label="Найти товар"></label>${part==='bodega'?`<div class="ncm-modes"><button type="button" data-mode="buy" class="${this.mode==='buy'?'active':''}">Купить</button><button type="button" data-mode="sell" class="${this.mode==='sell'?'active':''}">Продать</button></div>`:''}</div>${this.mode!=='sell'?`<nav class="sl-filters" aria-label="Категории товаров"><button type="button" data-category-filter="" class="${!this.category?'active':''}">${icon('border-all')} Все товары</button>${[...categories].map(c=>`<button type="button" data-category-filter="${esc(c)}" class="${this.category===c?'active':''}">${esc(c)}</button>`).join('')}</nav>`:''}<div class="sl-list-heading"><span>ПРЕДМЕТ</span><span>КОЛИЧЕСТВО / ЦЕНА / ДЕЙСТВИЕ</span></div><div class="ncm-products">${rows.join('')||'<p class="ncm-muted">'+(this.mode==='sell'?'Нет подходящих для скупки предметов.':'В этой точке пока нет товаров.')+'</p>'}<p class="ncm-no-results" hidden>Ничего не найдено</p></div>${gm?'<div class="ncm-drop" data-drop>'+icon('plus')+' Перетащите предмет сюда, чтобы добавить товар</div>':''}</section>${this.mode!=='sell'?await shopAside(part,shop,this.buyer,this.inspected):'<aside class="sl-inspector"><section class="sl-panel"><h3>Скупка снаряжения</h3><p>В списке показаны доступные для продажи вещи. Для предметов без подтверждённой цены потребуется проверка Мастера.</p></section></aside>'}</div></section>`;
  }

  tradeContent(){
    const actors=game.actors.filter(a=>a.type==='character'&&a.id!==this.buyerId&&game.users.some(u=>!u.isGM&&a.testUserPermission(u,'OWNER')));
    if(!actors.some(a=>a.id===this.targetId))this.targetId=actors[0]?.id;
    const items=this.buyer?eligibleItems(this.buyer):[];
    return `<section class="ncm-detail ncm-trade">${hero('ПЕРЕДАЧА ВЕЩЕЙ','МЕЖДУ СВОИМИ','trade')}<div class="sl-actors">${actorCard(this.buyer,'ОТПРАВИТЕЛЬ')}${icon('angles-right')}${actorCard(game.actors.get(this.targetId),'ПОЛУЧАТЕЛЬ','cyan')}</div><div class="ncm-detail-head"><div><h2>Передать снаряжение</h2><p>Оружие передаётся вместе с установленными улучшениями.</p></div><label>Получатель<select name="recipient">${options([['','Выберите получателя'],...actors.map(a=>[a.id,a.name])],this.targetId)}</select></label></div><div class="ncm-toolbar"><label class="ncm-search">${icon('magnifying-glass')}<input type="search" name="search" placeholder="Найти предмет" value="${esc(this.query)}"></label></div><div class="ncm-products">${items.map(item=>{const bundle=bundleItemIds(this.buyer,item.id).length>1;return `<article class="ncm-product" data-search="${esc(item.name.toLocaleLowerCase('ru'))}">${picture(item.img,item.name)}<div class="ncm-product-name"><strong>${esc(item.name)}</strong><small>${bundle?'В комплекте с улучшениями':`В наличии: ${itemAmount(item)}`}</small></div><label class="ncm-quantity">Кол-во<input name="qty" type="number" min="1" max="${itemAmount(item)}" value="${bundle?itemAmount(item):1}" ${bundle?'readonly':''}></label><button type="button" data-transfer="${item.id}" ${!this.targetId||!game.users.activeGM?'disabled':''}>Передать</button></article>`;}).join('')||'<p class="ncm-muted">Нет доступных предметов. Выберите персонажа сверху.</p>'}<p class="ncm-no-results" hidden>Ничего не найдено</p></div></section>`;
  }
  quickContent(){
    requireMarketGM();
    const p=PRESETS[this.quickPreset];
    return `<section class="ncm-quick"><div><span class="ncm-eyebrow">ДЛЯ МАСТЕРА</span><h2>Торговая точка за два шага</h2><p>Выберите набор. Затем укажите место на карте.</p></div><form class="ncm-quick-form"><div class="ncm-presets">${Object.entries(PRESETS).map(([id,v])=>`<button type="button" data-preset="${id}" class="${id===this.quickPreset?'active':''}">${icon(v.icon)}<strong>${v.label}</strong><small>${esc(v.description)}</small></button>`).join('')}</div><div class="ncm-quick-fields"><label>Название<input name="pointName" type="text" required maxlength="100" value="${esc(this.copySource?.name||p.label)}"></label><div class="ncm-quick-summary">${this.copySource?`${icon('copy')} Копия «${esc(this.copySource.name)}»: ${(this.copySource.items??[]).length} товаров. Запасы будут независимыми.`:`${icon('wand-magic-sparkles')} До ${p.stockCount} разных товаров по умолчанию; количество можно изменить. Подбор из всех подходящих предметов и компендиумов, по цене до ${money(p.maxPrice)} за товар. Цены и свойства сохраняются.`}</div>${!this.copySource?`<label>Разных товаров<input name="stockCount" type="number" min="1" max="120" step="1" value="${p.stockCount}" required></label>`:""}</div><p class="ncm-muted">${esc(p.description)} Если подходящих предметов меньше, будут добавлены только доступные. Цены указаны за упаковку.</p><div class="ncm-quick-options">${!this.copySource?'<label class="ncm-check"><input name="empty" type="checkbox"> Пустая точка — добавлю товары сам</label>':''}${p.part!=='diner'?'<label class="ncm-check"><input name="restock" type="checkbox" checked> Пополнять до исходного запаса каждый игровой день</label>':'<p class="ncm-muted">Кафе проверяет рацион персонажа и дневной лимит включённых блюд.</p>'}<label class="ncm-check"><input name="repeat" type="checkbox"> Разместить несколько одинаковых точек</label></div><div class="ncm-quick-submit"><button type="submit" class="primary">${icon('location-dot')} Разместить на карте</button><button type="button" data-action="quick-token">${icon('user-tag')} На выбранный токен</button></div><p class="ncm-muted">Щелчок ставит точку, Esc завершает расстановку. Двойной щелчок открывает ассортимент. Alt + двойной щелчок — обычные настройки токена или тайла.</p></form></section>`;
  }
  activateListeners(html){
    super.activateListeners(html);
    if(!this.editing&&game.user.isGM&&DEPARTMENTS[this.tab]){const shop=getPoint(this.tab,this.selected[this.tab]);if(shop?.quick)html.find('[data-action="refill"]').after(`<button type="button" data-action="restock">${icon('clock')} ${shop.quick.restock?'Отключить':'Включить'} автопополнение</button>`);}
    html.find('img').on('error',e=>{const img=e.currentTarget;if(!img.dataset.fallback){img.dataset.fallback='1';img.src='modules/night-city-market/assets/bodega.webp';}});
    html.find('[name="pointSelect"]').on('change',e=>{this.selected[this.tab]=e.currentTarget.value;this.inspected=0;this.query='';this.category='';this.render(false);});
    html.find('.sl-editor-form').on('submit',e=>{e.preventDefault();this.perform(()=>saveEditor(e.currentTarget),'Изменения сохранены');});
    html.find('.sl-settings-form').on('submit',e=>{e.preventDefault();this.perform(()=>saveSettings(e.currentTarget),'Настройки сохранены');});
    html.find('[name="buyer"]').on('change',e=>{this.buyerId=e.currentTarget.value;this.render(false);});
    html.find('[name="recipient"]').on('change',e=>{this.targetId=e.currentTarget.value;this.render(false);});
    html.find('[name="onlyScene"]').on('change',e=>{this.onlyScene=e.currentTarget.checked;this.render(false);});
    html.find('[name="search"]').on('input',e=>{this.query=e.currentTarget.value;this.filter(html);});
    html.find('[data-sell-row] [name="qty"]').on('input',e=>{const row=e.currentTarget.closest('article'),d=row.dataset;row.querySelector('[data-sale-total]').textContent=money(Math.floor(Number(d.market)*Number(d.pct)/100*Number(e.currentTarget.value)/Math.max(1,Number(d.size))));});
    html.find('[data-edit]').on('change',e=>{const el=e.currentTarget,row=el.closest('article');this.perform(()=>updateProduct(this.tab,this.selected[this.tab],Number(row.dataset.index),{[el.dataset.edit]:el.value},row.dataset.identity),'Товар обновлён');});
    html.on('click','button[type="button"]',e=>{
      const b=e.currentTarget,d=b.dataset,row=b.closest('article'),qty=Number(row?.querySelector('[name="qty"]')?.value||1);
      if(d.tab){if(!canOpenMarketTab(d.tab))return ui.notifications.warn('Этот раздел доступен только Мастеру.');if(!this.leaveEditor())return;this.tab=d.tab;this.query='';this.category='';this.mode='buy';this.inspected=0;if(d.tab==='quick')this.copySource=null;this.render(false);}
      else if(d.point){this.selected[this.tab]=d.point;this.query='';this.render(false);}
      else if(d.mode){this.mode=d.mode;this.category='';this.render(false);}
      else if('inspect' in d){this.inspected=Number(d.inspect);this.render(false);}
      else if('categoryFilter' in d){this.category=d.categoryFilter;html.find('[data-category-filter]').removeClass('active');b.classList.add('active');this.filter(html);}
      else if(d.editorTab){if(!game.user.isGM)return; if(!this.leaveEditor())return;this.editing=true;this.editorSection=d.editorTab;this.render(false);}
      else if(d.openItem){this.perform(async()=>{const item=await fromUuid(d.openItem);if(item?.testUserPermission(game.user,'LIMITED')||item?.pack)item?.sheet?.render(true);else throw Error('Описание предмета недоступно.');},'Описание открыто');}
      else if('removeProduct' in d){if(this.hasDirtyForm()){ui.notifications.warn('Сначала сохраните изменения.');return;}const entry=b.closest('[data-product-index]');this.perform(()=>removeProduct(this.tab,this.selected[this.tab],Number(d.removeProduct),entry.dataset.identity),'Товар удалён из витрины');}
      else if(d.preset){if(!game.user.isGM)return;this.quickPreset=d.preset;this.copySource=null;this.render(false);}
      else if('buy' in d)this.perform(()=>buy(this.tab,this.selected[this.tab],Number(d.buy),this.buyer,qty),'Покупка выполнена');
      else if(d.sell)this.perform(()=>sell(this.selected.bodega,d.sell,this.buyer,qty),'Продажа выполнена');
      else if(d.transfer)this.perform(()=>game.choomTrade.requestTransfer({sourceActorUuid:this.buyer.uuid,targetActorUuid:game.actors.get(this.targetId)?.uuid,itemId:d.transfer,quantity:qty}),'Предмет передан');
      else if(d.action==='quick-token')this.quickSubmit(html.find('form')[0],true);
      else if(d.action)this.action(d.action);
    });
    html.find('form.ncm-quick-form').on('submit',e=>{e.preventDefault();this.quickSubmit(e.currentTarget);});
    html.find('[data-drop]').on('dragover',e=>{e.preventDefault();e.currentTarget.classList.add('over');}).on('dragleave',e=>e.currentTarget.classList.remove('over')).on('drop',e=>{e.preventDefault();if(this.hasDirtyForm()){ui.notifications.warn('Сначала сохраните изменения.');return;}this.perform(async()=>{const payload=JSON.parse(e.originalEvent.dataTransfer.getData('text/plain'));const doc=await fromUuid(payload.uuid);await addProduct(this.tab,this.selected[this.tab],doc);},'Товар добавлен');});
    this.filter(html);
  }
  filter(html){let visible=0;html.find('[data-search]').each((_i,e)=>{e.hidden=!e.dataset.search.includes(this.query.trim().toLocaleLowerCase('ru'))||!!(this.category&&e.dataset.category!==this.category);if(!e.hidden)visible++;});html.find('.ncm-no-results').prop('hidden',(!this.query&&!this.category)||visible>0);}
  async perform(work,message){if(this.busy)return;this.busy=true;this.element.find('[data-buy],[data-sell],[data-transfer],[data-edit]').prop('disabled',true);try{const result=await work();if(result?.ok===false)throw Error(result.message||result.reason||'Операция не выполнена.');this.message=typeof message==='function'?message(result):message;}catch(error){this.message=error.message;ui.notifications.warn(error.message);}finally{this.busy=false;this.render(false);}}
  async quickSubmit(form,onToken=false){
    if(this.busy||!game.user.isGM)return;this.busy=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{
      const prepared=await preparePoint({presetId:this.quickPreset,name:form.querySelector('[name="pointName"]').value,restock:!!form.querySelector('[name="restock"]')?.checked,empty:!!form.querySelector('[name="empty"]')?.checked,sourceId:this.copySource?.id,count:form.querySelector('[name="stockCount"]')?.value});
      const placed=result=>{this.tab=result.part;this.selected[result.part]=result.point.id;this.onlyScene=true;this.message=`Создана точка «${result.point.name}»`;};
      if(onToken){const tokens=canvas.tokens.controlled;if(tokens.length!==1)throw Error('Выберите на карте один токен торговца.');placed(await createPoint(prepared,{token:tokens[0].document}));}
      else{const repeat=!!form.querySelector('[name="repeat"]')?.checked;await this.minimize();startPlacement(prepared,{repeat,onPlaced:placed,onEnd:()=>{if(!this._marketClosing){this.maximize();this.render(false);}}});}
    }catch(error){this.message=error.message;ui.notifications.warn(error.message);if(this._minimized)await this.maximize();}finally{this.busy=false;if(!this._minimized)this.render(false);}
  }
  async action(action){
    if(action==='help'){if(!this.leaveEditor())return;this.tab='help';this.render(false);return;}
    if(action==='inventory'){this.buyer?.sheet?.render(true);return;}
    if(!game.user.isGM)return ui.notifications.warn('Настройки и управление торговлей доступны только Мастеру.');
    if(action==='item-directory'){ui.sidebar.activateTab('items');ui.items.renderPopout();return;}
    if(action==='editor-cancel'){this.editing=false;this.message='Изменения отменены';this.render(false);return;}
    if(action==='editor-close'){if(!this.leaveEditor())return;this.render(false);return;}
    if(action==='pick-cover'){const field=this.element[0]?.querySelector('[data-field="img"]');if(field)new FilePicker({type:'image',current:field.value,callback:path=>{field.value=path;const preview=this.element[0]?.querySelector('.sl-cover-preview');if(preview)preview.src=path;}}).render(true);return;}
    if(!game.user.isGM)return;
    if(['copy','legacy','add-category','bind','refill','restock','expand-stock'].includes(action)&&this.hasDirtyForm()){this.message='Сначала сохраните изменения или нажмите «Отмена».';this.element.find('.ncm-status>span').text(this.message);return;}
    const part=this.tab,shop=getPoint(part,this.selected[part]);if(!shop)return;
    if(action==='copy'){this.editing=false;this.quickPreset=shop.quick?.presetId||(part==='bodega'?'street':part);this.copySource=shop;this.tab='quick';this.render(false);}
    else if(action==='advanced'){this.editing=true;this.editorSection='main';this.render(false);}
    else if(action==='legacy'){if(!this.leaveEditor())return;if(part==='diner')legacy.dinerEdit(shop.id);else legacy[part]();this.render(false);}
    else if(action==='locate'){this.perform(async()=>{const marker=await fromUuid(shop.tileUuid||shop.quick?.markerUuid||'');if(!marker)throw Error('У точки нет метки на карте.');if(marker.parent?.id!==canvas.scene?.id)await marker.parent.view();await this.minimize();canvas.animatePan({x:marker.x,y:marker.y,scale:1});},'Точка показана на карте');}
    else if(action==='add-category')this.perform(()=>addCategory(shop.id),'Категория добавлена');
    else if(action==='expand-stock')this.perform(()=>expandAssortment(part,shop.id,{count:this.element[0].querySelector('[name="expandCount"]').value}),r=>`Добавлено: ${r.added}. Всего: ${r.total}${r.total<r.target?' — больше подходящих товаров в доступных источниках не найдено.':'.'}`);
    else if(action==='refill')this.perform(()=>refill(part,shop.id),'Запасы пополнены');
    else if(action==='restock')this.perform(()=>setRestock(part,shop.id,!shop.quick.restock),'Автопополнение обновлено');
    else if(action==='bind')this.perform(async()=>{const tokens=canvas.tokens.controlled;if(tokens.length!==1)throw Error('Выберите один токен торговца.');const token=tokens[0].document;if(token.getFlag(ID,'point')||game.bodega.resolveVendorTokenSync(token))throw Error('Токен уже привязан к торговой точке.');await token.setFlag(ID,'point',{part,id:shop.id});},'Токен привязан');
  }
  hasDirtyForm(){const form=this.element[0]?.querySelector('.sl-editor-form,.sl-settings-form');return [...(form?.querySelectorAll('[data-field]')||[])].some(el=>(el.type==='checkbox'?String(el.checked):el.value)!==el.dataset.initial);}
  leaveEditor(){if(this.hasDirtyForm()){this.message='Сохраните изменения или нажмите «Отмена» перед переходом.';this.element.find('.ncm-status>span').text(this.message);return false;}this.editing=false;return true;}
  async close(options){this._marketClosing=true;cancelPlacement();try{return await super.close(options);}finally{this._marketClosing=false;}}
}
export function openMarket({tab,id,buyer}={}){
  if(tab&&!canOpenMarketTab(tab))return ui.notifications.warn('Этот раздел недоступен. Настройки и управление открывает Мастер.');
  if(app?.rendered&&app.hasDirtyForm()){app.leaveEditor();app.bringToTop();return app;}
  const conflicts=activeOriginals();if(conflicts.length)return ui.notifications.error('Отключите отдельные исходные модули: '+conflicts.join(', '));
  if(id&&DEPARTMENTS[tab]){const shop=getPoint(tab,id);if(!shop||!canVisit(shop))return ui.notifications.warn('Эта торговая точка недоступна.');}
  app??=new MarketWindow();if(tab)app.tab=tab;if(id&&DEPARTMENTS[app.tab])app.selected[app.tab]=id;if(buyer)app.buyerId=buyer.id;app.editing=false;
  if(id&&game.user.isGM)app.onlyScene=false;
  app.render(true);return app;
}
Hooks.once('init',()=>bindNativeMarkers(openMarket));
Hooks.once('ready',async()=>{
  if(activeOriginals().length)return;
  legacy={bodega:game.bodega.openAdmin,vendit:game.vendit.openManager,diner:game.dinerManager.openManager,dinerEdit:game.dinerManager.edit};
  game.nightCityMarket={open:openMarket,help:()=>{openMarket();app.action('help');},openShop:(part,id)=>openMarket({tab:part,id}),openManager:part=>{if(game.user.isGM)legacy[part]?.();},preparePoint,createPoint,refill,expandAssortment};
  game.bodega.openShop=id=>openMarket({tab:'bodega',id});game.vendit.openShop=id=>openMarket({tab:'vendit',id});game.dinerManager.open=id=>openMarket({tab:'diner',id});game.choomTrade.open=()=>openMarket({tab:'trade'});
  if(game.user.isGM&&game.users.activeGM?.id===game.user.id&&!game.macros.some(m=>m.getFlag(ID,'launcher')))await Macro.create({name:'Найт-Сити — Торговля',type:'script',img:'modules/night-city-market/assets/bodega.webp',command:'game.nightCityMarket.open();',ownership:{default:2},flags:{[ID]:{launcher:true}}});
  bindMapOpen(openMarket);scheduleRefill();
});
Hooks.on('getSceneControlButtons',controls=>{const token=controls.find(c=>c.name==='token');if(token&&!token.tools.some(t=>t.name==='night-city-market'))token.tools.push({name:'night-city-market',title:'Найт-Сити — Торговля',icon:'fas fa-store',button:true,onClick:()=>openMarket()});});
Hooks.on('renderActorDirectory',(_app,html)=>{if(html.find('[data-ncm-open]').length)return;const button=$('<button type="button" data-ncm-open><i class="fas fa-store"></i> Торговля Найт-Сити</button>');button.on('click',()=>openMarket());html.find('.directory-header').append(button);});
Hooks.on('canvasReady',()=>{cancelPlacement();bindMapOpen(openMarket);});Hooks.on('canvasTearDown',cancelPlacement);
Hooks.on('updateWorldTime',scheduleRefill);Hooks.on('simple-calendar-date-time-change',scheduleRefill);
let refreshTimer=null;
function refreshWindow(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(app?.rendered&&!app.busy&&!app._minimized&&app.tab!=='quick'&&!app.editing&&app.tab!=='settings'&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))app.render(false);},120);}
Hooks.on('updateSetting',setting=>{if(setting.key?.startsWith(ID+'.'))refreshWindow();});Hooks.on('updateActor',refreshWindow);Hooks.on('nightCityMarketChanged',refreshWindow);








function updateClock(){app?.element?.find('[data-game-time]').text(clockText());}
Hooks.on('updateWorldTime',updateClock);Hooks.on('simple-calendar-date-time-change',updateClock);
Hooks.on('renderChatMessage',(_message,html)=>{if(html.find('.sl-chat-card,.ct-chat-card').length)html.addClass('sl-receipt');});
