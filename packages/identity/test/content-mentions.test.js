import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {rebaseMentions} from '@yumunio/domain';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {ACTIVITY_LIMITS} from '../src/content-activity.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {prepareMentionBlocks,projectMentionBlocks} from '../src/content-mentions.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),origin='https://mentions.example.invalid',stamp='2026-10-16T00:00:00.000Z',workspaceId='workspace';
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
 for(const account of ['owner','editor','recipient','outsider','foreign'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(account,'Synthetic '+account,account+'@example.invalid',stamp,stamp);
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Mentions','mentions',stamp);
 for(const account of ['owner','editor','recipient','outsider'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('member-'+account,workspaceId,account,account==='owner'?'owner':'member',stamp);
 const raw=createSqliteContentStore(db);let beforeWrite=null,sequence=0,writes=0;
 const store={read:raw.read.bind(raw),async write(...args){writes++;const callback=beforeWrite;beforeWrite=null;await callback?.(...args);return raw.write(...args);}};
 const api=createAccountContentApi({store,origin,now:()=>stamp,createId:()=> 'mention-'+ ++sequence,resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}})});
 const request=(path='',method='GET',body,account='owner')=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Fixture-Account':account,'X-Yumunio-Expected-Account':account},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return{db,raw,request,beforeWrite:callback=>beforeWrite=callback,get writes(){return writes;}};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
const block=(text,mentions,id='body')=>({id,type:'paragraph',data:{text,...(mentions?{mentions}:{})}});
async function setup(t){const f=fixture(t),target=await ok(await f.request('/pages','POST',{expectedRevision:0,title:'Private target'}),201),source=await ok(await f.request('/pages','POST',{expectedRevision:1,title:'Source'}),201);await ok(await f.request('/pages/'+source.page.id+'/grants','POST',{expectedRevision:2,accountId:'editor',permission:'editor'}));await ok(await f.request('/pages/'+source.page.id+'/grants','POST',{expectedRevision:3,accountId:'recipient',permission:'viewer'}));return{f,target,source,path:'/pages/'+source.page.id};}
async function save(f,path,blocks,account='owner'){const current=await ok(await f.request(path,'GET',undefined,account));return f.request(path,'PATCH',{expectedRevision:current.revision,expectedVersion:current.document.version,blocks},account);}
const mentions=pageId=>[{kind:'person',accountId:'recipient',start:0,end:10},{kind:'page',pageId,start:11,end:19},{kind:'date',date:'2026-10-16',start:20,end:30}];

test('SQLite body authoring binds eligible people to a membership generation and projects only currently visible page/person references',async t=>{
 const{f,target,source,path}=await setup(t),values=mentions(target.page.id);const saved=await ok(await save(f,path,[block('@Recipient @Private 2026-10-16',values)]));assert.equal(saved.document.version,2);assert.equal(saved.document.blocks[0].data.mentions[0].accountId,'recipient');assert.equal('membershipId'in saved.document.blocks[0].data.mentions[0],false);
 const internal=(await f.raw.read(workspaceId,'owner')).payload.pages.find(item=>item.page.id===source.page.id).document.blocks[0].data.mentions;assert.equal(internal[0].membershipId,'member-recipient');
 const editor=await ok(await f.request(path,'GET',undefined,'editor'));assert.deepEqual(editor.document.blocks[0].data.mentions,[values[0],{kind:'page',start:11,end:19,unavailable:true},values[2]]);assert.doesNotMatch(JSON.stringify(editor.document),new RegExp(target.page.id+'|member-recipient|recipient@example'));
 const current=editor.document.blocks[0],nextText='X '+current.data.text,next=block(nextText,rebaseMentions(current.data.text,nextText,current.data.mentions));const changed=await ok(await save(f,path,[next],'editor'));assert.equal(changed.document.blocks[0].data.mentions[1].unavailable,true);assert.equal((await f.raw.read(workspaceId,'owner')).payload.pages.find(item=>item.page.id===source.page.id).document.blocks[0].data.mentions[1].pageId,target.page.id);
});

test('new references to foreign, unreadable or unverified people/pages and forged hidden ranges fail before persistence',async t=>{
 const{f,target,path}=await setup(t),before=f.writes;
 for(const value of [{kind:'person',accountId:'outsider',start:0,end:4},{kind:'person',accountId:'foreign',start:0,end:4},{kind:'person',accountId:'recipient',membershipId:'forged',start:0,end:4},{kind:'page',pageId:target.page.id,start:0,end:4},{kind:'page',start:0,end:4,unavailable:true}])assert.ok([400,404].includes((await save(f,path,[block('Name',[value])],'editor')).status));
 f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('recipient');assert.equal((await save(f,path,[block('Name',[{kind:'person',accountId:'recipient',start:0,end:4}])])).status,404);assert.equal(f.writes,before);
});

test('hidden references can survive a valid same-block edit, but cannot be copied, guessed or resurrected after their text is edited',async t=>{
 const{f,target,path}=await setup(t);await ok(await save(f,path,[block('@Recipient @Private 2026-10-16',mentions(target.page.id))]));const current=await ok(await f.request(path,'GET',undefined,'editor')),original=current.document.blocks[0],before=f.writes;
 for(const candidate of [{...original,id:'copied'},block(original.data.text,[{...original.data.mentions[1],start:0,end:10}]),block('@Recipient @Otherxx 2026-10-16',original.data.mentions)])assert.ok([400,404].includes((await save(f,path,[candidate],'editor')).status));
 assert.equal(f.writes,before);const changed={...original,type:'heading',data:{...original.data,level:2}};const converted=await ok(await save(f,path,[changed],'editor'));assert.equal(converted.document.blocks[0].data.mentions[1].unavailable,true);
});

test('removal and rejoining do not reactivate stored person mentions; explicit reselection binds the new live generation',async t=>{
 const{f,source,path}=await setup(t);await ok(await save(f,path,[block('@Recipient',[{kind:'person',accountId:'recipient',start:0,end:10}])]));f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('rejoined-recipient','recipient');
 const saved=await f.raw.read(workspaceId,'owner'),grant=saved.payload.grants.find(item=>item.pageId===source.page.id&&item.accountId==='recipient'),binding=saved.payload.grantBindings.find(item=>item.grantId===grant.id);binding.membershipId='rejoined-recipient';await f.raw.write(workspaceId,'owner',{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'member-owner',actorRole:'owner'});
 const hidden=await ok(await f.request(path));assert.deepEqual(hidden.document.blocks[0].data.mentions,[{kind:'person',start:0,end:10,unavailable:true}]);const nextText='X @Recipient';await ok(await save(f,path,[block(nextText,rebaseMentions('@Recipient',nextText,hidden.document.blocks[0].data.mentions))]));const prior=(await f.raw.read(workspaceId,'owner')).payload.pages.find(item=>item.page.id===source.page.id);assert.equal(prior.document.blocks[0].data.mentions[0].membershipId,'member-recipient');
 await ok(await save(f,path,[block(nextText,[{kind:'person',accountId:'recipient',start:2,end:12}])]));assert.equal((await f.raw.read(workspaceId,'owner')).payload.pages.find(item=>item.page.id===source.page.id).document.blocks[0].data.mentions[0].membershipId,'rejoined-recipient');
});

test('recipient membership, role, verification and page-read changes after authorization are fenced by the same content commit',async t=>{
 for(const kind of ['membership','role','verification','acl']){
  const{f,source,path}=await setup(t);f.beforeWrite(async()=>{if(kind==='membership')f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('rejoined','recipient');if(kind==='role')f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('admin','recipient');if(kind==='verification')f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('recipient');if(kind==='acl'){const current=await f.raw.read(workspaceId,'owner');current.payload.grants.find(item=>item.pageId===source.page.id&&item.accountId==='recipient').status='revoked';await f.raw.write(workspaceId,'owner',{expectedRevision:current.revision,payload:current.payload,actorMembershipId:'member-owner',actorRole:'owner'});}});
  const result=await save(f,path,[block('@Recipient',[{kind:'person',accountId:'recipient',start:0,end:10}])]);assert.ok([404,409].includes(result.status),kind);const internal=(await f.raw.read(workspaceId,'owner')).payload;assert.equal(internal.pages.find(item=>item.page.id===source.page.id).document.version,1,kind);assert.equal(internal.history,undefined,kind);
 }
});

test('new private pages can mention their creator but cannot mention a non-reader, and child creation respects inherited page-read',async t=>{
 const f=fixture(t),created=await ok(await f.request('/pages','POST',{expectedRevision:0,title:'Private self mention',blocks:[block('@Owner',[{kind:'person',accountId:'owner',start:0,end:6}])]}),201);assert.equal(created.document.blocks[0].data.mentions[0].accountId,'owner');assert.equal('membershipId'in created.document.blocks[0].data.mentions[0],false);
 const denied=await f.request('/pages','POST',{expectedRevision:1,title:'Private outsider',blocks:[block('Name',[{kind:'person',accountId:'recipient',start:0,end:4}])]});assert.equal(denied.status,404);
 await ok(await f.request('/pages/'+created.page.id+'/grants','POST',{expectedRevision:1,accountId:'recipient',permission:'viewer'}));
 assert.equal((await f.request('/pages','POST',{expectedRevision:2,parentId:created.page.id,title:'Page-only sharing is not inherited',blocks:[block('@Recipient',[{kind:'person',accountId:'recipient',start:0,end:10}])]})).status,404);
 const current=await f.raw.read(workspaceId,'owner');current.payload.grants.find(grant=>grant.pageId===created.page.id&&grant.accountId==='recipient').includeDescendants=true;await f.raw.write(workspaceId,'owner',{expectedRevision:2,payload:current.payload,actorMembershipId:'member-owner',actorRole:'owner'});
 const child=await ok(await f.request('/pages','POST',{expectedRevision:3,parentId:created.page.id,title:'Inherited child',blocks:[block('@Recipient',[{kind:'person',accountId:'recipient',start:0,end:10}])]}),201);assert.equal(child.document.blocks[0].data.mentions[0].accountId,'recipient');
});

test('workspace export keeps literal mention labels without account/page/generation reference metadata, and foreign import references are rejected',async t=>{
 const{f,target,source,path}=await setup(t);await ok(await save(f,path,[block('@Recipient @Private 2026-10-16',mentions(target.page.id))]));const exported=await ok(await f.request('/export?format=json')),page=exported.pages.find(item=>item.page.id===source.page.id);assert.equal(page.document.blocks[0].data.text,'@Recipient @Private 2026-10-16');assert.equal(page.document.blocks[0].data.mentions,undefined);assert.doesNotMatch(JSON.stringify(page.document),/member-recipient|accountId|membershipId/);
 const current=await f.raw.read(workspaceId,'owner'),input={expectedRevision:current.revision,importId:'foreign-mentions',pages:[{sourceId:'root',parentSourceId:null,title:'Imported',blocks:[block('@Recipient',[{kind:'person',accountId:'recipient',start:0,end:10}])]}]};assert.equal((await f.request('/imports','POST',input)).status,400);
 input.importId='date-only';input.pages[0].blocks=[block('2026-10-16',[{kind:'date',date:'2026-10-16',start:0,end:10}])];assert.equal((await f.request('/imports','POST',input)).status,201);
});

test('pure helpers minimize projected IDs and cap atomic recipient guards without mutating caller data',()=>{
 const people=Array.from({length:17},(_,index)=>({id:'member-'+index,accountId:'person-'+index,role:'member',emailVerified:true})),blocks=people.map((person,index)=>block('Name',[{kind:'person',accountId:person.accountId,start:0,end:4}],'block-'+index)),original=structuredClone(blocks);assert.throws(()=>prepareMentionBlocks({blocks,principals:people,personCanRead:()=>true,pageId:'page'}),error=>error.status===413);assert.deepEqual(blocks,original);
 const stored=[block('Name',[{kind:'person',accountId:'person-0',membershipId:'old-generation',start:0,end:4}])],projected=projectMentionBlocks({blocks:stored,principals:people,personCanRead:()=>true,pageId:'page'});assert.deepEqual(projected[0].data.mentions,[{kind:'person',start:0,end:4,unavailable:true}]);assert.equal(stored[0].data.mentions[0].accountId,'person-0');
});

const person=accountId=>({kind:'person',accountId,start:0,end:10});
const inlineInbox=async(f,account='recipient')=>(await ok(await f.request('/notifications','GET',undefined,account))).notifications;
test('ordinary body saves notify one current reader per page, preserve read state across range and block moves, and never share',async t=>{
 const{f,target,source,path}=await setup(t),before=await f.raw.read(workspaceId,'owner');
 await ok(await save(f,path,[block('@Recipient',[person('recipient')]),block('@Recipient',[person('recipient')],'second'),block('@OwnerName',[person('owner')],'self'),block('Private',[{kind:'page',pageId:target.page.id,start:0,end:7}],'link')]));
 const after=await f.raw.read(workspaceId,'owner'),notices=await inlineInbox(f);assert.equal(after.revision,before.revision+1);assert.deepEqual(after.payload.grants,before.payload.grants);assert.equal(notices.length,1);const first=notices[0];assert.deepEqual(first,{id:after.payload.activityNotifications[0].id,pageId:source.page.id,pageTitle:'Source',authorId:'owner',createdAt:stamp,readAt:null,reason:'inline-mention'});assert.deepEqual(await inlineInbox(f,'owner'),[]);assert.equal((await f.request('/pages/'+target.page.id,'GET',undefined,'recipient')).status,404);
 await ok(await f.request('/notifications','POST',{expectedRevision:after.revision,notificationIds:[first.id]},'recipient'));
 await ok(await save(f,path,[{id:'layout',type:'columns',children:[{id:'left',type:'column',children:[block('X @Recipient',[{...person('recipient'),start:2,end:12}],'relocated')]},{id:'right',type:'column',children:[]}]}]));
 assert.deepEqual((await inlineInbox(f)).map(item=>[item.id,item.readAt]),[[first.id,stamp]]);
 await ok(await save(f,path,[block('@Recipient',[person('recipient')])],'editor'));assert.equal((await inlineInbox(f))[0].id,first.id);
});

test('last-reference removal prunes its receipt, reselection creates a new unread receipt, and the recipient editing does not erase it',async t=>{
 const{f,path}=await setup(t);await ok(await save(f,path,[block('@Recipient',[person('recipient')])]));const first=(await inlineInbox(f))[0];
 await ok(await save(f,path,[block('Recipient')]));assert.deepEqual(await inlineInbox(f),[]);assert.deepEqual((await f.raw.read(workspaceId,'owner')).payload.activityNotifications,[]);
 await ok(await save(f,path,[block('@Recipient',[person('recipient')])]));const next=(await inlineInbox(f))[0];assert.notEqual(next.id,first.id);assert.equal(next.readAt,null);
 const current=await ok(await f.request(path));await ok(await f.request(path+'/grants','POST',{expectedRevision:current.revision,accountId:'recipient',permission:'editor'}));await ok(await save(f,path,[block('X @Recipient',[{...person('recipient'),start:2,end:12}])],'recipient'));assert.equal((await inlineInbox(f))[0].id,next.id);
});

test('inline inbox and mark-read never cross a revoked ACL or membership generation, even after new sharing',async t=>{
 const{f,source,path}=await setup(t);await ok(await save(f,path,[block('@Recipient',[person('recipient')])]));const old=(await inlineInbox(f))[0],saved=await f.raw.read(workspaceId,'owner');
 f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('rejoined-recipient','recipient');assert.deepEqual(await inlineInbox(f),[]);assert.equal((await f.request('/notifications','POST',{expectedRevision:saved.revision,notificationIds:[old.id]},'recipient')).status,404);
 await ok(await f.request(path+'/grants','POST',{expectedRevision:saved.revision,accountId:'recipient',permission:'viewer'}));assert.deepEqual(await inlineInbox(f),[]);
 await ok(await save(f,path,[block('@Recipient',[person('recipient')])]));const notice=(await inlineInbox(f))[0];assert.notEqual(notice.id,old.id);assert.equal((await f.raw.read(workspaceId,'owner')).payload.activityNotifications[0].recipientMembershipId,'rejoined-recipient');
 const latest=await f.raw.read(workspaceId,'owner');latest.payload.grants.find(item=>item.pageId===source.page.id&&item.accountId==='recipient'&&item.status==='active').status='revoked';await f.raw.write(workspaceId,'owner',{expectedRevision:latest.revision,payload:latest.payload,actorMembershipId:'member-owner',actorRole:'owner'});assert.deepEqual(await inlineInbox(f),[]);
});

test('creation, literal imports and a later ordinary save never retroactively notify pre-existing references',async t=>{
 const{f,source,path}=await setup(t),saved=await f.raw.read(workspaceId,'owner');await ok(await f.request(path+'/grants','POST',{expectedRevision:saved.revision,accountId:'recipient',permission:'viewer',includeDescendants:true}));
 const listing=await ok(await f.request('/pages')),created=await ok(await f.request('/pages','POST',{expectedRevision:listing.revision,parentId:source.page.id,title:'Initially authored elsewhere',blocks:[block('@Recipient',[person('recipient')])]}),201);assert.deepEqual(await inlineInbox(f),[]);
 await ok(await save(f,'/pages/'+created.page.id,[block('X @Recipient',[{...person('recipient'),start:2,end:12}])]));assert.deepEqual(await inlineInbox(f),[]);
 const current=await ok(await f.request('/pages'));await ok(await f.request('/imports','POST',{expectedRevision:current.revision,importId:'no-inline-receipts',pages:[{sourceId:'root',parentSourceId:null,title:'Literal import',blocks:[block('@Recipient')]}]}),201);assert.deepEqual(await inlineInbox(f),[]);
});

test('history remove and restore never revive an old receipt or mint a new one, while validation leaves archives untouched',async t=>{
 const{f,path}=await setup(t);await ok(await save(f,path,[block('@Recipient',[person('recipient')])]));const first=(await inlineInbox(f))[0],history=await ok(await f.request(path+'/history')),blank=history.versions.find(item=>item.version===1);assert.ok(blank);
 const restore=async id=>{const current=await ok(await f.request(path));return ok(await f.request(path+'/history/'+id+'/restore','POST',{expectedRevision:current.revision,expectedVersion:current.document.version}));};
 await restore(blank.id);assert.deepEqual(await inlineInbox(f),[]);assert.deepEqual((await f.raw.read(workspaceId,'owner')).payload.activityNotifications,[]);const next=await ok(await f.request(path+'/history')),mentioned=next.versions.find(item=>item.version===2);assert.ok(mentioned);await restore(mentioned.id);assert.deepEqual(await inlineInbox(f),[]);assert.equal((await ok(await f.request(path))).document.blocks[0].data.mentions[0].accountId,'recipient');
 const archived=(await f.raw.read(workspaceId,'owner')).payload;archived.activityNotifications=[{id:first.id,kind:'inline-mention',pageId:history.pageId,recipientId:'recipient',recipientMembershipId:'member-recipient',authorId:'owner',authorMembershipId:'member-owner',createdAt:stamp,readAt:null}];archived.pages.find(item=>item.page.id===history.pageId).document.blocks=[];const before=structuredClone(archived);validateContentPayload(archived,workspaceId);assert.deepEqual(archived,before);
 const saved=await f.raw.read(workspaceId,'owner');await f.raw.write(workspaceId,'owner',{expectedRevision:saved.revision,payload:archived,actorMembershipId:'member-owner',actorRole:'owner'});assert.deepEqual(archived,before);assert.deepEqual((await f.raw.read(workspaceId,'owner')).payload.activityNotifications,[]);
});

test('notification capacity failure rolls back the body, history, grants, and all new inline recipients together',async t=>{
 const{f,source,path}=await setup(t),saved=await f.raw.read(workspaceId,'owner'),rows=[];
 for(let index=0;;index++){const item={id:'historical-notice-'+index,collectionId:'old-collection',recordId:'old-record-'+index,pageId:source.page.id,propertyId:'old-property',recipientId:'recipient',recipientMembershipId:'member-recipient',authorId:'owner',authorMembershipId:'member-owner',createdAt:stamp,readAt:null};if(new TextEncoder().encode(JSON.stringify({comment:[],assignment:[...rows,item]})).length>ACTIVITY_LIMITS.bytes)break;rows.push(item);}
 saved.payload.activityNotifications=rows;validateContentPayload(saved.payload,workspaceId);f.db.prepare('UPDATE yumunio_account_content SET payload_json=? WHERE workspace_id=?').run(JSON.stringify(saved.payload),workspaceId);const before=await f.raw.read(workspaceId,'owner'),response=await save(f,path,[block('@Recipient',[person('recipient')])]);assert.equal(response.status,413,await response.clone().text());assert.equal((await response.json()).error.code,'NOTIFICATIONS_TOO_LARGE');assert.deepEqual(await f.raw.read(workspaceId,'owner'),before);assert.deepEqual(await inlineInbox(f),[]);
});

test('inline notification validation remains a strict optional union and never accepts caller-provided receipts',async t=>{
 const{f,path}=await setup(t);await ok(await save(f,path,[block('@Recipient',[person('recipient')])]));const saved=await f.raw.read(workspaceId,'owner'),item=saved.payload.activityNotifications[0];
 for(const change of [row=>row.kind='forged',row=>row.blockId='secret-block',row=>row.recipientId=row.authorId,row=>row.collectionId='foreign',row=>delete row.recipientMembershipId]){const payload=structuredClone(saved.payload);change(payload.activityNotifications[0]);assert.throws(()=>validateContentPayload(payload,workspaceId));}
 const duplicate=structuredClone(saved.payload);duplicate.activityNotifications.push({...item,id:'second-receipt'});assert.throws(()=>validateContentPayload(duplicate,workspaceId));
 const current=await ok(await f.request(path));assert.equal((await f.request(path,'PATCH',{expectedRevision:current.revision,expectedVersion:current.document.version,blocks:current.document.blocks,activityNotifications:[]})).status,400);assert.deepEqual(await f.raw.read(workspaceId,'owner'),saved);
});
