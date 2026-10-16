import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {createApiTokenApi} from '../src/api-tokens.js';
import {createSqliteApiTokenStore} from '../src/api-token-store.js';
import {createExternalPageActions} from '../src/external-page-actions.js';
import {createMcpApi} from '../src/mcp.js';

const origin='https://resource-access.example.invalid',workspaceId='studio',base='/api/content/workspaces/'+workspaceId,stamp='2026-10-16T00:00:00.000Z';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),tokensSchema=await readFile(new URL('../schema/api-tokens.sqlite.sql',import.meta.url),'utf8');
async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(tokensSchema);t.after(()=>db.close());db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Synthetic resource fixture','resource-fixture',stamp);
 for(const[account,role]of [['owner','owner'],['ren','member'],['person','member'],['admin','admin'],['guest','guest']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(account,'Synthetic '+account,account+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+account,workspaceId,account,role,stamp);}
 const resolveSession=async request=>{const account=request.headers.get('x-fixture-account'),user=db.prepare('SELECT id,emailVerified FROM yumunio_users WHERE id=?').get(account??'');return user?{user:{id:user.id,emailVerified:user.emailVerified===1}}:null;},raw=createSqliteContentStore(db);let beforeWrite=null,id=0;
 const store={read:(...args)=>raw.read(...args),write:async(...args)=>{if(beforeWrite){const callback=beforeWrite;beforeWrite=null;await callback();}return raw.write(...args);}};
 const content=createAccountContentApi({store,origin,resolveSession,now:()=>stamp,createId:()=> 'resource-'+ ++id,roomSecret:'Synthetic resource-access room secret'}),tokenStore=createSqliteApiTokenStore(db),actions=createExternalPageActions({store:tokenStore,contentStore:store,origin,enabled:true,now:()=>stamp}),tokens=createApiTokenApi({store:tokenStore,contentStore:store,actions,origin,enabled:true,resolveSession,now:()=>stamp}),mcp=createMcpApi({actions,origin,enabled:true,resolveSession});
 const headers=(account,body)=>({Origin:origin,'x-fixture-account':account,'X-Yumunio-Expected-Account':account,...(body===undefined?{}:{'Content-Type':'application/json'})});
 const request=(path,{account='owner',method='GET',body,extraHeaders={}}={})=>content(new Request(origin+base+path,{method,headers:{...headers(account,body),...extraHeaders},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const read=()=>raw.read(workspaceId,'owner'),revision=async()=>(await read())?.revision??0;
 const mutate=async(path,body={},options={})=>request(path,{method:'POST',body:{expectedRevision:await revision(),...body},...options});
 const rewrite=async mutatePayload=>{const saved=await read();mutatePayload(saved.payload);validateContentPayload(saved.payload,workspaceId);db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(saved.payload),workspaceId);};
 const collection=await ok(await mutate('/collections',{title:'Shared collection',parentId:null,properties:[{id:'text',name:'Notes',type:'text'}]}),201),rows=[];
 for(const name of ['First visible row','Second visible row'])rows.push((await ok(await mutate('/collections/'+collection.collectionId+'/records',{title:name,values:{text:name}}),201)).record);
 const page=await ok(await mutate('/pages',{title:'Private standalone',blocks:[{id:'private-standalone-body',type:'paragraph',data:{text:'Unshared standalone content'}}]}),201);
 const group=async()=> (await ok(await mutate('/groups',{name:'Writers role'}))).group;
 const roleMember=(groupId,account='ren')=>mutate('/groups/'+groupId+'/members',{accountId:account,confirmAccessChange:true});
 const roleGrant=(groupId,pageId=collection.pageId,permission='editor',includeDescendants=true,options={})=>mutate('/pages/'+pageId+'/group-grants',{groupId,permission,includeDescendants,confirmAccessChange:true},options);
 const personGrant=(accountId,pageId=collection.pageId,permission='viewer',includeDescendants=true,options={})=>mutate('/pages/'+pageId+'/grants',{accountId,permission,includeDescendants},options);
 const issue=async(account,pageId)=>ok(await tokens(new Request(origin+'/api/integrations/tokens',{method:'POST',headers:headers(account,{}),body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:await revision(),workspaceId,pageId,name:'Synthetic resource reader',scopes:['page:read','document:read','mcp:connect'],expiresAt:'2026-10-23T00:00:00.000Z',confirmPageAccess:true})})),201);
 const external=(token,pageId)=>tokens(new Request(origin+'/api/v1/pages/'+pageId+'/document',{headers:{Authorization:'Bearer '+token}}));
 const mcpClient=async token=>{const client=new Client({name:'resource-fixture',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(origin+'/api/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}},fetch:(input,init)=>mcp(new Request(input,init))});await client.connect(transport);t.after(()=>client.close());return client;};
 return{db,raw,store,read,revision,request,mutate,rewrite,collection,rows,page,group,roleMember,roleGrant,personGrant,issue,external,mcpClient,setBeforeWrite:fn=>beforeWrite=fn};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return response.json();}
async function denied(response,status=404,code){const value=await ok(response,status);if(code)assert.equal(value.error.code,code);assert.doesNotMatch(JSON.stringify(value),/membership-|payload_json|Unshared standalone content/);return value;}
const collectionPath=f=>'/collections/'+f.collection.collectionId;

test('role and individual collection sharing reach rows, filtered exports, external tokens and real MCP actions through one current ACL',async t=>{
 const f=await fixture(t),role=await f.group();await ok(await f.roleMember(role.id));const roleAck=await ok(await f.roleGrant(role.id));const individual=await ok(await f.personGrant('person'));
 for(const account of ['ren','person']){const value=await ok(await f.request(collectionPath(f),{account}));assert.deepEqual(value.collection.records.map(row=>row.id),f.rows.map(row=>row.id));const exported=await ok(await f.request('/export?format=json',{account}));assert.match(JSON.stringify(exported),/First visible row/);assert.doesNotMatch(JSON.stringify(exported),/Private standalone|Unshared standalone content/);await denied(await f.request('/pages/'+f.page.page.id,{account}));}
 await denied(await f.request(collectionPath(f),{account:'admin'}));await denied(await f.mutate('/groups',{name:'Workspace admin escalation'},{account:'ren'}));
 const updated=await ok(await f.mutate(collectionPath(f)+'/records/'+f.rows[0].id,{values:{text:'Edited through role'}},{method:'PATCH',account:'ren'}));assert.equal(updated.record.values.text,'Edited through role');await denied(await f.mutate(collectionPath(f)+'/records/'+f.rows[0].id,{values:{text:'Viewer cannot edit'}},{method:'PATCH',account:'person'}));
 const roleToken=await f.issue('ren',f.rows[0].pageId),personToken=await f.issue('person',f.rows[0].pageId),client=await f.mcpClient(roleToken.token);assert.equal((await ok(await f.external(roleToken.token,f.rows[0].pageId))).page.title,'First visible row');assert.equal((await client.callTool({name:'get_document',arguments:{}})).structuredContent.page.id,f.rows[0].pageId);
 await ok(await f.mutate('/pages/'+f.collection.pageId+'/group-grants',{grantId:roleAck.grants[0].id,confirmAccessChange:true},{method:'DELETE'}));await denied(await f.request(collectionPath(f),{account:'ren'}));await denied(await f.external(roleToken.token,f.rows[0].pageId),401,'API_TOKEN_UNAVAILABLE');await assert.rejects(client.callTool({name:'get_document',arguments:{}}));assert.equal((await ok(await f.external(personToken.token,f.rows[0].pageId))).page.id,f.rows[0].pageId);
 await ok(await f.mutate('/pages/'+f.collection.pageId+'/grants/'+individual.grant.id,{}, {method:'DELETE'}));await denied(await f.request(collectionPath(f),{account:'person'}));await denied(await f.external(personToken.token,f.rows[0].pageId),401,'API_TOKEN_UNAVAILABLE');
});

test('inheritance boundaries, direct denies and current membership generations filter collection rows without altering stored data',async t=>{
 const f=await fixture(t),role=await f.group();await ok(await f.roleMember(role.id));await ok(await f.roleGrant(role.id));await f.rewrite(payload=>{payload.pages.find(item=>item.page.id===f.rows[1].pageId).inheritPermissions=false;});
 let projected=await ok(await f.request(collectionPath(f),{account:'ren'}));assert.deepEqual(projected.collection.records.map(row=>row.id),[f.rows[0].id]);await denied(await f.request('/pages/'+f.rows[1].pageId,{account:'ren'}));const token=await f.issue('ren',f.rows[0].pageId),client=await f.mcpClient(token.token);
 await ok(await f.personGrant('ren',f.rows[0].pageId,'deny',false));projected=await ok(await f.request(collectionPath(f),{account:'ren'}));assert.deepEqual(projected.collection.records,[]);assert.doesNotMatch(JSON.stringify(await ok(await f.request('/export?format=json',{account:'ren'}))),/First visible row|Second visible row/);await denied(await f.external(token.token,f.rows[0].pageId),401);await assert.rejects(client.callTool({name:'get_page',arguments:{}}));
 const before=await f.read();f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('ren-rejoined','ren');await denied(await f.request(collectionPath(f),{account:'ren'}));assert.equal((await f.read()).revision,before.revision);assert.deepEqual((await f.read()).payload,before.payload);
});

test('guest access requires explicit individual sharing and cannot acquire a role or create collection records',async t=>{
 const f=await fixture(t),role=await f.group();await denied(await f.request(collectionPath(f),{account:'guest'}));await denied(await f.roleMember(role.id,'guest'));await denied(await f.mutate('/groups',{name:'Guest role'},{account:'guest'}));await ok(await f.personGrant('guest',f.collection.pageId,'full',true));const visible=await ok(await f.request(collectionPath(f),{account:'guest'}));assert.equal(visible.collection.records.length,2);await denied(await f.mutate(collectionPath(f)+'/records',{title:'Guest-created row',values:{text:'forged'}},{account:'guest'}));await denied(await f.request('/groups',{account:'guest'}));await denied(await f.request('/pages/'+f.page.page.id,{account:'guest'}));
});

test('individual access writes fence unrelated roster generation, verification and role races in the same CAS',async t=>{
 for(const race of ['generation','verified','role']){const f=await fixture(t),before=await f.read();f.setBeforeWrite(()=>race==='generation'?f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('admin-rejoined','admin'):race==='verified'?f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('admin'):f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('guest','admin'));await denied(await f.personGrant('person'),409,'CONTENT_CONFLICT');const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);}
});

test('shrinking and revoking either inherited individual or role sharing require management of every recoverable descendant',async t=>{
 for(const kind of ['individual','role'])for(const operation of ['shrink','revoke']){const f=await fixture(t),role=await f.group();await ok(await f.roleMember(role.id,'person'));const shared=await ok(await(kind==='role'?f.roleGrant(role.id,f.collection.pageId,'deny',true):f.personGrant('person',f.collection.pageId,'deny',true)));await ok(await f.personGrant('ren',f.collection.pageId,'full',false));await ok(await f.personGrant('ren',f.rows[0].pageId,'deny',false));await f.rewrite(payload=>{payload.pages.find(item=>item.page.id===f.rows[0].pageId).page.trashedAt=stamp;});const before=await f.read();
  const result=kind==='role'?operation==='shrink'?await f.roleGrant(role.id,f.collection.pageId,'deny',false,{account:'ren'}):await f.mutate('/pages/'+f.collection.pageId+'/group-grants',{grantId:shared.grants[0].id,confirmAccessChange:true},{method:'DELETE',account:'ren'}):operation==='shrink'?await f.personGrant('person',f.collection.pageId,'deny',false,{account:'ren'}):await f.mutate('/pages/'+f.collection.pageId+'/grants/'+shared.grant.id,{}, {method:'DELETE',account:'ren'});
  await denied(result,404,'CONTENT_NOT_FOUND');const after=await f.read();assert.equal(after.revision,before.revision,kind+' '+operation);assert.deepEqual(after.payload,before.payload);}
});

test('individual revoke and role archive cannot orphan the last manager of a trashed collection record',async t=>{
 for(const kind of ['individual','role']){const f=await fixture(t),role=await f.group();await ok(await f.roleMember(role.id));const granted=await ok(await(kind==='role'?f.roleGrant(role.id,f.collection.pageId,'full',true):f.personGrant('ren',f.collection.pageId,'full',true)));await f.rewrite(payload=>{const page=payload.pages.find(item=>item.page.id===f.rows[0].pageId);page.page.trashedAt=stamp;const ids=new Set(payload.grants.filter(grant=>grant.pageId===page.page.id&&grant.accountId==='owner').map(grant=>grant.id));payload.grants=payload.grants.filter(grant=>!ids.has(grant.id));payload.grantBindings=payload.grantBindings.filter(binding=>!ids.has(binding.grantId));for(const grant of payload.grants)if(grant.pageId===f.collection.pageId&&grant.accountId==='owner')grant.includeDescendants=false;});const before=await f.read();
  const response=kind==='role'?await f.mutate('/groups/'+role.id+'/archive',{archived:true,confirmAccessChange:true}):await f.mutate('/pages/'+f.collection.pageId+'/grants/'+granted.grant.id,{}, {method:'DELETE',account:'ren'});await denied(response,409,'LAST_PAGE_MANAGER');const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);}
});

test('an archived team does not conceal a recoverable collection record losing its only manager through role archive',async t=>{
 const f=await fixture(t),role=await f.group();await ok(await f.roleMember(role.id));await ok(await f.roleGrant(role.id,f.collection.pageId,'full',true));await ok(await f.personGrant('owner',f.rows[0].pageId,'deny',false));await f.rewrite(payload=>{payload.teamspaces=[{id:'archived-team',workspaceId,name:'Archived resource team',description:'',visibility:'private',defaultPermission:'viewer',createdAt:stamp,updatedAt:stamp,archivedAt:stamp}];payload.teamspaceMembers=[{id:'team-owner',workspaceId,teamspaceId:'archived-team',accountId:'owner',membershipId:'membership-owner',role:'owner'}];payload.teamspacePages=[{workspaceId,pageId:f.collection.pageId,teamspaceId:'archived-team'}];});const before=await f.read();assert.deepEqual((await ok(await f.request('/pages/'+f.rows[0].pageId,{account:'ren'}))).page.capabilities,['read']);await denied(await f.mutate('/groups/'+role.id+'/archive',{archived:true,confirmAccessChange:true}),409,'LAST_PAGE_MANAGER');const after=await f.read();assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);
});

test('access transitions invalidate only changed collection rooms and retain unrelated room epochs',async t=>{
 const f=await fixture(t),role=await f.group();await ok(await f.roleMember(role.id));await ok(await f.mutate('/pages/'+f.rows[0].pageId+'/room/open',{}),201);await ok(await f.mutate('/pages/'+f.page.page.id+'/room/open',{}),201);const before=await f.read(),unrelated=before.payload.rooms.find(room=>room.pageId===f.page.page.id);assert.equal(before.payload.rooms.length,2);await ok(await f.roleGrant(role.id));assert.deepEqual((await f.read()).payload.rooms,[unrelated]);
});
