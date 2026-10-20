import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createSqliteContentStore} from '../src/content-store.js';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {accountContentPolicy} from '../src/content-policy.js';
import {tokenPageContext} from '../src/api-token-model.js';
import {webhookPageAuthority} from '../src/webhooks-model.js';
import {createCollaborationService} from '../src/collaboration.js';
import {createSqliteCollaborationStore} from '../src/collaboration-store.js';
import {validateCreatedPage,validateCreatedPageProjection} from '../../../apps/web/public/page-create-result.js';
const ddl=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),origin='https://teams.example.invalid',stamp='2026-10-16T00:00:00.000Z',base='/api/content/workspaces/workspace';
async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(ddl);t.after(()=>db.close());
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run('workspace','Fixture','fixture',stamp);
 for(const[id,role]of [['owner','owner'],['member','member'],['second','owner'],['viewer','member'],['guest','guest']]){
  db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);
  db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+id,'workspace',id,role,stamp);
  db.prepare('INSERT INTO yumunio_auth_sessions(id,expiresAt,token,createdAt,updatedAt,userId)VALUES(?,?,?,?,?,?)').run('session-'+id,Date.parse(stamp)+3600000,'synthetic-'+id,Date.parse(stamp),Date.parse(stamp),id);
 }
 const page=id=>({page:{id,workspaceId:'workspace',parentId:null,title:id,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId:'workspace',version:1,updatedAt:stamp,blocks:[{id:id+'-body',type:'paragraph',data:{text:'Private '+id}}]},inheritPermissions:false});
 const payload={schemaVersion:1,pages:[page('legacy'),page('child')],grants:[],grantBindings:[]};payload.pages[1].page.parentId='legacy';
 for(const id of ['legacy','child']){payload.grants.push({id:'grant-'+id,workspaceId:'workspace',pageId:id,accountId:'owner',permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId:'grant-'+id,membershipId:'membership-owner'});}
 const raw=createSqliteContentStore(db);await raw.write('workspace','owner',{expectedRevision:0,payload,actorMembershipId:'membership-owner',actorRole:'owner'});
 let beforeWrite;const store={read:(...args)=>raw.read(...args),readPublication:(...args)=>raw.readPublication(...args),write:async(...args)=>{if(beforeWrite){const callback=beforeWrite;beforeWrite=null;await callback();}return raw.write(...args);}};
 const resolveSession=async request=>{const id=request.headers.get('x-fixture-account'),user=db.prepare('SELECT emailVerified FROM yumunio_users WHERE id=?').get(id??'');return user?{session:{id:'session-'+id},user:{id,emailVerified:user.emailVerified===1}}:null;};
 const api=createAccountContentApi({store,origin,resolveSession,now:()=>stamp,roomSecret:'Synthetic teamspace fixture room secret'});
 let beforeCollaborationCommit;const collaborationRaw=createSqliteCollaborationStore(db),collaborationCommit=collaborationRaw.commit.bind(collaborationRaw);
 collaborationRaw.commit=async(...args)=>{if(beforeCollaborationCommit){const callback=beforeCollaborationCommit;beforeCollaborationCommit=null;await callback();}return collaborationCommit(...args);};
 const collaboration=createCollaborationService({store:collaborationRaw,origin,resolveSession,secret:'Synthetic teamspace collaboration secret',now:()=>stamp});
 const request=(suffix,{method='GET',account='owner',body,headers={}}={})=>api(new Request(origin+base+suffix,{method,headers:{...(account?{'x-fixture-account':account,'X-Yumunio-Expected-Account':account}:{}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const read=()=>raw.read('workspace','owner'),change=async callback=>{const saved=await read();callback(saved.payload);validateContentPayload(saved.payload,'workspace');db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(saved.payload),'workspace');};
 const mutate=async(suffix,fields={},options={})=>request(suffix,{method:'POST',body:{expectedRevision:(await read()).revision,...fields},...options});
 const create=async(fields={})=>ok(await mutate('/teamspaces',{name:'Engineering',description:'Synthetic team',visibility:'open',defaultPermission:'editor',...fields}));
 const review=async(teamspaceId,pageId='legacy')=>{const saved=await read();return ok(await request('/pages/'+pageId+'/teamspace-review',{method:'POST',body:{expectedRevision:saved.revision,expectedVersion:saved.payload.pages.find(item=>item.page.id===pageId).document.version,teamspaceId}}));};
 const assign=async reviewed=>request('/pages/'+reviewed.pageId+'/teamspace',{method:'PATCH',body:{expectedRevision:reviewed.revision,expectedVersion:reviewed.pageVersion,teamspaceId:reviewed.teamspaceId,reviewDigest:reviewed.reviewDigest,confirmAccessChange:true}});
 return{db,read,change,request,mutate,create,review,assign,collaboration,setBeforeWrite:value=>beforeWrite=value,setBeforeCollaborationCommit:value=>beforeCollaborationCommit=value};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return response.json();}
async function error(response,status,code){const value=await ok(response,status);if(code)assert.equal(value.error.code,code);return value;}
const teamPath=team=>'/teamspaces/'+team.id;
test('closed-team request approval is generation-bound, private to its requester/owner and grants only member access in one CAS',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),path=teamPath(team),endpoint=path+'/requests';await ok(await f.assign(await f.review(team.id)));await ok(await f.mutate('/pages/legacy/room/open',{}),201);const before=await f.read();assert.equal(before.payload.rooms.length,1);
 const initial=await ok(await f.request(endpoint,{account:'member'}));assert.equal(initial.canRequest,true);assert.equal(initial.canReview,false);assert.deepEqual(initial.requests,[]);assert.equal((await f.read()).revision,before.revision);
 const pending=await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}));assert.deepEqual(Object.keys(pending).sort(),['accountId','action','requestId','revision','teamspaceId','workspaceId']);assert.equal(pending.action,'request');assert.equal(pending.accountId,'member');assert.equal(pending.revision,before.revision+1);await error(await f.request('/pages/legacy',{account:'member'}),404);
 const mine=await ok(await f.request(endpoint,{account:'member'})),stranger=await ok(await f.request(endpoint,{account:'viewer'})),queue=await ok(await f.request(endpoint));assert.equal(mine.myRequest.id,pending.requestId);assert.deepEqual(mine.requests,[]);assert.equal(mine.canRequest,false);assert.equal(stranger.myRequest,null);assert.deepEqual(stranger.requests,[]);assert.equal(queue.canReview,true);assert.equal(queue.requests[0].name,'Synthetic member');assert.equal(Object.hasOwn(queue.requests[0],'membershipId'),false);assert.deepEqual((await f.read()).payload.rooms,before.payload.rooms);
 await error(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}),409,'TEAMSPACE_REQUEST_EXISTS');await error(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'member',decision:'approve',confirmAccessChange:true},{method:'PATCH',account:'second'}),404);
 const snapshot=await f.read(),approved=await ok(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'member',decision:'approve',confirmAccessChange:true},{method:'PATCH'}));assert.equal(approved.revision,snapshot.revision+1);assert.equal(approved.action,'approve');const saved=await f.read();assert.equal(saved.payload.teamspaceMembers.find(row=>row.accountId==='member').role,'member');assert.deepEqual(saved.payload.teamspaceJoinRequests,[]);assert.deepEqual(saved.payload.rooms,[]);assert.equal(saved.payload.teamspaceMembers.filter(row=>row.role==='owner').length,1);assert.ok((await ok(await f.request('/pages/legacy',{account:'member'}))).page.capabilities.includes('editBody'));assert.equal((await ok(await f.request(path,{account:'member'}))).teamspace.role,'member');
});
test('request rejection/cancel are explicit, scoped and replay-safe while archive preserves a cancellable pending request',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),path=teamPath(team),endpoint=path+'/requests';let pending=await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}));const snapshot=await f.read();
 await error(await f.mutate(endpoint,{requestId:pending.requestId,confirmCancel:true},{method:'DELETE',account:'viewer'}),404);await error(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'viewer',decision:'approve',confirmAccessChange:true},{method:'PATCH'}),404);await error(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'member',decision:'approve',confirmAccessChange:false},{method:'PATCH'}),400);assert.equal((await f.read()).revision,snapshot.revision);
 assert.equal((await ok(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'member',decision:'reject',confirmAccessChange:true},{method:'PATCH'}))).action,'reject');await error(await f.mutate(endpoint,{requestId:pending.requestId,confirmCancel:true},{method:'DELETE',account:'member'}),404);
 pending=await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}));await ok(await f.mutate(path+'/archive',{archived:true}));assert.equal((await ok(await f.request(endpoint,{account:'member'}))).myRequest.id,pending.requestId);await error(await f.mutate(endpoint,{confirmRequest:true},{account:'viewer'}),409,'TEAMSPACE_ARCHIVED');await error(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'member',decision:'approve',confirmAccessChange:true},{method:'PATCH'}),409,'TEAMSPACE_ARCHIVED');assert.equal((await ok(await f.mutate(endpoint,{requestId:pending.requestId,confirmCancel:true},{method:'DELETE',account:'member'}))).action,'cancel');assert.deepEqual((await f.read()).payload.teamspaceJoinRequests,[]);
});
test('request creation never expands private/open discovery and validates strict intent, Origin, actor and revision before mutation',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),path=teamPath(team),endpoint=path+'/requests',before=await f.read();
 for(const[fields,options,status]of [[{confirmRequest:false},{account:'member'},400],[{confirmRequest:true,role:'owner'},{account:'member'},400],[{confirmRequest:true},{account:'guest'},404],[{confirmRequest:true},{},404],[{confirmRequest:true},{account:'member',headers:{Origin:'https://foreign.example.invalid'}},403],[{confirmRequest:true},{account:'member',headers:{'X-Yumunio-Expected-Account':'viewer'}},404]])await error(await f.mutate(endpoint,fields,options),status);
 await error(await f.request(endpoint,{method:'POST',account:'member',body:{expectedRevision:0,confirmRequest:true}}),409);assert.equal((await f.read()).revision,before.revision);
 for(const visibility of ['open','private']){await ok(await f.mutate(path,{name:team.name,description:team.description,visibility,defaultPermission:'editor',confirmAccessChange:true},{method:'PATCH'}));await error(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}),404);if(visibility==='private')await error(await f.request(endpoint,{account:'member'}),404);}
});
test('current-generation fences reject request approval and creation races without a partial membership or request write',async t=>{
 for(const race of ['requester-generation','requester-verification','owner-generation']){const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),endpoint=teamPath(team)+'/requests',pending=await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'})),before=await f.read();f.setBeforeWrite(()=>race==='requester-generation'?f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-member','member'):race==='requester-verification'?f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('member'):f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-owner','owner'));
  await error(await f.mutate(endpoint,{requestId:pending.requestId,accountId:'member',decision:'approve',confirmAccessChange:true},{method:'PATCH'}),race==='owner-generation'?404:409);const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);}
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),endpoint=teamPath(team)+'/requests',before=await f.read();f.setBeforeWrite(()=>f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-member','member'));await error(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}),404);assert.deepEqual((await f.read()).payload,before.payload);
});
test('stale pending generations do not disclose or grant access and are pruned only by a new explicit request',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),endpoint=teamPath(team)+'/requests';const old=await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}));f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-member','member');const before=await f.read();const mine=await ok(await f.request(endpoint,{account:'member'}));assert.equal(mine.myRequest,null);assert.equal(mine.canRequest,true);assert.deepEqual((await ok(await f.request(endpoint))).requests,[]);assert.equal((await f.read()).revision,before.revision);
 await error(await f.mutate(endpoint,{requestId:old.requestId,accountId:'member',decision:'approve',confirmAccessChange:true},{method:'PATCH'}),409,'TEAMSPACE_REQUEST_STALE');const next=await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'})),saved=await f.read();assert.notEqual(next.requestId,old.requestId);assert.equal(saved.payload.teamspaceJoinRequests.length,1);assert.equal(saved.payload.teamspaceJoinRequests[0].membershipId,'replacement-member');
});
test('duplicate excludes pending requests; direct addition and a change away from closed clear pending without changing existing sharing',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),path=teamPath(team),endpoint=path+'/requests';await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'member'}));const pending=(await f.read()).payload.teamspaceJoinRequests;const copy=await ok(await f.mutate(path+'/duplicate',{name:'Settings copy',confirmSettingsOnly:true}));assert.deepEqual((await f.read()).payload.teamspaceJoinRequests,pending);assert.deepEqual((await ok(await f.request(teamPath(copy.teamspace)+'/requests'))).requests,[]);
 await ok(await f.mutate(path+'/members',{accountId:'member',role:'member'}));assert.deepEqual((await f.read()).payload.teamspaceJoinRequests,[]);await ok(await f.mutate(endpoint,{confirmRequest:true},{account:'viewer'}));const before=await f.read();await ok(await f.mutate(path,{name:team.name,description:team.description,visibility:'private',defaultPermission:'editor',confirmAccessChange:true},{method:'PATCH'}));const saved=await f.read();assert.deepEqual(saved.payload.teamspaceJoinRequests,[]);assert.deepEqual(saved.payload.grants,before.payload.grants);await error(await f.request(endpoint,{account:'viewer'}),404);
});
test('legacy pages retain ACL and classification; new personal/team pages are created in one guarded save',async t=>{
 const f=await fixture(t),before=await f.read();const list=await ok(await f.request('/pages'));assert.equal(list.pages.find(page=>page.id==='legacy').sidebarSection,'legacy');
 assert.equal((await ok(await f.request('/teamspaces'))).teamspaces.length,0);assert.deepEqual((await f.read()).payload,before.payload);
 const personalInput={expectedRevision:(await f.read()).revision,title:'Personal',blocks:[{id:'personal-body',type:'paragraph',data:{text:''}}]};
 const personal=await ok(await f.request('/pages',{method:'POST',body:personalInput}),201);assert.equal(validateCreatedPage(personalInput,personal,{workspaceId:'workspace'}),personal);assert.equal(Object.hasOwn(personal.page,'capabilities'),false);assert.equal(Object.hasOwn(personal.page,'teamspaceId'),false);
 const loaded=await ok(await f.request('/pages/'+personal.page.id));assert.equal(validateCreatedPageProjection(personal,loaded,{workspaceId:'workspace'}),loaded);assert.equal(loaded.page.sidebarSection,'personal');assert.equal(loaded.page.teamspaceId,null);
 await error(await f.request('/pages/'+personal.page.id,{account:'second'}),404);
 const created=await f.create({visibility:'private'}),team=created.teamspace;
 const teamInput={expectedRevision:(await f.read()).revision,title:'Team page',teamspaceId:team.id,blocks:[{id:'team-body',type:'paragraph',data:{text:''}}]};
 const inTeam=await ok(await f.request('/pages',{method:'POST',body:teamInput}),201);assert.equal(validateCreatedPage(teamInput,inTeam,{workspaceId:'workspace'}),inTeam);
 const saved=await ok(await f.request('/pages/'+inTeam.page.id));assert.equal(validateCreatedPageProjection(inTeam,saved,{workspaceId:'workspace',teamspaceId:team.id}),saved);assert.equal(saved.page.teamspaceId,team.id);assert.equal(saved.page.sidebarSection,'teamspace');
 assert.equal((await f.read()).payload.teamspacePages.filter(binding=>binding.pageId===inTeam.page.id).length,1);
 await error(await f.mutate('/pages',{title:'Guest team injection',teamspaceId:team.id},{account:'guest'}),404);
 await error(await f.mutate('/pages',{title:'Nested binding injection',teamspaceId:team.id,parentId:'legacy'}),400);
});
test('open requires explicit eligible join, private existence stays hidden and workspace owner is not a team/page bypass',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create(),path=teamPath(team);
 await ok(await f.assign(await f.review(team.id)));await error(await f.request('/pages/legacy',{account:'second'}),404);
 const outsider=await ok(await f.request(path,{account:'member'}));assert.deepEqual(outsider.members,[]);assert.deepEqual(outsider.candidates,[]);assert.ok(outsider.teamspace.capabilities.includes('join'));
 await error(await f.mutate(path+'/join',{}, {account:'guest'}),404);
 const joined=await ok(await f.mutate(path+'/join',{}, {account:'member'}));assert.equal(joined.teamspace.role,'member');assert.deepEqual(joined.candidates,[]);
 const page=await ok(await f.request('/pages/legacy',{account:'member'}));assert.ok(page.page.capabilities.includes('editBody'));assert.equal(page.page.capabilities.includes('manage'),false);
 await error(await f.request('/pages/child',{account:'member'}),404);
 await error(await f.mutate(path+'/join',{}, {account:'member'}),409);
 const owner=await ok(await f.request(path));const updated=await ok(await f.mutate(path,{name:team.name,description:team.description,visibility:'private',defaultPermission:'viewer',confirmAccessChange:true},{method:'PATCH'}));assert.equal(updated.revision,owner.revision+1);
 await error(await f.request(path,{account:'second'}),404);assert.equal((await ok(await f.request('/teamspaces',{account:'second'}))).teamspaces.length,0);
 assert.equal((await ok(await f.request('/pages/legacy',{account:'member'}))).page.capabilities.includes('editBody'),false);
 const memberId=updated.members.find(member=>member.accountId==='member').id;
 await ok(await f.mutate(path+'/members',{memberId},{method:'DELETE'}));await error(await f.request('/pages/legacy',{account:'member'}),404);await error(await f.request(path,{account:'member'}),404);
});
test('assignment review binds counts/current generations, preserves explicit outside grants and rejects hidden descendant management',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'private'});
 await f.change(payload=>{payload.grants.push({id:'outside',workspaceId:'workspace',pageId:'legacy',accountId:'viewer',permission:'viewer',includeDescendants:false,status:'active'});payload.grantBindings.push({grantId:'outside',membershipId:'membership-viewer'});});
 const before=await f.read(),review=await f.review(team.id);assert.equal(review.existingGrantsPreserved,true);assert.equal(review.outsideReadersPreserved,1);assert.equal(review.teamspaceOwnersHaveFullAccess,true);assert.equal(review.actorCanReadAfter,true);assert.equal(review.actorCanManageAfter,true);
 await ok(await f.assign(review));assert.deepEqual((await f.read()).payload.grants,before.payload.grants);const outside=await ok(await f.request('/pages/legacy',{account:'viewer'}));assert.equal(outside.page.teamspaceId,null);assert.equal(outside.page.sidebarSection,'shared');
 const changed=await f.review(null);f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('new-viewer-generation','viewer');await error(await f.assign(changed),409,'TEAMSPACE_REVIEW_CHANGED');
 const current=await f.review(null),snapshot=await f.read();f.setBeforeWrite(()=>f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('second'));await error(await f.assign(current),409);const rejected=await f.read();assert.equal(rejected.revision,snapshot.revision);assert.deepEqual(rejected.payload,snapshot.payload);
 await f.change(payload=>{payload.grants=payload.grants.filter(grant=>grant.pageId!=='child');payload.grantBindings=payload.grantBindings.filter(binding=>payload.grants.some(grant=>grant.id===binding.grantId));});await error(await f.request('/pages/legacy/teamspace-review',{method:'POST',body:{expectedRevision:(await f.read()).revision,expectedVersion:(await f.read()).payload.pages[0].document.version,teamspaceId:null}}),404);
});
test('last team owner, role generations, explicit deny and archive remain effective through shared policy, external tokens and webhook authority',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create(),path=teamPath(team);await ok(await f.assign(await f.review(team.id)));
 await error(await f.mutate(path+'/members',{memberId:(await ok(await f.request(path))).members[0].id},{method:'DELETE'}),409,'LAST_TEAMSPACE_OWNER');
 await ok(await f.mutate(path+'/members',{accountId:'member',role:'owner'}));const direct=await ok(await f.request('/pages/legacy',{account:'member'}));assert.ok(direct.page.capabilities.includes('manage'));
 const row={accountId:'member',workspaceId:'workspace',pageId:'legacy',membershipId:'membership-member',actorRole:'member'},saved=await f.read();assert.ok(tokenPageContext(row,saved,validateContentPayload,{capability:'editBody'}));assert.ok(await webhookPageAuthority({workspaceId:'workspace',pageId:'legacy',accountId:'member',saved,validatePayload:validateContentPayload}));
 await ok(await f.mutate(path+'/archive',{archived:true}));const archived=await ok(await f.request('/pages/legacy',{account:'owner'}));assert.deepEqual(archived.page.capabilities,['read']);const archivedSaved=await f.read();assert.equal(tokenPageContext(row,archivedSaved,validateContentPayload,{capability:'editBody'}),null);assert.ok(tokenPageContext(row,archivedSaved,validateContentPayload));assert.equal(await webhookPageAuthority({workspaceId:'workspace',pageId:'legacy',accountId:'member',saved:archivedSaved,validatePayload:validateContentPayload}),null);
 await error(await f.mutate('/pages',{title:'Archived injection',teamspaceId:team.id}),404);await ok(await f.mutate(path+'/archive',{archived:false}));
 await f.change(payload=>{payload.grants.push({id:'deny',workspaceId:'workspace',pageId:'legacy',accountId:'member',permission:'deny',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId:'deny',membershipId:'membership-member'});});await error(await f.request('/pages/legacy',{account:'member'}),404);
 f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-member','member');assert.equal((await ok(await f.request(path,{account:'member'}))).teamspace.role,null);await error(await f.request('/pages/legacy',{account:'member'}),404);
});
test('workspace removal/demotion cannot orphan a teamspace and page movement cannot bypass assignment review',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'private'}),path=teamPath(team);await ok(await f.assign(await f.review(team.id)));
 const revision=(await f.read()).revision;
 const response=await f.collaboration.handle(new Request(origin+'/api/collaboration/workspaces/workspace/members/membership-owner',{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json','X-Fixture-Account':'second','X-Yumunio-Expected-Account':'second'},body:JSON.stringify({expectedRevision:revision,role:'guest'})}));
 await error(response,409,'LAST_TEAMSPACE_OWNER');assert.equal((await f.read()).revision,revision);
 const personal=await ok(await f.mutate('/pages',{title:'Separate personal'}),201);
 await error(await f.mutate('/pages/'+personal.page.id+'/location',{parentId:'legacy',inheritPermissions:true},{method:'PATCH'}),409,'PAGE_TEAMSPACE_REVIEW_REQUIRED');
 await ok(await f.mutate(path+'/members',{accountId:'second',role:'owner'}));await ok(await f.mutate(path+'/members',{accountId:'owner',role:'member'}));
 const state=await f.read();validateContentPayload(state.payload,'workspace');assert.ok(accountContentPolicy(state.payload,state.principals,'workspace').teamspaces.length);
});
test('teamspace requests reject forged roles, fields, origins, stale revisions and cross-workspace references without mutation',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'closed'}),path=teamPath(team),before=await f.read();
 await error(await f.request(path,{headers:{'X-Yumunio-Expected-Account':'second'}}),404);
 await error(await f.request(path,{headers:{'X-Yumunio-Expected-Account':''}}),400);
 await error(await f.mutate(path+'/members',{accountId:'member',role:'admin'}),400);
 await error(await f.mutate(path+'/members',{accountId:'guest',role:'member'}),404);
 await error(await f.mutate(path+'/members',{accountId:'member',role:'member',membershipId:'forged'}),400);
 await error(await f.mutate(path+'/join',{}, {account:'member'}),404);
 await error(await f.mutate(path+'/archive',{archived:true},{headers:{Origin:'https://foreign.example.invalid'}}),403);
 await error(await f.request(path+'/archive',{method:'POST',body:{expectedRevision:0,archived:true}}),409);
 assert.deepEqual((await f.read()).payload,before.payload);assert.equal((await f.read()).revision,before.revision);
});

