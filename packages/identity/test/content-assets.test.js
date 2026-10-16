import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const contentSchema=await readFile(new URL('../schema/content.sqlite.sql',import.meta.url),'utf8');
const origin='https://assets.example',workspaceId='asset-workspace',stamp='2026-10-15T00:00:00.000Z';
const digest=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const bytes=new TextEncoder().encode('private attachment 日本語 😀');
const meta=async(extra={})=>({expectedRevision:0,sourceId:'source-asset',name:'日本語.txt',mediaType:'text/plain',size:bytes.length,checksum:await digest(bytes),...extra});
const bundle=(assetId,extra={})=>({expectedRevision:2,importId:'asset-import',pages:[
  {sourceId:'folder',parentSourceId:null,title:'Folder',blocks:[]},
  {sourceId:'doc',parentSourceId:'folder',title:'Document',blocks:[{id:'source-text',type:'paragraph',data:{text:'Open file',links:[{start:5,end:9,label:'file',sourceAssetId:'source-asset'}]}}]},
],assets:[{sourceId:'source-asset',assetId,pageSourceIds:['doc','folder']}],...extra});
function fixture(t,{disabled=false}={}){
  const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(contentSchema);t.after(()=>db.close());
  for(const role of ['owner','member','guest']){
    db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(role,role,role+'@example.invalid',stamp,stamp);
  }
  db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Assets','assets',stamp);
  for(const role of ['owner','member','guest'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+role,workspaceId,role,role,stamp);
  const raw=createSqliteContentStore(db),objects=new Map();let sequence=0,reads=0,writes=0,puts=0,deletes=0,beforeWrite=null,beforeGet=null,beforePut=null,deleteFailure=false;
  const blobStore={profileId:'blob-fixture',async put(key,input){puts++;if(beforePut)await beforePut();if(objects.has(key))throw Object.assign(new Error('private provider error'),{code:'BLOB_EXISTS'});
    objects.set(key,input.slice());return{size:input.length,checksum:await digest(input)};},
    async get(key){if(beforeGet)await beforeGet();return objects.get(key)?.slice()??null;},
    async delete(key){deletes++;if(deleteFailure)throw new Error('private storage credentials');objects.delete(key);}};
  const store={async read(...args){reads++;return raw.read(...args);},async write(...args){writes++;if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
  const api=createAccountContentApi({store,blobStore:disabled?null:blobStore,origin,now:()=>stamp,createId:()=> 'generated-'+ ++sequence,
    resolveSession:async request=>request.headers.has('x-actor')?{user:{id:request.headers.get('x-actor'),emailVerified:true}}:null});
  const request=(path,{account='member',method='GET',body,headers={},binary=false}={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,
    headers:{Origin:origin,'Content-Type':binary?'application/octet-stream':'application/json',...(account?{'x-actor':account,'X-Yumunio-Expected-Account':account}:{}),...headers},
    ...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})}));
  const reserve=async(data)=>{const response=await request('/imports/asset-import/assets',{method:'POST',body:data??await meta()});assert.equal(response.status,201);return response.json();};
  const upload=async(assetId,revision=1,input=bytes)=>request('/imports/asset-import/assets/'+assetId,{method:'PUT',body:input,binary:true,headers:{'X-Yumunio-Expected-Revision':String(revision)}});
  return{db,raw,objects,blobStore,request,reserve,upload,setBeforeWrite:fn=>beforeWrite=fn,setBeforeGet:fn=>beforeGet=fn,setBeforePut:fn=>beforePut=fn,setDeleteFailure:value=>deleteFailure=value,
    get reads(){return reads;},get writes(){return writes;},get puts(){return puts;},get deletes(){return deletes;}};
}
async function error(response,status,code){assert.equal(response.status,status);const body=await response.json();assert.equal(body.error.code,code);assert.doesNotMatch(JSON.stringify(body),/objects\/|blob-fixture|private attachment|credentials|membership-|checksum/);}
async function stage(f){const reserved=await f.reserve();const uploaded=await f.upload(reserved.assetId);assert.equal(uploaded.status,200);assert.deepEqual(await uploaded.json(),{revision:2,assetId:reserved.assetId,status:'ready'});return reserved.assetId;}

