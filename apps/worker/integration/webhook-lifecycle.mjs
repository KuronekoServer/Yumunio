import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exerciseWebhookLifecycle} from '../../../packages/identity/test/fixtures/webhook-lifecycle-flow.js';

const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-webhook-lifecycle-',origin='https://lifecycle.fixture.invalid';
test('actual workerd/D1 production webhook lifecycle preserves consent current scope signed metadata and durability',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs'),key=Buffer.alloc(32,29),received=[];let worker,db,receiverRetry=false;
 const relay=createServer(async(request,response)=>{try{const parts=[];let count=0;for await(const part of request){count+=part.length;assert.ok(count<=1024);parts.push(part);}const body=Buffer.concat(parts).toString('utf8'),event=JSON.parse(body);assert.equal(request.url,'/events');assert.deepEqual(Object.keys(event),['schemaVersion','eventId','eventType','workspaceId','pageId','version','occurredAt']);assert.doesNotMatch(body,/Private|body|fixture@|parentId|membership|profile|grant/);assert.equal(request.headers['x-yumunio-signature'],'sha256='+createHmac('sha256',key).update(request.headers['x-yumunio-timestamp']+'.'+body).digest('hex'));received.push(event);response.writeHead(receiverRetry?503:204).end();}catch{response.writeHead(500).end();}});relay.listen(0,'127.0.0.1');await once(relay,'listening');
 t.after(async()=>{try{await worker?.dispose();await new Promise(resolve=>relay.close(resolve));}finally{const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}});
 await build({entryPoints:[join(root,'apps/worker/integration/webhooks-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 const bindings={YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'Synthetic-worker-lifecycle-legacy-key-2026!',YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:'Synthetic-worker-lifecycle-authentication-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled',YUMUNIO_WEBHOOK_ENABLED:'true',YUMUNIO_WEBHOOK_ENDPOINT:'https://receiver.webhook-fixture.invalid/events',YUMUNIO_WEBHOOK_SIGNING_KEY:key.toString('base64'),YUMUNIO_WEBHOOK_EVENTS:'page.updated,page.title.updated,page.document.updated,page.created,page.moved,page.trashed,page.restored',YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS:'true',YUMUNIO_SERVER_ADMIN_IDS:'webhook-admin',YUMUNIO_FIXTURE_WEBHOOK_RELAY:'http://127.0.0.1:'+relay.address().port+'/events'};
 const start=()=>new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'webhook-lifecycle-runtime'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings}));
 const restart=async()=>{if(worker)assert.equal((await(await worker.dispatchFetch(origin+'/__fixture/metrics')).json()).externalAttempts,0);await worker?.dispose();worker=start();await worker.ready;db=await worker.getD1Database('DB');};await restart();
 const schema=(await readFile(join(root,'apps/worker/auth-schema.sql'),'utf8')).replace(/^\s*--.*$/gm,'');await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
 const request=(path,{method='GET',body,account,headers={}}={})=>worker.dispatchFetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/__fixture/seed')).status,200);
 const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password:'Synthetic-Worker-Webhook-Fixture-2026!'}});assert.equal(response.status,200,await response.clone().text());const value=await response.json();return{id:value.user.id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};};
 await exerciseWebhookLifecycle({request,owner:await login('webhook-owner'),admin:await login('webhook-admin'),workspaceId:'webhook-workspace',received,restart,setRetry(value){receiverRetry=value;},readPending(pageId){return db.prepare('SELECT status,attempts FROM yumunio_webhook_jobs WHERE page_id=? ORDER BY created_at DESC LIMIT 1').bind(pageId).first();},forceDue(){return db.prepare("UPDATE yumunio_webhook_jobs SET next_attempt_at='2020-01-01T00:00:00.000Z' WHERE status='queued'").run();},async drain(){const response=await request('/__fixture/drain',{method:'POST',body:{}});assert.equal(response.status,200,await response.clone().text());},async replaceMembership(id){await db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').bind('webhook-rejoined-lifecycle',id).run();}});
 assert.equal((await(await request('/__fixture/metrics')).json()).externalAttempts,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM yumunio_webhook_guards').first()).n,0);
});
