import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {once} from 'node:events';
import {getMigrations} from 'better-auth/db/migration';
import {createNodeIdentityService} from '../identity.mjs';
import {createAppServer} from '../server.mjs';
import {createWorkerAccountServices} from '../../worker/identity.js';
import worker from '../../worker/worker.js';

function retiredEnvironment(base={}){
 const env={...base};
 for(const key of ['YUMUNIO_AI_ENABLED','YUMUNIO_AI_DRIVER','YUMUNIO_AI_ENDPOINT','YUMUNIO_AI_MODEL','YUMUNIO_AI_API_KEY','YUMUNIO_AI_ENCRYPTION_KEY'])Object.defineProperty(env,key,{get(){throw Error('Retired AI configuration must not be read');}});
 return env;
}

test('Node and Worker account factories ignore retired AI configuration without opening disabled account resources',async()=>{
 const env=retiredEnvironment(),config={get storage(){throw Error('Must not open account storage');}};
 assert.equal(await createNodeIdentityService(env,config),null);
 assert.equal(await createWorkerAccountServices(env),null);
});

test('new generated D1 schema includes notes identity tokens and webhooks without creating an AI table',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(await readFile(new URL('../../worker/auth-schema.sql',import.meta.url),'utf8'));
 const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
 for(const name of ['yumunio_users','yumunio_memberships','yumunio_account_content','yumunio_api_tokens','yumunio_webhook_subscriptions'])assert.equal(names.has(name),true,name);
 assert.equal(names.has('yumunio_ai_requests'),false);
});

test('explicit Node identity migration creates no AI table and preserves a pre-existing retired AI table untouched',async t=>{
 const prefix='yumunio-retired-ai-',directory=await mkdtemp(join(tmpdir(),prefix)),filename=join(directory,'accounts.sqlite');let service;
 t.after(async()=>{await service?.close();const target=resolve(directory),rel=relative(resolve(tmpdir()),target);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const env=retiredEnvironment({YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_PUBLIC_ORIGIN:'http://127.0.0.1:8792',YUMUNIO_AUTH_SECRET:'Synthetic-retired-AI-fixture-authentication-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'}),config={storage:'sqlite',database:filename};
 service=await createNodeIdentityService(env,config,{verifySchema:false});
 await(await getMigrations(service.auth.options)).runMigrations();await service.migrateContentSchema();assert.equal(Object.hasOwn(service,'ai'),false);await service.close();service=null;
 const legacy=new DatabaseSync(filename);try{assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yumunio_ai_requests'").get(),undefined);legacy.exec('CREATE TABLE yumunio_ai_requests (marker TEXT NOT NULL)');legacy.prepare('INSERT INTO yumunio_ai_requests(marker) VALUES (?)').run('preserved legacy marker');}finally{legacy.close();}
 service=await createNodeIdentityService(env,config);await service.migrateContentSchema();assert.equal(Object.hasOwn(service,'ai'),false);await service.close();service=null;
 const check=new DatabaseSync(filename);try{assert.deepEqual(check.prepare('SELECT marker FROM yumunio_ai_requests').all().map(row=>row.marker),['preserved legacy marker']);assert.equal(check.prepare('SELECT COUNT(*) AS n FROM yumunio_account_content').get().n,0);}finally{check.close();}
});

test('retired AI HTTP paths behave as unknown routes and cannot invoke a service on Node or Worker',async t=>{
 let calls=0;const identity={async handle(){throw Error('Unexpected identity dispatch');}};Object.defineProperty(identity,'ai',{get(){calls++;throw Error('Retired service invoked');}});
 const server=createAppServer({identity});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>server.close(done)));const origin='http://127.0.0.1:'+server.address().port;
 for(const path of ['/api/unknown-retired-route','/api/ai/config','/api/ai/workspaces/fixture/pages/page/requests'])for(const method of ['GET','POST']){
  const response=await fetch(origin+path,{method,headers:method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{},...(method==='POST'?{body:'{}'}:{})});assert.equal(response.status,501);assert.equal((await response.json()).error.code,'NOT_IMPLEMENTED');
 }
 assert.equal(calls,0);
 const workerOrigin='https://retired-fixture.invalid',env=retiredEnvironment({ASSETS:{async fetch(){throw Error('API must not reach assets');}}});
 assert.equal((await worker.fetch(new Request(workerOrigin+'/health'),env)).status,200);
 for(const path of ['/api/unknown-retired-route','/api/ai/config','/api/ai/workspaces/fixture/pages/page/requests'])for(const method of ['GET','POST']){
  const response=await worker.fetch(new Request(workerOrigin+path,{method,headers:method==='POST'?{Origin:workerOrigin,'Content-Type':'application/json'}:{},...(method==='POST'?{body:'{}'}:{})}),env);assert.equal(response.status,501);assert.equal((await response.json()).error.code,'NOT_IMPLEMENTED');
 }
});
