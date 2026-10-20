import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createAccountContentApi, validateContentPayload } from '../src/content.js';
import { createSqliteContentStore } from '../src/content-store.js';
import { CONTENT_STORAGE_LIMITS } from '../src/content-codec.js';

const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const contentSchema=await readFile(new URL('../schema/content.sqlite.sql',import.meta.url),'utf8');
const origin='https://workspace.example';
const workspaceId='workspace-a';
const stamp='2026-10-15T00:00:00.000Z';
const bundle=(extra={})=>({expectedRevision:0,importId:'import-fixture-a',pages:[
  {sourceId:'child',parentSourceId:'folder',title:'Imported child',blocks:[{id:'source-block',type:'paragraph',data:{text:'Private imported body',b:2,a:1},children:[{id:'nested-source',type:'paragraph',data:{text:'Nested'}}]}]},
  {sourceId:'folder',parentSourceId:null,title:'Import folder',blocks:[]},
  {sourceId:'sibling',parentSourceId:'folder',title:'Imported sibling',blocks:[]},
],...extra});
function fixture(t) {
  const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(contentSchema);
  t.after(()=>db.close());
  for(const name of ['owner','member','admin','guest']) {
    db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(name,name,name+'@example.invalid',stamp,stamp);
  }
  for(const id of [workspaceId,'workspace-b']) db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(id,id,id,stamp);
  for(const role of ['owner','member','admin','guest']) db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+role,workspaceId,role,role,stamp);
  db.exec("CREATE TABLE prototype_sentinel(value TEXT); INSERT INTO prototype_sentinel VALUES('preserved legacy snapshot')");
  const raw=createSqliteContentStore(db);let beforeWrite=null;let sequence=0;let writes=0;let reads=0;
  const store={read:(...args)=>{reads++;return raw.read(...args);},async write(...args){writes++;if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
  const api=createAccountContentApi({store,origin,now:()=>stamp,createId:()=> 'server-'+ ++sequence,
    resolveSession:async request=>request.headers.has('x-fixture-account') ? {user:{id:request.headers.get('x-fixture-account'),emailVerified:true}} : null});
  const request=(accountId,body=bundle(),path='/imports',method='POST',headers={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{
    method,headers:{Origin:origin,'Content-Type':'application/json',...(accountId ? {'x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId} : {}),...headers},
    ...(method === 'GET' ? {} : {body:JSON.stringify(body)})
  }));
  return {db,raw,api,request,setBeforeWrite:callback=>{beforeWrite=callback;},get writes(){return writes;},get reads(){return reads;}};
}
async function error(response,status,code) {
  assert.equal(response.status,status);const body=await response.json();assert.equal(body.error.code,code);
  assert.deepEqual(Object.keys(body),['error']);assert.doesNotMatch(JSON.stringify(body),/Private imported|membership-|server-|digest|source-block/);
}

test('one SQLite CAS imports an unordered private subtree, remaps all IDs and leaves old snapshot data untouched',async t=>{
  const f=fixture(t);const response=await f.request('member');assert.equal(response.status,201);
  const result=await response.json();assert.deepEqual(Object.keys(result),['revision','importId','rootPageId','pageCount','replayed']);
  assert.equal(result.revision,1);assert.equal(result.importId,'import-fixture-a');assert.equal(result.pageCount,3);assert.equal(result.replayed,false);
  assert.equal(f.writes,1);
  const saved=await f.raw.read(workspaceId,'member');const payload=saved.payload;
  assert.equal(saved.revision,1);assert.equal(payload.pages.length,3);assert.equal(payload.grants.length,1);
  assert.equal(payload.grants[0].pageId,result.rootPageId);assert.equal(payload.grants[0].accountId,'member');assert.equal(payload.grants[0].permission,'full');
  assert.equal(payload.grants[0].includeDescendants,true);assert.equal(payload.grantBindings[0].membershipId,'membership-member');
  const root=payload.pages.find(item=>item.page.id===result.rootPageId);assert.equal(root.page.parentId,null);assert.equal(root.inheritPermissions,false);
  for(const item of payload.pages.filter(item=>item!==root)) {assert.equal(item.page.parentId,result.rootPageId);assert.equal(item.inheritPermissions,true);assert.equal(item.document.version,1);}
  const child=payload.pages.find(item=>item.page.title==='Imported child');
  assert.notEqual(child.document.blocks[0].id,'source-block');assert.notEqual(child.document.blocks[0].children[0].id,'nested-source');
  assert.deepEqual(child.document.blocks[0].data,bundle().pages[0].blocks[0].data);
  for(const role of ['owner','admin','guest']) {
    const listed=await f.request(role,undefined,'/pages','GET');assert.equal(listed.status,200);const data=await listed.json();assert.deepEqual(data.pages,[]);
    for(const key of ['payload','imports','grants','grantBindings','principals']) assert.equal(Object.hasOwn(data,key),false);
  }
  assert.equal(f.db.prepare('SELECT value FROM prototype_sentinel').get().value,'preserved legacy snapshot');
});

test('replay uses the original commit, canonical bundle keys and current membership without writing duplicate pages',async t=>{
  const f=fixture(t);const first=await(await f.request('member')).json();
  const changed=await f.request('member',{expectedRevision:1,expectedVersion:1,title:'Edited after import'},'/pages/'+first.rootPageId,'PATCH');assert.equal(changed.status,200);
  const reordered=bundle({expectedRevision:99});
  const block=reordered.pages[0].blocks[0];block.data={a:1,b:2,text:block.data.text};
  reordered.pages=reordered.pages.map(page=>({blocks:page.blocks,title:page.title,parentSourceId:page.parentSourceId,sourceId:page.sourceId}));
  const retry=await f.request('member',reordered);assert.equal(retry.status,200);
  assert.deepEqual(await retry.json(),{...first,replayed:true});assert.equal(f.writes,2);
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,2);assert.equal(saved.payload.pages.length,3);
  const different=bundle();different.pages[0].title='Different body';await error(await f.request('member',different),409,'CONTENT_CONFLICT');
  await error(await f.request('owner'),404,'CONTENT_NOT_FOUND');await error(await f.request('admin'),404,'CONTENT_NOT_FOUND');
  assert.equal(f.writes,2);
});

test('invalid hierarchy, authorization injection and request/page limits have no partial writes',async t=>{
  const f=fixture(t);const malformed=[
    value=>{value.pages=[];},value=>{value.pages.push(structuredClone(value.pages[0]));},
    value=>{value.pages[2].parentSourceId=null;},value=>{value.pages[0].parentSourceId='outside-existing-parent';},
    value=>{value.pages[0].parentSourceId='sibling';value.pages[2].parentSourceId='child';},
    value=>{value.pages[1].parentSourceId='child';},value=>{value.pages[0].permission='full';},
    value=>{value.actorMembershipId='membership-owner';},value=>{value.pages[0].blocks[0].children[0].id='source-block';},
    value=>{value.pages[0].title=123;},value=>{value.importId='../invalid';},
  ];
  for(const corrupt of malformed) {const data=bundle();corrupt(data);await error(await f.request('member',data),400,'INVALID_CONTENT');}
  const tooMany=bundle({pages:Array.from({length:501},(_,index)=>({sourceId:'source-'+index,parentSourceId:index===0 ? null : 'source-0',title:'Page',blocks:[]}))});
  await error(await f.request('member',tooMany),413,'CONTENT_TOO_LARGE');
  const large=bundle();large.pages[0].blocks[0].data.text='x'.repeat(768000);await error(await f.request('member',large),413,'CONTENT_TOO_LARGE');
  await error(await f.request('member',bundle({expectedRevision:1})),409,'CONTENT_CONFLICT');
  await error(await f.request('guest'),404,'CONTENT_NOT_FOUND');await error(await f.request(null),401,'UNAUTHORIZED');
  await error(await f.request('member',bundle(),'/imports','POST',{Origin:'https://other.invalid'}),403,'ORIGIN_REJECTED');
  await error(await f.request('member',undefined,'/imports','GET'),405,'METHOD_NOT_ALLOWED');
  assert.equal(f.writes,0);assert.equal((await f.raw.read(workspaceId,'member')).revision,0);
});

test('the byte budget remains atomic while imports grow beyond a thousand existing pages',async t=>{
  const f=fixture(t);await f.request('member');
  let saved=await f.raw.read(workspaceId,'member');saved.payload.pages[0].document.blocks[0].data.text='';
  const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length,nearLimit=CONTENT_STORAGE_LIMITS.logicalBytes-20000;
  const existingText='x'.repeat(nearLimit-bytes(saved.payload));saved.payload.pages[0].document.blocks[0].data.text=existingText;
  assert.equal(bytes(saved.payload),nearLimit);validateContentPayload(saved.payload,workspaceId);
  await f.raw.write(workspaceId,'member',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});
  const overflow=bundle({expectedRevision:2,importId:'overflow'});overflow.pages[0].blocks[0].data.text='y'.repeat(25000);
  assert.ok(bytes(overflow)<768000);
  await error(await f.request('member',overflow),413,'CONTENT_TOO_LARGE');
  saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,2);assert.equal(saved.payload.pages.length,3);assert.equal(saved.payload.pages[0].document.blocks[0].data.text,existingText);assert.equal(saved.payload.imports.length,1);
  saved.payload.pages[0].document.blocks[0].data.text='small';
  for(let i=3;i<1000;i++) saved.payload.pages.push({page:{id:'existing-'+i,workspaceId,title:'Existing',parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null},
    document:{pageId:'existing-'+i,workspaceId,version:1,blocks:[],updatedAt:stamp},inheritPermissions:false});
  validateContentPayload(saved.payload,workspaceId);
  await f.raw.write(workspaceId,'member',{expectedRevision:2,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});
  const imported=await f.request('member',bundle({expectedRevision:3,importId:'next-pages'}));assert.equal(imported.status,201);
  saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,4);assert.equal(saved.payload.pages.length,1003);assert.equal(saved.payload.pages[0].document.blocks[0].data.text,'small');
  assert.equal(f.writes,2);
});

