import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAdminApi,readServerAdminIds,readAdminDiagnostics} from '../src/admin.js';
import {createSqliteAdminStore,createD1AdminStore} from '../src/admin-store.js';
import {createSqliteCollaborationStore} from '../src/collaboration-store.js';
import {createDurableMailQueue} from '../src/jobs.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const jobsSchema=await readFile(new URL('../schema/collaboration.sqlite.sql',import.meta.url),'utf8');
const origin='https://workspace.example.invalid',secret='admin-fixture-secret-'.repeat(3),stamp='2026-10-15T00:00:00.000Z';
const adminIds=['admin-a','admin-b','unverified'];
async function fixture(t,{d1=false,env={}}={}){
  const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(jobsSchema);db.exec("CREATE TABLE admin_private_sentinel (text TEXT);INSERT INTO admin_private_sentinel VALUES ('PRIVATE PAGE MUST NOT LEAK')");
  t.after(()=>db.close());
  for(const [id,verified]of [['admin-a',1],['admin-b',1],['user-c',1],['unverified',0]])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,?,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',verified,stamp,stamp);
  for(const [id,user]of [['session-a','admin-a'],['session-b','admin-b'],['session-c','user-c']])db.prepare('INSERT INTO yumunio_auth_sessions(id,expiresAt,token,createdAt,updatedAt,ipAddress,userAgent,userId)VALUES(?,?,?,?,?,?,?,?)').run(id,'2026-10-16T00:00:00.000Z','RAW-PRIVATE-TOKEN-'+id,stamp,stamp,'PRIVATE-IP','PRIVATE-UA',user);
  const binding={prepare(sql){return {bind(...params){return {async all(){const s=db.prepare(sql);return /^SELECT\b/.test(sql)?{success:true,results:s.all(...params),meta:{changes:0}}:{success:true,results:[],meta:{changes:Number(s.run(...params).changes)}};}};}};}};
  const store=d1?createD1AdminStore(binding,{adminIds}):createSqliteAdminStore(db,{adminIds});
  const options={env:{YUMUNIO_SERVER_ADMIN_IDS:adminIds.join(','),YUMUNIO_MAIL_DRIVER:'http',...env},store,origin,secret,runtime:d1?'worker':'node',storage:d1?'d1':'sqlite',now:()=>stamp,
    resolveSession:async request=>({user:{id:request.headers.get('x-test-account')??'admin-a',emailVerified:true},session:{id:'session-a'}})};
  const api=createAdminApi(options);
  const request=(path,{method='GET',body,account='admin-a',headers={}}={})=>api(new Request(origin+'/api/admin'+path,{method,headers:{
    'X-Test-Account':account,'X-Yumunio-Expected-Account':account,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {db,store,api,request,options};
}
test('server administrator IDs are explicit, bounded account IDs, never email or first-user promotion',()=>{
  assert.deepEqual(readServerAdminIds(),[]);assert.deepEqual(readServerAdminIds({YUMUNIO_SERVER_ADMIN_IDS:' admin-a,admin-b,admin-a '}),['admin-a','admin-b']);
  assert.throws(()=>readServerAdminIds({YUMUNIO_SERVER_ADMIN_IDS:'owner@example.invalid'}));
  assert.throws(()=>readServerAdminIds({YUMUNIO_SERVER_ADMIN_IDS:'admin-a,,admin-b'}));
  assert.throws(()=>readServerAdminIds({YUMUNIO_SERVER_ADMIN_IDS:Array.from({length:101},(_,i)=>'id-'+i).join(',')}));
});

for(const d1 of [false,true])test((d1?'D1-shaped':'SQLite')+' admin projections are bounded and session cancellation uses current verified authority in one mutation',async t=>{
  const f=await fixture(t,{d1});
  const users=await f.request('/users');assert.equal(users.status,200);const text=await users.text();
  assert.doesNotMatch(text,/RAW-PRIVATE|PRIVATE-IP|PRIVATE-UA|PRIVATE PAGE|password|sessionToken/);
  const list=JSON.parse(text);assert.equal(list.users.length,4);assert.equal(list.users.find(u=>u.id==='admin-a').serverAdmin,true);
  assert.equal(list.users.find(u=>u.id==='user-c').serverAdmin,false);
  const sessions=await f.request('/users/user-c/sessions');assert.equal(sessions.status,200);
  assert.deepEqual(await sessions.json(),{userId:'user-c',sessions:[{id:'session-c',createdAt:stamp,expiresAt:'2026-10-16T00:00:00.000Z',current:false}],hasMore:false});
  const current=await f.request('/users/admin-a/sessions');assert.equal((await current.json()).sessions[0].current,true);
  const wrong=await f.request('/users/admin-b/sessions/session-c',{method:'DELETE',body:{consent:true}});
  assert.equal(wrong.status,404);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions WHERE id=?').get('session-c').n,1);
  const revoked=await f.request('/users/user-c/sessions/session-c',{method:'DELETE',body:{consent:true}});
  assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{revoked:true,currentSession:false});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions WHERE id=?').get('session-c').n,0);
  assert.deepEqual(f.db.prepare('SELECT text FROM admin_private_sentinel').get().text,'PRIVATE PAGE MUST NOT LEAK');
});

test('unconfigured users and unverified configured administrators cannot enumerate people or mutate sessions',async t=>{
  const f=await fixture(t);
  for(const account of ['user-c','unverified','missing'])assert.equal((await f.request('/users',{account})).status,404);
  f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('admin-a');
  assert.equal((await f.request('/config')).status,404);
  assert.equal((await f.request('/users/user-c/sessions/session-c',{method:'DELETE',body:{consent:true}})).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions WHERE id=?').get('session-c').n,1);
});

test('exact Origin, optional GET account guard, mandatory mutation guard and explicit consent reject requests before mutation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/config',{headers:{Origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await f.request('/config',{headers:{'X-Yumunio-Expected-Account':'admin-b'}})).status,404);
  assert.equal((await f.request('/config',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.request('/users/user-c/sessions/session-c',{method:'DELETE',body:{consent:false}})).status,400);
  assert.equal((await f.request('/users/user-c/sessions/session-c',{method:'DELETE',body:{consent:true},headers:{'X-Yumunio-Expected-Account':''}})).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions WHERE id=?').get('session-c').n,1);
});

test('database authority is rechecked after handler authorization for reads, revocations and test-job admission',async t=>{
  for(const action of ['users','revokeSession','enqueueTest']){
    const f=await fixture(t),original=f.store[action].bind(f.store);
    f.store[action]=async(...args)=>{f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('admin-a');return original(...args);};
    const response=action==='users'?await f.request('/users'):action==='revokeSession'?await f.request('/users/user-c/sessions/session-c',{method:'DELETE',body:{consent:true}}):
      await f.request('/mail-test',{method:'POST',body:{requestId:'guarded-test',consent:true}});
    assert.equal(response.status,404);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions WHERE id=?').get('session-c').n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,0);
  }
});

test('diagnostics return whitelisted env state, transport modes and public brand only, never private hosts, paths, DSNs or secrets',async t=>{
  const env={YUMUNIO_DATABASE_URL:'postgres://PRIVATE-USER:PRIVATE-PASSWORD@PRIVATE-HOST/PRIVATE-DB',YUMUNIO_DATABASE:'/PRIVATE/PATH',YUMUNIO_DATABASE_TLS:'verify-full',
    YUMUNIO_SMTP_HOST:'PRIVATE-SMTP-HOST',YUMUNIO_SMTP_PASSWORD:'PRIVATE-SMTP-PASSWORD',YUMUNIO_AUTH_SECRET:'PRIVATE-AUTH-SECRET',YUMUNIO_MAIL_HTTP_ENDPOINT:'https://PRIVATE-RELAY.invalid/send',
    YUMUNIO_BRAND_NAME:'Studio',YUMUNIO_BRAND_LOGO_LIGHT:'/brand/studio.svg',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_EMAIL_DOMAIN_MODE:'allowlist',YUMUNIO_EMAIL_ALLOWED_DOMAINS:'example.invalid'};
  const config=readAdminDiagnostics({env,runtime:'node',storage:'postgres'}),text=JSON.stringify(config);
  assert.doesNotMatch(text,/PRIVATE-/);assert.equal(config.readonly,true);assert.equal(config.database.driver,'postgres');assert.equal(config.branding.applicationName,'Studio');
  assert.equal(config.sourceEnvironment.find(row=>row.key==='YUMUNIO_DATABASE_URL').configured,true);
  assert.deepEqual(config.accounts.domainPolicy.allowedDomains,['example.invalid']);
  const f=await fixture(t,{env});const response=await f.request('/config');assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/PRIVATE-/);
});

test('mail tests queue one encrypted fixed message for the live administrator only, with stable replay and distinct delivery state',async t=>{
  const f=await fixture(t),body={requestId:'explicit-self-test',consent:true};
  const first=await f.request('/mail-test',{method:'POST',body});assert.equal(first.status,202);const job=await first.json();assert.equal(job.status,'queued');assert.equal(job.replayed,false);
  const replay=await f.request('/mail-test',{method:'POST',body});assert.equal(replay.status,202);assert.deepEqual(await replay.json(),{...job,replayed:true});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,1);
  assert.doesNotMatch(f.db.prepare('SELECT payload_ciphertext FROM yumunio_mail_jobs').get().payload_ciphertext,/admin-a@example|Yumunio/);
  const mail=[],queue=createDurableMailQueue({store:createSqliteCollaborationStore(f.db),secret,now:()=>stamp,sendMail:async message=>{mail.push(message);return {status:'accepted'};}});
  assert.equal(mail.length,0);assert.equal((await queue.runDue()).accepted,1);assert.equal(mail[0].to,'admin-a@example.invalid');
  const jobs=await f.request('/jobs');assert.equal(jobs.status,200);const result=await jobs.json();assert.equal(result.counts.accepted,1);assert.equal(result.tests[0].status,'accepted');
  assert.doesNotMatch(JSON.stringify(result),/payload|ciphertext|digest|dedupe|example.invalid|token|provider|relay/);
  assert.deepEqual((await(await f.request('/jobs',{account:'admin-b'})).json()).tests,[]);
  assert.equal((await f.request('/mail-test',{method:'POST',body:{...body,to:'other@example.invalid'}})).status,400);
});

test('dead retries are limited to own test jobs, invalidate old leases and regenerate the message for the current verified email',async t=>{
  const f=await fixture(t);
  const response=await f.request('/mail-test',{method:'POST',body:{requestId:'retry-me',consent:true}}),job=await response.json();
  assert.equal((await f.request('/jobs/'+job.jobId+'/retry',{method:'POST',body:{consent:true}})).status,409);
  f.db.prepare("UPDATE yumunio_mail_jobs SET status='dead',lease_id='stale-lease',lease_until=? WHERE id=?").run(stamp,job.jobId);
  assert.equal((await f.request('/jobs/'+job.jobId+'/retry',{method:'POST',account:'admin-b',body:{consent:true}})).status,409);
  f.db.prepare('UPDATE yumunio_users SET email=? WHERE id=?').run('new-admin@example.invalid','admin-a');
  assert.equal((await f.request('/mail-test',{method:'POST',body:{requestId:'retry-me',consent:true}})).status,409);
  const retry=await f.request('/jobs/'+job.jobId+'/retry',{method:'POST',body:{consent:true}});assert.equal(retry.status,202);assert.deepEqual(await retry.json(),{jobId:job.jobId,status:'queued'});
  const row=f.db.prepare('SELECT lease_id,lease_until,attempts FROM yumunio_mail_jobs WHERE id=?').get(job.jobId);assert.equal(row.lease_id,null);assert.equal(row.lease_until,null);assert.equal(row.attempts,0);
  const mail=[],queue=createDurableMailQueue({store:createSqliteCollaborationStore(f.db),secret,now:()=>stamp,sendMail:async message=>{mail.push(message);return {status:'accepted'};}});
  await queue.runDue();assert.equal(mail[0].to,'new-admin@example.invalid');
  assert.equal((await f.request('/jobs/'+job.jobId+'/retry',{method:'POST',body:{consent:true}})).status,409);
  const replay=await f.request('/mail-test',{method:'POST',body:{requestId:'retry-me',consent:true}});assert.equal(replay.status,202);assert.equal((await replay.json()).replayed,true);
});

test('user and session output remain bounded at 100 and malformed or oversized requests leave storage unchanged',async t=>{
  const f=await fixture(t);
  for(let i=0;i<101;i++)f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,?,?,?)').run('user-'+i,'User '+i,'user-'+i+'@example.invalid',1,stamp,stamp);
  const users=await(await f.request('/users')).json();assert.equal(users.users.length,100);assert.equal(users.hasMore,true);
  const request=(body)=>f.api(new Request(origin+'/api/admin/mail-test',{method:'POST',headers:{Origin:origin,'X-Yumunio-Expected-Account':'admin-a','Content-Type':'application/json'},body}));
  assert.equal((await request('{bad')).status,400);assert.equal((await request('x'.repeat(4097))).status,413);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,0);
});

test('disabled mail never queues a test and unexpected database failures remain sanitized',async t=>{
  const f=await fixture(t,{env:{YUMUNIO_MAIL_DRIVER:'disabled'}});
  assert.equal((await f.request('/mail-test',{method:'POST',body:{requestId:'disabled-test',consent:true}})).status,503);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,0);
  f.store.authorize=async()=>{throw new Error('PRIVATE DATABASE PASSWORD');};
  const response=await f.request('/users');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/PRIVATE/);
});
