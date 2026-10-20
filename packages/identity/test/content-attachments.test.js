import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSqliteContentStore } from '../src/content-store.js';
import { createAccountContentApi } from '../src/content.js';
import {ClipboardUploadBatch} from '../../../apps/web/public/clipboard-upload.js';
import {createAttachmentBlock} from '../../../apps/web/public/attachment-block.js';
import {HttpRoomClient} from '../../collaboration/src/client.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const stamp='2026-10-15T00:00:00.000Z',origin='https://uploads.example.invalid',workspaceId='workspace';
const bytes=new TextEncoder().encode('Synthetic page attachment.');
const hash=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',value)).toString('hex');
async function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(workspaceId,'Uploads','uploads',stamp);
  const people=[['author','member','full'],['editor','guest','editor'],['viewer','guest','viewer'],['hidden','member',null]];
  for(const[id,role]of people){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,role,stamp);}
  const page=id=>({page:{id,workspaceId,title:id,parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId,version:1,updatedAt:stamp,blocks:[{id:'text-'+id,type:'paragraph',data:{text:'Keep this body'}}]},inheritPermissions:false});
  const payload={schemaVersion:1,pages:[page('page'),page('other')],grants:[],grantBindings:[]};
  for(const[id,,permission]of people)if(permission){const grantId='grant-'+id;payload.grants.push({id:grantId,workspaceId,pageId:'page',accountId:id,permission,includeDescendants:false,status:'active'});payload.grantBindings.push({grantId,membershipId:'membership-'+id});}
  const raw=createSqliteContentStore(db);await raw.write(workspaceId,'author',{expectedRevision:0,payload,actorMembershipId:'membership-author',actorRole:'member'});
  const objects=new Map();let beforeWrite,beforeGet,beforeDelete,putCount=0,reads=0;
  const blobStore={profileId:'synthetic',async put(key,value){putCount++;if(objects.has(key))throw Object.assign(new Error('exists'),{code:'BLOB_EXISTS'});objects.set(key,value.slice());return{size:value.length,checksum:await hash(value)};},async get(key){await beforeGet?.();beforeGet=null;return objects.get(key)?.slice()??null;},async delete(key){if(beforeDelete){const cb=beforeDelete;beforeDelete=null;await cb();}objects.delete(key);}};
  const api=createAccountContentApi({origin,blobStore,roomSecret:'synthetic-attachment-room-secret-1234567890',resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}}),store:{read(...args){reads++;return raw.read(...args);},async write(...args){if(beforeWrite){const cb=beforeWrite;beforeWrite=null;await cb();}return raw.write(...args);}}});
  const request=(accountId,path,method='GET',body,extra={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{'x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId,...(method==='GET'?{}:{Origin:origin,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'}),...extra},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})}));
  const read=()=>raw.read(workspaceId,'author');
  const change=async fn=>{const row=await read();fn(row.payload);db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(row.payload),workspaceId);};
  const stagePath='/pages/page/uploads/upload-one/assets';
  return{db,objects,raw,request,read,change,stagePath,setBeforeWrite:fn=>beforeWrite=fn,setBeforeGet:fn=>beforeGet=fn,setBeforeDelete:fn=>beforeDelete=fn,get reads(){return reads;},get putCount(){return putCount;},async reserve(accountId='author'){const response=await request(accountId,stagePath,'POST',{expectedRevision:(await read()).revision,sourceId:'file-one',name:'架空.txt',mediaType:'text/plain',size:bytes.length,checksum:await hash(bytes)});assert.equal(response.status,201,await response.clone().text());return response.json();},async ready(accountId='author'){const reservation=await this.reserve(accountId),response=await request(accountId,stagePath+'/'+reservation.assetId,'PUT',bytes,{'X-Yumunio-Expected-Revision':String(reservation.revision)});assert.equal(response.status,200,await response.clone().text());return{...await response.json(),path:stagePath+'/'+reservation.assetId};}};
}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json()).error.code,code);}

