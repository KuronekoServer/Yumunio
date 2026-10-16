import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSqliteContentStore } from '../src/content-store.js';
import { createAccountContentApi, validateContentPayload } from '../src/content.js';
import {handleDiscussion} from '../src/content-comments.js';
const schema = await readFile(new URL('../../../apps/worker/auth-schema.sql', import.meta.url), 'utf8');
const stamp = '2026-10-15T00:00:00.000Z', origin = 'https://comments.example.invalid', workspaceId = 'workspace';
async function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec(schema); t.after(() => db.close());
  db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(workspaceId, 'Comments', 'comments', stamp);
  const permissions = [['author','member','full'],['commenter','guest','commenter'],['viewer','guest','viewer'],['hidden','member',null]];
  for (const [id, role] of permissions) {
    db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);
    db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,role,stamp);
  }
  const page = { page: { id:'page',workspaceId,title:'Notes',parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null }, document: { pageId:'page',workspaceId,version:1,updatedAt:stamp,blocks:[{id:'block',type:'paragraph',data:{text:'Text'}},{id:'source',type:'code',data:{text:'Original',purpose:'import-source'}}] },inheritPermissions:false };
  const payload = { schemaVersion:1,pages:[page],grants:[],grantBindings:[] };
  for (const [id,,permission] of permissions) if (permission) { const grantId='grant-'+id;payload.grants.push({id:grantId,workspaceId,pageId:'page',accountId:id,permission,includeDescendants:false,status:'active'});payload.grantBindings.push({grantId,membershipId:'membership-'+id}); }
  const raw = createSqliteContentStore(db); await raw.write(workspaceId,'author',{expectedRevision:0,payload,actorMembershipId:'membership-author',actorRole:'member'});
  let next = 0, reads = 0, beforeWrite;
  const api = createAccountContentApi({ origin,now:()=>stamp,createId:()=> 'comment-generated-'+ ++next,
    resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}}),
    store:{read(...args){reads++;return raw.read(...args);},async write(...args){if(beforeWrite){const fn=beforeWrite;beforeWrite=null;await fn();}return raw.write(...args);}} });
  const request = (accountId, suffix='/pages/page/comments', method='GET', body, extra={}) => api(new Request(origin+'/api/content/workspaces/'+workspaceId+suffix,{method,headers:{'x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId,...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const read = ()=>raw.read(workspaceId,'author');
  const change = async fn=>{const row=await read();fn(row.payload);db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(row.payload),workspaceId);};
  return {db,request,read,change,setBeforeWrite:fn=>beforeWrite=fn,get reads(){return reads;},async create(accountId='author',extra={}) { const response=await request(accountId,'/pages/page/comments','POST',{expectedRevision:(await read()).revision,blockId:'block',text:'Hello @Viewer',mentions:[{accountId:'viewer',start:6,end:13}],...extra});assert.equal(response.status,200,await response.clone().text());return response.json(); }};
}
const path = id=>'/pages/page/comments/'+id;
async function error(response,status,code) { assert.equal(response.status,status,await response.clone().text());const value=await response.json();assert.equal(value.error.code,code);assert.deepEqual(Object.keys(value),['error']); }
test('a commenter may start and reply while mentions create only a private authorized inbox item and grant no edit access',async t=>{
  const f=await fixture(t),created=await f.create('commenter'),thread=created.thread;
  assert.equal(created.revision,2);assert.equal(thread.blockId,'block');assert.equal(thread.messages[0].text,'Hello @Viewer');
  const inbox=await(await f.request('viewer','/notifications')).json();assert.equal(inbox.notifications.length,1);assert.equal(inbox.notifications[0].text,'Hello @Viewer');
  assert.equal((await(await f.request('author','/notifications')).json()).notifications.length,0);
  await error(await f.request('viewer',path(thread.id),'POST',{expectedRevision:2,text:'Viewer cannot reply',mentions:[]}),404,'CONTENT_NOT_FOUND');
  const reply=await f.request('commenter',path(thread.id),'POST',{expectedRevision:2,text:'A plain reply',mentions:[]});assert.equal(reply.status,200);
  const current=await f.read();assert.equal(current.payload.pages[0].document.version,1);assert.equal(current.payload.grants.length,3);
  const mark=await f.request('viewer','/notifications','POST',{expectedRevision:3,notificationIds:[inbox.notifications[0].id]});assert.equal(mark.status,200);
  assert.equal((await(await f.request('viewer','/notifications')).json()).notifications[0].readAt,stamp);
});
test('mention admission rejects hidden recipients, invalid ranges, source anchors and unexpected actors without any partial writes',async t=>{
  const f=await fixture(t);
  for(const patch of [
    {mentions:[{accountId:'hidden',start:6,end:13}]}, {mentions:[{accountId:'viewer',start:0,end:5}]},
    {mentions:[{accountId:'viewer',start:6,end:99}]}, {mentions:[{accountId:'viewer',start:6,end:13,membershipId:'forged'}]},
    {blockId:'source'}, {blockId:'missing'}, {text:'  ',mentions:[]},
  ]) { const response=await f.request('author','/pages/page/comments','POST',{expectedRevision:1,blockId:'block',text:'Hello @Viewer',mentions:[{accountId:'viewer',start:6,end:13}],...patch});assert.ok([400,404].includes(response.status),await response.clone().text()); }
  assert.equal((await f.read()).revision,1);assert.equal((await f.read()).payload.discussion,undefined);
  const reads=f.reads;await error(await f.request('author','/pages/page/comments','GET',undefined,{'X-Yumunio-Expected-Account':'viewer'}),404,'CONTENT_NOT_FOUND');assert.equal(f.reads,reads);
});
test('message edit and tombstone preserve replies, do not repeat unchanged mentions, and managers alone may moderate another author',async t=>{
  const f=await fixture(t),{thread}=await f.create('commenter'),id=thread.messages[0].id;
  const initial=(await(await f.request('viewer','/notifications')).json()).notifications[0].id;
  await f.request('viewer','/notifications','POST',{expectedRevision:2,notificationIds:[initial]});
  const edited=await f.request('commenter',path(thread.id)+'/messages/'+id,'PATCH',{expectedRevision:3,text:'Hello @Viewer!',mentions:[{accountId:'viewer',start:6,end:13}]});assert.equal(edited.status,200);
  const after=(await(await f.request('viewer','/notifications')).json()).notifications;assert.equal(after.length,1);assert.equal(after[0].id,initial);assert.equal(after[0].readAt,stamp);
  await f.request('author',path(thread.id),'POST',{expectedRevision:4,text:'Manager reply',mentions:[]});
  const deleted=await f.request('author',path(thread.id)+'/messages/'+id,'DELETE',{expectedRevision:5});assert.equal(deleted.status,200);
  const projected=(await deleted.json()).thread;assert.equal(projected.messages.length,2);assert.equal(projected.messages[0].text,'');assert.equal(projected.messages[0].deletedAt,stamp);assert.equal(projected.messages[1].text,'Manager reply');
  assert.equal((await(await f.request('viewer','/notifications')).json()).notifications.length,0);
});
test('resolve closes replies and reopen is restricted to the current author generation or manager',async t=>{
  const f=await fixture(t),{thread}=await f.create('commenter');
  await error(await f.request('viewer',path(thread.id)+'/resolve','PATCH',{expectedRevision:0,resolved:true}),404,'CONTENT_NOT_FOUND');
  assert.equal((await f.request('commenter',path(thread.id)+'/resolve','PATCH',{expectedRevision:2,resolved:true})).status,200);
  await error(await f.request('author',path(thread.id),'POST',{expectedRevision:3,text:'Closed',mentions:[]}),409,'COMMENT_THREAD_RESOLVED');
  assert.equal((await f.request('author',path(thread.id)+'/resolve','PATCH',{expectedRevision:3,resolved:false})).status,200);
  assert.equal((await f.request('commenter',path(thread.id),'POST',{expectedRevision:4,text:'Reopened',mentions:[]})).status,200);
});
test('revoked recipient or actor between admission and SQL CAS cancels both message and inbox atomically',async t=>{
  for (const who of ['viewer','author']) { const f=await fixture(t);f.setBeforeWrite(()=>f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-'+who));
    await error(await f.request('author','/pages/page/comments','POST',{expectedRevision:1,blockId:null,text:'Hi @Viewer',mentions:[{accountId:'viewer',start:3,end:10}]}),404,'CONTENT_NOT_FOUND');
    assert.equal(f.db.prepare('SELECT revision FROM yumunio_account_content').get().revision,1);assert.equal(JSON.parse(f.db.prepare('SELECT payload_json FROM yumunio_account_content').get().payload_json).discussion,undefined);
  }
});
test('lost page access and replacement memberships hide notifications; missing anchors do not expose moved block IDs',async t=>{
  const f=await fixture(t),{thread}=await f.create();
  await f.change(payload=>{payload.pages[0].document.blocks=[];payload.grants.find(item=>item.accountId==='viewer').status='revoked';});
  assert.equal((await(await f.request('viewer','/notifications')).json()).notifications.length,0);
  const projected=(await(await f.request('author')).json()).threads[0];assert.equal(projected.anchorMissing,true);assert.equal(projected.blockId,null);assert.equal(projected.messages[0].mentions.length,0);
  f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('replacement-viewer','membership-viewer');
  assert.equal((await(await f.request('viewer','/notifications')).json()).notifications.length,0);
  assert.equal(thread.messages[0].mentions.length,1);
});
test('authorized competing writes return a conflict and malformed persisted discussion fails closed',async t=>{
  const f=await fixture(t);f.setBeforeWrite(()=>f.change(payload=>{payload.pages[0].page.title='Concurrent';}));
  await error(await f.request('author','/pages/page/comments','POST',{expectedRevision:1,blockId:null,text:'Not committed',mentions:[]}),409,'CONTENT_CONFLICT');
  assert.equal((await f.read()).payload.discussion,undefined);
  const created=await f.create();const saved=await f.read();saved.payload.discussion.notifications[0].recipientMembershipId='forged';
  assert.throws(()=>validateContentPayload(saved.payload,workspaceId));
  assert.equal(created.thread.messages.length,1);
});

test('moderation preserves authorship: managers may delete or resolve but cannot edit another authors text',async t=>{
  const f=await fixture(t),{thread}=await f.create('commenter'),id=thread.messages[0].id;
  const projected=(await(await f.request('author')).json()).threads[0].messages[0];assert.equal(projected.canEdit,false);assert.equal(projected.canDelete,true);
  await error(await f.request('author',path(thread.id)+'/messages/'+id,'PATCH',{expectedRevision:2,text:'Forged attribution',mentions:[]}),404,'CONTENT_NOT_FOUND');assert.equal((await f.read()).revision,2);assert.equal((await f.read()).payload.discussion.threads[0].messages[0].text,'Hello @Viewer');
  assert.equal((await f.request('commenter',path(thread.id)+'/messages/'+id,'PATCH',{expectedRevision:2,text:'Own edit',mentions:[]})).status,200);
  assert.equal((await f.request('author',path(thread.id)+'/messages/'+id,'DELETE',{expectedRevision:3})).status,200);
});

test('source subtrees cannot be comment anchors and removed author generations cannot edit old messages',async t=>{
  const f=await fixture(t);await f.change(payload=>{payload.pages[0].document.blocks[1].children=[{id:'source-child',type:'paragraph',data:{text:'Raw source child'}}];});
  await error(await f.request('author','/pages/page/comments','POST',{expectedRevision:2,blockId:'source-child',text:'Cannot anchor raw source',mentions:[]}),404,'CONTENT_NOT_FOUND');assert.equal((await f.read()).revision,2);
  const {thread}=await f.create('commenter');f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('new-generation-commenter','membership-commenter');
  await f.change(payload=>{payload.grantBindings.find(item=>item.grantId==='grant-commenter').membershipId='new-generation-commenter';});
  const shown=(await(await f.request('commenter')).json()).threads[0];assert.equal(shown.messages[0].canEdit,false);assert.equal(shown.canResolve,false);
  await error(await f.request('commenter',path(thread.id)+'/messages/'+thread.messages[0].id,'PATCH',{expectedRevision:4,text:'Old author generation',mentions:[]}),404,'CONTENT_NOT_FOUND');
});

test('safe people expose names and IDs only for current verified principals with access to this page',async t=>{
  const f=await fixture(t),response=await f.request('viewer','/pages/page/people');assert.equal(response.status,200);const dto=await response.json();assert.deepEqual(dto.people.map(person=>person.accountId).sort(),['author','commenter','viewer']);for(const person of dto.people){assert.deepEqual(Object.keys(person).sort(),['accountId','name']);assert.equal(typeof person.name,'string');}assert.doesNotMatch(JSON.stringify(dto),/@example|email|membership-/);
  await error(await f.request('hidden','/pages/page/people'),404,'CONTENT_NOT_FOUND');f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('commenter');assert.deepEqual((await(await f.request('viewer','/pages/page/people')).json()).people.map(person=>person.accountId).sort(),['author','viewer']);
});
test('people policy capture is shared only within one request and a fresh request observes revocation',async t=>{
  const f=await fixture(t),saved=await f.read();let captures=0;
  const policy=(payload,principals,workspaceId)=>{captures++;return{accounts:principals.map(row=>({id:row.accountId,email:row.email,emailVerified:row.emailVerified,status:'active',serverRole:'user'})),workspaces:[{id:workspaceId,status:'active'}],memberships:principals.map(row=>({id:row.id,workspaceId,accountId:row.accountId,role:row.role,status:'active'})),pages:payload.pages.map(({page,inheritPermissions})=>({id:page.id,workspaceId,parentId:page.parentId,trashedAt:page.trashedAt,inheritPermissions})),grants:payload.grants,invitations:[]};};
  const context={request:new Request(origin+'/people'),action:'people',pageId:'page',payload:saved.payload,saved,accountId:'author',actor:saved.principals.find(item=>item.accountId==='author'),workspaceId,access:()=>['read'],policy};
  const first=await(await handleDiscussion(context)).json();assert.equal(first.people.length,3);assert.equal(captures,1);
  const payload=structuredClone(saved.payload);payload.grants.find(item=>item.accountId==='viewer').status='revoked';const second=await(await handleDiscussion({...context,payload})).json();assert.equal(second.people.length,2);assert.equal(captures,2);
});
const inbox=async(f,accountId)=>(await(await f.request(accountId,'/notifications')).json()).notifications;
const accepted=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
test('plain replies notify current prior authors once, exclude the sender and preserve independent explicit mentions',async t=>{
 const f=await fixture(t),{thread}=await f.create('commenter'),reply=await accepted(await f.request('author',path(thread.id),'POST',{expectedRevision:2,text:'A reply without an at-sign',mentions:[]}));
 const replies=await inbox(f,'commenter');assert.equal(replies.length,1);assert.equal(replies[0].reason,'reply');assert.equal(replies[0].messageId,reply.thread.messages[1].id);assert.equal((await inbox(f,'author')).length,0);assert.equal((await inbox(f,'viewer'))[0].reason,'mention');const saved=await f.read();assert.equal(saved.payload.pages[0].document.version,1);assert.equal(saved.payload.grants.length,3);
});
test('overlapping mentions and replies deduplicate, preserve read state through edits and never notify later participants retroactively',async t=>{
 const f=await fixture(t),{thread}=await f.create('commenter'),reply=await accepted(await f.request('author',path(thread.id),'POST',{expectedRevision:2,text:'Hi @Commenter',mentions:[{accountId:'commenter',start:3,end:13}]})),message=reply.thread.messages[1],first=(await inbox(f,'commenter'))[0];assert.equal(first.reason,'reply');assert.equal((await inbox(f,'commenter')).length,1);
 await accepted(await f.request('commenter','/notifications','POST',{expectedRevision:3,notificationIds:[first.id]}));await accepted(await f.request('author',path(thread.id)+'/messages/'+message.id,'PATCH',{expectedRevision:4,text:'Edited without the mention',mentions:[]}));assert.deepEqual((await inbox(f,'commenter')).map(item=>[item.id,item.reason,item.readAt]),[[first.id,'reply',stamp]]);
 await f.change(payload=>{payload.grants.find(grant=>grant.accountId==='viewer').permission='commenter';});await accepted(await f.request('viewer',path(thread.id),'POST',{expectedRevision:6,text:'A later participant',mentions:[]}));await accepted(await f.request('author',path(thread.id)+'/messages/'+message.id,'PATCH',{expectedRevision:7,text:'Another edit',mentions:[]}));assert.equal((await inbox(f,'viewer')).some(item=>item.messageId===message.id),false);assert.equal((await inbox(f,'commenter')).find(item=>item.id===first.id).readAt,stamp);
 const saved=await f.read(),keys=saved.payload.discussion.notifications.map(item=>item.messageId+'/'+item.recipientId);assert.equal(new Set(keys).size,keys.length);assert.ok(saved.payload.discussion.notifications.every(item=>saved.payload.discussion.threads[0].messages.find(message=>message.id===item.messageId).authorId!==item.recipientId));
});
test('tombstoned prior authors remain subscribed while deleting the notified reply removes all its notifications',async t=>{
 const f=await fixture(t),{thread}=await f.create('commenter',{text:'Original',mentions:[]});await accepted(await f.request('author',path(thread.id)+'/messages/'+thread.messages[0].id,'DELETE',{expectedRevision:2}));const reply=await accepted(await f.request('author',path(thread.id),'POST',{expectedRevision:3,text:'Reply to the existing discussion',mentions:[]}));assert.equal((await inbox(f,'commenter'))[0].reason,'reply');await accepted(await f.request('author',path(thread.id)+'/messages/'+reply.thread.messages[1].id,'DELETE',{expectedRevision:4}));assert.deepEqual(await inbox(f,'commenter'),[]);
});
test('replacement generations, lost read access and unverified prior authors do not receive new reply notifications',async t=>{
 for(const reason of ['generation','access','verification']){const f=await fixture(t),{thread}=await f.create('commenter',{text:'Original',mentions:[]});if(reason==='generation')f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('new-commenter-generation','commenter');if(reason==='verification')f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('commenter');if(reason==='access')await f.change(payload=>{payload.grants.find(item=>item.accountId==='commenter').status='revoked';});const current=await f.read();await accepted(await f.request('author',path(thread.id),'POST',{expectedRevision:current.revision,text:'No stale subscription',mentions:[]}));assert.equal((await f.read()).payload.discussion.notifications.length,0,reason);}
 const f=await fixture(t),{thread}=await f.create('commenter',{text:'Original',mentions:[]});await accepted(await f.request('author',path(thread.id),'POST',{expectedRevision:2,text:'Visible until revoked',mentions:[]}));assert.equal((await inbox(f,'commenter')).length,1);await f.change(payload=>{payload.grants.find(item=>item.accountId==='commenter').status='revoked';});assert.deepEqual(await inbox(f,'commenter'),[]);
});
test('reply recipients are guarded in the same SQL CAS so revocation never commits the reply or a partial inbox',async t=>{
 for(const reason of ['generation','verification','role']){const f=await fixture(t),{thread}=await f.create('commenter',{text:'Original',mentions:[]}),before=await f.read();f.setBeforeWrite(()=>{if(reason==='generation')f.db.prepare('DELETE FROM yumunio_memberships WHERE userId=?').run('commenter');if(reason==='verification')f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('commenter');if(reason==='role')f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('member','commenter');});await error(await f.request('author',path(thread.id),'POST',{expectedRevision:2,text:'Atomic reply',mentions:[]}),404,'CONTENT_NOT_FOUND');const saved=await f.read();assert.equal(saved.revision,before.revision);assert.deepEqual(saved.payload,before.payload);}
});
test('all eligible recipients must fit the atomic guard limit instead of silently dropping earlier participants',async t=>{
 const f=await fixture(t),{thread}=await f.create('author',{text:'Original',mentions:[]});for(let index=0;index<17;index++){const id='participant-'+index;f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,'guest',stamp);}
 await f.change(payload=>{for(let index=0;index<17;index++){const id='participant-'+index,grantId='grant-'+id;payload.grants.push({id:grantId,workspaceId,pageId:'page',accountId:id,permission:'viewer',includeDescendants:false,status:'active'});payload.grantBindings.push({grantId,membershipId:'membership-'+id});payload.discussion.threads[0].messages.push({id:'prior-message-'+index,authorId:id,authorMembershipId:'membership-'+id,text:'Earlier participation',mentions:[],createdAt:stamp,updatedAt:stamp,deletedAt:null});}});
 const before=await f.read();await error(await f.request('author',path(thread.id),'POST',{expectedRevision:3,text:'Too many atomic recipients',mentions:[]}),413,'COMMENTS_TOO_LARGE');assert.deepEqual(await f.read(),before);
});
test('old mention metadata remains valid and reply reasons require an actual prior author binding',async t=>{
 const f=await fixture(t),{thread}=await f.create('commenter');await f.change(payload=>{delete payload.discussion.notifications[0].reason;});assert.equal((await inbox(f,'viewer'))[0].reason,'mention');await accepted(await f.request('author',path(thread.id),'POST',{expectedRevision:3,text:'New reply',mentions:[]}));const saved=await f.read();validateContentPayload(saved.payload,workspaceId);
 for(const change of [payload=>payload.discussion.notifications[0].reason='reply',payload=>payload.discussion.notifications[0].reason='invalid',payload=>{const notification=payload.discussion.notifications.find(item=>item.reason==='reply');notification.recipientId='author';notification.recipientMembershipId='membership-author';}]){const payload=structuredClone(saved.payload);change(payload);assert.throws(()=>validateContentPayload(payload,workspaceId));}
});
