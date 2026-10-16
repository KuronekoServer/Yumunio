import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupsClient,validateGroups,validateGroupGrants} from '../public/groups-client.js';
const stamp='2026-10-16T00:00:00.000Z';
const group={id:'design',workspaceId:'studio',name:'Design',createdAt:stamp,updatedAt:stamp,archivedAt:null,memberCount:1};
const detail={workspaceId:'studio',revision:5,canManage:true,group,members:[{id:'group-a',accountId:'account-a',name:'Aoi',currentUser:true}],candidates:[{accountId:'account-a',name:'Aoi'},{accountId:'account-b',name:'Ren'}]};
const session={user:{id:'account-a',emailVerified:true}},options=fetcher=>({workspaceId:'studio',accountId:'account-a',fetcher});
const response=(value,status=200)=>Response.json(value,{status});

test('group projections reject malformed identities, duplicate members, hidden member arrays and inconsistent counts',()=>{
 assert.equal(validateGroups(detail,'studio',{detail:true}).group.id,'design');
 for(const patch of [value=>value.workspaceId='other',value=>value.group.memberCount=2,value=>value.group.createdAt='bad',value=>value.group.name=' padded ',value=>value.members=[null],value=>value.members.push({...value.members[0],accountId:'another'}),value=>value.candidates=[null],value=>value.canManage=false]){const data=structuredClone(detail);patch(data);assert.throws(()=>validateGroups(data,'studio',{detail:true}),error=>error.code==='INVALID_RESPONSE');}
 assert.throws(()=>validateGroups({workspaceId:'studio',revision:1,canManage:false,groups:[null]},'studio'),error=>error.code==='INVALID_RESPONSE');
 assert.equal(validateGroups({...detail,canManage:false,members:[],candidates:[]},'studio',{detail:true}).group.memberCount,1);
 const grant={id:'grant',workspaceId:'studio',pageId:'page-a',groupId:'design',groupName:'Design',permission:'viewer',includeDescendants:false,status:'active'},value={workspaceId:'studio',revision:5,pageId:'page-a',grants:[grant]};
 assert.equal(validateGroupGrants(value,'studio','page-a').grants.length,1);for(const patch of [{pageId:'another'},{grants:[grant,grant]},{grants:[null]},{grants:[{...grant,permission:'admin'}]}])assert.throws(()=>validateGroupGrants({...value,...patch},'studio','page-a'),error=>error.code==='INVALID_RESPONSE');
});

test('groups use the Window fetch receiver contract and cookie/expected-account guards on every read and write',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'fetch'),calls=[];
 Object.defineProperty(globalThis,'fetch',{configurable:true,value:async function(path,init){assert.equal(this,undefined);assert.equal(init.credentials,'same-origin');assert.equal(init.headers['X-Yumunio-Expected-Account'],'account-a');calls.push({path,method:init.method});return response(path.endsWith('get-session')?session:init.method==='PATCH'?{...detail,group:{...group,name:'Reviewed'}}:{workspaceId:'studio',revision:4,canManage:true,groups:[group]});}});
 t.after(()=>Object.defineProperty(globalThis,'fetch',previous));const client=new GroupsClient({workspaceId:'studio',accountId:'account-a'});assert.equal((await client.list()).groups[0].id,'design');assert.equal((await client.rename('design',{expectedRevision:4,name:'Reviewed',confirmAccessChange:true})).group.name,'Reviewed');assert.equal(calls.filter(item=>item.method==='PATCH').length,1);client.destroy();
});