test('old payloads remain valid and receipt metadata is strictly validated without changing public reads',async t=>{
  const old={schemaVersion:1,pages:[],grants:[],grantBindings:[]};assert.deepEqual(validateContentPayload(old,workspaceId),old);
  const f=fixture(t);await f.request('member');const saved=await f.raw.read(workspaceId,'member');
  for(const corrupt of [value=>{value.imports.push(structuredClone(value.imports[0]));},value=>{value.imports[0].digest='bad';},
    value=>{value.imports[0].rootPageId='missing';},value=>{value.imports[0].pageCount=501;},value=>{value.imports[0].token='secret';},
    value=>{value.imports[0].revision=0;}]) {
    const payload=structuredClone(saved.payload);corrupt(payload);assert.throws(()=>validateContentPayload(payload,workspaceId));
  }
});

for(const mutation of ['remove','rejoin','guest','unverify','revoke-root']) test('replay reveals no receipt after '+mutation,async t=>{
  const f=fixture(t);await f.request('member');
  if(mutation==='remove') f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-member');
  if(mutation==='rejoin') f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('membership-rejoined','membership-member');
  if(mutation==='guest') f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE id=?').run('guest','membership-member');
  if(mutation==='unverify') f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('member');
  if(mutation==='revoke-root') {
    const saved=await f.raw.read(workspaceId,'member');saved.payload.grants[0].status='revoked';
    await f.raw.write(workspaceId,'member',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});
  }
  await error(await f.request('member'),404,'CONTENT_NOT_FOUND');assert.equal(f.writes,1);
});

