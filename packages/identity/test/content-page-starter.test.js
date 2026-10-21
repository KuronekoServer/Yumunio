import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createAccountContentApi} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {verifyPageStarterFlow,starterRecipe} from './fixtures/page-starter-flow.js';
const origin='https://starters.example',workspaceId='starter-workspace',stamp='2026-10-21T00:00:00.000Z';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
 for(const id of ['owner','member','guest'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(workspaceId,workspaceId,workspaceId,stamp);
 for(const id of ['owner','member','guest'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,id,stamp);
 const raw=createSqliteContentStore(db);let writes=0,beforeWrite=null;
 const api=createAccountContentApi({origin,store:{read:(...args)=>raw.read(...args),write:(...args)=>{writes++;beforeWrite?.();return raw.write(...args);}},now:()=>stamp,resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}})});
 const request=(path,{method='GET',body,account={id:'owner'},headers={}}={})=>api(new Request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Yumunio-Expected-Account':account.id,'x-fixture-account':account.id,...headers},...(body?{body:JSON.stringify(body)}:{})}));
 return{request,raw,get writes(){return writes;},setBeforeWrite:fn=>{beforeWrite=fn;}};
}
test('SQLite creates independent board/table pages atomically, preserves inheritance and enforces source permissions',async t=>{
 const f=fixture(t),result=await verifyPageStarterFlow({request:f.request,workspaceId,owner:{id:'owner'},viewer:{id:'member'}});
 assert.equal(f.writes,result.revision);assert.equal((await f.raw.read(workspaceId,'owner')).revision,result.revision);
});
test('a failed CAS cannot leave a partial page, database or sample rows',async t=>{
 const f=fixture(t);f.setBeforeWrite(()=>{throw Object.assign(Error('Synthetic conflict'),{code:'CONTENT_CONFLICT'});});
 const response=await f.request('/api/content/workspaces/'+workspaceId+'/pages',{method:'POST',body:{expectedRevision:0,title:'Atomic',starter:starterRecipe('board')}});assert.equal(response.status,409);
 const stored=await f.raw.read(workspaceId,'owner');assert.equal(stored.revision,0);assert.equal(stored.payload?.pages?.length??0,0);assert.equal(stored.payload?.collections?.length??0,0);
});

test('teamspace templates share through current team membership and reject unavailable destinations',async t=>{
 const f=fixture(t),base='/api/content/workspaces/'+workspaceId;
 const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
 const team=await ok(await f.request(base+'/teamspaces',{method:'POST',body:{expectedRevision:0,name:'Staff',description:'Team tasks',visibility:'private',defaultPermission:'editor'}}));
 const joined=await ok(await f.request(base+'/teamspaces/'+team.teamspace.id+'/members',{method:'POST',body:{expectedRevision:team.revision,accountId:'member',role:'member'}}));
 const created=await ok(await f.request(base+'/pages',{method:'POST',body:{expectedRevision:joined.revision,title:'Staff board',teamspaceId:team.teamspace.id,starter:starterRecipe('board')}}),201);
 const plan=starterRecipe('board'),db=created.document.blocks[1].data.collectionId;
 assert.equal((await ok(await f.request(base+'/collections/'+db,{account:{id:'member'}}))).collection.records.length,3);
 const before=await f.raw.read(workspaceId,'owner');
 for(const[account,extra,headers,status]of [[{id:'guest'},{},undefined,404],[{id:'member'},{teamspaceId:'unavailable'},undefined,404],[{id:'owner'},{},{'X-Yumunio-Expected-Account':''},400]]){
  assert.equal((await f.request(base+'/pages',{method:'POST',account,headers,body:{expectedRevision:created.revision,title:'Denied',starter:plan,...extra}})).status,status);
 }
 assert.deepEqual(await f.raw.read(workspaceId,'owner'),before);
});