test('confirmed group and page-grant commands are captured before a delayed actor check',async()=>{
 for(const kind of ['rename','grant']){let release,first=true,submitted;const gate=new Promise(resolve=>{release=resolve;});const command=kind==='rename'?{expectedRevision:4,name:'Reviewed',confirmAccessChange:true}:{expectedRevision:4,groupId:'design',permission:'commenter',includeDescendants:false,confirmAccessChange:true};const expected=structuredClone(command);
  const client=new GroupsClient(options(async(path,init)=>{if(path.endsWith('get-session')){if(first){first=false;await gate;}return response(session);}submitted=JSON.parse(init.body);return response(kind==='rename'?{...detail,group:{...group,name:'Reviewed'}}:{workspaceId:'studio',pageId:'page-a',revision:5,grants:[{id:'grant',workspaceId:'studio',pageId:'page-a',groupId:'design',groupName:'Design',permission:'commenter',includeDescendants:false,status:'active'}]});}));
  const pending=client[kind](kind==='rename'?'design':'page-a',command);command.expectedRevision=80;command.name='Changed';command.permission='deny';release();await pending;assert.deepEqual(submitted,expected);client.destroy();
 }
});

test('a changed actor prevents content requests while post-write drift rejects success and fences retries',async()=>{
 let sent=0;const client=new GroupsClient(options(async path=>{if(!path.endsWith('get-session'))sent++;return response({user:{id:'other',emailVerified:true}});}));await assert.rejects(client.read('design'),error=>error.code==='ACCOUNT_CHANGED');await assert.rejects(client.rename('design',{expectedRevision:4,name:'Reviewed',confirmAccessChange:true}),error=>error.code==='ACCOUNT_CHANGED');assert.equal(sent,0);client.destroy();
 let sessions=0;const changed=new GroupsClient(options(async path=>{if(path.endsWith('get-session'))return response(++sessions===1?session:{user:{id:'other',emailVerified:true}});sent++;return response({...detail,group:{...group,name:'Reviewed'}});}));await assert.rejects(changed.rename('design',{expectedRevision:4,name:'Reviewed',confirmAccessChange:true}),error=>error.code==='ACCOUNT_CHANGED');assert.equal(changed.uncertain,true);await assert.rejects(changed.rename('design',{expectedRevision:4,name:'Reviewed',confirmAccessChange:true}),error=>error.code==='REQUEST_UNCONFIRMED');assert.equal(sent,1);changed.destroy();
});

test('strict group and page-grant ACK intent failures lock a write client without a second mutation',async()=>{
 const cases=[['rename','design',{expectedRevision:4,name:'Expected',confirmAccessChange:true},detail],['archive','design',{expectedRevision:4,archived:true,confirmAccessChange:true},detail],['member','design',{expectedRevision:4,accountId:'account-b',confirmAccessChange:true},detail],['remove','design',{expectedRevision:4,memberId:'group-a',confirmAccessChange:true},detail],['grant','page-a',{expectedRevision:4,groupId:'design',permission:'editor',includeDescendants:false,confirmAccessChange:true},{workspaceId:'studio',pageId:'page-a',revision:5,grants:[]}]];
 for(const[method,id,body,ack]of cases){let writes=0;const client=new GroupsClient(options(async path=>{if(path.endsWith('get-session'))return response(session);writes++;return response(ack);}));await assert.rejects(client[method](id,body),error=>error.code==='INVALID_RESPONSE');assert.equal(client.uncertain,true);await assert.rejects(client[method](id,body),error=>error.code==='REQUEST_UNCONFIRMED');assert.equal(writes,1);client.destroy();}
});

test('known CAS rejection can be reviewed again and destruction cancels late successful content responses',async()=>{
 let refused=true,release;const gate=new Promise(resolve=>{release=resolve;});const client=new GroupsClient(options(async path=>{if(path.endsWith('get-session'))return response(session);if(refused)return response({error:{code:'CONTENT_CONFLICT'}},409);await gate;return response({...detail,group:{...group,name:'Reviewed'}});}));const body={expectedRevision:4,name:'Reviewed',confirmAccessChange:true};await assert.rejects(client.rename('design',body),error=>error.status===409);assert.equal(client.uncertain,false);refused=false;const pending=client.rename('design',body);for(let i=0;i<10;i++)await Promise.resolve();client.destroy();release();await assert.rejects(pending,error=>error.code==='DESTROYED');assert.equal(client.uncertain,true);
});