test('SQLite staged bytes stay unpublished until one import CAS binds per-page attachment IDs and ACL-checked downloads',async t=>{
  const f=fixture(t);const enabled=await(await f.request('/pages')).json();assert.equal(enabled.attachmentsEnabled,true);assert.doesNotMatch(JSON.stringify(enabled),/profileId|objectKey|blob-fixture/);assert.equal(f.puts,0);assert.equal(f.writes,0);const reserved=await f.reserve();assert.deepEqual(Object.keys(reserved),['revision','assetId','status']);assert.equal(reserved.status,'reserved');
  assert.equal((await f.raw.read(workspaceId,'member')).payload.pages.length,0);assert.equal(f.objects.size,0);
  const listed=await(await f.request('/imports/asset-import/assets')).json();assert.equal(listed.revision,1);assert.equal(listed.assets.length,1);
  assert.deepEqual(Object.keys(listed.assets[0]),['assetId','sourceId','name','mediaType','size','checksum','status']);assert.doesNotMatch(JSON.stringify(listed),/objectKey|profileId|membershipId|accountId/);
  const uploaded=await f.upload(reserved.assetId);assert.equal(uploaded.status,200);assert.equal(f.objects.size,1);
  const published=await f.request('/imports',{method:'POST',body:bundle(reserved.assetId)});assert.equal(published.status,201);const result=await published.json();assert.equal(result.revision,3);
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.payload.pendingBlobs.length,0);assert.equal(saved.payload.attachments.length,2);
  assert.notEqual(saved.payload.attachments[0].id,saved.payload.attachments[1].id);assert.equal(saved.payload.attachments[0].objectKey,saved.payload.attachments[1].objectKey);
  const doc=saved.payload.pages.find(item=>item.page.title==='Document');const get=await(await f.request('/pages/'+doc.page.id)).json();
  const attachment=get.attachments[0];assert.deepEqual(Object.keys(attachment),['id','name','mediaType','size']);
  assert.deepEqual(get.document.blocks[0].data.links,[{start:5,end:9,label:'file',pageId:doc.page.id,attachmentId:attachment.id}]);
  const path='/pages/'+doc.page.id+'/attachments/'+attachment.id;
  const download=await f.request(path);assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/octet-stream');
  assert.match(download.headers.get('content-disposition'),/^attachment;.*filename\*=UTF-8''/);assert.match(download.headers.get('content-security-policy'),/sandbox/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  await error(await f.request(path,{account:'owner'}),404,'CONTENT_NOT_FOUND');
  const grant=await f.request('/pages/'+doc.page.id+'/grants',{method:'POST',body:{expectedRevision:3,accountId:'guest',permission:'viewer'}});assert.equal(grant.status,200);
  assert.equal((await f.request(path,{account:'guest'})).status,200);
  const replay=await f.request('/imports',{method:'POST',body:bundle(reserved.assetId)});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),{...result,replayed:true});
  const otherPage=saved.payload.pages.find(item=>item.page.title==='Folder').page.id;
  await error(await f.request('/pages/'+otherPage+'/attachments/'+attachment.id),404,'CONTENT_NOT_FOUND');
});

test('staging enforces account expectation before reads, exact metadata/body integrity and idempotent retry without new objects',async t=>{
  const f=fixture(t);const body=await meta();
  for(const method of ['GET','POST','PUT','DELETE']){
    const path='/imports/asset-import/assets'+(['PUT','DELETE'].includes(method)?'/unknown':'');
    await error(await f.request(path,{method,...(method==='GET'?{}:{body}),headers:{'X-Yumunio-Expected-Account':''}}),400,'INVALID_CONTENT');
    await error(await f.request(path,{method,...(method==='GET'?{}:{body}),headers:{'X-Yumunio-Expected-Account':'owner'}}),404,'CONTENT_NOT_FOUND');
  }
  assert.equal(f.reads,0);assert.equal(f.writes,0);
  const reservation=await f.reserve(body);
  const retry=await f.request('/imports/asset-import/assets',{method:'POST',body});assert.equal(retry.status,200);assert.deepEqual(await retry.json(),reservation);
  await error(await f.request('/imports/asset-import/assets',{method:'POST',body:{...body,name:'different.txt'}}),409,'CONTENT_CONFLICT');
  await error(await f.upload(reservation.assetId,0),409,'CONTENT_CONFLICT');
  await error(await f.upload(reservation.assetId,1,new Uint8Array(bytes.length)),400,'INVALID_CONTENT');assert.equal(f.puts,0);
  const uploaded=await f.upload(reservation.assetId);assert.equal(uploaded.status,200);await uploaded.arrayBuffer();
  const replay=await f.upload(reservation.assetId,0);assert.equal(replay.status,200);assert.equal((await replay.json()).revision,2);assert.equal(f.puts,1);
  const foreign=await(await f.request('/imports/asset-import/assets',{account:'owner'})).json();assert.deepEqual(foreign.assets,[]);
  await error(await f.upload('nonexistent'),404,'CONTENT_NOT_FOUND');
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,2);assert.equal(saved.payload.pages.length,0);
});

