import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {previewNotionImport} from '../../importer/src/index.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),contentSchema=await readFile(new URL('../schema/content.sqlite.sql',import.meta.url),'utf8');
const origin='https://pages.example',workspaceId='lifecycle-workspace',stamp='2026-10-15T00:00:00.000Z';
function row(id,title,parentId=null,text=''){return{page:{id,workspaceId,title,parentId,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId,version:1,blocks:text?[{id:'block-'+id,type:'paragraph',data:{text}}]:[],updatedAt:stamp},inheritPermissions:parentId!==null};}
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(contentSchema);t.after(()=>db.close());
  for(const [account,role]of [['owner','owner'],['member','member'],['other','member'],['guest','guest']]){
    db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(account,account,account+'@example.invalid',stamp,stamp);
    if(account==='owner')db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Lifecycle','lifecycle',stamp);
    db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+account,workspaceId,account,role,stamp);
  }
  db.exec("CREATE TABLE legacy_sentinel(value TEXT);INSERT INTO legacy_sentinel VALUES('legacy unchanged')");
  const payload={schemaVersion:1,pages:[row('root','Root',null,'Private ancestor body'),row('branch','Branch','root','Branch visible text'),
    row('leaf','東京 note','branch','Visible 東京 body 😀'),row('old','Old row','branch','Hidden row allsecret'),row('dest','Destination'),row('hidden','Private owner',null,'owner private secret')],grants:[],grantBindings:[]};
  let grantNumber=0;const grant=(pageId,accountId,permission='full',includeDescendants=true)=>{const id='fixture-grant-'+ ++grantNumber;payload.grants.push({id,workspaceId,pageId,accountId,permission,includeDescendants,status:'active'});payload.grantBindings.push({grantId:id,membershipId:'membership-'+accountId});};
  grant('root','member');grant('dest','member');grant('hidden','owner');grant('dest','other','viewer');grant('branch','guest','full',false);
  const raw=createSqliteContentStore(db);let reads=0,writes=0,sequence=0,beforeWrite=null;
  const store={async read(...args){reads++;return raw.read(...args);},async write(...args){writes++;if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
  const api=createAccountContentApi({store,origin,now:()=>stamp,createId:()=> 'generated-'+ ++sequence,
    resolveSession:async request=>request.headers.has('x-actor')?{user:{id:request.headers.get('x-actor'),emailVerified:true}}:null});
  const request=(path,{account='member',method='GET',body,headers={}}={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,
    headers:{Origin:origin,'Content-Type':'application/json',...(account?{'x-actor':account,'X-Yumunio-Expected-Account':account}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const save=async(value,expected=0)=>raw.write(workspaceId,'member',{expectedRevision:expected,payload:value,actorMembershipId:'membership-member',actorRole:'member'});
  return{db,raw,payload,grant,save,request,setBeforeWrite:fn=>beforeWrite=fn,get reads(){return reads;},get writes(){return writes;}};
}
async function error(response,status,code){assert.equal(response.status,status);const body=await response.json();assert.equal(body.error.code,code);assert.doesNotMatch(JSON.stringify(body),/private secret|Hidden row|membership-|fixture-grant|objectKey|digest/);}
const location=(f,pageId,parentId,expectedRevision=1,extra={})=>f.request('/pages/'+pageId+'/location',{method:'PATCH',body:{expectedRevision,parentId,...extra}});
const trash=(f,pageId,expectedRevision=1,extra={})=>f.request('/pages/'+pageId,{method:'DELETE',body:{expectedRevision},...extra});
const restore=(f,pageId,expectedRevision,parentId=undefined)=>f.request('/pages/'+pageId+'/restore',{method:'POST',body:{expectedRevision,...(parentId===undefined?{}:{parentId})}});

test('moving a managed subtree uses one CAS, increments every affected version, retains full authority and defaults to private inheritance',async t=>{
  const f=fixture(t);await f.save(f.payload);const response=await location(f,'branch','dest');assert.equal(response.status,200);assert.deepEqual(await response.json(),{revision:2,pageId:'branch',affectedPageCount:3});
  const saved=await f.raw.read(workspaceId,'member');const branch=saved.payload.pages.find(item=>item.page.id==='branch');assert.equal(branch.page.parentId,'dest');assert.equal(branch.inheritPermissions,false);
  for(const id of ['branch','leaf','old'])assert.equal(saved.payload.pages.find(item=>item.page.id===id).document.version,2);assert.equal(saved.payload.pages.find(item=>item.page.id==='root').document.version,1);
  const own=saved.payload.grants.find(grant=>grant.pageId==='branch'&&grant.accountId==='member');assert.equal(own.permission,'full');assert.equal(own.includeDescendants,true);
  assert.equal(saved.payload.grants.filter(grant=>grant.accountId==='other').length,1);
  const other=await(await f.request('/pages',{account:'other'})).json();assert.deepEqual(other.pages.map(page=>page.id),['dest']);
  const retained=await(await f.request('/pages/branch')).json();assert.ok(retained.page.capabilities.includes('manage'));
  const shared=await location(f,'branch','dest',2,{inheritPermissions:true});assert.equal(shared.status,200);
  const expanded=await(await f.request('/pages',{account:'other'})).json();assert.ok(expanded.pages.some(page=>page.id==='leaf'));
  assert.equal(f.writes,2);assert.equal(f.db.prepare('SELECT value FROM legacy_sentinel').get().value,'legacy unchanged');
});

test('move rejects cycles, invisible source ancestors, inaccessible targets, hidden descendants and collection row rebinding without writes',async t=>{
  const f=fixture(t);await f.save(f.payload);
  await error(await location(f,'branch','leaf'),400,'HIERARCHY_CYCLE');await error(await location(f,'branch','hidden'),404,'CONTENT_NOT_FOUND');
  await error(await location(f,'branch','unknown'),404,'CONTENT_NOT_FOUND');await error(await location(f,'branch','dest',0),409,'CONTENT_CONFLICT');
  await error(await f.request('/pages/branch/location',{account:'guest',method:'PATCH',body:{expectedRevision:1,parentId:null}}),404,'CONTENT_NOT_FOUND');
  const saved=await f.raw.read(workspaceId,'member');saved.payload.pages.push(row('island','Visible island','hidden'));
  saved.payload.grants.push({id:'island-grant',workspaceId,pageId:'island',accountId:'member',permission:'full',includeDescendants:true,status:'active'});saved.payload.grantBindings.push({grantId:'island-grant',membershipId:'membership-member'});
  await f.save(saved.payload,1);await error(await location(f,'island',null,2),404,'CONTENT_NOT_FOUND');
  const current=await f.raw.read(workspaceId,'member');current.payload.grants.push({id:'leaf-deny',workspaceId,pageId:'leaf',accountId:'member',permission:'deny',includeDescendants:false,status:'active'});current.payload.grantBindings.push({grantId:'leaf-deny',membershipId:'membership-member'});await f.save(current.payload,2);
  await error(await location(f,'branch','dest',3),404,'CONTENT_NOT_FOUND');await error(await trash(f,'branch',3),404,'CONTENT_NOT_FOUND');assert.equal(f.writes,0);
});

test('trash batches restore only their own active subtree and invalidate stale document versions while older trash stays deleted',async t=>{
  const f=fixture(t);await f.save(f.payload);assert.equal((await trash(f,'old')).status,200);assert.equal((await trash(f,'branch',2)).status,200);
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.payload.trashGroups.length,2);assert.equal(saved.payload.trashGroups.find(group=>group.rootPageId==='branch').pageIds.length,2);
  assert.equal((await f.request('/pages/leaf')).status,404);
  const list=await(await f.request('/trash')).json();assert.deepEqual(list.pages.map(page=>page.id),['old','branch']);assert.equal(list.pages.find(page=>page.id==='branch').pageCount,2);
  assert.deepEqual((await(await f.request('/trash',{account:'owner'})).json()).pages,[]);assert.deepEqual((await(await f.request('/trash',{account:'guest'})).json()).pages,[]);
  await error(await restore(f,'leaf',3),404,'CONTENT_NOT_FOUND');
  const restored=await restore(f,'branch',3);assert.equal(restored.status,200);assert.deepEqual(await restored.json(),{revision:4,pageId:'branch',affectedPageCount:2});
  const final=await f.raw.read(workspaceId,'member');assert.equal(final.payload.pages.find(item=>item.page.id==='old').page.trashedAt,stamp);assert.equal(final.payload.pages.find(item=>item.page.id==='old').document.version,2);
  assert.equal(final.payload.pages.find(item=>item.page.id==='leaf').page.trashedAt,null);assert.equal(final.payload.pages.find(item=>item.page.id==='leaf').document.version,3);assert.equal(final.payload.trashGroups.length,1);
  await error(await f.request('/pages/leaf',{method:'PATCH',body:{expectedRevision:4,expectedVersion:1,title:'Stale pre-trash title'}}),409,'CONTENT_CONFLICT');
  assert.deepEqual((await(await f.request('/trash')).json()).pages.map(page=>page.id),['old']);assert.equal(f.writes,3);
});

test('restore requires a live destination or an explicit root choice and cannot revive another trash batch',async t=>{
  const f=fixture(t);await f.save(f.payload);await trash(f,'branch');await trash(f,'root',2);
  await error(await restore(f,'branch',3),404,'CONTENT_NOT_FOUND');const response=await restore(f,'branch',3,null);assert.equal(response.status,200);
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.payload.pages.find(item=>item.page.id==='branch').page.parentId,null);assert.equal(saved.payload.pages.find(item=>item.page.id==='root').page.trashedAt,stamp);
  assert.deepEqual(saved.payload.trashGroups.map(group=>group.rootPageId),['root']);
});

test('lifecycle actor expectation runs before storage and live role, membership, target and page revocation races reject the entire CAS',async t=>{
  const f=fixture(t);await f.save(f.payload);
  for(const [path,method,body]of [['/pages/branch/location','PATCH',{expectedRevision:1,parentId:null}],['/pages/branch','DELETE',{expectedRevision:1}],['/pages/branch/restore','POST',{expectedRevision:1}]]){
    await error(await f.request(path,{method,body,headers:{'X-Yumunio-Expected-Account':''}}),400,'INVALID_CONTENT');
    await error(await f.request(path,{method,body,headers:{'X-Yumunio-Expected-Account':'owner'}}),404,'CONTENT_NOT_FOUND');
  }
  assert.equal(f.reads,0);assert.equal(f.writes,0);
  f.setBeforeWrite(()=>f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE id=?').run('guest','membership-member'));
  await error(await location(f,'branch','dest'),404,'CONTENT_NOT_FOUND');assert.equal(f.db.prepare('SELECT revision FROM yumunio_account_content').get().revision,1);
  for(const mode of ['membership','target','source']){
    const g=fixture(t);await g.save(g.payload);g.setBeforeWrite(async()=>{
      if(mode==='membership'){g.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-member');return;}
      const saved=await g.raw.read(workspaceId,'member');const page=mode==='target'?'dest':'root';saved.payload.grants.find(grant=>grant.pageId===page&&grant.accountId==='member').status='revoked';await g.save(saved.payload,1);
    });await error(await location(g,'branch','dest'),404,'CONTENT_NOT_FOUND');
    assert.equal((g.db.prepare('SELECT revision FROM yumunio_account_content').get().revision),mode==='membership'?1:2);
  }
});

test('import receipts survive moving their root and replay only after current ACL and membership revalidation',async t=>{
  const f=fixture(t);await f.save(f.payload);const body={expectedRevision:1,importId:'moved-import',pages:[{sourceId:'import-folder',parentSourceId:null,title:'Imported folder',blocks:[]},{sourceId:'import-child',parentSourceId:'import-folder',title:'Imported child',blocks:[]}]};
  const created=await f.request('/imports',{method:'POST',body});assert.equal(created.status,201);const receipt=await created.json();
  assert.equal((await location(f,receipt.rootPageId,'dest',2)).status,200);
  const replay=await f.request('/imports',{method:'POST',body});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),{...receipt,replayed:true});
  assert.equal((await trash(f,receipt.rootPageId,3)).status,200);await error(await f.request('/imports',{method:'POST',body}),404,'CONTENT_NOT_FOUND');
  assert.equal((await restore(f,receipt.rootPageId,4)).status,200);assert.equal((await f.request('/imports',{method:'POST',body})).status,200);
});

test('search uses a strict bounded Japanese substring query over readable active pages and never searches hidden or trashed notes',async t=>{
  const f=fixture(t);await f.save(f.payload);const found=await(await f.request('/search?q='+encodeURIComponent('東京'))).json();assert.equal(found.results.length,1);assert.equal(found.results[0].page.id,'leaf');assert.match(found.results[0].snippet,/東京/);
  const hidden=await(await f.request('/search?q=private',{account:'other'})).json();assert.deepEqual(hidden.results,[]);assert.equal(hidden.truncated,false);
  assert.deepEqual((await(await f.request('/search?q=allsecret',{account:'guest'})).json()).results,[]);
  for(const query of ['','?q=','?q=x&q=y','?q=x&extra=y','?format=json','?q='+encodeURIComponent('x'.repeat(101)),'?q=%00'])await error(await f.request('/search'+query),400,'INVALID_CONTENT');
  await error(await f.request('/pages?q=東京'),400,'INVALID_CONTENT');
  await trash(f,'branch');assert.deepEqual((await(await f.request('/search?q='+encodeURIComponent('東京'))).json()).results,[]);
});

test('search truncates at 100 readable matches without counting private pages',async t=>{
  const f=fixture(t);for(let index=0;index<102;index++){const id='hit-'+index;f.payload.pages.push(row(id,'Hit '+index));f.grant(id,'member');}await f.save(f.payload);
  const result=await(await f.request('/search?q=HIT')).json();assert.equal(result.results.length,100);assert.equal(result.truncated,true);
});

test('JSON and CRC-checked ZIP exports redact hidden ancestry, rows, link targets, grants and blob locations while declaring manifest-only attachments',async t=>{
  const f=fixture(t);f.grant('branch','other','viewer',false);f.grant('leaf','other','viewer',false);
  f.payload.pages.find(item=>item.page.id==='leaf').document.blocks[0].data={text:'Visible file and hidden',links:[{start:17,end:23,label:'hidden',pageId:'hidden'}]};
  f.payload.collections=[{pageId:'branch',collection:{id:'native-collection',workspaceId,title:'Collection',properties:[{id:'column',name:'Code',type:'text'}],records:[{id:'record-leaf',values:{column:'=literal formula'}},{id:'record-old',values:{column:'secret-hidden-row'}}],createdAt:stamp,updatedAt:stamp},sourceHeaders:['Original Code'],recordPages:[{recordId:'record-leaf',pageId:'leaf',sourceValues:{column:'001'}},{recordId:'record-old',pageId:'old',sourceValues:{column:'original-hidden-row'}}]}];
  f.payload.attachments=[{id:'attachment-leaf',pageId:'leaf',name:'private.txt',mediaType:'application/octet-stream',size:5,checksum:'0'.repeat(64),profileId:'blob-secret-profile',objectKey:'objects/secret-key'}];await f.save(f.payload);
  const response=await f.request('/export?format=json',{account:'other'});assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);const data=await response.json();
  assert.equal(data.kind,'yumunio-account-content-export');assert.equal(data.pages.length,3);assert.equal(data.pages.find(item=>item.page.id==='branch').page.parentId,null);
  assert.deepEqual(data.pages.find(item=>item.page.id==='leaf').document.blocks[0].data.links,[{start:17,end:23,label:'hidden',unavailable:true}]);
  assert.equal(data.collections[0].collection.records.length,1);assert.equal(data.collections[0].collection.records[0].sourceValues.column,'001');assert.equal(data.attachments.length,1);
  assert.match(data.warnings.join(' '),/manifest only.*not a full backup/);assert.doesNotMatch(JSON.stringify(data),/secret-hidden-row|original-hidden-row|objectKey|profileId|secret-key|grantBindings|membership-|owner private|"imports"/);
  const archive=await f.request('/export?format=zip',{account:'other'});assert.equal(archive.status,200);const bytes=new Uint8Array(await archive.arrayBuffer());const plan=await previewNotionImport(bytes);
  assert.equal(plan.pages.length,3);assert.equal(plan.collections.length,1);assert.equal(plan.collections[0].rows.length,1);assert.equal(plan.collections[0].rows[0].cells[1],"'=literal formula");
  assert.doesNotMatch(new TextDecoder().decode(bytes),/secret-hidden-row|original-hidden-row|secret-key|blob-secret-profile/);
  for(const path of ['/export','/export?format=other','/export?format=json&format=zip','/export?format=json&includeTrash=true'])await error(await f.request(path),400,'INVALID_CONTENT');
  await error(await f.request('/export?format=json',{method:'POST',body:{}}),405,'METHOD_NOT_ALLOWED');assert.equal(f.writes,0);
});

test('collection rows cannot leave their container and trash metadata or exhausted versions cannot create partial changes',async t=>{
  const f=fixture(t);f.payload.collections=[{pageId:'branch',collection:{id:'collection',workspaceId,title:'Rows',properties:[{id:'p',name:'Text',type:'text'}],records:[{id:'r',values:{p:'old'}}],createdAt:stamp,updatedAt:stamp},sourceHeaders:['Text'],recordPages:[{recordId:'r',pageId:'leaf',sourceValues:{p:'old'}}]}];await f.save(f.payload);
  await error(await location(f,'leaf','dest'),409,'COLLECTION_ROW_LOCATION');
  const saved=await f.raw.read(workspaceId,'member');saved.payload.pages.find(item=>item.page.id==='leaf').document.version=Number.MAX_SAFE_INTEGER;await f.save(saved.payload,1);
  await error(await trash(f,'branch',2),409,'CONTENT_CONFLICT');assert.equal(f.writes,0);
  for(const groups of [[{id:'bad',rootPageId:'missing',pageIds:['missing'],trashedAt:stamp}],[{id:'bad',rootPageId:'branch',pageIds:['branch'],trashedAt:stamp}]])assert.throws(()=>validateContentPayload({...f.payload,trashGroups:groups},workspaceId));
});
test('search snippets use the same normalization as matching so compatibility and case expansion do not shift the hit',async t=>{
  const f=fixture(t);f.payload.pages.find(item=>item.page.id==='leaf').document.blocks[0].data.text='Ａ'.repeat(180)+'ｶﾞİstanbul';await f.save(f.payload);
  const result=await(await f.request('/search?q='+encodeURIComponent('ガi'))).json();assert.equal(result.results.length,1);assert.match(result.results[0].snippet,/ガi/);assert.doesNotMatch(result.results[0].snippet,/Ａ|ｶﾞ/);
});