for(const mutation of ['remove','role-change','unverify']) test('a live '+mutation+' between read and CAS imports zero pages',async t=>{
  const f=fixture(t);
  f.setBeforeWrite(()=>{
    if(mutation==='remove') f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-member');
    if(mutation==='role-change') f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE id=?').run('admin','membership-member');
    if(mutation==='unverify') f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('member');
  });
  await error(await f.request('member'),404,'CONTENT_NOT_FOUND');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_account_content').get().n,0);
});

for(const same of [true,false]) test('two admitted imports '+(same ? 'share an idempotent result' : 'have one CAS winner')+' atomically',async t=>{
  const f=fixture(t);let arrivals=0;let release;const gate=new Promise(resolve=>{release=resolve;});
  f.setBeforeWrite(async()=>{if(++arrivals===2)release();await gate;});
  const second=bundle(same ? {} : {importId:'different-import'});
  const responses=await Promise.all([f.request('member'),f.request('member',second)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),same ? [200,201] : [201,409]);
  const results=await Promise.all(responses.map(response=>response.json()));
  if(same) {assert.equal(results[0].rootPageId,results[1].rootPageId);assert.deepEqual(results.map(result=>result.replayed).sort(),[false,true]);}
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.revision,1);assert.equal(saved.payload.pages.length,3);assert.equal(saved.payload.imports.length,1);
});