test('reservations bound upload quotas before bytes and rejected imports consume no page or staged data',async t=>{
  const f=fixture(t);
  for(const change of [{name:'../unsafe'},{name:'line\nbreak'},{size:-1},{size:16*1024*1024+1},{checksum:'bad'},{mediaType:'text/plain\r\nInjected: true'}])
    await error(await f.request('/imports/asset-import/assets',{method:'POST',body:await meta(change)}),400,'INVALID_CONTENT');
  const hash=await digest(new Uint8Array());
  for(let i=0;i<4;i++)assert.equal((await f.request('/imports/asset-import/assets',{method:'POST',body:await meta({expectedRevision:i,sourceId:'large-'+i,size:16*1024*1024,checksum:hash})})).status,201);
  await error(await f.request('/imports/asset-import/assets',{method:'POST',body:await meta({expectedRevision:4,sourceId:'excess',size:1})}),413,'CONTENT_TOO_LARGE');
  assert.equal(f.puts,0);assert.equal((await f.raw.read(workspaceId,'member')).revision,4);
  const other=fixture(t);const assetId=await stage(other);const invalid=bundle(assetId);invalid.assets[0].pageSourceIds=['folder'];
  await error(await other.request('/imports',{method:'POST',body:invalid}),400,'INVALID_CONTENT');
  const wrongActor=await other.request('/imports',{account:'owner',method:'POST',body:bundle(assetId)});await error(wrongActor,404,'CONTENT_NOT_FOUND');
  const saved=await other.raw.read(workspaceId,'member');assert.equal(saved.revision,2);assert.equal(saved.payload.pages.length,0);assert.equal(saved.payload.pendingBlobs[0].status,'ready');
});

test('cancellation is fenced before blob deletion, survives provider failures and cannot be consumed by a late import',async t=>{
  const f=fixture(t);const assetId=await stage(f);const path='/imports/asset-import/assets/'+assetId;
  f.setDeleteFailure(true);
  await error(await f.request(path,{method:'DELETE',body:{expectedRevision:2}}),503,'CONTENT_UNAVAILABLE');
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,3);assert.equal(saved.payload.pendingBlobs[0].status,'deleting');
  await error(await f.request('/imports',{method:'POST',body:bundle(assetId,{expectedRevision:3})}),404,'CONTENT_NOT_FOUND');
  await error(await f.upload(assetId,3),404,'CONTENT_NOT_FOUND');
  f.setDeleteFailure(false);const removed=await f.request(path,{method:'DELETE',body:{expectedRevision:3}});assert.equal(removed.status,200);
  assert.deepEqual(await removed.json(),{revision:4,removed:true});assert.equal(f.objects.size,0);
  assert.deepEqual((await(await f.request('/imports/asset-import/assets')).json()).assets,[]);
});

test('lost ready acknowledgement and competing aggregate CAS preserve immutable staged bytes for retry',async t=>{
  const f=fixture(t);const reservation=await f.reserve();let injected=false;
  f.setBeforeWrite(async(wid,actor,data)=>{
    if(injected||data.payload.pendingBlobs?.[0]?.status!=='ready')return;injected=true;
    const saved=await f.raw.read(wid,actor);await f.raw.write(wid,actor,{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});
  });
  await error(await f.upload(reservation.assetId),409,'CONTENT_CONFLICT');assert.equal(f.objects.size,1);
  f.setBeforeWrite(null);const retried=await f.upload(reservation.assetId,2);assert.equal(retried.status,200);assert.equal((await retried.json()).revision,3);
  assert.equal(f.objects.size,1);assert.equal(f.puts,2);
});

