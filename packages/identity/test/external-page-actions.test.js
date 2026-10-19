import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createApiTokenApi} from '../src/api-tokens.js';
import {createExternalPageActions} from '../src/external-page-actions.js';
import {createSqliteApiTokenStore,createD1ApiTokenStore} from '../src/api-token-store.js';
import {createSqliteContentStore,createD1ContentStore,SqlAccountContentStore} from '../src/content-store.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),origin='https://external-actions.example.invalid';
const readScopes=['page:read','document:read'],writeScopes=[...readScopes,'document:write'];
const fails=status=>error=>error.status===status;

function fixture(t,{driver='sqlite',permission='editor',enabled=true,source=false,now=()=>new Date().toISOString()}={}){
 const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());const stamp=new Date().toISOString();
 db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run('actor','Synthetic actor','actor@example.invalid',stamp,stamp);
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run('workspace','Synthetic workspace','external-actions',stamp);
 db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership','workspace','actor','member',stamp);
 const execute=(sql,params=[])=>{const statement=db.prepare(sql);return /^\s*SELECT\b/i.test(sql)?{rows:statement.all(...params),changes:0}:{rows:[],changes:Number(statement.run(...params).changes)};};
 const prepare=(sql,params=[])=>({sql,params,bind(...params){return prepare(sql,params);},async all(){const result=execute(sql,params);return{success:true,results:result.rows,meta:{changes:result.changes}};}});
 const d1={prepare,async batch(commands){db.exec('BEGIN IMMEDIATE');try{const values=[];for(const command of commands)values.push(await command.all());db.exec('COMMIT');return values;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const commands=[],networkQuery=async(sql,params=[])=>{commands.push({sql,params});const translated=sql.replace(/\bBINARY /g,'').replace(/\$\d+/g,'?').replace("to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')","strftime('%Y-%m-%dT%H:%M:%fZ','now')").replace("CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%f'),23),'Z')","strftime('%Y-%m-%dT%H:%M:%fZ','now')"),result=execute(translated,params);return{rows:result.rows,affectedRows:result.changes};};
 const raw=driver==='d1'?createD1ContentStore(d1):['mysql','postgres'].includes(driver)?new SqlAccountContentStore({dialect:driver,query:networkQuery}):createSqliteContentStore(db),tokens=driver==='d1'?createD1ApiTokenStore(d1):createSqliteApiTokenStore(db);
 let beforeWrite=null,writes=0,sessions=0,tokenReads=0;
 const content={read:raw.read.bind(raw),async write(...args){if(args[2].tokenGuard){writes++;const hook=beforeWrite;beforeWrite=null;await hook?.(args[2]);}return raw.write(...args);}};
 const tokenStore={list:tokens.list.bind(tokens),create:tokens.create.bind(tokens),revoke:tokens.revoke.bind(tokens),readExternal(...args){tokenReads++;return tokens.readExternal(...args);}};
 const actions=createExternalPageActions({store:tokenStore,contentStore:content,origin,enabled,now});
 const api=createApiTokenApi({store:tokenStore,contentStore:content,origin,enabled,now,actions,resolveSession:async request=>{sessions++;return request.headers.get('x-fixture-account')==='actor'?{user:{id:'actor',emailVerified:true}}:null;}});
 const payload={schemaVersion:1,pages:[{page:{id:'page',workspaceId:'workspace',parentId:null,title:'Original',createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:'page',workspaceId:'workspace',version:1,updatedAt:stamp,blocks:[{id:'body',type:'paragraph',data:{text:'Hello world',marks:[{start:0,end:5,styles:['bold']}],mentions:[{kind:'person',accountId:'actor',membershipId:'membership',start:0,end:5}],links:[{start:6,end:11,label:'world',pageId:'hidden-target'}],objectKey:'private-locator'}},...(source?[{id:'source',type:'code',data:{text:'Private raw import source',purpose:'import-source'}}]:[])]},inheritPermissions:false}],grants:[{id:'grant',workspaceId:'workspace',pageId:'page',accountId:'actor',permission,includeDescendants:false,status:'active'}],grantBindings:[{grantId:'grant',membershipId:'membership'}]};
 const request=(path,{method='GET',body,authorization,account=true,headers={}}={})=>api(new Request(origin+path,{method,headers:{Origin:origin,...(account?{'X-Fixture-Account':'actor','X-Yumunio-Expected-Account':'actor'}:{}),...(authorization?{Authorization:authorization}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const issue=async(scopes=writeScopes)=>{const response=await request('/api/integrations/tokens',{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:(await raw.read('workspace','actor')).revision,workspaceId:'workspace',pageId:'page',name:'Synthetic capability',scopes,expiresAt:new Date(Date.now()+86400000).toISOString(),confirmPageAccess:true}});assert.equal(response.status,201,await response.clone().text());const value=await response.json();return{...value,authorization:'Bearer '+value.token};};
 return{db,raw,content,actions,payload,request,issue,commands,seed:()=>raw.write('workspace','actor',{expectedRevision:0,payload,actorMembershipId:'membership',actorRole:'member'}),beforeWrite:hook=>beforeWrite=hook,get writes(){return writes;},get sessions(){return sessions;},get tokenReads(){return tokenReads;}};
}

for(const driver of ['sqlite','d1'])test('incremental block edits preserve omitted source and private metadata atomically on '+driver,async t=>{
 const f=fixture(t,{driver,source:true});await f.seed();const writer=await f.issue(),sessions=f.sessions;
 const response=await f.request('/api/v1/pages/page/blocks',{method:'PATCH',authorization:writer.authorization,body:{expectedVersion:1,operations:[{type:'update',blockId:'body',data:{text:'X Hello world'}},{type:'append',parentId:'body',blocks:[{type:'paragraph',data:{text:'Nested child'}}]},{type:'append',blocks:[{type:'checklist',data:{text:'Added task',checked:false}}]}]}});
 assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.page.version,2);assert.equal(result.omittedBlocks,1);assert.match(result.document.blocks[1].id,/^[a-f0-9-]{36}$/);assert.equal(result.document.blocks[0].children[0].data.text,'Nested child');assert.doesNotMatch(JSON.stringify(result),/Private raw import source|private-locator|hidden-target/);assert.equal(f.sessions,sessions);
 const saved=await f.raw.read('workspace','actor');assert.equal(saved.payload.pages[0].document.blocks[1].data.purpose,'import-source');assert.equal(saved.payload.pages[0].document.blocks[0].data.objectKey,'private-locator');assert.deepEqual(saved.payload.pages[0].document.blocks[0].data.marks,[{start:2,end:7,styles:['bold']}]);assert.equal(saved.payload.history.length,1);
 const before=await f.raw.read('workspace','actor');
 for(const operations of [[{type:'append',blocks:[{type:'paragraph',data:{text:'Must roll back'}}]},{type:'delete',blockId:'source'}],[{type:'update',blockId:'body',data:{mentions:[]}}],[{type:'append',blocks:[{id:'body',type:'paragraph',data:{text:'Collision'}}]}]]){
  const rejected=await f.request('/api/v1/pages/page/blocks',{method:'PATCH',authorization:writer.authorization,body:{expectedVersion:2,operations}});assert.ok([400,409].includes(rejected.status),await rejected.text());assert.deepEqual(await f.raw.read('workspace','actor'),before);
 }
 const deleted=await f.actions.execute({authorization:writer.authorization,action:'blocks.edit',input:{expectedVersion:2,operations:[{type:'delete',blockId:result.document.blocks[1].id}]}});assert.equal(deleted.page.version,3);assert.equal(deleted.document.blocks.length,1);
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'blocks.edit',input:{expectedVersion:2,operations:[{type:'append',blocks:[{type:'paragraph',data:{text:'Stale'}}]}]}}),fails(409));
});

test('incremental edits cannot target omitted descendants or delete a visible parent containing hidden blocks',async t=>{
 const f=fixture(t);f.payload.pages[0].document.blocks[0].children=[{id:'hidden-parent',type:'unknown',children:[{id:'hidden-child',type:'paragraph',data:{text:'Private descendant'}}]}];await f.seed();const writer=await f.issue(),before=await f.raw.read('workspace','actor');
 for(const operation of [{type:'update',blockId:'hidden-child',data:{text:'Denied'}},{type:'delete',blockId:'body'},{type:'append',parentId:'hidden-child',blocks:[{type:'paragraph',data:{text:'Denied'}}]}]){
  await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'blocks.edit',input:{expectedVersion:1,operations:[operation]}}),fails(409));assert.deepEqual(await f.raw.read('workspace','actor'),before);
 }
 const result=await f.actions.execute({authorization:writer.authorization,action:'blocks.edit',input:{expectedVersion:1,operations:[{type:'update',blockId:'body',data:{text:'Updated visible parent'}}]}});assert.equal(result.page.version,2);assert.deepEqual((await f.raw.read('workspace','actor')).payload.pages[0].document.blocks[0].children,before.payload.pages[0].document.blocks[0].children);
});