test('an uncertain committed response is not retried automatically and a client replay finds the durable receipt',async t=>{
  const f=fixture(t);let once=true;
  f.setBeforeWrite(async(...args)=>{if(once){once=false;await f.raw.write(...args);throw Object.assign(new Error('Private response failure'),{code:'CONTENT_STORAGE_ERROR'});}});
  await error(await f.request('member'),503,'CONTENT_UNAVAILABLE');
  assert.equal(f.writes,1);const replay=await f.request('member');assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
  assert.equal(f.writes,1);assert.equal((await f.raw.read(workspaceId,'member')).payload.pages.length,3);
});

test('imports require a valid expected account matching the trusted session before reading or writing storage',async t=>{
  const f=fixture(t);
  const missingHeader=new Request(origin+'/api/content/workspaces/'+workspaceId+'/imports',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json','x-fixture-account':'member'},body:JSON.stringify(bundle())
  });
  await error(await f.api(missingHeader),400,'INVALID_CONTENT');
  await error(await f.request('member',bundle(),'/imports','POST',{'X-Yumunio-Expected-Account':'bad/expected'}),400,'INVALID_CONTENT');
  await error(await f.request('member',bundle(),'/imports','POST',{'X-Yumunio-Expected-Account':'owner'}),404,'CONTENT_NOT_FOUND');
  // Simulate another-tab cookie/account change after the UI captured member as its expected actor.
  await error(await f.request('member',bundle(),'/imports','POST',{'x-fixture-account':'owner'}),404,'CONTENT_NOT_FOUND');
  assert.equal(f.reads,0);assert.equal(f.writes,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_account_content').get().n,0);
  const accepted=await f.request('member');assert.equal(accepted.status,201);assert.equal(f.reads,1);assert.equal(f.writes,1);
});

function collectionBundle(extra={}) {
  return {expectedRevision:0,importId:'native-csv-import',pages:[
    {sourceId:'folder',parentSourceId:null,title:'Import folder',blocks:[]},
    {sourceId:'csv',parentSourceId:'folder',title:'Tasks',blocks:[]},
    {sourceId:'row-a',parentSourceId:'csv',title:'First row',blocks:[]},
    {sourceId:'row-b',parentSourceId:'csv',title:'Second row',blocks:[]},
    {sourceId:'doc',parentSourceId:'folder',title:'Linked document',blocks:[{id:'text',type:'paragraph',data:{text:'See Tasks and First',links:[
      {start:4,end:9,label:'Tasks',sourceCollectionId:'csv-collection',fragment:'overview'},
      {start:14,end:19,label:'First',sourcePageId:'row-a'},
    ]}}]},
  ],collections:[{sourceId:'csv-collection',pageSourceId:'csv',properties:[
    {id:'column-a',name:'Name',type:'text',sourceName:''}, {id:'column-b',name:'Name',type:'text',sourceName:'Name'},
  ],records:[{sourceId:'record-a',pageSourceId:'row-a',values:{'column-a':'001','column-b':''}},
    {sourceId:'record-b',pageSourceId:'row-b',values:{'column-a':'日本語 😀','column-b':'=literal formula'}}]}],...extra};
}
async function importedCollection(f) {
  const response=await f.request('member',collectionBundle());assert.equal(response.status,201);
  const result=await response.json();const saved=await f.raw.read(workspaceId,'member');const entry=saved.payload.collections[0];
  return {result,saved,entry,path:'/collections/'+entry.collection.id};
}