test('downloads recheck page authorization after IO and reject corruption or storage profile changes without exposing bytes',async t=>{
  const f=fixture(t);const assetId=await stage(f);assert.equal((await f.request('/imports',{method:'POST',body:bundle(assetId)})).status,201);
  const saved=await f.raw.read(workspaceId,'member'),attachment=saved.payload.attachments[0],path='/pages/'+attachment.pageId+'/attachments/'+attachment.id;
  f.objects.set(attachment.objectKey,new Uint8Array(bytes.length));await error(await f.request(path),503,'CONTENT_UNAVAILABLE');
  f.objects.set(attachment.objectKey,bytes);f.blobStore.profileId='different-profile';await error(await f.request(path),503,'CONTENT_UNAVAILABLE');
  f.blobStore.profileId='blob-fixture';f.setBeforeGet(()=>f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-member'));
  await error(await f.request(path),404,'CONTENT_NOT_FOUND');
});

test('disabled storage and revoked membership perform no upload and old payloads remain valid',async t=>{
  const disabled=fixture(t,{disabled:true});assert.equal((await(await disabled.request('/pages')).json()).attachmentsEnabled,false);await error(await disabled.request('/imports/asset-import/assets',{method:'POST',body:await meta()}),503,'CONTENT_UNAVAILABLE');assert.equal(disabled.writes,0);
  const f=fixture(t);const reservation=await f.reserve();f.setBeforeWrite(()=>f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-member'));
  await error(await f.upload(reservation.assetId),404,'CONTENT_NOT_FOUND');
  assert.equal(f.db.prepare('SELECT revision FROM yumunio_account_content').get().revision,1);
  assert.deepEqual(validateContentPayload({schemaVersion:1,pages:[],grants:[],grantBindings:[]},workspaceId),{schemaVersion:1,pages:[],grants:[],grantBindings:[]});
});
test('a late upload after cancellation cannot publish pages and removes its unreferenced object best effort',async t=>{
  const f=fixture(t);const reservation=await f.reserve();let cancelled=false;
  f.setBeforePut(async()=>{
    if(cancelled)return;cancelled=true;
    const response=await f.request('/imports/asset-import/assets/'+reservation.assetId,{method:'DELETE',body:{expectedRevision:1}});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{revision:3,removed:true});
  });
  await error(await f.upload(reservation.assetId),409,'CONTENT_CONFLICT');
  assert.equal(f.objects.size,0);assert.equal(f.deletes,2);
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,3);assert.equal(saved.payload.pendingBlobs.length,0);assert.equal(saved.payload.pages.length,0);
  await error(await f.request('/imports',{method:'POST',body:bundle(reservation.assetId,{expectedRevision:3})}),404,'CONTENT_NOT_FOUND');
});

test('attachment names preserve 255-character originals and reject path, bidi and malformed header values',async t=>{
  const f=fixture(t);
  for(const name of ['x'.repeat(256),'..','bidi\u202efilename.txt','isolate\u2066name.txt','bad\ud800name'])
    await error(await f.request('/imports/asset-import/assets',{method:'POST',body:await meta({name})}),400,'INVALID_CONTENT');
  assert.equal(f.writes,0);
  const reservation=await f.reserve(await meta({name:'x'.repeat(255)}));
  const data=await(await f.request('/imports/asset-import/assets')).json();assert.equal(data.assets[0].name,'x'.repeat(255));assert.equal(data.assets[0].assetId,reservation.assetId);
});

test('64 MiB reservations are scoped to exact import actor and membership tuples and concurrent last slots remain CAS bounded',async t=>{
  const f=fixture(t),size=16*1024*1024,checksum='0'.repeat(64),path='/imports/asset-import/assets';
  for(let index=0;index<3;index++)assert.equal((await f.request(path,{method:'POST',body:await meta({expectedRevision:index,sourceId:'large-'+index,size,checksum})})).status,201);
  const responses=await Promise.all(['left','right'].map(async sourceId=>f.request(path,{method:'POST',body:await meta({expectedRevision:3,sourceId,size,checksum})})));
  assert.deepEqual(responses.map(response=>response.status).sort(),[201,409]);await Promise.all(responses.map(response=>response.arrayBuffer()));
  let saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,4);assert.equal(saved.payload.pendingBlobs.reduce((sum,row)=>sum+row.size,0),64*1024*1024);
  await error(await f.request(path,{method:'POST',body:await meta({expectedRevision:4,sourceId:'one-over',size:1,checksum})}),413,'CONTENT_TOO_LARGE');
  assert.equal((await f.request(path,{account:'owner',method:'POST',body:await meta({expectedRevision:4,sourceId:'other-actor',size,checksum})})).status,201);
  f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('membership-member-rejoined','membership-member');
  assert.equal((await f.request(path,{method:'POST',body:await meta({expectedRevision:5,sourceId:'new-generation',size,checksum})})).status,201);
  const visible=await(await f.request(path)).json();assert.equal(visible.assets.length,1);assert.equal(visible.assets[0].sourceId,'new-generation');
  saved=await f.raw.read(workspaceId,'member');assert.equal(saved.payload.pendingBlobs.reduce((sum,row)=>sum+row.size,0),96*1024*1024);assert.equal(f.puts,0);assert.equal(f.objects.size,0);
});

