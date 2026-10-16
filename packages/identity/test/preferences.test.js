import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createPreferencesApi } from '../src/preferences.js';
import { createSqlitePreferencesStore,createD1PreferencesStore,SqlPreferencesStore } from '../src/preferences-store.js';
import { validatePreferences,THEMES,FONT_OPTIONS,validateCustomColors } from '../src/preferences-model.js';
import { PreferencesStore,validateCustomColors as browserColors } from '../../../apps/web/public/preferences.js';
const identitySchema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const preferenceSchema=await readFile(new URL('../schema/preferences.sqlite.sql',import.meta.url),'utf8');
const origin='https://workspace.example.invalid';
const snapshot=(extra={})=>({schemaVersion:1,themeId:'ocean',customColors:{},fontId:'system',locale:'ja',...extra});
async function fixture(t,{d1=false}={}){
  const db=new DatabaseSync(':memory:');db.exec(identitySchema);db.exec(preferenceSchema);t.after(()=>db.close());
  for(const [id,verified]of [['account-a',1],['account-b',1],['unverified',0]])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,?,?,?)').run(id,id,id+'@example.invalid',verified,'2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z');
  const binding={prepare(sql){return {bind(...params){return {async all(){const s=db.prepare(sql);if(/^SELECT\b/.test(sql))return {success:true,results:s.all(...params),meta:{changes:0}};return {success:true,results:[],meta:{changes:Number(s.run(...params).changes)}};}};}};}};
  const store=d1?createD1PreferencesStore(binding):createSqlitePreferencesStore(db);
  const api=createPreferencesApi({store,origin,resolveSession:async request=>({user:{id:request.headers.get('x-test-account')??'account-a',emailVerified:true}})});
  const request=(body,{method=body===undefined?'GET':'PUT',account='account-a',headers={}}={})=>api(new Request(origin+'/api/preferences',{method,headers:{
    'X-Test-Account':account,'X-Yumunio-Expected-Account':account,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {db,store,api,request};
}
for(const d1 of [false,true])test((d1?'D1-shaped':'SQLite')+' per-account preferences use one verified-account CAS with one winner and no partial overwrite',async t=>{
  const f=await fixture(t,{d1});await f.store.checkSchema();
  assert.deepEqual(await(await f.request()).json(),{revision:0,preferences:null});
  const results=await Promise.all([
    f.request({expectedRevision:0,preferences:snapshot({themeId:'paper'})}),
    f.request({expectedRevision:0,preferences:snapshot({themeId:'midnight'})}),
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const saved=await(await f.request()).json();assert.equal(saved.revision,1);
  assert.ok(['paper','midnight'].includes(saved.preferences.themeId));
  assert.deepEqual(await(await f.request(undefined,{account:'account-b'})).json(),{revision:0,preferences:null});
  const changed=await f.request({expectedRevision:1,preferences:snapshot({locale:'en',fontId:'line-seed-jp'})});
  assert.equal(changed.status,200);assert.deepEqual(await changed.json(),{revision:2,preferences:snapshot({locale:'en',fontId:'line-seed-jp'})});
  assert.equal((await f.request({expectedRevision:1,preferences:snapshot()})).status,409);
  assert.equal((await(await f.request()).json()).revision,2);
});

test('server-neutral preferences match all browser themes, fonts, locale and custom contrast decisions without importing browser code in production',()=>{
  for(const theme of THEMES)for(const font of FONT_OPTIONS)for(const locale of ['ja','en']){
    const value=snapshot({themeId:theme.id,fontId:font.id,locale});
    assert.deepEqual(validatePreferences(value),PreferencesStore.prototype.validate(value));
  }
  for(const theme of THEMES)for(const colors of [{},{accent:'#123'},{text:theme.colors.canvas},{canvas:'rgb(255,255,255)',text:'#111',accent:'#23558E'},{accent:'var(--unsafe)'},{border:'#000'}]){
    const server=validateCustomColors(theme.id,colors),browser=browserColors(theme.id,colors);
    assert.deepEqual(server,browser);
  }
});

test('strict snapshots reject getters, prototype fields, missing schema data, CSS injection, unknown font and low contrast before writing',async t=>{
  const f=await fixture(t);let invoked=0;
  const getter=snapshot();Object.defineProperty(getter,'themeId',{enumerable:true,get(){invoked++;return 'paper';}});
  assert.throws(()=>validatePreferences(getter));assert.equal(invoked,0);
  for(const value of [
    {...snapshot(),schemaVersion:2},{...snapshot(),themeId:'other'},{...snapshot(),fontId:'url(https://fonts.invalid)'},
    {...snapshot(),locale:'fr/../en'},{...snapshot(),customColors:{canvas:'transparent'}},
    {...snapshot(),customColors:{text:THEMES.find(t=>t.id==='ocean').colors.canvas}},
    {...snapshot(),customColors:{surface:'#fff'}},{...snapshot(),secret:'must not store'},
  ])assert.equal((await f.request({expectedRevision:0,preferences:value})).status,400);
  const missing=snapshot();delete missing.customColors;assert.equal((await f.request({expectedRevision:0,preferences:missing})).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_account_preferences').get().n,0);
});

test('session account and exact origin checks run before store access, with no caller account ID accepted in the body',async t=>{
  let reads=0,writes=0;
  const api=createPreferencesApi({origin,resolveSession:async()=>({user:{id:'account-a',emailVerified:true}}),store:{async read(){reads++;return {revision:0,preferences:null};},async write(){writes++;return {};}}});
  const request=(headers={},body)=>api(new Request(origin+'/api/preferences',{method:body?'PUT':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
  assert.equal((await request({'X-Yumunio-Expected-Account':'account-b'})).status,404);
  assert.equal((await request({Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await request({Origin:origin},{expectedRevision:0,preferences:snapshot()})).status,404);
  assert.equal(reads,0);assert.equal(writes,0);
  assert.equal((await request({Origin:origin,'X-Yumunio-Expected-Account':'account-a'},{expectedRevision:0,preferences:snapshot(),accountId:'account-b'})).status,400);
  assert.equal(writes,0);
});

test('current verification or account removal between request validation and the SQL mutation denies the write atomically',async t=>{
  const f=await fixture(t);assert.equal((await f.request(undefined,{account:'unverified'})).status,404);
  const original=f.store.write.bind(f.store);
  f.store.write=async(...args)=>{f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('account-a');return original(...args);};
  assert.equal((await f.request({expectedRevision:0,preferences:snapshot()})).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_account_preferences').get().n,0);
});

test('SQL snapshots are captured before awaiting transport and stored corruption or database errors remain generic',async t=>{
  let release,parameters;
  const store=new SqlPreferencesStore({dialect:'postgres',query:async(sql,params)=>{parameters=params;await new Promise(resolve=>{release=resolve;});return {rows:[],affectedRows:1};}});
  const value=snapshot({customColors:{accent:'#123'}});
  const write=store.write('account-a',{expectedRevision:1,preferences:value});
  value.themeId='paper';value.customColors.accent='#fff';release();
  assert.deepEqual(await write,{revision:2,preferences:snapshot({customColors:{accent:'#112233'}})});
  assert.equal(parameters[0],JSON.stringify(snapshot({customColors:{accent:'#112233'}})));
  const f=await fixture(t);await f.request({expectedRevision:0,preferences:snapshot()});
  f.db.prepare('UPDATE yumunio_account_preferences SET preferences_json=?').run('{"private":"invalid"}');
  const response=await f.request();assert.equal(response.status,503);assert.equal((await response.text()).includes('private'),false);
  const broken=createPreferencesApi({origin,resolveSession:async()=>({user:{id:'account-a',emailVerified:true}}),store:{async read(){throw new Error('private database credential');},async write(){}}});
  const result=await broken(new Request(origin+'/api/preferences'));assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/credential/);
});

test('malformed, oversized and unsupported preference requests do not write or alter the previously saved revision',async t=>{
  const f=await fixture(t);await f.request({expectedRevision:0,preferences:snapshot()});
  const send=(body,type='application/json')=>f.api(new Request(origin+'/api/preferences',{method:'PUT',headers:{Origin:origin,'X-Yumunio-Expected-Account':'account-a','Content-Type':type},body}));
  assert.equal((await send('{bad')).status,400);assert.equal((await send(' '.repeat(8193))).status,413);assert.equal((await send('{}','text/plain')).status,415);
  assert.equal((await f.request({expectedRevision:Number.MAX_SAFE_INTEGER,preferences:snapshot()})).status,400);
  assert.equal((await f.store.read('account-a')).revision,1);
});

test('a canonical community locale round-trips through the real SQLite preference API without changing other settings',async t=>{
 const f=await fixture(t),value=snapshot({locale:'qaa',fontId:'line-seed-jp'});const saved=await f.request({expectedRevision:0,preferences:value});assert.equal(saved.status,200);assert.deepEqual((await saved.json()).preferences,value);const loaded=await f.request();assert.equal(loaded.status,200);assert.deepEqual((await loaded.json()).preferences,value);
});

test('system-following preferences round-trip through SQLite and D1-shaped CAS without replacing manual palette data',async t=>{
 for(const d1 of [false,true]){
  const f=await fixture(t,{d1}),value=snapshot({followSystem:true,customColors:{accent:'#23558E'}});
  const saved=await f.request({expectedRevision:0,preferences:value});assert.equal(saved.status,200);assert.deepEqual((await saved.json()).preferences,value);
  assert.deepEqual((await(await f.request()).json()).preferences,value);
  assert.deepEqual(await(await f.request(undefined,{account:'account-b'})).json(),{revision:0,preferences:null});
  const manual=snapshot({followSystem:false});const changed=await f.request({expectedRevision:1,preferences:manual});assert.equal(changed.status,200);assert.deepEqual((await changed.json()).preferences,snapshot());
  assert.equal((await f.request({expectedRevision:2,preferences:snapshot({followSystem:'true'})})).status,400);assert.equal((await(await f.request()).json()).revision,2);
 }
});