test('native CSV import atomically creates editable text collections and row pages while preserving all raw cells and headers',async t=>{
  const f=fixture(t);const {result,saved,entry,path}=await importedCollection(f);
  assert.equal(result.pageCount,5);assert.equal(f.writes,1);assert.equal(saved.revision,1);
  const source=collectionBundle().collections[0];assert.deepEqual(entry.sourceHeaders,['','Name']);
  assert.notEqual(entry.collection.id,source.sourceId);assert.notEqual(entry.collection.properties[0].id,'column-a');
  assert.equal(entry.collection.properties[0].name,entry.collection.properties[1].name);
  const columns=entry.collection.properties.map(property=>property.id);
  assert.deepEqual(entry.collection.records[0].values,{[columns[0]]:'001',[columns[1]]:''});
  assert.deepEqual(entry.collection.records[1].values,{[columns[0]]:'日本語 😀',[columns[1]]:'=literal formula'});
  assert.deepEqual(entry.recordPages[0].sourceValues,entry.collection.records[0].values);
  const response=await f.request('member',undefined,path,'GET');assert.equal(response.status,200);const data=await response.json();
  assert.equal(data.collection.records.length,2);assert.equal(data.pageId,entry.pageId);assert.deepEqual(data.collection.sourceHeaders,['','Name']);
  const list=await(await f.request('member',undefined,'/pages','GET')).json();
  assert.equal(list.pages.find(page=>page.id===entry.pageId).collectionId,entry.collection.id);
  const row=data.collection.records[0];assert.equal(list.pages.find(page=>page.id===row.pageId).recordId,row.id);
  assert.ok(row.capabilities.includes('editRecordValues'));
  const edited=await f.request('member',{expectedRevision:1,values:{[columns[0]]:'Changed'}},path+'/records/'+row.id,'PATCH');
  assert.equal(edited.status,200);const changed=await edited.json();assert.equal(changed.revision,2);assert.equal(changed.collectionId,entry.collection.id);
  assert.equal(changed.record.values[columns[0]],'Changed');assert.equal(changed.record.values[columns[1]],'');
  assert.equal(changed.record.sourceValues[columns[0]],'001');assert.equal(changed.record.sourceValues[columns[1]],'');
  await error(await f.request('member',{expectedRevision:1,values:{[columns[0]]:'Stale'}},path+'/records/'+row.id,'PATCH'),409,'CONTENT_CONFLICT');
  assert.equal(f.writes,2);assert.equal(f.db.prepare('SELECT value FROM prototype_sentinel').get().value,'preserved legacy snapshot');
  const replay=await f.request('member',collectionBundle({expectedRevision:999}));assert.equal(replay.status,200);assert.deepEqual(await replay.json(),{...result,replayed:true});
  const modified=collectionBundle();modified.collections[0].records[0].values['column-a']='Different';
  await error(await f.request('member',modified),409,'CONTENT_CONFLICT');assert.equal(f.writes,2);
});

