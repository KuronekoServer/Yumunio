import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/worker-fixture.mjs';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { largeImportBundle } from '../../server/test/fixtures/import-capacity.mjs';
import { previewAppFlowyImport } from '../../../packages/importer/src/index.js';
import { prepareImportBundle, buildImportBundle } from '../../../packages/importer/src/apply-plan.js';
import { appFlowyNativeFiles, appFlowyNativeZip } from '../../../packages/importer/test/fixtures/appflowy-native.js';
import { validateBlocks } from '../../../packages/domain/src/index.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-import-capacity-',origin='https://import-capacity.fixture.invalid';

test('actual workerd/D1 atomically imports 260 private pages above the generic JSON limit and preserves typed source cells and replay after restart',{timeout:120000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs');let worker;
 t.after(async()=>{
  await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);
  assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 await build({entryPoints:[join(root,'apps/worker/integration/import-capacity-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
 const start=()=>new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'import-capacity-source'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'Synthetic-import-capacity-legacy-key-2026!',YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:'Synthetic-import-capacity-authentication-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'}}));
 worker=start();await worker.ready;const database=await worker.getD1Database('DB'),schema=(await readFile(join(root,'apps/worker/snapshot-schema.sql'),'utf8')+'\n'+await readFile(join(root,'apps/worker/auth-schema.sql'),'utf8')).replace(/^\s*--.*$/gm,'');await database.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>database.prepare(sql)));
 const request=async(path,{method='GET',body,account,headers={}}={})=>{
  try{return await worker.dispatchFetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch(cause){throw new Error('Synthetic Worker request failed: '+method+' '+path,{cause});}
 };
 async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 async function login(id){const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password:'Synthetic-feed-password-2026!'}}),result=await ok(response);assert.equal(result.user.id,id);return{id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
 await ok(await request('/__fixture/seed'));const owner=await login('feed-owner'),member=await login('feed-member'),base='/api/content/workspaces/feed-workspace';
 const body=largeImportBundle(0),bodyBytes=new TextEncoder().encode(JSON.stringify(body)).length;assert.equal(body.pages.length,260);assert.ok(bodyBytes>256000&&bodyBytes<768000);
 const invalid=structuredClone(body);invalid.pages[0].parentSourceId=invalid.pages[1].sourceId;invalid.pages[1].parentSourceId=invalid.pages[0].sourceId;
 const bad=await request(base+'/imports',{method:'POST',body:invalid,account:owner});assert.equal(bad.status,400);await bad.arrayBuffer();
 const tooMany={...body,pages:Array.from({length:501},(_,index)=>({sourceId:'page-'+index,parentSourceId:index?'page-0':null,title:'Page',blocks:[]})),collections:[]};
 const capped=await request(base+'/imports',{method:'POST',body:tooMany,account:owner});assert.equal(capped.status,413);await capped.arrayBuffer();
 const ordinary={expectedRevision:0,title:'Ordinary request',blocks:Array.from({length:3},(_,index)=>({id:'ordinary-'+index,type:'paragraph',data:{text:'x'.repeat(90000)}}))};
 validateBlocks(ordinary.blocks);const ordinaryBytes=new TextEncoder().encode(JSON.stringify(ordinary)).length;assert.ok(ordinaryBytes>256000&&ordinaryBytes<=300000);
 const generic=await request(base+'/pages',{method:'POST',account:owner,body:ordinary});
 assert.equal(generic.headers.get('X-Yumunio-Fixture-Received-Bytes'),String(ordinaryBytes));assert.equal(generic.headers.get('X-Yumunio-Fixture-Forwarded-Length'),'absent');
 assert.equal(generic.status,413);assert.equal((await generic.json()).error.code,'CONTENT_TOO_LARGE');assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM yumunio_account_content').first()).n,0);
 const created=await ok(await request(base+'/imports',{method:'POST',body,account:owner}),201);assert.equal(created.pageCount,260);assert.equal(created.revision,1);assert.equal(created.replayed,false);
 const denied=await request(base+'/imports',{method:'POST',body,account:owner,headers:{'X-Yumunio-Expected-Account':member.id}});
 assert.equal(denied.headers.get('X-Yumunio-Fixture-Received-Bytes'),String(bodyBytes));assert.equal(denied.headers.get('X-Yumunio-Fixture-Forwarded-Length'),'absent');
 assert.equal(denied.status,404);assert.equal((await denied.json()).error.code,'CONTENT_NOT_FOUND');
 assert.deepEqual((await ok(await request(base+'/pages',{account:member}))).pages,[]);
 const summary=await database.prepare("SELECT revision,length(CAST(payload_json AS BLOB)) AS bytes,json_array_length(json_extract(payload_json,'$.pages')) AS pages,json_array_length(json_extract(payload_json,'$.imports')) AS receipts FROM yumunio_account_content").first();assert.equal(summary.revision,1);assert.equal(summary.pages,260);assert.equal(summary.receipts,1);assert.ok(summary.bytes<900000);
 await worker.dispose();worker=start();await worker.ready;
 const replay=await ok(await request(base+'/imports',{method:'POST',body,account:owner}));assert.deepEqual(replay,{...created,replayed:true});
 const listing=await ok(await request(base+'/pages',{account:owner}));assert.equal(listing.pages.length,260);assert.equal(listing.revision,1);assert.equal(Object.hasOwn(listing,'imports'),false);
 const table=listing.pages.find(page=>page.title==='Imported records'),collection=await ok(await request(base+'/collections/'+table.collectionId,{account:owner}));assert.equal(collection.collection.records.length,125);assert.ok(collection.collection.properties.every(property=>property.type==='text'));
 const original=collection.collection.properties.find(property=>property.name==='Original');assert.ok(collection.collection.records.some(record=>record.values[original.id]==='007'));assert.ok(collection.collection.records.some(record=>record.values[original.id]==='=SUM(A1)'));
 const rowPrivate=await request(base+'/collections/'+table.collectionId,{account:member});assert.equal(rowPrivate.status,404);await rowPrivate.arrayBuffer();
 const nativePlan=await previewAppFlowyImport(appFlowyNativeZip(appFlowyNativeFiles({attachment:false}))),nativeOptions={expectedRevision:1,importId:'native-source-object-runtime',rootTitle:'Native runtime import',csvMode:'native',rowPageMappings:[]},nativePreview=prepareImportBundle(nativePlan,nativeOptions);
 const nativeBundle=buildImportBundle(nativePlan,{...nativeOptions,acknowledgements:Object.fromEntries(nativePreview.requiredAcknowledgements.map(key=>[key,true]))});
 const nativeResult=await ok(await request(base+'/imports',{method:'POST',body:nativeBundle.body,account:owner}),201);assert.equal(nativeResult.revision,2);assert.equal(nativeResult.pageCount,4);
 const nativeListing=await ok(await request(base+'/pages',{account:owner})),nativePage=nativeListing.pages.find(page=>page.title==='Synthetic page');assert.equal(nativeListing.pages.length,264);
 const nativeTable=nativeListing.pages.find(page=>page.title==='Synthetic database'),nativeCollection=await ok(await request(base+'/collections/'+nativeTable.collectionId,{account:owner}));
 const nativeState=nativeCollection.collection.properties.find(property=>property.name==='State'),nativeRow=nativeCollection.collection.records[0];
 assert.equal(nativeRow.values[nativeState.id],'First');assert.equal(nativeRow.sourceValues[nativeState.id],'First');
 const nativeRowPage=await ok(await request(base+'/pages/'+nativeRow.pageId,{account:owner}));assert.equal(nativeRowPage.document.blocks.find(block=>block.data.sourceFormat==='appflowy-row-v1').data.source.cells['select-field'].data,'option-one');
 const expectedSource=nativePlan.pages.find(page=>page.title==='Synthetic page').blocks.find(block=>block.data.sourceFormat==='appflowy-document-v1').data;
 const getNative=await ok(await request(base+'/pages/'+nativePage.id,{account:owner}));assert.deepEqual(getNative.document.blocks.find(block=>block.data.sourceFormat==='appflowy-document-v1').data,expectedSource);
 const exported=await ok(await request(base+'/export?format=json',{account:owner}));assert.deepEqual(exported.pages.find(item=>item.page.id===nativePage.id).document.blocks.find(block=>block.data.sourceFormat==='appflowy-document-v1').data,expectedSource);
 assert.deepEqual((await ok(await request(base+'/pages',{account:member}))).pages,[]);
 const finalDb=await worker.getD1Database('DB');assert.equal((await finalDb.prepare('SELECT revision FROM yumunio_account_content').first()).revision,2);assert.equal((await finalDb.prepare('SELECT COUNT(*) AS n FROM yumunio_prototype_snapshots').first()).n,0);
});