test('member and owner self-exit return a sanitized success ACK while last-owner demotion is atomic and archived writes pause',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create({visibility:'private'}),path=teamPath(team);
 const initial=await ok(await f.request(path)),ownerId=initial.members[0].id;
 await error(await f.mutate(path+'/members',{accountId:'owner',role:'member'}),409,'LAST_TEAMSPACE_OWNER');
 await ok(await f.mutate(path+'/members',{accountId:'member',role:'member'}));const member=(await ok(await f.request(path))).members.find(member=>member.accountId==='member');
 const left=await ok(await f.mutate(path+'/members',{memberId:member.id},{method:'DELETE',account:'member'}));assert.equal(left.teamspace.role,null);assert.deepEqual(left.teamspace.capabilities,[]);assert.equal(left.teamspace.memberCount,0);assert.deepEqual(left.members,[]);assert.deepEqual(left.candidates,[]);await error(await f.request(path,{account:'member'}),404);
 await ok(await f.mutate(path+'/members',{accountId:'second',role:'owner'}));await ok(await f.mutate(path+'/archive',{archived:true}));
 await error(await f.mutate(path+'/members',{accountId:'member',role:'member'}),409,'TEAMSPACE_ARCHIVED');
 await error(await f.mutate(path,{name:team.name,description:team.description,visibility:'private',defaultPermission:'editor',confirmAccessChange:true},{method:'PATCH'}),409,'TEAMSPACE_ARCHIVED');
 const ownerLeft=await ok(await f.mutate(path+'/members',{memberId:ownerId},{method:'DELETE'}));assert.equal(ownerLeft.teamspace.role,null);assert.deepEqual(ownerLeft.members,[]);await error(await f.request(path),404);
 await ok(await f.mutate(path+'/archive',{archived:false},{account:'second'}));assert.equal((await ok(await f.request(path,{account:'second'}))).teamspace.role,'owner');
});
test('teamspace revocation applies to comments, people, room tickets, export and references through the central policy',async t=>{
 const f=await fixture(t),{teamspace:team}=await f.create(),path=teamPath(team);await ok(await f.assign(await f.review(team.id)));await ok(await f.mutate(path+'/join',{}, {account:'member'}));
 const opened=await ok(await f.mutate('/pages/legacy/room/open',{}, {account:'member'}),201);const headers={'X-Yumunio-Room-Ticket':opened.ticket};
 await ok(await f.request('/pages/legacy/people',{account:'member'}));await ok(await f.request('/pages/legacy/comments',{account:'member'}));assert.equal((await f.request('/export?format=json',{account:'member'})).status,200);
 const member=(await ok(await f.request(path))).members.find(member=>member.accountId==='member');await ok(await f.mutate(path+'/members',{memberId:member.id},{method:'DELETE'}));
 for(const suffix of ['/pages/legacy','/pages/legacy/comments','/pages/legacy/people','/pages/legacy/room'])await error(await f.request(suffix,{account:'member',headers}),404);
 const exported=await ok(await f.request('/export?format=json',{account:'member'}));assert.doesNotMatch(JSON.stringify(exported),/Private legacy|Private child/);
 const before=await f.read();await error(await f.request('/pages/legacy/comments',{method:'POST',account:'member',body:{expectedRevision:before.revision,blockId:null,text:'Stale writer',mentions:[]}}),404);assert.equal((await f.read()).revision,before.revision);
});
test('page review snapshot fences all membership identity/role/verification changes after its fresh recomputation',async t=>{
 for(const kind of ['generation','role','verification','addition']){
  const f=await fixture(t),{teamspace:team}=await f.create(),review=await f.review(team.id),before=await f.read();
  f.setBeforeWrite(()=>{if(kind==='generation')f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('new-generation','member');if(kind==='role')f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('admin','member');if(kind==='verification')f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('member');if(kind==='addition'){f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run('new','Synthetic new','new@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-new','workspace','new','member',stamp);}});
  await error(await f.assign(review),409);const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);
 }
});