test('incremental editing requires write consent and current revocation guard at commit',async t=>{
 const f=fixture(t);await f.seed();const reader=await f.issue(readScopes),writer=await f.issue(),input={expectedVersion:1,operations:[{type:'append',blocks:[{type:'paragraph',data:{text:'Denied'}}]}]};
 assert.equal((await f.request('/api/v1/pages/page/blocks',{method:'PATCH',authorization:reader.authorization,body:input})).status,401);assert.equal((await f.request('/api/v1/pages/page/blocks',{authorization:writer.authorization})).status,405);
 f.beforeWrite(()=>f.db.prepare('UPDATE yumunio_api_tokens SET revoked_at=?,active_slot=NULL,version=version+1 WHERE id=?').run(new Date().toISOString(),writer.metadata.id));
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'blocks.edit',input}),fails(401));assert.equal((await f.raw.read('workspace','actor')).payload.pages[0].document.version,1);
});

test('explicit write consent requires current edit ACL; read credentials never acquire write or MCP access',async t=>{
 const f=fixture(t,{permission:'viewer'});await f.seed();const reader=await f.issue(readScopes),sessions=f.sessions;
 await assert.rejects(f.actions.execute({authorization:reader.authorization,pageId:'page',action:'document.write',input:{expectedVersion:1,title:'Denied'}}),fails(401));
 await assert.rejects(f.actions.authorize({authorization:reader.authorization,scope:'mcp:connect'}),fails(401));
 const denied=await f.request('/api/integrations/tokens',{method:'POST',body:{requestId:crypto.randomUUID(),expectedRevision:1,workspaceId:'workspace',pageId:'page',name:'Denied writer',scopes:writeScopes,expiresAt:new Date(Date.now()+86400000).toISOString(),confirmPageAccess:true}});assert.equal(denied.status,404);
 assert.equal(f.writes,0);assert.equal(f.sessions,sessions+1);
});

