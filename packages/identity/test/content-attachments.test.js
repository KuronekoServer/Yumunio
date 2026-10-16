import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSqliteContentStore } from '../src/content-store.js';
import { createAccountContentApi } from '../src/content.js';
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
  const api=createAccountContentApi({origin,blobStore,resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}}),store:{read(...args){reads++;return raw.read(...args);},async write(...args){if(beforeWrite){const cb=beforeWrite;beforeWrite=null;await cb();}return raw.write(...args);}}});
  const request=(accountId,path,method='GET',body,extra={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{'x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId,...(method==='GET'?{}:{Origin:origin,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'}),...extra},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})}));
  const read=()=>raw.read(workspaceId,'author');
  const change=async fn=>{const row=await read();fn(row.payload);db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(row.payload),workspaceId);};
  const stagePath='/pages/page/uploads/upload-one/assets';
  return{db,objects,raw,request,read,change,stagePath,setBeforeWrite:fn=>beforeWrite=fn,setBeforeGet:fn=>beforeGet=fn,setBeforeDelete:fn=>beforeDelete=fn,get reads(){return reads;},get putCount(){return putCount;},async reserve(accountId='author'){const response=await request(accountId,stagePath,'POST',{expectedRevision:(await read()).revision,sourceId:'file-one',name:'架空.txt',mediaType:'text/plain',size:bytes.length,checksum:await hash(bytes)});assert.equal(response.status,201,await response.clone().text());return response.json();},async ready(accountId='author'){const reservation=await this.reserve(accountId),response=await request(accountId,stagePath+'/'+reservation.assetId,'PUT',bytes,{'X-Yumunio-Expected-Revision':String(reservation.revision)});assert.equal(response.status,200,await response.clone().text());return{...await response.json(),path:stagePath+'/'+reservation.assetId};}};
}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json()).error.code,code);}
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