function invalidateAlternateOwner(f,kind){
 if(kind==='verification')f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('member');
 if(kind==='generation')f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('new-owner-generation','member');
 if(kind==='removal')f.db.prepare('DELETE FROM yumunio_memberships WHERE userId=?').run('member');
}
test('team self-exit and owner demotion atomically reject a stale alternate-owner proof',async t=>{
 for(const operation of ['exit','demote'])for(const kind of ['verification','generation','removal']){
  const f=await fixture(t),{teamspace:team}=await f.create({visibility:'private'}),path=teamPath(team);
  const owners=await ok(await f.mutate(path+'/members',{accountId:'member',role:'owner'})),owner=owners.members.find(member=>member.accountId==='owner'),before=await f.read();
  f.setBeforeWrite(()=>invalidateAlternateOwner(f,kind));
  const response=operation==='exit'?await f.mutate(path+'/members',{memberId:owner.id},{method:'DELETE'}):await f.mutate(path+'/members',{accountId:'owner',role:'member'});
  await error(response,409);const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);
  assert.equal((await ok(await f.request(path))).teamspace.role,'owner');
 }
});
test('workspace demotion and removal atomically retain a team owner when its alternate loses eligibility',async t=>{
 for(const operation of ['demote','remove'])for(const kind of ['verification','generation','removal']){
  const f=await fixture(t),{teamspace:team}=await f.create({visibility:'private'}),path=teamPath(team);
  await ok(await f.mutate(path+'/members',{accountId:'member',role:'owner'}));const before=await f.read();
  f.setBeforeCollaborationCommit(()=>invalidateAlternateOwner(f,kind));
  const response=await f.collaboration.handle(new Request(origin+'/api/collaboration/workspaces/workspace/members/membership-owner',{method:operation==='remove'?'DELETE':'PATCH',headers:{Origin:origin,'Content-Type':'application/json','X-Fixture-Account':'second','X-Yumunio-Expected-Account':'second'},body:JSON.stringify({expectedRevision:before.revision,...(operation==='remove'?{}:{role:'guest'})})}));
  await error(response,409);const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);
  assert.equal(f.db.prepare('SELECT role FROM yumunio_memberships WHERE id=?').get('membership-owner').role,'owner');
 }
});
test('legacy page-manager preservation also fences alternate-manager changes at membership commit',async t=>{
 for(const kind of ['verification','generation','removal']){
  const f=await fixture(t);
  await f.change(payload=>{for(const pageId of ['legacy','child']){const id='alternate-'+pageId;payload.grants.push({id,workspaceId:'workspace',pageId,accountId:'member',permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId:id,membershipId:'membership-member'});}});
  const before=await f.read();f.setBeforeCollaborationCommit(()=>invalidateAlternateOwner(f,kind));
  const response=await f.collaboration.handle(new Request(origin+'/api/collaboration/workspaces/workspace/members/membership-owner',{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json','X-Fixture-Account':'second','X-Yumunio-Expected-Account':'second'},body:JSON.stringify({expectedRevision:before.revision,role:'guest'})}));
  await error(response,409);const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);assert.equal(f.db.prepare('SELECT role FROM yumunio_memberships WHERE id=?').get('membership-owner').role,'owner');
 }
});

test('archived teamspace pages retain their group-only last manager across workspace removal and guest demotion',async t=>{
 for(const operation of ['remove','demote']){
  const f=await fixture(t),{teamspace:team}=await f.create({visibility:'private'}),path=teamPath(team);await ok(await f.mutate(path+'/members',{accountId:'second',role:'owner'}));await ok(await f.assign(await f.review(team.id)));
  const {group}=await ok(await f.mutate('/groups',{name:'Only page managers'}));await ok(await f.mutate('/groups/'+group.id+'/members',{accountId:'member',confirmAccessChange:true}));await ok(await f.mutate('/pages/legacy/group-grants',{groupId:group.id,permission:'full',includeDescendants:false,confirmAccessChange:true}));
  await ok(await f.mutate('/pages/legacy/grants',{accountId:'second',permission:'deny'}));await ok(await f.mutate('/pages/legacy/grants',{accountId:'owner',permission:'deny'}));assert.ok((await ok(await f.request('/pages/legacy',{account:'member'}))).page.capabilities.includes('manage'));
  await ok(await f.mutate(path+'/archive',{archived:true}));assert.deepEqual((await ok(await f.request('/pages/legacy',{account:'member'}))).page.capabilities,['read']);const before=await f.read();
  const response=await f.collaboration.handle(new Request(origin+'/api/collaboration/workspaces/workspace/members/membership-member',{method:operation==='remove'?'DELETE':'PATCH',headers:{Origin:origin,'Content-Type':'application/json','X-Fixture-Account':'second','X-Yumunio-Expected-Account':'second'},body:JSON.stringify({expectedRevision:before.revision,...(operation==='remove'?{}:{role:'guest'})})}));
  await error(response,409,'LAST_PAGE_MANAGER');const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);assert.equal(f.db.prepare('SELECT role FROM yumunio_memberships WHERE id=?').get('membership-member').role,'member');
  await ok(await f.mutate(path+'/archive',{archived:false}));assert.ok((await ok(await f.request('/pages/legacy',{account:'member'}))).page.capabilities.includes('manage'));
 }
});

test('an archived team owner cannot exit when every remaining team owner is denied the only managed page',async t=>{
 const f=await fixture(t),created=await f.create({visibility:'private'}),team=created.teamspace,path=teamPath(team),ownerId=created.members.find(member=>member.accountId==='owner').id;await ok(await f.mutate(path+'/members',{accountId:'second',role:'owner'}));await ok(await f.assign(await f.review(team.id)));
 await ok(await f.mutate('/pages/legacy/grants',{accountId:'second',permission:'deny'}));await f.change(payload=>{const removed=new Set(payload.grants.filter(grant=>grant.pageId==='legacy'&&grant.accountId==='owner').map(grant=>grant.id));payload.grants=payload.grants.filter(grant=>!removed.has(grant.id));payload.grantBindings=payload.grantBindings.filter(binding=>!removed.has(binding.grantId));});
 assert.ok((await ok(await f.request('/pages/legacy'))).page.capabilities.includes('manage'));await ok(await f.mutate(path+'/archive',{archived:true}));const before=await f.read();await error(await f.mutate(path+'/members',{memberId:ownerId},{method:'DELETE'}),409,'LAST_PAGE_MANAGER');const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);assert.equal((await ok(await f.request(path))).teamspace.role,'owner');
 await ok(await f.mutate(path+'/archive',{archived:false}));assert.ok((await ok(await f.request('/pages/legacy'))).page.capabilities.includes('manage'));
});