test('CSV collection and structured-link validation reject the entire bundle before any write',async t=>{
  const f=fixture(t);
  for (const corrupt of [
    value=>{value.collections[0].pageSourceId='unknown';},value=>{value.collections[0].records[0].pageSourceId='doc';},
    value=>{value.collections[0].records[1].pageSourceId='row-a';},value=>{value.collections[0].properties[1].id='column-a';},
    value=>{value.collections[0].records[0].values['column-a']=123;},value=>{delete value.collections[0].records[0].values['column-b'];},
    value=>{value.collections[0].records[0].values.unknown='injected';},value=>{value.collections[0].properties[0].type='number';},
    value=>{value.collections[0].records[1].sourceId='record-a';},value=>{value.collections.push(structuredClone(value.collections[0]));},
    value=>{value.collections[0].records[0].permission='full';},value=>{value.collections[0].properties[0].sourceName=42;},
    value=>{value.pages[4].blocks[0].data.links[0].sourceCollectionId='missing';},
    value=>{value.pages[4].blocks[0].data.links[0].sourcePageId='row-a';},
    value=>{value.pages[4].blocks[0].data.links[0].start=3;},
    value=>{value.pages[4].blocks[0].data.links[1].fragment='bad\nfragment';},
    value=>{value.pages[4].blocks[0].data.links[0].pageId='injected';},
    value=>{value.pages[4].blocks[0].data.links[1].start=8;},
  ]) {const body=collectionBundle();corrupt(body);await error(await f.request('member',body),400,'INVALID_CONTENT');}
  assert.equal(f.writes,0);assert.equal((await f.raw.read(workspaceId,'member')).revision,0);
  const old=bundle();assert.equal((await f.request('member',old)).status,201);
  assert.equal((await f.request('member',{...old,collections:[]})).status,200);
});

test('collection records and internal destinations are filtered by current page ACL without private row identifiers',async t=>{
  const f=fixture(t);const {entry,path}=await importedCollection(f);let rev=1;
  const grant=async(pageId,permission)=>{
    const response=await f.request('member',{expectedRevision:rev,accountId:'guest',permission},'/pages/'+pageId+'/grants','POST');assert.equal(response.status,200);rev=(await response.json()).revision;
  };
  const source=(await f.raw.read(workspaceId,'member')).payload;
  const doc=source.pages.find(item=>item.page.title==='Linked document');const first=entry.recordPages[0];const second=entry.recordPages[1];
  await grant(doc.page.id,'viewer');
  let linked=await(await f.request('guest',undefined,'/pages/'+doc.page.id,'GET')).json();
  assert.deepEqual(linked.document.blocks[0].data.links,[{start:4,end:9,label:'Tasks',unavailable:true},{start:14,end:19,label:'First',unavailable:true}]);
  await error(await f.request('guest',undefined,path,'GET'),404,'CONTENT_NOT_FOUND');
  await grant(entry.pageId,'viewer');await grant(first.pageId,'editor');
  const visible=await(await f.request('guest',undefined,path,'GET')).json();assert.equal(visible.collection.records.length,1);assert.equal(visible.collection.records[0].id,first.recordId);
  assert.doesNotMatch(JSON.stringify(visible),new RegExp(second.recordId+'|'+second.pageId+'|日本語|literal formula'));
  linked=await(await f.request('guest',undefined,'/pages/'+doc.page.id,'GET')).json();
  assert.equal(linked.document.blocks[0].data.links[0].pageId,entry.pageId);assert.equal(linked.document.blocks[0].data.links[1].pageId,first.pageId);
  assert.equal(linked.document.blocks[0].data.links[0].fragment,'overview');
  const column=entry.collection.properties[0].id;
  const changed=await f.request('guest',{expectedRevision:rev,values:{[column]:'Guest edit'}},path+'/records/'+first.recordId,'PATCH');assert.equal(changed.status,200);rev=(await changed.json()).revision;
  const before=f.writes;
  await error(await f.request('guest',{expectedRevision:rev,values:{[column]:'Hidden edit'}},path+'/records/'+second.recordId,'PATCH'),404,'CONTENT_NOT_FOUND');
  assert.equal(f.writes,before);
});