test('shared discovery returns only bound page and live capability scopes; opaque credential details stay private',async t=>{
 const f=fixture(t);await f.seed();const writer=await f.issue([...writeScopes,'mcp:connect']),value=await f.actions.authorize({authorization:writer.authorization,scope:'mcp:connect'});
 assert.deepEqual(value,{pageId:'page',scopes:[...writeScopes,'mcp:connect']});assert.ok(Object.isFrozen(value));assert.ok(Object.isFrozen(value.scopes));assert.doesNotMatch(JSON.stringify(value),/workspace|membership|actor|tokenHash/);
 f.payload.grants[0].permission='viewer';await f.raw.write('workspace','actor',{expectedRevision:1,payload:f.payload,actorMembershipId:'membership',actorRole:'member'});
 assert.deepEqual((await f.actions.authorize({authorization:writer.authorization,scope:'mcp:connect'})).scopes,[...readScopes,'mcp:connect']);
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',requiredScopes:['mcp:connect'],input:{expectedVersion:1,title:'Denied'}}),fails(401));
});

test('write uses the content engine CAS and history while preserving hidden metadata and rebasing shared inline ranges',async t=>{
 const f=fixture(t);await f.seed();const writer=await f.issue(),sessions=f.sessions;
 const response=await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization:writer.authorization,body:{expectedVersion:1,title:'Literal <script>title</script>',blocks:[{id:'body',type:'paragraph',data:{text:'X Hello world'}}]}});
 assert.equal(response.status,200,await response.clone().text());const value=await response.json();assert.equal(f.sessions,sessions);assert.equal(value.document.version,2);assert.equal(value.document.blocks[0].data.text,'X Hello world');assert.doesNotMatch(JSON.stringify(value),/private-locator|hidden-target|marks|links|revision|workspace|actor/);
 const saved=await f.raw.read('workspace','actor'),data=saved.payload.pages[0].document.blocks[0].data;assert.equal(saved.revision,2);assert.equal(data.objectKey,'private-locator');assert.deepEqual(data.marks,[{start:2,end:7,styles:['bold']}]);assert.deepEqual(data.mentions,[{kind:'person',accountId:'actor',membershipId:'membership',start:2,end:7}]);assert.deepEqual(data.links,[{start:8,end:13,label:'world',pageId:'hidden-target'}]);assert.equal(saved.payload.history.length,1);assert.equal(saved.payload.history[0].document.blocks[0].data.text,'Hello world');
 assert.equal((await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization:writer.authorization,body:{expectedVersion:1,title:'Stale'}})).status,409);assert.equal(f.writes,1);
});

