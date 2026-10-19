import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { createSqliteContentStore } from '@yumunio/identity/content-store';
import { previewNotionImport, extractNotionAttachments } from '../../../packages/importer/src/index.js';
import { buildNotionImportBundle } from '../../../packages/importer/src/apply-plan.js';
import { sha256 } from '../../../packages/adapters/src/blob.js';
import { createLocalBlobStore } from '../blob-store.mjs';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';
import { AccountImportAssets } from '../../web/public/import-assets.js';
import { archive } from './fixtures/notion-zip.mjs';

test('a synthetic Notion ZIP preserves native rows, links and private attachment bytes through real Node HTTP', async t => {
  const directory=await mkdtemp(join(tmpdir(),'yumunio-import-assets-'));
  const store=new SqliteSnapshotStore(':memory:'), mail=[];let identity;
  const blobStore=await createLocalBlobStore({driver:'local',directory:join(directory,'blobs')});
  const server=createAppServer({snapshotStore:store,accessKey:'assets-http-fixture-'.repeat(3),identity:{
    handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();store.close();
    const canonical=await realpath(directory);assert.equal(dirname(canonical).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
    assert.match(basename(canonical),/^yumunio-import-assets-/);await rm(canonical,{recursive:true,force:true});
  });
  identity=createIdentity({database:store.database,origin,workspaceContent:true,secret:'local-assets-http-secret-'.repeat(3),registrationMode:'open',
    sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();
  store.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  identity.content=createAccountContentApi({store:createSqliteContentStore(store.database),origin,blobStore,
    resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
  let cookie='',accountId='';
  const request=(path,method='GET',body,{binary=false,revision,authenticated=true}={})=>fetch(origin+path,{method,headers:{
    ...(authenticated&&cookie?{Cookie:cookie}:{}),...(method==='GET'?{}:{Origin:origin}),
    ...(body===undefined?{}:{'Content-Type':binary?'application/octet-stream':'application/json'}),
    ...(accountId?{'X-Yumunio-Expected-Account':accountId}:{}),...(revision===undefined?{}:{'X-Yumunio-Expected-Revision':String(revision)})
  },...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})});
  const email='native-assets@example.invalid',password='native-assets-local-password';
  assert.equal((await request('/api/auth/sign-up/email','POST',{name:'Native fixture',email,password})).status,202);
  await identity.flushBackgroundTasks();
  const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');
  assert.equal((await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account'))).status,200);
  const login=await request('/api/auth/sign-in/email','POST',{email,password});assert.equal(login.status,200);
  accountId=(await login.json()).user.id;cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const workspaceResponse=await request('/api/auth/organization/create','POST',{name:'Native assets fixture',slug:'native-assets-fixture'});
  assert.equal(workspaceResponse.status,200);const workspace=await workspaceResponse.json(),base='/api/content/workspaces/'+workspace.id;
  const fileBytes=new TextEncoder().encode('Independent attachment. <script>literal only</script>');
  const zip=archive([['Guide.md','# Guide\n\n[Rows](Rows.csv)\n\n[Manual](manual.txt)\n'],
    ['Rows.csv','Name,Note\r\nFixture row,"=A1+1"\r\n'],['manual.txt',fileBytes]]);
  const plan=await previewNotionImport(zip),files=await extractNotionAttachments(zip);
  assert.equal(files.size,1);const entry=plan.entries.find(item=>item.kind==='attachment');
  assert.deepEqual(files.get(entry.id),fileBytes);
  const importId='native-assets-http-1',stagePath=base+'/imports/'+importId+'/assets';
  const reservation=await request(stagePath,'POST',{expectedRevision:0,sourceId:entry.id,name:'manual.txt',mediaType:'application/octet-stream',
    size:fileBytes.length,checksum:await sha256(fileBytes)});
  assert.equal(reservation.status,201);const reserved=await reservation.json();assert.equal(reserved.status,'reserved');
  const upload=await request(stagePath+'/'+reserved.assetId,'PUT',fileBytes,{binary:true,revision:reserved.revision});
  assert.equal(upload.status,200);const ready=await upload.json();assert.equal(ready.status,'ready');
  const bundle=buildNotionImportBundle(plan,{expectedRevision:ready.revision,importId,rootTitle:'Imported files',csvMode:'native',
    assets:[{sourceId:entry.id,assetId:ready.assetId}],acknowledgements:{csvTextTypes:true}});
  assert.equal(bundle.summary.attachmentsIncluded,1);assert.equal(bundle.summary.attachmentsExcluded,0);assert.equal(bundle.summary.unconvertedLinks,0);
  const importedResponse=await request(base+'/imports','POST',bundle.body);assert.equal(importedResponse.status,201);
  const imported=await importedResponse.json();assert.equal(imported.pageCount,4);
  const listing=await(await request(base+'/pages')).json(),guide=listing.pages.find(page=>page.title==='Guide');
  const container=listing.pages.find(page=>page.collectionId&&!page.recordId);assert.ok(container);
  const guideEnvelope=await(await request(base+'/pages/'+guide.id)).json();
  assert.equal(guideEnvelope.attachments.length,1);
  const attachment=guideEnvelope.attachments[0];
  const links=guideEnvelope.document.blocks.flatMap(block=>block.data?.links??[]);
  assert.ok(links.some(link=>link.pageId===container.id));assert.ok(links.some(link=>link.attachmentId===attachment.id));
  const downloadPath=base+'/pages/'+guide.id+'/attachments/'+attachment.id;
  const download=await request(downloadPath);assert.equal(download.status,200);
  assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment;/);
  assert.match(download.headers.get('content-security-policy'),/sandbox/);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),fileBytes);
  const collectionEnvelope=await(await request(base+'/collections/'+container.collectionId)).json();
  const collection=collectionEnvelope.collection,record=collection.records[0],property=collection.properties[1];
  assert.equal(record.values[property.id],'=A1+1');assert.equal(record.sourceValues[property.id],'=A1+1');
  const updated=await request(base+'/collections/'+collection.id+'/records/'+record.id,'PATCH',{
    expectedRevision:collectionEnvelope.revision,values:{[property.id]:'Edited text'}
  });assert.equal(updated.status,200);
  const result=await updated.json();assert.equal(result.record.values[property.id],'Edited text');assert.equal(result.record.sourceValues[property.id],'=A1+1');
  const replay=await request(base+'/imports','POST',bundle.body);assert.equal(replay.status,200);assert.equal((await replay.json()).rootPageId,imported.rootPageId);
  assert.equal((await(await request(base+'/pages')).json()).pages.length,4);
  assert.equal((await(await request(stagePath)).json()).assets.length,0);
  const stageFlow=new AccountImportAssets({fetcher:(path,init)=>fetch(origin+path,{...init,headers:{...init.headers,Origin:origin,Cookie:cookie}})});
  const current=(await(await request(base+'/pages')).json()).revision;
  await stageFlow.prepare({workspaceId:workspace.id,accountId,importId:'cancel-native-http',revision:current,
    assets:[{sourceId:'cancel-file',name:'cancel.txt',bytes:fileBytes}]});
  await stageFlow.upload();
  const stageRecords=(await createSqliteContentStore(store.database).read(workspace.id,accountId)).payload.pendingBlobs;
  assert.equal(stageRecords.length,1);const cancelKey=stageRecords[0].objectKey;
  assert.deepEqual(await blobStore.get(cancelKey),fileBytes);
  await stageFlow.cancel();assert.equal(stageFlow.phase,'cancelled');assert.equal(await blobStore.get(cancelKey),null);
  assert.equal((await createSqliteContentStore(store.database).read(workspace.id,accountId)).payload.pendingBlobs.length,0);
  assert.equal((await store.read()).snapshot,null);
  await request('/api/auth/sign-out','POST',{});
  assert.equal((await request(downloadPath)).status,401);
});