test('collection updates enforce typed values, immutable source cells and live actor guards',async t=>{
  const f=fixture(t);const {entry,path}=await importedCollection(f);const column=entry.collection.properties[0].id;const row=entry.recordPages[0];
  for(const values of [{}, {[column]:false}, {unknown:'injected'}]) await error(await f.request('member',{expectedRevision:1,values},path+'/records/'+row.recordId,'PATCH'),400,'INVALID_CONTENT');
  const saved=await f.raw.read(workspaceId,'member');
  saved.payload.collections[0].sourceProperties=structuredClone(saved.payload.collections[0].collection.properties);
  saved.payload.collections[0].collection.properties[0].type='number';
  for(const record of saved.payload.collections[0].collection.records) record.values[column]=1;
  await f.raw.write(workspaceId,'member',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});
  await error(await f.request('member',{expectedRevision:2,values:{[column]:'2'}},path+'/records/'+row.recordId,'PATCH'),400,'INVALID_CONTENT');
  const changed=await f.request('member',{expectedRevision:2,values:{[column]:2}},path+'/records/'+row.recordId,'PATCH');assert.equal(changed.status,200);
  assert.equal((await changed.json()).record.sourceValues[column],'001');
  f.setBeforeWrite(()=>f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-member'));
  await error(await f.request('member',{expectedRevision:3,values:{[column]:3}},path+'/records/'+row.recordId,'PATCH'),404,'CONTENT_NOT_FOUND');
  assert.equal(f.db.prepare('SELECT revision FROM yumunio_account_content').get().revision,3);
});

test('persisted native collection bindings and original cells are validated without changing the old aggregate shape',async t=>{
  const f=fixture(t);const {saved}=await importedCollection(f);
  for(const corrupt of [
    value=>{value.collections[0].recordPages[0].pageId=value.collections[0].pageId;},
    value=>{value.collections[0].recordPages[0].sourceValues={};},
    value=>{value.collections[0].collection.records[0].values.unknown='bad';},
    value=>{value.collections[0].sourceHeaders=[];},
    value=>{value.collections.push(structuredClone(value.collections[0]));},
  ]) {const value=structuredClone(saved.payload);corrupt(value);assert.throws(()=>validateContentPayload(value,workspaceId));}
  assert.deepEqual(validateContentPayload({schemaVersion:1,pages:[],grants:[],grantBindings:[]},workspaceId),{schemaVersion:1,pages:[],grants:[],grantBindings:[]});
});


test('import-only capacity admits a reversed 500-page chain in one CAS while generic request and stream limits remain bounded',async t=>{
  const f=fixture(t),pages=Array.from({length:500},(_,index)=>({sourceId:'chain-'+index,parentSourceId:index===0?null:'chain-'+(index-1),title:'Page '+index,blocks:[]})).reverse();
  const response=await f.request('member',bundle({pages}));assert.equal(response.status,201);const result=await response.json();assert.equal(result.pageCount,500);assert.equal(result.revision,1);assert.equal(f.writes,1);
  const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.payload.pages.length,500);validateContentPayload(saved.payload,workspaceId);
  const retry=await f.request('member',bundle({pages}));assert.equal(retry.status,200);assert.equal((await retry.json()).replayed,true);assert.equal(f.writes,1);
  await error(await f.request('member',{expectedRevision:1,title:'Ordinary page',blocks:[{id:'large-ordinary',type:'paragraph',data:{text:'x'.repeat(256000)}}]},'/pages'),413,'CONTENT_TOO_LARGE');
  assert.equal(f.writes,1);
});

test('import byte capacity checks declared lengths and bounded streams before any CAS',async t=>{
  const f=fixture(t);
  await error(await f.request('member',bundle(),'/imports','POST',{'Content-Length':'768001'}),413,'CONTENT_TOO_LARGE');
  let part=0;
  const stream=new ReadableStream({pull(controller){if(part++===0)controller.enqueue(new TextEncoder().encode(' '.repeat(768000)));else controller.enqueue(new TextEncoder().encode('{}'));}});
  const request=new Request(origin+'/api/content/workspaces/'+workspaceId+'/imports',{method:'POST',duplex:'half',body:stream,headers:{Origin:origin,'Content-Type':'application/json','x-fixture-account':'member','X-Yumunio-Expected-Account':'member'}});
  await error(await f.api(request),413,'CONTENT_TOO_LARGE');assert.equal(f.writes,0);assert.equal((await f.raw.read(workspaceId,'member')).revision,0);
});