test('duplicate copies settings in one CAS with one fresh current owner and no pages, members or source mutations',async t=>{
 const f=await fixture(t),{teamspace:source}=await f.create({visibility:'private',description:'Copy this policy',defaultPermission:'commenter'}),path=teamPath(source);
 await ok(await f.mutate(path+'/members',{accountId:'member',role:'owner'}));await ok(await f.assign(await f.review(source.id)));
 const before=await f.read(),original=before.payload.teamspaces.find(item=>item.id===source.id);
 const copied=await ok(await f.mutate(path+'/duplicate',{name:'Policy copy',confirmSettingsOnly:true},{account:'member'}));
 assert.equal(copied.revision,before.revision+1);assert.notEqual(copied.teamspace.id,source.id);assert.equal(copied.teamspace.name,'Policy copy');
 for(const key of ['description','visibility','defaultPermission'])assert.equal(copied.teamspace[key],original[key]);
 assert.equal(copied.teamspace.archivedAt,null);assert.equal(copied.teamspace.role,'owner');assert.equal(copied.teamspace.memberCount,1);assert.deepEqual(copied.members.map(item=>[item.accountId,item.role,item.currentUser]),[['member','owner',true]]);
 const after=await f.read();assert.deepEqual(after.payload.teamspaces.find(item=>item.id===source.id),original);
 assert.deepEqual(after.payload.teamspaceMembers.filter(item=>item.teamspaceId===source.id),before.payload.teamspaceMembers.filter(item=>item.teamspaceId===source.id));
 assert.equal(after.payload.teamspacePages.some(item=>item.teamspaceId===copied.teamspace.id),false);
 for(const key of Object.keys(before.payload).filter(key=>!['teamspaces','teamspaceMembers'].includes(key)))assert.deepEqual(after.payload[key],before.payload[key],key);
 const ownerBinding=after.payload.teamspaceMembers.find(item=>item.teamspaceId===copied.teamspace.id);assert.equal(ownerBinding.membershipId,'membership-member');assert.equal(before.payload.teamspaceMembers.some(item=>item.id===ownerBinding.id),false);
 await error(await f.request(teamPath(copied.teamspace)),404);assert.ok((await ok(await f.request('/pages/legacy',{account:'owner'}))).page.capabilities.includes('manage'));
});

