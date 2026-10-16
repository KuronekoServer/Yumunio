import test from 'node:test';
import assert from 'node:assert/strict';
import {TeamspaceClient,validateTeamspaceList,validateTeamspaceDetail,validateTeamspaceReview} from '../public/teamspace-client.js';
const team={id:'team-a',workspaceId:'studio',name:'Design',description:'Shared drafts',visibility:'private',defaultPermission:'editor',createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z',archivedAt:null,role:'owner',capabilities:['read','manage','createPage'],memberCount:1};
const detail={workspaceId:'studio',revision:5,teamspace:team,members:[{id:'team-owner',accountId:'account-a',name:'Aoi',role:'owner',currentUser:true}],candidates:[{accountId:'account-a',name:'Aoi'},{accountId:'account-b',name:'Ren'}]};
const session={user:{id:'account-a',emailVerified:true}};
const options=fetcher=>({workspaceId:'studio',accountId:'account-a',fetcher});
const response=(value,status=200)=>Response.json(value,{status});

test('default Window fetch keeps its global receiver contract for teamspace reads and writes',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'fetch'),calls=[];
 Object.defineProperty(globalThis,'fetch',{configurable:true,value:async function(path,init){assert.equal(this,undefined,'Window.fetch must not receive a TeamspaceClient as its receiver');calls.push({path,method:init.method});if(path.endsWith('/get-session'))return response(session);return response(init.method==='POST'?detail:{workspaceId:'studio',revision:4,canCreate:true,teamspaces:[team]});}});
 t.after(()=>Object.defineProperty(globalThis,'fetch',previous));const client=new TeamspaceClient({workspaceId:'studio',accountId:'account-a'});
 assert.equal((await client.list()).teamspaces[0].id,'team-a');assert.equal((await client.create({expectedRevision:4,name:'Design',description:'Shared drafts',visibility:'private',defaultPermission:'editor'})).revision,5);assert.equal(calls.filter(item=>item.method==='POST').length,1);client.destroy();
});

test('teamspace DTOs reject duplicate identity, inconsistent workspace and a different page review basis',()=>{
 const list={workspaceId:'studio',revision:4,canCreate:true,teamspaces:[team]};
 assert.equal(validateTeamspaceList(list,'studio').teamspaces[0].id,'team-a');
 assert.throws(()=>validateTeamspaceList({...list,teamspaces:[team,team]},'studio'));
 assert.throws(()=>validateTeamspaceDetail({...detail,candidates:[...detail.candidates,detail.candidates[0]]},'studio','team-a'));
 assert.throws(()=>validateTeamspaceDetail({...detail,workspaceId:'another'},'studio','team-a'));
 const basis={workspaceId:'studio',pageId:'page-a',revision:4,pageVersion:2,teamspaceId:'team-a'};
 const review={...basis,affectedPageCount:2,beforeReaders:1,afterReaders:3,addedReaders:2,removedReaders:0,outsideReadersPreserved:1,reviewDigest:'a'.repeat(64),existingGrantsPreserved:true,teamspaceOwnersHaveFullAccess:true,actorCanReadAfter:true,actorCanManageAfter:true};
 assert.equal(validateTeamspaceReview(review,basis).affectedPageCount,2);
 for(const patch of [{pageId:'other'},{revision:5},{teamspaceId:'other'},{existingGrantsPreserved:false},{reviewDigest:'not-a-digest'}])assert.throws(()=>validateTeamspaceReview({...review,...patch},basis));
});

test('a changed account blocks private reads and mutations before the request is sent',async()=>{
 const calls=[],client=new TeamspaceClient(options(async(path,init)=>{calls.push([path,init]);return response({user:{id:'account-b',emailVerified:true}});}));
 await assert.rejects(client.list(),error=>error.code==='ACCOUNT_CHANGED');
 await assert.rejects(client.create({expectedRevision:4,name:'Design'}),error=>error.code==='ACCOUNT_CHANGED');
 assert.equal(calls.length,2);assert.ok(calls.every(([path,init])=>path==='/api/auth/get-session'&&init.headers['X-Yumunio-Expected-Account']==='account-a'));
 assert.equal(client.uncertain,false);client.destroy();
});

test('an unknown write acknowledgement fences retry while a known CAS refusal permits a new reviewed command',async()=>{
 const calls=[];let refused=true;
 const client=new TeamspaceClient(options(async(path,init)=>{calls.push({path,method:init.method});if(path.endsWith('get-session'))return response(session);if(refused)return response({error:{code:'CONTENT_CONFLICT'}},409);return response({...detail,revision:8});}));
 await assert.rejects(client.create({expectedRevision:4,name:'Design'}),error=>error.status===409);assert.equal(client.uncertain,false);
 refused=false;await assert.rejects(client.create({expectedRevision:4,name:'Design'}),error=>error.code==='INVALID_RESPONSE');assert.equal(client.uncertain,true);
 const mutations=calls.filter(call=>call.method==='POST').length;
 await assert.rejects(client.create({expectedRevision:4,name:'Design'}),error=>error.code==='REQUEST_UNCONFIRMED');
 assert.equal(calls.filter(call=>call.method==='POST').length,mutations);client.destroy();
});