test('raising one import reservation limit preserves the 256 MiB workspace quota and 100-object per-import ceiling',async t=>{
  const f=fixture(t),size=16*1024*1024,checksum='0'.repeat(64);
  for(let index=0;index<16;index++){
    const path='/imports/batch-'+Math.floor(index/4)+'/assets';
    assert.equal((await f.request(path,{method:'POST',body:await meta({expectedRevision:index,sourceId:'asset-'+index,size,checksum})})).status,201);
  }
  await error(await f.request('/imports/new-batch/assets',{method:'POST',body:await meta({expectedRevision:16,sourceId:'workspace-over',size:1,checksum})}),413,'CONTENT_TOO_LARGE');
  assert.equal((await f.raw.read(workspaceId,'member')).payload.pendingBlobs.reduce((sum,row)=>sum+row.size,0),256*1024*1024);assert.equal(f.writes,16);assert.equal(f.puts,0);
  const count=fixture(t);
  for(let index=0;index<100;index++)assert.equal((await count.request('/imports/asset-import/assets',{method:'POST',body:await meta({expectedRevision:index,sourceId:'empty-'+index,size:0,checksum})})).status,201);
  await error(await count.request('/imports/asset-import/assets',{method:'POST',body:await meta({expectedRevision:100,sourceId:'one-too-many',size:0,checksum})}),413,'CONTENT_TOO_LARGE');
  assert.equal(count.writes,100);assert.equal(count.puts,0);assert.equal((await count.raw.read(workspaceId,'member')).payload.pendingBlobs.length,100);
});


test('ordinary page uploads retain their combined 32 MiB tuple limit while only import reservations can use 64 MiB',async t=>{
  const f=fixture(t),size=16*1024*1024,checksum='0'.repeat(64),importId='page-and-import';
  const created=await f.request('/pages',{method:'POST',body:{expectedRevision:0,title:'Ordinary upload page',blocks:[]}});assert.equal(created.status,201);const page=(await created.json()).page;
  const path='/pages/'+page.id+'/uploads/'+importId+'/assets';
  for(let index=0;index<2;index++)assert.equal((await f.request(path,{method:'POST',body:await meta({expectedRevision:index+1,sourceId:'page-file-'+index,size,checksum})})).status,201);
  await error(await f.request(path,{method:'POST',body:await meta({expectedRevision:3,sourceId:'page-over',size:1,checksum})}),413,'CONTENT_TOO_LARGE');
  const other=await f.request('/pages',{method:'POST',body:{expectedRevision:3,title:'Another ordinary page',blocks:[]}});assert.equal(other.status,201);const otherPage=(await other.json()).page;
  await error(await f.request('/pages/'+otherPage.id+'/uploads/'+importId+'/assets',{method:'POST',body:await meta({expectedRevision:4,sourceId:'other-page-over',size:1,checksum})}),413,'CONTENT_TOO_LARGE');
  for(let index=0;index<2;index++)assert.equal((await f.request('/imports/'+importId+'/assets',{method:'POST',body:await meta({expectedRevision:index+4,sourceId:'import-file-'+index,size,checksum})})).status,201);
  await error(await f.request('/imports/'+importId+'/assets',{method:'POST',body:await meta({expectedRevision:6,sourceId:'tuple-over',size:1,checksum})}),413,'CONTENT_TOO_LARGE');
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,6);assert.equal(saved.payload.pendingBlobs.reduce((sum,row)=>sum+row.size,0),64*1024*1024);assert.equal(saved.payload.pendingBlobs.filter(row=>row.pageId).reduce((sum,row)=>sum+row.size,0),32*1024*1024);assert.equal(f.puts,0);
});