test('duplicate requires an active owner, explicit settings-only consent and exact fields without stale or forged writes',async t=>{
 const f=await fixture(t),{teamspace:source}=await f.create({visibility:'private'}),path=teamPath(source),before=await f.read();
 for(const account of ['second','member','guest'])await error(await f.mutate(path+'/duplicate',{name:'Copy',confirmSettingsOnly:true},{account}),404);
 for(const fields of [{name:'Copy',confirmSettingsOnly:false},{name:'Copy'},{name:'Copy',confirmSettingsOnly:true,members:[]},{name:'Copy',confirmSettingsOnly:true,visibility:'open'},{name:' ',confirmSettingsOnly:true}])await error(await f.mutate(path+'/duplicate',fields),400);
 await error(await f.request(path+'/duplicate',{method:'POST',body:{expectedRevision:0,name:'Stale',confirmSettingsOnly:true}}),409);
 await error(await f.mutate(path+'/duplicate',{name:'Copy',confirmSettingsOnly:true},{headers:{Origin:'https://foreign.example.invalid'}}),403);
 assert.deepEqual(await f.read(),before);
 await ok(await f.mutate(path+'/members',{accountId:'member',role:'member'}));await error(await f.mutate(path+'/duplicate',{name:'Copy',confirmSettingsOnly:true},{account:'member'}),404);
 await ok(await f.mutate(path+'/archive',{archived:true}));const archived=await f.read();await error(await f.mutate(path+'/duplicate',{name:'Copy',confirmSettingsOnly:true}),409,'TEAMSPACE_ARCHIVED');assert.deepEqual(await f.read(),archived);
});