test('double submit sends one mutation and post-response account drift exposes no successful private result',async()=>{
 let release,mutations=0,sessions=0;
 const pending=new Promise(resolve=>{release=resolve;});
 const client=new TeamspaceClient(options(async(path)=>{if(path.endsWith('get-session')){sessions++;return response(sessions===1?session:{user:{id:'account-b',emailVerified:true}});}mutations++;await pending;return response(detail);}));
 const first=client.create({expectedRevision:4,name:'Design'});for(let i=0;i<8;i++)await Promise.resolve();
 await assert.rejects(client.create({expectedRevision:4,name:'Duplicate'}),error=>error.code==='BUSY');release();
 await assert.rejects(first,error=>error.code==='ACCOUNT_CHANGED');assert.equal(mutations,1);assert.equal(client.uncertain,true);client.destroy();
});

test('page assignment sends the reviewed digest once and requires the exact resulting target and aggregate revision',async()=>{
 const body={expectedRevision:4,expectedVersion:2,teamspaceId:'team-a',reviewDigest:'a'.repeat(64),confirmAccessChange:true},calls=[];
 const client=new TeamspaceClient(options(async(path,init)=>{if(path.endsWith('get-session'))return response(session);calls.push({path,body:JSON.parse(init.body)});return response({workspaceId:'studio',revision:5,pageId:'page-a',affectedPageCount:2,teamspaceId:'team-a'});}));
 assert.equal((await client.movePage('page-a',body)).revision,5);assert.deepEqual(calls,[{path:'/api/content/workspaces/studio/pages/page-a/teamspace',body}]);client.destroy();
 const invalid=new TeamspaceClient(options(async path=>response(path.endsWith('get-session')?session:{workspaceId:'studio',revision:5,pageId:'page-a',affectedPageCount:2,teamspaceId:'other'})));
 await assert.rejects(invalid.movePage('page-a',body),error=>error.code==='INVALID_RESPONSE');assert.equal(invalid.uncertain,true);invalid.destroy();
});

test('the confirmed assignment command remains captured while the actor lookup is pending',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let first=true,submitted;
 const client=new TeamspaceClient(options(async(path,init)=>{if(path.endsWith('get-session')){if(first){first=false;await gate;}return response(session);}submitted=JSON.parse(init.body);return response({workspaceId:'studio',revision:5,pageId:'page-a',affectedPageCount:1,teamspaceId:'team-a'});}));
 const command={expectedRevision:4,expectedVersion:2,teamspaceId:'team-a',reviewDigest:'a'.repeat(64),confirmAccessChange:true};
 const result=client.movePage('page-a',command);command.teamspaceId='other';command.expectedRevision=100;command.reviewDigest='b'.repeat(64);release();
 assert.equal((await result).teamspaceId,'team-a');assert.equal(submitted.expectedRevision,4);assert.equal(submitted.teamspaceId,'team-a');assert.equal(submitted.reviewDigest,'a'.repeat(64));client.destroy();
});

test('duplicate captures the confirmed command and accepts only a fresh team with the current actor as its sole owner',async()=>{
 let release,first=true,submitted;const gate=new Promise(resolve=>{release=resolve;});
 const copied={...structuredClone(detail),teamspace:{...team,id:'team-copy',name:'Policy copy'}};
 const client=new TeamspaceClient(options(async(path,init)=>{if(path.endsWith('get-session')){if(first){first=false;await gate;}return response(session);}assert.equal(path,'/api/content/workspaces/studio/teamspaces/team-a/duplicate');submitted=JSON.parse(init.body);return response(copied);}));
 const command={expectedRevision:4,name:'Policy copy',confirmSettingsOnly:true},pending=client.duplicate('team-a',command);command.name='Changed during actor lookup';command.expectedRevision=80;release();
 assert.equal((await pending).teamspace.id,'team-copy');assert.deepEqual(submitted,{expectedRevision:4,name:'Policy copy',confirmSettingsOnly:true});assert.equal(client.uncertain,false);client.destroy();
});

test('duplicate rejects malformed or ambiguous success ACKs and prevents retry, while actor drift prevents sending',async()=>{
 const command={expectedRevision:4,name:'Policy copy',confirmSettingsOnly:true};
 for(const patch of [value=>value.teamspace.id='team-a',value=>value.teamspace.name='Unexpected',value=>value.teamspace.role='member',value=>value.teamspace.memberCount=2,value=>value.members.push({...value.members[0],id:'other',accountId:'other',currentUser:false}),value=>value.members[0].accountId='other',value=>value.teamspace.archivedAt=team.createdAt]){
  let writes=0;const copied={...structuredClone(detail),teamspace:{...team,id:'team-copy',name:'Policy copy'}};patch(copied);
  const client=new TeamspaceClient(options(async(path)=>{if(path.endsWith('get-session'))return response(session);writes++;return response(copied);}));
  await assert.rejects(client.duplicate('team-a',command),error=>error.code==='INVALID_RESPONSE');assert.equal(client.uncertain,true);
  await assert.rejects(client.duplicate('team-a',command),error=>error.code==='REQUEST_UNCONFIRMED');assert.equal(writes,1);client.destroy();
 }
 let sent=false;const changed=new TeamspaceClient(options(async path=>{if(!path.endsWith('get-session'))sent=true;return response({user:{id:'other',emailVerified:true}});}));
 await assert.rejects(changed.duplicate('team-a',command),error=>error.code==='ACCOUNT_CHANGED');assert.equal(sent,false);changed.destroy();
});
