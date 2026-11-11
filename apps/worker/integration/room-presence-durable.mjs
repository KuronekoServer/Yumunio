import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/test/fixtures/worker.mjs';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HttpRoomClient} from '@yumunio/collaboration/client';
const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-presence-durable-',origin='https://room-presence-durable.fixture.invalid';
test('Durable Object presence keeps TTL rows in the page room SQLite, never writes D1, and still fences revoked sessions',{timeout:150000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs'),clients=[];let worker;
 t.after(async()=>{for(const client of clients)client.destroy();await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await build({entryPoints:[join(root,'apps/worker/integration/room-socket-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 worker=new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'room-presence-durable'},durableObjects:{ROOMS:{className:'PageRoom',useSQLite:true}},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'Synthetic-worker-durable-presence-key-2026!',YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:'Synthetic-worker-durable-presence-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'}}));await worker.ready;
 // Without the D1 presence migration: the room's own storage must be enough.
 const database=await worker.getD1Database('DB'),presenceSchema=await readFile(join(root,'packages/identity/schema/room-presence.sqlite.sql'),'utf8'),schema=(await readFile(join(root,'apps/worker/auth-schema.sql'),'utf8')).replace(presenceSchema,'').replace(/^\s*--.*$/gm,'');assert.equal(schema.includes('yumunio_room_presence'),false);await database.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>database.prepare(sql)));
 const request=(path,{method='GET',body,account,headers={}}={})=>worker.dispatchFetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};await ok(await request('/__fixture/seed'));
 const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password:'Synthetic-Worker-Room-Renewal-2026!'}}),value=await ok(response);return{id:value.user.id,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};},owner=await login('renew-owner'),viewer=await login('renew-viewer'),base='/api/content/workspaces/renew-workspace';
 const page=await ok(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:0,title:'Durable presence',blocks:[{id:'body',type:'paragraph',data:{text:'Hello room'}}]}}),201),path=base+'/pages/'+page.page.id;await ok(await request(path+'/grants',{method:'POST',account:owner,body:{expectedRevision:1,accountId:viewer.id,permission:'viewer'}}));
 const roomClient=account=>{const client=new HttpRoomClient({accountId:account.id,workspaceId:'renew-workspace',pageId:page.page.id,draft:{title:page.page.title,blocks:page.document.blocks},request:async call=>{const response=await request(call.path,{...call,account}),value=await response.json();if(!response.ok)throw Object.assign(new Error('Synthetic presence request failed.'),{status:response.status,code:value.error?.code});return value;}});clients.push(client);return client;};
 const editor=roomClient(owner),reader=roomClient(viewer);await editor.open({expectedRevision:2});await reader.open({expectedRevision:3});
 const cursor={blockId:'body',start:0,end:5,direction:'forward'},tables=async()=>(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%presence%'").all()).results;
 await editor.publishPresence({cursor});const joined=await reader.publishPresence();assert.deepEqual(joined.participants.map(item=>item.displayName).sort(),['Synthetic renew-owner','Synthetic renew-viewer']);
 assert.deepEqual((await reader.readPresence()).participants.find(item=>!item.self).cursor,cursor);assert.deepEqual(await tables(),[]);
 for(let beat=0;beat<3;beat++)await editor.publishPresence({cursor:{...cursor,start:beat,end:beat}});assert.equal((await editor.readPresence()).participants.length,2);
 await editor.leavePresence();assert.equal((await reader.readPresence()).participants.length,1);await editor.publishPresence({cursor});
 // A deleted session must disappear immediately from other readers, before its TTL.
 await database.prepare('DELETE FROM yumunio_auth_sessions WHERE userId=?').bind(viewer.id).run();assert.deepEqual((await editor.readPresence()).participants.map(item=>item.self),[true]);await assert.rejects(reader.readPresence(),error=>error.status===401);
 assert.deepEqual(await tables(),[]);assert.equal((await ok(await request('/__fixture/metrics'))).externalAttempts,0);
});
