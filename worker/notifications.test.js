import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sendDueDigests,localClock} from './notifications.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 for(const file of ['0001_initial.sql','0002_notifications.sql'])db.exec(readFileSync(new URL('./migrations/'+file,import.meta.url),'utf8'));
 const env={DB:{prepare(sql){return {args:[],bind(...args){assert.ok(args.length<=100);this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args);},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return {meta:db.prepare(sql).run(...this.args)};}};}},TELEGRAM_BOT_TOKEN:'test',APP_URL:'https://example.com'};
 const settings={enabled:true,time:'09:00',timezone:'Europe/Moscow',min_score:50,filter_ids:[],urgent:false};
 db.prepare('INSERT INTO users(telegram_id,settings_json,created_at,updated_at,notification_since) VALUES(?,?,?,?,?)').run('1',JSON.stringify(settings),'2026-01-01','2026-01-01','2026-01-01');
 db.prepare('INSERT INTO saved_filters(id,user_id,name,query_json,created_at) VALUES(?,?,?,?,?)').run('default','1','Default','{}','2026-01-01');
 const add=(id,date='2026-01-02T00:00:00Z',score=80)=>db.prepare("INSERT INTO events(id,title,status,score,created_at) VALUES(?,?,'active',?,?)").run(id,'Event '+id,score,date);
 return {db,env,add,settings};
}
test('DST repeats use the same local day and spring forward is passed',()=>{
 assert.equal(localClock(new Date('2026-11-01T05:30:00Z'),'America/New_York').day,localClock(new Date('2026-11-01T06:30:00Z'),'America/New_York').day);
 assert.equal(localClock(new Date('2026-03-08T07:05:00Z'),'America/New_York').time,'03:05');
});
test('top three, no old entries, reserved before network and no retry after failure',async()=>{
 const {db,env,add}=fixture();try{
 add('old','2025-12-01');for(let i=0;i<5;i++)add(String(i));let calls=0;
 const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.ok(db.prepare('SELECT * FROM digest_deliveries').get());assert.equal(body.text.includes('Event old'),false);assert.equal(body.text.split('\n').filter(x=>/^\d\./.test(x)).length,3);assert.ok(body.reply_markup);throw new Error('timeout');};
 try{await sendDueDigests(env,new Date('2026-01-03T09:00:00Z'));await sendDueDigests(env,new Date('2026-01-03T10:00:00Z'));assert.equal(calls,1);}finally{globalThis.fetch=original;}
 }finally{db.close();}
});
test('empty digest does not send, filter creation excludes backlog, urgent needs opt in',async()=>{
 const {db,env,add,settings}=fixture();try{
 add('earlier');db.prepare('INSERT INTO saved_filters(id,user_id,name,query_json,created_at) VALUES(?,?,?,?,?)').run('f','1','Filter','{}','2026-01-04');
 db.prepare('UPDATE users SET settings_json=? WHERE telegram_id=?').run(JSON.stringify({...settings,filter_ids:['f']}),'1');
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({ok:true})};};
 try{await sendDueDigests(env,new Date('2026-01-05T09:00:00Z'));assert.equal(calls,0);
 add('favorite');db.prepare("UPDATE events SET deadline='2026-01-05T15:00:00Z' WHERE id='favorite'").run();db.prepare("INSERT INTO favorites VALUES('1','favorite')").run();
 await sendDueDigests(env,new Date('2026-01-05T09:00:00Z'));assert.equal(calls,0);
 db.prepare('UPDATE users SET settings_json=? WHERE telegram_id=?').run(JSON.stringify({...settings,enabled:false,urgent:true}),'1');
 await sendDueDigests(env,new Date('2026-01-05T09:00:00Z'));await sendDueDigests(env,new Date('2026-01-05T09:01:00Z'));assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
 }finally{db.close();}
});
test('persistent pagination advances and isolates invalid settings',async()=>{
 const {db,env}=fixture();try{env.NOTIFICATION_BATCH_SIZE='1';db.prepare("UPDATE users SET settings_json='broken'").run();db.prepare("INSERT INTO users(telegram_id,created_at,updated_at) VALUES('2','2026-01-01','2026-01-01')").run();
 await sendDueDigests(env);assert.equal(db.prepare('SELECT after_user FROM notification_cursor').get().after_user,'1');
 await sendDueDigests(env);assert.equal(db.prepare('SELECT after_user FROM notification_cursor').get().after_user,'2');
 await sendDueDigests(env);assert.equal(db.prepare('SELECT after_user FROM notification_cursor').get().after_user,'');
 }finally{db.close();}
});

test('no saved filters means no digest, twenty complex filters respect bind cap',async()=>{
 const {db,env,add}=fixture();try{
 db.exec('DELETE FROM saved_filters');add('new');let calls=0;let text='';
 const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>{calls++;text=JSON.parse(options.body).text;return {ok:true,json:async()=>({ok:true})};};
 try{
 await sendDueDigests(env,new Date('2026-01-03T09:00:00Z'));assert.equal(calls,0);
 db.exec("UPDATE notification_cursor SET after_user=''");
 for(let i=0;i<20;i++)db.prepare('INSERT INTO saved_filters(id,user_id,name,query_json,created_at) VALUES(?,?,?,?,?)').run(String(i),'1','Filter',JSON.stringify({min_score:30,age:18}),'2026-01-01');
 await sendDueDigests(env,new Date('2026-01-03T09:00:00Z'));assert.equal(calls,1);assert.ok(text.includes('для вас: 1'));
 }finally{globalThis.fetch=original;}
 }finally{db.close();}
});
