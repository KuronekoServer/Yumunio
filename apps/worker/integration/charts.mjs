import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/worker-fixture.mjs';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoPrivateJsonLiterals} from '../../../packages/identity/test/fixtures/assert-private-projection.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-chart-runtime-',origin='https://chart.fixture.invalid';
test('actual workerd/D1 persists charts across restart and excludes unreadable rows from every aggregate',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs');let worker;
 t.after(async()=>{await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await build({entryPoints:[join(root,'apps/worker/integration/charts-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 const start=()=>new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'chart-runtime-source'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'synthetic-chart-fixture-legacy-key-2026',YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:'synthetic-worker-chart-authentication-secret-2026',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'}}));
 worker=start();await worker.ready;
 const db=await worker.getD1Database('DB'),schema=(await readFile(join(root,'apps/worker/auth-schema.sql'),'utf8')).replace(/^\s*--.*$/gm,'');await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
 const request=(path,{method='GET',body,account,headers={}}={})=>worker.dispatchFetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 async function login(id){const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password:'Synthetic-chart-password-2026!'}}),result=await ok(response);assert.equal(result.user.id,id);return{id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
 await ok(await request('/__fixture/seed'));const owner=await login('chart-owner'),member=await login('chart-member'),base='/api/content/workspaces/chart-workspace';
 const created=await ok(await request(base+'/collections',{method:'POST',account:owner,body:{expectedRevision:0,title:'Chart',parentId:null,properties:[{id:'group',name:'Group',type:'text'},{id:'amount',name:'Amount',type:'number'}]}}),201),path=base+'/collections/'+created.collectionId;
 const visible=(await ok(await request(path+'/records',{method:'POST',account:owner,body:{expectedRevision:1,title:'Visible',values:{group:'A',amount:4}}}),201)).record;
 const hidden=(await ok(await request(path+'/records',{method:'POST',account:owner,body:{expectedRevision:2,title:'Hidden',values:{group:'Private',amount:999}}}),201)).record;
 const view={name:'Saved chart',type:'chart',filters:[],sorts:[],groupBy:'group',datePropertyId:null,endDatePropertyId:null,chart:{type:'bar',aggregation:'sum',valuePropertyId:'amount'}},saved=await ok(await request(path+'/views',{method:'POST',account:owner,body:{expectedRevision:3,view}}),201),viewPath=path+'/views/'+saved.viewId;
 for(const[pageId,revision]of [[created.pageId,4],[visible.pageId,5]])await ok(await request(base+'/pages/'+pageId+'/grants',{method:'POST',account:owner,body:{expectedRevision:revision,accountId:member.id,permission:'viewer'}}));
 const assertReadableProjection=result=>{
  assert.equal(Object.hasOwn(result,'groups'),false);assert.deepEqual(result.chart,{status:'available',groups:[{value:'A',count:1,numericCount:1,result:4}]});
  assert.deepEqual(result.collection.records.map(({id,pageId,title,values})=>({id,pageId,title,values})),[{id:visible.id,pageId:visible.pageId,title:'Visible',values:{group:'A',amount:4}}]);
  assertNoPrivateJsonLiterals(result,[hidden.id,hidden.pageId,'Hidden','Private',999,'999']);
 };
 let result=await ok(await request(viewPath,{account:member}));assertReadableProjection(result);
 await worker.dispose();worker=start();await worker.ready;result=await ok(await request(viewPath,{account:member}));assertReadableProjection(result);assert.deepEqual(result.view.chart,view.chart);
 const stale=await request(viewPath,{method:'PATCH',account:owner,body:{expectedRevision:4,view}});assert.equal(stale.status,409);await stale.arrayBuffer();
 const dbAgain=await worker.getD1Database('DB');await dbAgain.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').bind('replacement-member',member.id).run();const revoked=await request(viewPath,{account:member});assert.equal(revoked.status,404);await revoked.arrayBuffer();
});
