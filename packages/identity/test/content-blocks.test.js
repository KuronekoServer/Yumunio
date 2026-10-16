import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSqliteContentStore } from '../src/content-store.js';
import { createAccountContentApi } from '../src/content.js';
import { moveDocumentBlock } from '../src/content-blocks.js';
const schema = await readFile(new URL('../../../apps/worker/auth-schema.sql', import.meta.url), 'utf8');
const origin = 'https://blocks.example.invalid', workspaceId = 'workspace-blocks', stamp = '2026-10-15T00:00:00.000Z';
async function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec(schema); t.after(() => db.close());
  db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run('actor','Actor','actor@example.invalid',stamp,stamp);
  db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(workspaceId,'Blocks','blocks',stamp);
  db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership',workspaceId,'actor','member',stamp);
  const blocks = [{ id: 'block-one', type: 'paragraph', data: { text: 'Keep stable IDs' }, children: [{ id: 'nested', type: 'quote', data: { text: 'Nested' } }] }, { id: 'block-two', type: 'paragraph', data: { text: 'Second' } }];
  const page = (id, list) => ({ page: { id,workspaceId,title:id,parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null },document:{ pageId:id,workspaceId,version:1,blocks:list,updatedAt:stamp },inheritPermissions:false });
  const payload = { schemaVersion:1,pages:[page('source',blocks),page('target',[]),page('hidden',[])],grants:['source','target'].map(id => ({id:'grant-'+id,workspaceId,pageId:id,accountId:'actor',permission:'full',includeDescendants:false,status:'active'})),grantBindings:['source','target'].map(id => ({grantId:'grant-'+id,membershipId:'membership'})) };
  const raw = createSqliteContentStore(db); await raw.write(workspaceId,'actor',{expectedRevision:0,payload,actorMembershipId:'membership',actorRole:'member'});
  let beforeWrite, reads = 0;
  const api = createAccountContentApi({ origin,resolveSession:async () => ({user:{id:'actor',emailVerified:true}}),now:()=>stamp,
    store:{ async read(...args) { reads++; return raw.read(...args); },async write(...args) { await beforeWrite?.();return raw.write(...args); } } });
  const move = (patch = {}, headers = {}) => api(new Request(origin+'/api/content/workspaces/'+workspaceId+'/pages/source/blocks/move',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Yumunio-Expected-Account':'actor',...headers},body:JSON.stringify({expectedRevision:1,expectedVersion:1,targetPageId:'target',targetExpectedVersion:1,blockId:'block-one',parentBlockId:null,index:0,...patch})}));
  return {db,raw,move,setBeforeWrite:fn=>beforeWrite=fn,get reads(){return reads;}};
}
async function configure(f,change){const saved=await f.raw.read(workspaceId,'actor');change(saved.payload);f.db.prepare('UPDATE yumunio_account_content SET payload_json=? WHERE workspace_id=?').run(JSON.stringify(saved.payload),workspaceId);}
const forestMove=(f,blockIds,extra={})=>f.move({blockId:undefined,blockIds,...extra});
test('cross-page block move commits both versions in one CAS and preserves nested IDs and source content', async t => {
  const f = await fixture(t), response = await f.move(); assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{revision:2,blockId:'block-one',sourcePageId:'source',targetPageId:'target',sourceVersion:2,targetVersion:2});
  const saved = await f.raw.read(workspaceId,'actor'), [source,target] = saved.payload.pages;
  assert.deepEqual(source.document.blocks.map(row=>row.id),['block-two']); assert.equal(target.document.blocks[0].children[0].id,'nested'); assert.equal(target.document.blocks[0].data.text,'Keep stable IDs');
  assert.equal((await f.move()).status,409); assert.equal((await f.raw.read(workspaceId,'actor')).revision,2);
});
test('block move checks expected account before storage and does not disclose private targets or overwrite stale pages', async t => {
  const f = await fixture(t);
  assert.equal((await f.move({}, {'X-Yumunio-Expected-Account':'other'})).status,404); assert.equal(f.reads,0);
  assert.equal((await f.move({targetPageId:'hidden'})).status,404);
  assert.equal((await f.move({targetExpectedVersion:0})).status,409);
  assert.equal((await f.move({index:99})).status,400);
  assert.equal((await f.raw.read(workspaceId,'actor')).revision,1);
});
test('same-page nesting rejects cycles and updates a document once', async t => {
  const f = await fixture(t);
  assert.equal((await f.move({targetPageId:'source',parentBlockId:'nested'})).status,400);
  const response = await f.move({targetPageId:'source',blockId:'block-two',parentBlockId:'block-one',index:1}); assert.equal(response.status,200);
  const result = await response.json(); assert.equal(result.sourceVersion,2); assert.equal(result.targetVersion,2);
  const saved = await f.raw.read(workspaceId,'actor'); assert.equal(saved.payload.pages[0].document.blocks[0].children[1].id,'block-two');
});
test('revocation between block-move read and CAS leaves both pages intact and returns no new revision', async t => {
  const f = await fixture(t); f.setBeforeWrite(async () => {
    const saved=await f.raw.read(workspaceId,'actor'); saved.payload.grants.find(row=>row.pageId==='target').status='revoked';
    await f.raw.write(workspaceId,'actor',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership',actorRole:'member'});
  });
  const response = await f.move(); assert.equal(response.status,404); assert.equal(Object.hasOwn(await response.json(),'revision'),false);
  const saved = await f.raw.read(workspaceId,'actor'); assert.equal(saved.payload.pages[0].document.blocks.length,2); assert.equal(saved.payload.pages[1].document.blocks.length,0); assert.equal(saved.revision,2);
});
test('moving colliding block IDs fails before any saved change', async t => {
  const f=await fixture(t), saved=await f.raw.read(workspaceId,'actor');
  saved.payload.pages[1].document.blocks=[{id:'nested',type:'paragraph',data:{text:'Existing'}}];
  await f.raw.write(workspaceId,'actor',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership',actorRole:'member'});
  const response=await f.move({expectedRevision:2}); assert.equal(response.status,409); assert.equal((await response.json()).error.code,'BLOCK_ID_CONFLICT');
  assert.equal((await f.raw.read(workspaceId,'actor')).revision,2);
});

test('cross-page movement refuses page-bound attachment references without touching either document', () => {
  const source={blocks:[{id:'file-link',type:'paragraph',data:{text:'file',links:[{attachmentId:'page-bound-file'}]}}]},target={blocks:[]};
  assert.throws(()=>moveDocumentBlock(source,target,{blockId:'file-link',parentBlockId:null,index:0}),error=>error.code==='BLOCK_ATTACHMENTS_UNSUPPORTED'&&error.status===409);
  assert.equal(source.blocks.length,1);assert.equal(target.blocks.length,0);
});
test('the blockIds union moves an intact normalized forest and canonical columns in one CAS with exact metadata',async t=>{
 const f=await fixture(t);await configure(f,payload=>{payload.pages[0].document.blocks=[{id:'first',type:'paragraph',data:{text:'Actor source date',marks:[{start:0,end:5,styles:['bold']}],links:[{start:6,end:12,label:'source',pageId:'source'}],mentions:[{kind:'person',start:0,end:5,accountId:'actor',membershipId:'membership'},{kind:'page',start:6,end:12,pageId:'source'},{kind:'date',start:13,end:17,date:'2026-10-17'}],future:{retained:true}},children:[{id:'child',type:'quote',data:{text:'Nested'}}]},{id:'layout',type:'columns',children:[{id:'left',type:'column',children:[{id:'inside',type:'paragraph',data:{text:'Column'}}]},{id:'right',type:'column',children:[]}]},{id:'tail',type:'paragraph',data:{text:'Tail'}},{id:'keep',type:'paragraph',data:{text:'Keep'}}];payload.pages[1].document.blocks=[{id:'parent',type:'quote',data:{text:'Parent'},children:[]}];});
 const before=await f.raw.read(workspaceId,'actor'),response=await forestMove(f,['tail','child','inside','layout','first','first'],{parentBlockId:'parent',index:0});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),{revision:2,blockIds:['first','layout','tail'],sourcePageId:'source',targetPageId:'target',sourceVersion:2,targetVersion:2});
 const after=await f.raw.read(workspaceId,'actor');assert.deepEqual(after.payload.pages[0].document.blocks,[before.payload.pages[0].document.blocks[3]]);assert.deepEqual(after.payload.pages[1].document.blocks[0].children,before.payload.pages[0].document.blocks.slice(0,3));assert.equal(after.payload.history.length,2);assert.deepEqual(after.payload.pages.map(item=>item.document.version),[2,2,1]);
 assert.equal((await forestMove(f,['first','layout'])).status,409);assert.equal((await f.raw.read(workspaceId,'actor')).revision,2);
});
test('mixed invalid selections and exclusive union validation never change a single selected block or version',async t=>{
 const f=await fixture(t),before=await f.raw.read(workspaceId,'actor');for(const patch of [{blockIds:['block-two']},{blockId:undefined,blockIds:[]},{blockId:undefined,blockIds:['block-one','missing']},{blockId:undefined,blockIds:['block-one',null]}]){const response=await f.move(patch);assert.ok([400,404].includes(response.status));assert.deepEqual(await f.raw.read(workspaceId,'actor'),before);}
});
test('moving the last selected child preserves empty source and target column wrappers',async t=>{
 const f=await fixture(t);await configure(f,payload=>{for(const[index,id]of[['0','source-layout'],['1','target-layout']])payload.pages[index].document.blocks=[{id,type:'columns',children:[{id:id+'-left',type:'column',children:index==='0'?[{id:'last',type:'paragraph',data:{text:'Last'}}]:[]},{id:id+'-right',type:'column',children:[]}]}];});
 const response=await forestMove(f,['last'],{parentBlockId:'target-layout-right'});assert.equal(response.status,200,await response.clone().text());const saved=await f.raw.read(workspaceId,'actor');assert.deepEqual(saved.payload.pages[0].document.blocks[0].children.map(item=>item.children),[[],[]]);assert.equal(saved.payload.pages[1].document.blocks[0].children[1].children[0].id,'last');
});
async function withMentionedPerson(t,{targetReadable=true,membershipId='mentioned-generation',pageReference='source'}={}){
 const f=await fixture(t);f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run('mentioned','Mentioned','mentioned@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('mentioned-generation',workspaceId,'mentioned','member',stamp);
 await configure(f,payload=>{payload.pages[0].document.blocks[0].data={text:'Mention source',mentions:[{kind:'person',start:0,end:7,accountId:'mentioned',membershipId},{kind:'page',start:8,end:14,pageId:pageReference}]};for(const pageId of targetReadable?['source','target']:['source']){const grantId='mentioned-'+pageId;payload.grants.push({id:grantId,workspaceId,pageId,accountId:'mentioned',permission:'viewer',includeDescendants:false,status:'active'});payload.grantBindings.push({grantId,membershipId:'mentioned-generation'});}});return f;
}
test('every person generation and referenced page is reauthorized in the destination context before any selected block moves',async t=>{
 for(const options of [{targetReadable:false},{membershipId:'retired-generation'},{pageReference:'hidden'}]){const f=await withMentionedPerson(t,options),before=await f.raw.read(workspaceId,'actor'),response=await forestMove(f,['block-two','block-one']);assert.equal(response.status,404,await response.clone().text());assert.deepEqual(await f.raw.read(workspaceId,'actor'),before);}
 const f=await withMentionedPerson(t);assert.equal((await forestMove(f,['block-two','block-one'])).status,200);
});
test('a mentioned principal replaced between preparation and SQL CAS rolls back the complete forest without a revision acknowledgement',async t=>{
 const f=await withMentionedPerson(t),before=await f.raw.read(workspaceId,'actor');f.setBeforeWrite(()=>{f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-generation','mentioned');});const response=await forestMove(f,['block-one','block-two']);assert.equal(response.status,409);assert.equal(Object.hasOwn(await response.json(),'revision'),false);const saved=await f.raw.read(workspaceId,'actor');assert.equal(saved.revision,before.revision);assert.deepEqual(saved.payload,before.payload);
});
test('a later readonly or attachment-bearing subtree cannot leave earlier selected content partially moved',async t=>{
 for(const data of [{text:'private',purpose:'import-source'},{text:'file',links:[{start:0,end:4,label:'file',pageId:'source',attachmentId:'attachment'}]}]){const f=await fixture(t);await configure(f,payload=>{payload.pages[0].document.blocks[1].data=data;if(data.purpose)payload.pages[0].document.blocks[1].type='code';});const before=await f.raw.read(workspaceId,'actor'),response=await forestMove(f,['block-one','block-two']);assert.equal(response.status,409,await response.clone().text());assert.deepEqual(await f.raw.read(workspaceId,'actor'),before);}
});
test('revoking either page during a forest move leaves every source and target block, version and history untouched',async t=>{
 for(const pageId of ['source','target']){const f=await fixture(t),before=await f.raw.read(workspaceId,'actor');f.setBeforeWrite(async()=>{const current=await f.raw.read(workspaceId,'actor');current.payload.grants.find(row=>row.pageId===pageId).status='revoked';await f.raw.write(workspaceId,'actor',{expectedRevision:1,payload:current.payload,actorMembershipId:'membership',actorRole:'member'});});const response=await forestMove(f,['block-two','block-one']);assert.equal(response.status,404);assert.equal(Object.hasOwn(await response.json(),'revision'),false);const after=await f.raw.read(workspaceId,'actor');assert.equal(after.revision,2);assert.deepEqual(after.payload.pages,before.payload.pages);assert.equal(after.payload.history,undefined);}
});
test('a forest cannot make the final destination exceed the normal whole-document person guard limit',async t=>{
 const f=await fixture(t);for(let index=0;index<17;index++){const id='person-'+index;f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,'member',stamp);}
 await configure(f,payload=>{for(let index=0;index<17;index++){const id='person-'+index;for(const pageId of ['source','target']){const grantId=id+'-'+pageId;payload.grants.push({id:grantId,workspaceId,pageId,accountId:id,permission:'viewer',includeDescendants:false,status:'active'});payload.grantBindings.push({grantId,membershipId:'membership-'+id});}}const personBlock=index=>({id:'mention-'+index,type:'paragraph',data:{text:'Peer',mentions:[{kind:'person',start:0,end:4,accountId:'person-'+index,membershipId:'membership-person-'+index}]}});payload.pages[1].document.blocks=Array.from({length:16},(_,index)=>personBlock(index));payload.pages[0].document.blocks.push(personBlock(16));});
 const before=await f.raw.read(workspaceId,'actor'),response=await forestMove(f,['block-one','mention-16'],{index:16});assert.equal(response.status,413,await response.clone().text());assert.equal((await response.json()).error.code,'CONTENT_TOO_LARGE');assert.deepEqual(await f.raw.read(workspaceId,'actor'),before);
});
