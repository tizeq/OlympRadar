import { buildEventQuery, safeUrl } from './index.js';

export function localClock(now, timezone) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
 }).formatToParts(now).map(p=>[p.type,p.value]));
 return {day:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}
const changes = result => Number(result?.meta?.changes || 0);
const clean = value => String(value||'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180);
async function telegram(env, uid, text) {
 const url=safeUrl(env.APP_URL);
 const body={chat_id:uid,text,disable_web_page_preview:true};
 if(url?.startsWith('https:'))body.reply_markup={inline_keyboard:[[{text:'Открыть каталог',web_app:{url}}]]};
 const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)throw new Error('Telegram delivery failed');
 const data=await response.json();if(data.ok!==true)throw new Error('Telegram delivery failed');
}
export async function dailyCandidates(db,user,settings,cutoff) {
 const last=await db.prepare('SELECT cutoff FROM digest_deliveries WHERE user_id=? AND cutoff IS NOT NULL ORDER BY julianday(cutoff) DESC LIMIT 1').bind(user.telegram_id).first();
 const ids=Array.isArray(settings.filter_ids)?settings.filter_ids.slice(0,20):[];
 const all=await db.prepare('SELECT id,query_json,created_at FROM saved_filters WHERE user_id=? ORDER BY id LIMIT 20').bind(user.telegram_id).all();
 const filters=ids.length?all.results.filter(f=>ids.includes(f.id)):all.results;
 const values=[];
 const parameter=value=>{const i=values.length;values.push(value??null);return `json_extract(?1, '$[${i}]')`;};
 const since=parameter(user.notification_since||user.created_at);
 const previous=parameter(last?.cutoff);
 const clauses=[];
 for(const filter of filters){let input;try{input=JSON.parse(filter.query_json);}catch{continue;}
  const q=buildEventQuery({...input,min_score:Math.max(Number(input.min_score)||0,Number(settings.min_score)||0)},user.telegram_id);
  let index=0;
  const where=q.where.replace(/e\.(start|deadline) (>=|<=) \?/g, 'julianday(e.$1) $2 julianday(?)').replace(/\?/g,()=>parameter(q.args[index++]));
  const created=parameter(filter.created_at);
  clauses.push(`(${where} AND julianday(e.created_at) > max(coalesce(julianday(${since}),0), coalesce(julianday(${previous}),0), coalesce(julianday(${created}),0)))`);
 }
 if(!clauses.length){const empty=[];empty.total=0;return empty;}
 const before=parameter(cutoff);
 // One JSON bind parameter keeps the complete OR query below D1's variable limit.
 // SQL deduplicates overlapping filters, counts the matches, and returns only three rows.
 const result=await db.prepare(`SELECT e.id,e.title,e.deadline,e.score,COUNT(*) OVER() AS total FROM events e WHERE (${clauses.join(' OR ')}) AND julianday(e.created_at) <= julianday(${before}) ORDER BY e.score DESC,e.id LIMIT 3`).bind(JSON.stringify(values)).all();
 const items=result.results;
 items.total=items[0]?.total||0;
 return items;
}

async function processUser(env,user,now) {
 const settings=JSON.parse(user.settings_json);
 if(settings.enabled!==true && settings.urgent!==true)return;
 const stamp=now.toISOString();
 if(settings.enabled===true){
  const clock=localClock(now,settings.timezone||'Europe/Moscow');
  if(clock.time >= (settings.time||'09:00')){
   const prior=await env.DB.prepare('SELECT status FROM digest_deliveries WHERE user_id=? AND local_date=?').bind(user.telegram_id,clock.day).first();
   if(!prior){
    const items=await dailyCandidates(env.DB,user,settings,stamp);
    if(items.length){
     const reserved=await env.DB.prepare("INSERT OR IGNORE INTO digest_deliveries(user_id,local_date,status,cutoff) VALUES(?,?,'reserved',?)").bind(user.telegram_id,clock.day,stamp).run();
     if(changes(reserved)){
      try{await telegram(env,user.telegram_id,`Новых соревнований для вас: ${items.total}\n\n`+items.map((e,i)=>`${i+1}. ${clean(e.title)}${e.deadline?' — '+clean(e.deadline):''}`).join('\n'));
       await env.DB.prepare("UPDATE digest_deliveries SET status='sent',sent_at=? WHERE user_id=? AND local_date=?").bind(stamp,user.telegram_id,clock.day).run();
      }catch{console.error('Digest delivery failed');}
     }
    }
   }
  }
 }
 if(settings.urgent===true){
  // Explicit favorites only; ISO date-only deadlines expire at the end of the UTC day.
  const deadline="julianday(CASE WHEN length(e.deadline)=10 THEN e.deadline || 'T23:59:59Z' ELSE e.deadline END)";
  const rows=await env.DB.prepare(`SELECT e.id,e.title,e.deadline FROM events e JOIN favorites f ON f.event_id=e.id WHERE f.user_id=?1 AND e.status='active' AND ${deadline}>julianday(?2) AND ${deadline}<=julianday(?2)+1 AND NOT EXISTS(SELECT 1 FROM urgent_deliveries d WHERE d.user_id=f.user_id AND d.event_id=e.id AND d.deadline=e.deadline) ORDER BY ${deadline},e.id LIMIT 3`).bind(user.telegram_id,stamp).all();
  const due=rows.results;
  const reserved=[];
  for(const e of due){const result=await env.DB.prepare('INSERT OR IGNORE INTO urgent_deliveries(user_id,event_id,deadline,reserved_at) VALUES(?,?,?,?)').bind(user.telegram_id,e.id,e.deadline,stamp).run();if(changes(result))reserved.push(e);}
  if(reserved.length)try{await telegram(env,user.telegram_id,'Скоро дедлайн избранных:\n\n'+reserved.map(e=>`${clean(e.title)} — ${clean(e.deadline)}`).join('\n'));}catch{console.error('Urgent delivery failed');}
 }
}
export async function sendDueDigests(env,now=new Date()) {
 if(!env.TELEGRAM_BOT_TOKEN)return {processed:0};
 // Persistent keyset pagination caps queries and network requests per cron invocation.
 const limit=1; // Keep the per-invocation query and Telegram request budget bounded.
 const cursor=await env.DB.prepare('SELECT after_user FROM notification_cursor WHERE id=1').first();
 const users=await env.DB.prepare('SELECT telegram_id,settings_json,created_at,notification_since FROM users WHERE telegram_id>? ORDER BY telegram_id LIMIT ?').bind(cursor?.after_user||'',limit).all();
 for(const user of users.results)try{await processUser(env,user,now);}catch{console.error('Notification user skipped');}
 const after=users.results.length===limit?users.results.at(-1).telegram_id:'';
 await env.DB.prepare('UPDATE notification_cursor SET after_user=? WHERE id=1').bind(after).run();
 return {processed:users.results.length};
}