test('duplicate rejects a changed creator membership at the same storage CAS',async t=>{
 for(const kind of ['generation','verification']){
  const f=await fixture(t),{teamspace:source}=await f.create({visibility:'private'}),path=teamPath(source);
  const before=await f.read();
  if(kind==='generation')f.setBeforeWrite(()=>f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-owner','owner'));
  if(kind==='verification')f.setBeforeWrite(()=>f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('owner'));
  await error(await f.mutate(path+'/duplicate',{name:'Copy',confirmSettingsOnly:true}),404);
  const after=f.db.prepare('SELECT revision,payload_json FROM yumunio_account_content WHERE workspace_id=?').get('workspace');assert.equal(after.revision,before.revision);assert.deepEqual(JSON.parse(after.payload_json),before.payload);
 }
});

test('creation and duplication grow past 64 teams and a full source membership does not exhaust other teams',async t=>{
 const f=await fixture(t),{teamspace:source}=await f.create({visibility:'private'});
 await f.change(payload=>{for(let index=1;index<70;index++){
  const id='team-'+index;payload.teamspaces.push({...payload.teamspaces[0],id,name:'Team '+index});payload.teamspaceMembers.push({id:'owner-'+index,workspaceId:'workspace',teamspaceId:id,accountId:'owner',membershipId:'membership-owner',role:'owner'});
 }for(let index=1;index<1000;index++)payload.teamspaceMembers.push({id:'source-member-'+index,workspaceId:'workspace',teamspaceId:source.id,accountId:'synthetic-person-'+index,membershipId:'generation-'+index,role:'member'});});
 const created=await f.create({name:'Next team',visibility:'private'});assert.equal(created.teamspace.memberCount,1);
 const copy=await ok(await f.mutate(teamPath(source)+'/duplicate',{name:'Copy',confirmSettingsOnly:true}));assert.equal(copy.members.length,1);assert.equal(copy.members[0].accountId,'owner');
 const listed=await ok(await f.request('/teamspaces'));assert.equal(listed.teamspaces.length,72);
 assert.equal((await ok(await f.request('/teamspaces',{account:'second'}))).teamspaces.length,0);
 assert.equal((await f.read()).payload.teamspaceMembers.filter(row=>row.teamspaceId===source.id).length,1000);
});

test('duplicate cannot commit after source settings or its creator ownership changes before storage CAS',async t=>{
 for(const kind of ['settings','owner']){
  const f=await fixture(t),{teamspace:source}=await f.create({visibility:'private'}),path=teamPath(source);await ok(await f.mutate(path+'/members',{accountId:'member',role:'owner'}));const before=await f.read();
  f.setBeforeWrite(()=>f.change(payload=>{if(kind==='settings')payload.teamspaces.find(item=>item.id===source.id).defaultPermission='viewer';else payload.teamspaceMembers=payload.teamspaceMembers.filter(item=>item.accountId!=='owner');}));
  await error(await f.mutate(path+'/duplicate',{name:'Copy',confirmSettingsOnly:true}),kind==='settings'?409:404);
  const after=await f.read();assert.equal(after.revision,before.revision+1);assert.equal(after.payload.teamspaces.length,1);assert.equal(after.payload.teamspaceMembers.some(item=>item.teamspaceId!==source.id),false);assert.deepEqual(after.payload.pages,before.payload.pages);
 }
});
