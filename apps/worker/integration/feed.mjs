import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/test/fixtures/worker.mjs';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoPrivateJsonLiterals} from '../../../packages/identity/test/fixtures/assert-private-projection.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-feed-runtime-',origin='https://feed.fixture.invalid';
test('actual workerd/D1 persists Feed order across restart and excludes unreadable rows',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs');let worker;
 t.after(async()=>{await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await build({entryPoints:[join(root,'apps/worker/integration/feed-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 const start=()=>new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'feed-runtime-source'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'synthetic-feed-fixture-legacy-key-2026',YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:'synthetic-worker-feed-authentication-secret-2026',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'}}));
 worker=start();await worker.ready;
 const db=await worker.getD1Database('DB'),schema=(await readFile(join(root,'apps/worker/auth-schema.sql'),'utf8')).replace(/^\s*--.*$/gm,'');await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
 const request=(path,{method='GET',body,account,headers={}}={})=>worker.dispatchFetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 async function login(id){const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password:'Synthetic-feed-password-2026!'}}),result=await ok(response);assert.equal(result.user.id,id);return{id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
 await ok(await request('/__fixture/seed'));const owner=await login('feed-owner'),member=await login('feed-member'),base='/api/content/workspaces/feed-workspace';
 const created=await ok(await request(base+'/collections',{method:'POST',account:owner,body:{expectedRevision:0,title:'Feed',parentId:null,properties:[{id:'group',name:'Group',type:'text'},{id:'amount',name:'Amount',type:'number'}]}}),201),path=base+'/collections/'+created.collectionId;
 const low=(await ok(await request(path+'/records',{method:'POST',account:owner,body:{expectedRevision:1,title:'Low',values:{group:'A',amount:4}}}),201)).record;
 const high=(await ok(await request(path+'/records',{method:'POST',account:owner,body:{expectedRevision:2,title:'High <b>literal</b>',values:{group:'A',amount:8}}}),201)).record;
 const hidden=(await ok(await request(path+'/records',{method:'POST',account:owner,body:{expectedRevision:3,title:'Hidden',values:{group:'Private',amount:999}}}),201)).record;
 const view={name:'Saved Feed',type:'feed',filters:[],sorts:[{propertyId:'amount',direction:'desc'}],groupBy:null,datePropertyId:null,endDatePropertyId:null},saved=await ok(await request(path+'/views',{method:'POST',account:owner,body:{expectedRevision:4,view}}),201),viewPath=path+'/views/'+saved.viewId;
 for(const[pageId,revision]of [[created.pageId,5],[low.pageId,6],[high.pageId,7]])await ok(await request(base+'/pages/'+pageId+'/grants',{method:'POST',account:owner,body:{expectedRevision:revision,accountId:member.id,permission:'viewer'}}));
 const assertReadableProjection=result=>{
  assert.equal(Object.hasOwn(result,'groups'),false);assert.equal(Object.hasOwn(result,'chart'),false);
  assert.deepEqual(result.collection.records.map(({id,pageId,title,values})=>({id,pageId,title,values})),[{id:high.id,pageId:high.pageId,title:'High <b>literal</b>',values:{group:'A',amount:8}},{id:low.id,pageId:low.pageId,title:'Low',values:{group:'A',amount:4}}]);
  assertNoPrivateJsonLiterals(result,[hidden.id,hidden.pageId,'Hidden','Private',999,'999']);
 };
 let result=await ok(await request(viewPath,{account:member}));assertReadableProjection(result);
 const placed={...view,type:'table',name:'Independent placement',filters:[{propertyId:'group',operator:'eq',value:'A'}]},queried=await ok(await request(path+'/query',{method:'POST',account:member,body:{view:placed}}));assertReadableProjection(queried);assert.equal(queried.view.name,'Independent placement');assert.equal(queried.collection.views[0].name,'Saved Feed');assert.equal(queried.revision,result.revision);
 await worker.dispose();worker=start();await worker.ready;result=await ok(await request(viewPath,{account:member}));assertReadableProjection(result);assert.deepEqual({...result.view,id:undefined},{...view,id:undefined});
 const stale=await request(viewPath,{method:'PATCH',account:owner,body:{expectedRevision:7,view:{...view,name:'Retained draft'}}});assert.equal(stale.status,409);await stale.arrayBuffer();
 const denied=await request(viewPath,{method:'PATCH',account:member,body:{expectedRevision:8,view}});assert.equal(denied.status,404);await denied.arrayBuffer();
 const dbAgain=await worker.getD1Database('DB');await dbAgain.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').bind('replacement-member',member.id).run();const revoked=await request(viewPath,{account:member});assert.equal(revoked.status,404);await revoked.arrayBuffer();
 const hiddenPlacement=await request(path+'/query',{method:'POST',account:member,body:{view:placed}});assert.equal(hiddenPlacement.status,404);await hiddenPlacement.arrayBuffer();
 const issues=await ok(await request(base+'/collections',{method:'POST',account:owner,body:{expectedRevision:8,title:'Issues',parentId:null,properties:[{id:'status',name:'Status',type:'status',options:['Not started','Done']},{id:'url',name:'URL',type:'url'},{id:'created',name:'Created',type:'created_time'},{id:'edited',name:'Edited',type:'last_edited_time'}]}}),201),issuePath=base+'/collections/'+issues.collectionId;
 const template=await ok(await request(issuePath+'/templates',{method:'POST',account:owner,body:{expectedRevision:9,name:'New issue',values:{status:'Not started'},blocks:[{id:'overview',type:'heading',data:{text:'Overview',level:2}}]}}),201);
 const issue=await ok(await request(issuePath+'/records',{method:'POST',account:owner,body:{expectedRevision:10,title:'Templated record',templateId:template.templateId,values:{url:'https://example.invalid/'}}}),201);assert.equal(issue.record.values.status,'Not started');assert.ok(Number.isFinite(Date.parse(issue.record.values.created)));
 const project=await ok(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:11,title:'Linked instructions',blocks:[{id:'synced',type:'synced-block',data:{format:'synced-page-v1',pageId:issue.record.pageId}}]}}),201);await ok(await request(base+'/pages/'+project.page.id+'/grants',{method:'POST',account:owner,body:{expectedRevision:12,accountId:member.id,permission:'viewer'}}));
 await worker.dispose();worker=start();await worker.ready;const persisted=await ok(await request(issuePath,{account:owner}));assert.equal(persisted.collection.templates[0].id,template.templateId);assert.equal((await ok(await request(base+'/pages/'+issue.record.pageId,{account:owner}))).document.blocks[0].data.text,'Overview');assert.doesNotMatch(JSON.stringify(await ok(await request(base+'/pages/'+project.page.id,{account:member}))),/Overview|Templated record/);const privateSource=await request(base+'/pages/'+issue.record.pageId,{account:member});assert.equal(privateSource.status,404);await privateSource.arrayBuffer();
});