test('REST and MCP shared writes cannot inject mentions or issue receipts when preserving legacy unbound metadata',async t=>{
 const f=fixture(t),stamp=new Date().toISOString();f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run('reader','Synthetic reader','reader@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('reader-generation','workspace','reader','guest',stamp);
 f.payload.grants.push({id:'reader-grant',workspaceId:'workspace',pageId:'page',accountId:'reader',permission:'viewer',includeDescendants:false,status:'active'});f.payload.grantBindings.push({grantId:'reader-grant',membershipId:'reader-generation'});f.payload.pages[0].document.blocks[0].data.mentions=[{kind:'person',accountId:'reader',start:0,end:5}];await f.seed();const writer=await f.issue([...writeScopes,'mcp:connect']);
 for(const requiredScopes of [[],['mcp:connect']]){const saved=await f.raw.read('workspace','actor'),version=saved.payload.pages[0].document.version;
  await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',requiredScopes,input:{expectedVersion:version,blocks:[{id:'body',type:'paragraph',data:{text:'Hello world',mentions:[{kind:'person',accountId:'reader',start:0,end:5}]}}]}}),fails(400));
  await f.actions.execute({authorization:writer.authorization,action:'document.write',requiredScopes,input:{expectedVersion:version,blocks:[{id:'body',type:'paragraph',data:{text:'Hello world'}}]}});const current=await f.raw.read('workspace','actor');assert.equal(current.payload.pages[0].document.blocks[0].data.mentions[0].membershipId,'reader-generation');assert.equal(current.payload.activityNotifications,undefined);
 }
});

test('external removal retires an old inline receipt in the same CAS and cannot revive it with an older document',async t=>{
 const f=fixture(t),stamp=new Date().toISOString();f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run('reader','Synthetic reader','reader@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('reader-generation','workspace','reader','guest',stamp);f.payload.grants.push({id:'reader-grant',workspaceId:'workspace',pageId:'page',accountId:'reader',permission:'viewer',includeDescendants:false,status:'active'});f.payload.grantBindings.push({grantId:'reader-grant',membershipId:'reader-generation'});f.payload.pages[0].document.blocks[0].data.mentions=[{kind:'person',accountId:'reader',membershipId:'reader-generation',start:0,end:5}];f.payload.activityNotifications=[{id:'existing-receipt',kind:'inline-mention',pageId:'page',recipientId:'reader',recipientMembershipId:'reader-generation',authorId:'actor',authorMembershipId:'membership',createdAt:stamp,readAt:null}];await f.seed();const writer=await f.issue([...writeScopes,'mcp:connect']);
 await f.actions.execute({authorization:writer.authorization,action:'document.write',input:{expectedVersion:1,blocks:[]}});const removed=await f.raw.read('workspace','actor');assert.deepEqual(removed.payload.activityNotifications,[]);assert.equal(f.payload.activityNotifications.length,1,'the caller snapshot was not changed');
 await f.actions.execute({authorization:writer.authorization,action:'document.write',requiredScopes:['mcp:connect'],input:{expectedVersion:2,blocks:[{id:'body',type:'paragraph',data:{text:'Hello world'}}]}});assert.deepEqual((await f.raw.read('workspace','actor')).payload.activityNotifications,[]);
});

test('read-only imported source blocks prevent replacement but allow title edits without deleting originals',async t=>{
 const f=fixture(t,{source:true});await f.seed();const writer=await f.issue(),before=await f.raw.read('workspace','actor');
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',input:{expectedVersion:1,blocks:[{id:'body',type:'paragraph',data:{text:'Replacement'}}]}}),error=>error.status===409&&error.code==='EXTERNAL_DOCUMENT_READ_ONLY');
 assert.deepEqual(await f.raw.read('workspace','actor'),before);
 const value=await f.actions.execute({authorization:writer.authorization,action:'document.write',input:{expectedVersion:1,title:'Renamed'}});assert.equal(value.page.title,'Renamed');assert.equal(value.omittedBlocks,1);assert.doesNotMatch(JSON.stringify(value),/Private raw import source/);assert.deepEqual((await f.raw.read('workspace','actor')).payload.pages[0].document.blocks,before.payload.pages[0].document.blocks);
});

test('bounded block grammar rejects injected private references, unknown fields, rich type conversion and oversized bodies before mutation',async t=>{
 const f=fixture(t);await f.seed();const writer=await f.issue();
 for(const input of [{title:'No expected version'},{expectedVersion:1,title:'No aggregate revision',expectedRevision:1},{expectedVersion:1,blocks:[{id:'body',type:'paragraph',data:{text:'Forged',links:[{start:0,end:6,label:'Forged',pageId:'secret'}]}}]},{expectedVersion:1,blocks:[{id:'database',type:'database',data:{text:'Hidden'}}]},{expectedVersion:1,blocks:[{id:'body',type:'paragraph',data:{text:'x'}},{id:'body',type:'paragraph',data:{text:'duplicate'}}]}])await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',input}),fails(400));
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',input:{expectedVersion:1,blocks:[{id:'body',type:'code',data:{text:'Hello world'}}]}}),fails(409));
 assert.equal((await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization:writer.authorization,body:{expectedVersion:1,blocks:[{id:'large',type:'paragraph',data:{text:'x'.repeat(210000)}}]}})).status,413);assert.equal(f.writes,0);assert.equal((await f.raw.read('workspace','actor')).revision,1);
});