const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWrkAAAAASUVORK5CYII=','base64'));
async function clipboardFixture(t,{lose=null}={}){
 const f=await fixture(t),pageId='page',base='/api/content/workspaces/'+workspaceId;
 let envelope=await(await f.request('editor','/pages/page')).json(),fault=lose,actor='editor',counter=0;
 const attached=[],calls=[],draft=structuredClone(envelope.document.blocks);
 const request=async({path,method='GET',body,headers={}})=>{
  calls.push({path,method});
  if(path==='/api/auth/get-session')return{user:{id:actor,emailVerified:true}};
  const response=await f.request(actor,path.slice(base.length),method,body,headers),result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error.code),{code:result.error.code,status:response.status});
  if(fault==='put'&&method==='PUT'||fault==='commit'&&path.endsWith('/commit')){fault=null;throw new Error('Synthetic lost response');}
  return result;
 };
 const files=[{name:'日本語.png',mediaType:'image/png',file:{arrayBuffer:async()=>png.slice().buffer}},{name:'notes.txt',mediaType:'text/plain',file:{arrayBuffer:async()=>bytes.slice().buffer}}];
 const batch=new ClipboardUploadBatch({files,accountId:'editor',workspaceId,pageId,request,createId:()=> 'clipboard-'+(++counter),onReview:value=>{
  if(value.document.version!==envelope.document.version)throw Object.assign(new Error('CONTENT_CONFLICT'),{status:409});envelope=value;
 },onAttachment:(attachment,result)=>{attached.push(attachment);envelope.revision=result.revision;draft.push(createAttachmentBlock(attachment,{pageId,id:'block-'+attachment.id}));}});
 return{...f,batch,calls,attached,draft,get putCount(){return f.putCount;},get envelope(){return envelope;},setActor:value=>actor=value};
}

test('cross-page attachment resolution checks both ACLs, reuses bytes and retries without duplicating metadata',async t=>{
 const f=await clipboardFixture(t);await f.batch.run();await f.change(payload=>{payload.grants.push({id:'destination-editor',workspaceId,pageId:'other',accountId:'editor',permission:'editor',includeDescendants:false,status:'active'});payload.grantBindings.push({grantId:'destination-editor',membershipId:'membership-editor'});});
 const saved=await f.read(),blocks=f.draft.slice(1),copies=f.attached.map((asset,n)=>({sourceId:asset.id,targetId:'copy-'+n})),body={expectedRevision:saved.revision,expectedVersion:1,sourcePageId:'page',blocks,copies},path='/pages/other/attachment-copies';
 const denied=await f.request('viewer',path,'POST',body);await error(denied,404,'CONTENT_NOT_FOUND');
 const copied=await f.request('editor',path,'POST',body);assert.equal(copied.status,201,await copied.clone().text());const result=await copied.json();assert.equal(result.version,1);assert.deepEqual(result.blocks.map(block=>block.data.links[0].pageId),['other','other']);assert.deepEqual(result.blocks.map(block=>block.data.links[0].attachmentId),['copy-0','copy-1']);assert.equal(f.putCount,2);assert.equal(f.objects.size,2);
 const replay=await f.request('editor',path,'POST',body);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);assert.equal((await f.read()).payload.attachments.length,4);
 const preview=await f.request('editor','/pages/other/attachments/copy-0/preview');assert.equal(preview.status,200);assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),png);
 await f.change(payload=>{payload.grants.find(row=>row.id==='grant-editor').permission='deny';});await error(await f.request('editor',path,'POST',body),404,'CONTENT_NOT_FOUND');
 const after=await f.read();assert.equal(after.payload.attachments.length,4);assert.doesNotMatch(JSON.stringify(result),/objectKey|profileId|membershipId|checksum/);
});

test('images and files can be uploaded, pasted and durably synchronized without ending a structured room',async t=>{
 const f=await clipboardFixture(t),prefix='/api/content/workspaces/'+workspaceId+'/pages/page',transport=async({path,method='GET',body,headers={}})=>{const response=await f.request('editor',path.slice(('/api/content/workspaces/'+workspaceId).length),method,body,headers),value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error.code),{code:value.error.code,status:response.status});return value;};
 const client=new HttpRoomClient({accountId:'editor',workspaceId,pageId:'page',protocol:2,draft:{title:'page',blocks:f.envelope.document.blocks},request:transport});t.after(()=>client.destroy());await client.open({expectedRevision:f.envelope.revision});const epoch=client.epoch;await f.batch.run();client.pasteTree(f.draft);await client.sync();assert.equal(client.epoch,epoch);assert.equal(client.pending,false);
 const stored=(await f.read()).payload.pages[0].document;assert.deepEqual(stored.blocks.map(block=>block.type),['paragraph','image','file']);const after=await f.request('viewer','/pages/page/attachments/'+f.attached[0].id+'/preview');assert.equal(after.status,200);assert.deepEqual(new Uint8Array(await after.arrayBuffer()),png);
 const forged={...createAttachmentBlock({id:'foreign',name:'secret.pdf',mediaType:'application/pdf'},{pageId:'page',id:'forged'})};client.pasteTree([...client.snapshot().blocks,forged]);await assert.rejects(client.sync(),{code:'CONTENT_NOT_FOUND'});assert.deepEqual((await f.read()).payload.pages[0].document,stored);
});

