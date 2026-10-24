/** Ночной рынок по Корке (по Night City Map, Verlierboy, с разрешения автора): работает ночью, пускают по репутации или рекомендации фиксера. */
export const FIXERS=['Роуг','Мистер Фрешн','Падре','Тихоня Мэй','Скарлетт','Дядя Чен','Ватсон-Джо','Мама Вуду','Кейси «Сто процентов»','Барон','Лиза Дрейк'];
export const MARKET_NAMES=['Рынок под эстакадой','Чёрный базар','Ночной рынок у доков','Барахолка «Полночь»','Рынок на крытой парковке','Базар у старого моста','Контейнерный рынок','Рынок «Красная луна»','Рынок в туннелях метро','Рынок на крыше молла','Неоновый развал','Рынок в заброшенном цеху'];
export const isNightHour=hour=>Number.isFinite(hour)&&(hour>=21||hour<6);
/** Час игровых суток: Simple Calendar, иначе время мира (как часы StreetLife). */
export function marketHour(){
  try{if(game.modules.get('foundryvtt-simple-calendar')?.active){const hour=Number(globalThis.SimpleCalendar?.api?.currentDateTime?.()?.hour);if(Number.isFinite(hour))return hour%24;}}catch{}
  return Math.floor(Math.max(0,Number(game.time?.worldTime)||0)/3600)%24;
}
export const reputationOf=actor=>{const value=Number(actor?.system?.reputation?.value??actor?.system?.reputation??0);return Number.isFinite(value)?value:0;};
/** Можно ли сейчас торговать: Мастер всегда; игрок — ночью и с репутацией или рекомендацией. */
export function nightAccess(shop,actor,{isGM=false,hour=null}={}){
  const market=shop?.nightMarket;if(!market)return {open:true};
  if(isGM)return {open:true,gm:true,night:isNightHour(hour)};
  if(!isNightHour(hour))return {open:false,reason:'Ночной рынок работает с 21:00 до 6:00. Торговцы появятся с наступлением ночи.'};
  const rep=reputationOf(actor);
  if(rep>=Number(market.rep||0)||(actor&&market.referrals?.includes(actor.id)))return {open:true};
  return {open:false,referral:true,reason:`Вход по репутации ${market.rep}+ или по рекомендации фиксера ${market.fixer||''}. У персонажа: ${rep}.`.replace(' .','.')};
}