for(const driver of ['sqlite','d1'])test(driver+' commit atomically fences revocation, scopes, expiry, membership, verification and content ACL after admitted authorization',async t=>{
 for(const kind of ['revoke','scopes','expiry','membership','role','verification','acl','mcp']){
  const f=fixture(t,{driver});await f.seed();const writer=await f.issue([...writeScopes,'mcp:connect']);
  f.beforeWrite(async()=>{
   if(kind==='revoke')f.db.prepare('UPDATE yumunio_api_tokens SET revoked_at=?,active_slot=NULL,version=version+1').run(new Date().toISOString());
   if(kind==='scopes')f.db.prepare('UPDATE yumunio_api_tokens SET scopes_json=?').run(JSON.stringify([...readScopes,'mcp:connect']));
   if(kind==='mcp')f.db.prepare('UPDATE yumunio_api_tokens SET scopes_json=?').run(JSON.stringify(writeScopes));
   if(kind==='expiry')f.db.prepare('UPDATE yumunio_api_tokens SET expires_at=?').run(new Date(Date.now()-1).toISOString());
   if(kind==='membership')f.db.prepare('UPDATE yumunio_memberships SET id=?').run('rejoined');
   if(kind==='role')f.db.prepare('UPDATE yumunio_memberships SET role=?').run('admin');
   if(kind==='verification')f.db.prepare('UPDATE yumunio_users SET emailVerified=0').run();
   if(kind==='acl'){f.payload.grants[0].permission='viewer';await f.raw.write('workspace','actor',{expectedRevision:1,payload:f.payload,actorMembershipId:'membership',actorRole:'member'});}
  });
  await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',requiredScopes:['mcp:connect'],input:{expectedVersion:1,title:'Must never commit'}}),error=>[401,404,409].includes(error.status),kind);
  const row=f.db.prepare('SELECT revision,payload_json FROM yumunio_account_content').get(),payload=JSON.parse(row.payload_json);assert.equal(payload.pages[0].page.title,'Original',kind);assert.equal(payload.pages[0].document.version,1,kind);assert.equal(payload.history,undefined,kind);assert.equal(row.revision,kind==='acl'?2:1,kind);
 }
});