test('clipboard files publish sequentially and image/file blocks persist with page-bound references and private previews',async t=>{
 const f=await clipboardFixture(t);await f.batch.run();assert.equal(f.batch.state,'done');assert.equal(f.attached.length,2);assert.equal(f.putCount,2);
 const saved=await f.request('editor','/pages/page','PATCH',{expectedRevision:f.envelope.revision,expectedVersion:1,title:'page',blocks:f.draft});assert.equal(saved.status,200,await saved.clone().text());
 const loaded=await(await f.request('viewer','/pages/page')).json();assert.deepEqual(loaded.document.blocks.slice(1).map(block=>block.type),['image','file']);
 const image=f.attached[0],path='/pages/page/attachments/'+image.id+'/preview',preview=await f.request('viewer',path);assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/png');assert.match(preview.headers.get('content-disposition'),/^inline;/);assert.equal(preview.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),png);
 await error(await f.request('hidden',path),404,'CONTENT_NOT_FOUND');await error(await f.request('viewer','/pages/other/attachments/'+image.id+'/preview'),404,'CONTENT_NOT_FOUND');
 const download=await f.request('viewer','/pages/page/attachments/'+image.id);assert.match(download.headers.get('content-disposition'),/^attachment;/);
 await error(await f.request('viewer','/pages/page/attachments/'+f.attached[1].id+'/preview'),415,'CONTENT_TYPE');
 const removed=await f.request('editor','/pages/page/attachments/'+image.id,'DELETE',{expectedRevision:loaded.revision,expectedVersion:loaded.document.version});assert.equal(removed.status,200);
 const afterRemoval=await(await f.request('editor','/pages/page')).json();
 const edited=await f.request('editor','/pages/page','PATCH',{expectedRevision:afterRemoval.revision,expectedVersion:afterRemoval.document.version,title:'Still editable',blocks:afterRemoval.document.blocks});assert.equal(edited.status,200,await edited.clone().text());
 await error(await f.request('viewer',path),404,'CONTENT_NOT_FOUND');
});
test('clipboard retries reconcile lost binary/commit responses and never create duplicate attachments',async t=>{
 for(const lose of ['put','commit']){const f=await clipboardFixture(t,{lose});await assert.rejects(f.batch.run());assert.equal(f.batch.state,'paused');assert.ok(f.batch.flow.file);const puts=f.putCount;await f.batch.run();assert.equal(f.batch.state,'done');assert.equal(f.attached.length,2);assert.equal(f.putCount,2);assert.equal(puts,1);assert.equal((await f.read()).payload.attachments.length,2);assert.equal(f.calls.filter(call=>call.method==='PUT').length,2);}
});
test('cancelling a clipboard batch reads its uncertain result and keeps a committed image without sending remaining files',async t=>{
 const f=await clipboardFixture(t,{lose:'commit'});await assert.rejects(f.batch.run());const before=f.calls.filter(call=>call.method!=='GET').length;await f.batch.cancel();assert.equal(f.batch.state,'done');assert.equal(f.attached.length,1);assert.equal(f.calls.filter(call=>call.method!=='GET').length,before);assert.equal(f.putCount,1);
});
test('account/content changes pause clipboard uploads before new writes and retain the source files',async t=>{
 const switched=await clipboardFixture(t);switched.setActor('author');await assert.rejects(switched.batch.run(),error=>error.code==='ACCOUNT_CHANGED');assert.equal(switched.putCount,0);assert.equal(switched.batch.files.length,2);
 const changed=await clipboardFixture(t);await changed.change(payload=>{payload.pages[0].document.version++;});await assert.rejects(changed.batch.run(),error=>error.status===409);assert.equal(changed.putCount,0);assert.equal(changed.batch.files.length,2);
});
test('image previews reject active/mislabeled bytes and recheck permissions after blob IO',async t=>{
 const f=await clipboardFixture(t);await f.batch.run();const image=f.attached[0],path='/pages/page/attachments/'+image.id+'/preview';
 const malicious=new TextEncoder().encode('<svg onload="alert(1)"></svg>'),checksum=await hash(malicious);
 // Keep the checksum valid so this verifies type validation, rather than corruption detection.
 await f.change(payload=>{const asset=payload.attachments.find(row=>row.id===image.id);asset.mediaType='image/png';asset.size=malicious.length;asset.checksum=checksum;f.objects.set(asset.objectKey,malicious);});
 await error(await f.request('viewer',path),415,'CONTENT_TYPE');
 const legitimate=await clipboardFixture(t);await legitimate.batch.run();legitimate.setBeforeGet(()=>legitimate.change(payload=>{const grant=payload.grants.find(row=>row.accountId==='viewer');grant.status='revoked';}));
 await error(await legitimate.request('viewer','/pages/page/attachments/'+legitimate.attached[0].id+'/preview'),404,'CONTENT_NOT_FOUND');
});
test('a page editor guest can stage private bytes and bind exactly one page attachment without changing the body or granting access',async t=>{
  const f=await fixture(t),ready=await f.ready('editor');
  assert.equal((await(await f.request('author','/pages/page')).json()).attachments,undefined);
  const committed=await f.request('editor',ready.path+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:1});assert.equal(committed.status,201,await committed.clone().text());const result=await committed.json();assert.equal(result.version,1);assert.equal(result.attachment.name,'架空.txt');assert.equal(result.replayed,false);
  const current=await f.read();assert.equal(current.payload.pendingBlobs.length,0);assert.equal(current.payload.attachments.length,1);assert.equal(current.payload.pages[0].document.blocks[0].data.text,'Keep this body');assert.equal(current.payload.grants.length,3);
  const download=await f.request('viewer','/pages/page/attachments/'+ready.assetId);assert.equal(download.status,200);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  await error(await f.request('hidden','/pages/page/attachments/'+ready.assetId),404,'CONTENT_NOT_FOUND');
  const replay=await f.request('editor',ready.path+'/commit','POST',{expectedRevision:0,expectedVersion:0});assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);assert.equal((await f.read()).revision,result.revision);
});
test('page-scoped pending files cannot be listed, transferred or consumed through the import-only staging routes',async t=>{
  const f=await fixture(t),ready=await f.ready();
  const listing=await(await f.request('author','/imports/upload-one/assets')).json();assert.equal(listing.assets.length,0);
  await error(await f.request('author','/imports/upload-one/assets/'+ready.assetId,'DELETE',{expectedRevision:ready.revision}),404,'CONTENT_NOT_FOUND');
  const bundle={expectedRevision:ready.revision,importId:'upload-one',pages:[{sourceId:'root',parentSourceId:null,title:'Injected',blocks:[]}],assets:[{sourceId:'file-one',assetId:ready.assetId,pageSourceIds:['root']}]};
  await error(await f.request('author','/imports','POST',bundle),404,'CONTENT_NOT_FOUND');
  assert.equal((await f.read()).payload.pages.length,2);assert.equal((await f.read()).payload.pendingBlobs.length,1);
  await error(await f.request('author','/pages/other/uploads/upload-one/assets/'+ready.assetId+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:1}),404,'CONTENT_NOT_FOUND');
});
test('expected account and edit rights are required before staging or finalization, and a wrong version leaves ready bytes unpublished',async t=>{
  const f=await fixture(t),reads=f.reads;
  await error(await f.request('author',f.stagePath,'GET',undefined,{'X-Yumunio-Expected-Account':'editor'}),404,'CONTENT_NOT_FOUND');assert.equal(f.reads,reads);
  await error(await f.request('viewer',f.stagePath),404,'CONTENT_NOT_FOUND');
  const ready=await f.ready();await error(await f.request('author',ready.path+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:99}),409,'CONTENT_CONFLICT');
  assert.equal((await f.read()).payload.pendingBlobs[0].status,'ready');assert.equal((await f.read()).payload.attachments,undefined);
});
test('live permission revocation during blob verification prevents final publication and rejects replay without exposing metadata',async t=>{
  const f=await fixture(t),ready=await f.ready('editor');
  f.setBeforeGet(()=>f.change(payload=>{payload.grants.find(row=>row.accountId==='editor').status='revoked';}));
  await error(await f.request('editor',ready.path+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:1}),404,'CONTENT_NOT_FOUND');
  assert.equal((await f.read()).payload.attachments,undefined);assert.equal((await f.read()).payload.pendingBlobs.length,1);
  await error(await f.request('editor',ready.path+'/commit','POST',{expectedRevision:0,expectedVersion:0}),404,'CONTENT_NOT_FOUND');
});
test('revocation during upload CAS denies publication and corrupt bytes can never become a committed attachment',async t=>{
  const f=await fixture(t),reserved=await f.reserve('editor');f.setBeforeWrite(()=>f.change(payload=>{payload.grants.find(row=>row.accountId==='editor').status='revoked';}));
  await error(await f.request('editor',f.stagePath+'/'+reserved.assetId,'PUT',bytes,{'X-Yumunio-Expected-Revision':String(reserved.revision)}),404,'CONTENT_NOT_FOUND');
  assert.equal((await f.read()).payload.pendingBlobs[0].status,'reserved');
  const second=await fixture(t),ready=await second.ready();second.objects.set((await second.read()).payload.pendingBlobs[0].objectKey,new Uint8Array([0]));
  await error(await second.request('author',ready.path+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:1}),503,'CONTENT_UNAVAILABLE');assert.equal((await second.read()).payload.attachments,undefined);
});
test('a cancelled page upload is fenced before deletion and cannot later bind a ready object',async t=>{
  const f=await fixture(t),ready=await f.ready('editor'),deleted=await f.request('editor',ready.path,'DELETE',{expectedRevision:ready.revision});assert.equal(deleted.status,200);assert.equal(f.objects.size,0);
  await error(await f.request('editor',ready.path+'/commit','POST',{expectedRevision:(await f.read()).revision,expectedVersion:1}),404,'CONTENT_NOT_FOUND');assert.equal((await f.read()).payload.attachments,undefined);
});
test('recoverable upload listing exposes only the current page and uploader generation without private blob locations',async t=>{
  const f=await fixture(t),ready=await f.ready('editor');
  const mine=await(await f.request('editor','/pages/page/uploads')).json();assert.equal(mine.uploads.length,1);assert.equal(mine.uploads[0].id,ready.assetId);assert.equal(mine.uploads[0].status,'ready');
  for(const key of ['objectKey','profileId','accountId','membershipId'])assert.equal(Object.hasOwn(mine.uploads[0],key),false);
  assert.equal((await(await f.request('author','/pages/page/uploads')).json()).uploads.length,0);
  await error(await f.request('viewer','/pages/page/uploads'),404,'CONTENT_NOT_FOUND');
  f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('editor-replacement','membership-editor');
  await error(await f.request('editor','/pages/page/uploads'),404,'CONTENT_NOT_FOUND');
});
test('attachment deletion preserves bytes still referenced by another private page and never reveals that reference',async t=>{
  const f=await fixture(t),ready=await f.ready();await f.request('author',ready.path+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:1});
  await f.change(payload=>{payload.attachments.push({...payload.attachments[0],id:'hidden-shared-attachment',pageId:'other'});});
  const response=await f.request('author','/pages/page/attachments/'+ready.assetId,'DELETE',{expectedRevision:(await f.read()).revision,expectedVersion:1});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(Object.keys(await response.json()).sort(),['removed','replayed','revision','version']);
  assert.equal(f.objects.size,1);assert.equal((await f.read()).payload.attachments.length,1);assert.equal((await f.read()).payload.attachments[0].pageId,'other');
  await error(await f.request('author','/pages/page/attachments/'+ready.assetId),404,'CONTENT_NOT_FOUND');
});
test('failed blob deletion keeps a durable fence and quota that the uploader can explicitly resume after reload',async t=>{
  const f=await fixture(t),ready=await f.ready('editor');await f.request('editor',ready.path+'/commit','POST',{expectedRevision:ready.revision,expectedVersion:1});
  f.setBeforeDelete(()=>{throw new Error('synthetic provider failure');});
  await error(await f.request('editor','/pages/page/attachments/'+ready.assetId,'DELETE',{expectedRevision:(await f.read()).revision,expectedVersion:1}),503,'CONTENT_UNAVAILABLE');
  const listing=await(await f.request('editor','/pages/page/uploads')).json();assert.equal(listing.uploads.length,1);const pending=listing.uploads[0];assert.equal(pending.status,'deleting');assert.equal((await f.read()).payload.attachments.length,0);assert.equal(f.objects.size,1);
  const resumed=await f.request('editor','/pages/page/uploads/'+pending.uploadId+'/assets/'+pending.id,'DELETE',{expectedRevision:listing.revision});assert.equal(resumed.status,200);assert.equal((await f.read()).payload.pendingBlobs.length,0);assert.equal(f.objects.size,0);
  const replay=await f.request('editor','/pages/page/attachments/'+ready.assetId,'DELETE',{expectedRevision:0,expectedVersion:0});assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
});
