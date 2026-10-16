import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exerciseStructuredRoom} from '../../../packages/identity/test/fixtures/structured-room-flow.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-structured-room-',origin='https://structured-room.fixture.invalid';
test('actual workerd and D1 persist granular structured room operations, selective undo, restart, legacy protocol and current ACL fences',{timeout:150000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs');let worker;
 t.after(async()=>{await worker?.dispose();const target=resolve(directory),rel=relative(resolve(tmpdir()),target);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await build({entryPoints:[join(root,'apps/worker/integration/room-renew-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 const options=convertV4MiniflareOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'structured-room-runtime-source'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'Synthetic-worker-structured-room-access-key-2026!',YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:'Synthetic-worker-structured-room-auth-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'}}),start=async()=>{worker=new Miniflare(options);await worker.ready;};await start();let database=await worker.getD1Database('DB');const schema=(await readFile(join(root,'apps/worker/auth-schema.sql'),'utf8')).replace(/^\s*--.*$/gm,'');await database.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>database.prepare(sql)));
 const request=(path,{method='GET',body,account,headers={}}={})=>worker.dispatchFetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),ok=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};await ok(await request('/__fixture/seed'));
 const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password:'Synthetic-Worker-Room-Renewal-2026!'}}),value=await ok(response);return{id:value.user.id,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};};
 let concurrentProof=null;
 const diagnostics=async()=>{let timer;try{const response=await Promise.race([request('/__fixture/metrics'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic diagnostics timeout.')),5000);})]);return await ok(response);}finally{clearTimeout(timer);}};
 try{
  await exerciseStructuredRoom({request,owner:await login('renew-owner'),member:await login('renew-viewer'),workspaceId:'renew-workspace',async beforeConcurrentSync(){await ok(await request('/__fixture/structured-race',{method:'POST',body:{}}));},async afterConcurrentSync(_stage,{failed}){const metrics=await diagnostics();concurrentProof={race:metrics.structuredRace,failures:metrics.batchFailures};if(!failed){assert.deepEqual(metrics.structuredRace,{arrivals:2,released:true,timedOut:false});assert.ok(metrics.batchFailures.some(item=>item.contentWrite),'the concurrent fixture must exercise a rejected CAS batch');}},async restart(){await worker.dispose();await start();database=await worker.getD1Database('DB');},async replaceMembership(){await database.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').bind('replacement-structured-generation','renew-viewer').run();}});assert.equal((await diagnostics()).externalAttempts,0);
 }finally{
  try{const metrics=await diagnostics();console.log('Structured room bounded diagnostics: '+JSON.stringify({concurrent:concurrentProof,current:{race:metrics.structuredRace,failures:metrics.batchFailures}}));}catch{console.log('Structured room bounded diagnostics unavailable.');}
 }
});