test('an unrelated content CAS change is not retried and cannot be overwritten by a page-scoped write',async t=>{
 const f=fixture(t);await f.seed();const writer=await f.issue();f.beforeWrite(async()=>{const other=structuredClone(f.payload.pages[0]);other.page.id='other';other.page.title='Concurrent private page';other.document.pageId='other';f.payload.pages.push(other);await f.raw.write('workspace','actor',{expectedRevision:1,payload:f.payload,actorMembershipId:'membership',actorRole:'member'});});
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',input:{expectedVersion:1,title:'Conflict'}}),fails(409));assert.equal(f.writes,1);assert.equal((await f.raw.read('workspace','actor')).payload.pages[1].page.title,'Concurrent private page');
});

test('disabled external actions fail before token queries and never resolve a cookie session',async t=>{
 const f=fixture(t,{enabled:false});await assert.rejects(f.actions.authorize({authorization:'Bearer invalid',scope:'mcp:connect'}),fails(503));assert.equal((await f.request('/api/v1/pages/page/document',{method:'PATCH',body:{expectedVersion:1,title:'Disabled'}})).status,503);assert.equal(f.tokenReads,0);assert.equal(f.sessions,0);
});

for(const driver of ['sqlite','d1','mysql','postgres'])test(driver+' token expiry is checked at SQL mutation time even when the application clock still admits the credential',async t=>{
 const clock=new Date(Date.now()-120000).toISOString(),f=fixture(t,{driver,now:()=>clock});await f.seed();const writer=await f.issue();f.db.prepare('UPDATE yumunio_api_tokens SET expires_at=?').run(new Date(Date.now()-1000).toISOString());
 assert.equal((await f.actions.authorize({authorization:writer.authorization,scope:'document:write'})).pageId,'page');
 await assert.rejects(f.actions.execute({authorization:writer.authorization,action:'document.write',input:{expectedVersion:1,title:'Expired in SQL'}}),fails(409));assert.equal((await f.raw.read('workspace','actor')).revision,1);
 if(['mysql','postgres'].includes(driver)){const mutation=f.commands.find(command=>command.sql.startsWith('UPDATE yumunio_account_content')&&command.sql.includes('external_token'));assert.ok(mutation);assert.equal(mutation.sql.includes(writer.metadata.id),false);assert.ok(mutation.params.includes(writer.metadata.id));assert.equal(mutation.sql.includes(writer.token),false);assert.ok(mutation.params.includes(JSON.stringify(writeScopes)));}
});
