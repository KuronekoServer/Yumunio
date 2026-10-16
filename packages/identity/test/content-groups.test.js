import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createSqliteContentStore} from '../src/content-store.js';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {accountContentPolicy} from '../src/content-policy.js';
import {createPageAccessEvaluator,validateGroupState} from '@yumunio/domain';
const origin='https://groups.example.invalid',base='/api/content/workspaces/studio',stamp='2026-10-16T00:00:00.000Z';
async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run('studio','Studio','studio',stamp);
 for(const[id,role]of [['aoi','owner'],['ren','member'],['admin','admin'],['guest','guest']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('member-'+id,'studio',id,role,stamp);}
 const page=(id,parentId=null,inheritPermissions=false)=>({page:{id,workspaceId:'studio',parentId,title:id,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId:'studio',version:1,blocks:[{id:'body-'+id,type:'paragraph',data:{text:'Synthetic '+id}}],updatedAt:stamp},inheritPermissions});
 const payload={schemaVersion:1,pages:[page('private'),page('child','private',true),page('boundary','private')],grants:[{id:'aoi-grant',workspaceId:'studio',pageId:'private',accountId:'aoi',permission:'full',includeDescendants:true,status:'active'},{id:'boundary-grant',workspaceId:'studio',pageId:'boundary',accountId:'aoi',permission:'full',includeDescendants:false,status:'active'}],grantBindings:[{grantId:'aoi-grant',membershipId:'member-aoi'},{grantId:'boundary-grant',membershipId:'member-aoi'}]};
 const raw=createSqliteContentStore(db);await raw.write('studio','aoi',{expectedRevision:0,payload,actorMembershipId:'member-aoi',actorRole:'owner'});let beforeWrite;
 const store={read:(...args)=>raw.read(...args),write:async(...args)=>{if(beforeWrite){const fn=beforeWrite;beforeWrite=null;fn();}return raw.write(...args);}};
 const api=createAccountContentApi({store,origin,resolveSession:async request=>{const id=request.headers.get('x-fixture-account');return id?{user:{id,emailVerified:true}}:null;},now:()=>stamp});
 const request=(suffix,{account='aoi',method='GET',body,headers={}}={})=>api(new Request(origin+base+suffix,{method,headers:{'x-fixture-account':account,'X-Yumunio-Expected-Account':account,...(body?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}));
 const revision=async()=>(await raw.read('studio','aoi')).revision;
 const mutate=async(suffix,body={},options={})=>request(suffix,{method:'POST',body:{expectedRevision:await revision(),...body},...options});
 const create=async()=>ok(await mutate('/groups',{name:'Engineering'}));
 return{db,raw,request,mutate,create,revision,set beforeWrite(fn){beforeWrite=fn;}};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function denied(response,status=404){return ok(response,status);}
const grant=async(f,group,permission='editor',includeDescendants=true)=>ok(await f.mutate('/pages/private/group-grants',{groupId:group.id,permission,includeDescendants,confirmAccessChange:true}));
test('groups require workspace administration and current verified nonguest members, without exposing a private page',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE yumunio_users SET name=? WHERE id=?').run('Fixture Ren','ren');const created=await f.create();assert.equal(created.group.memberCount,0);assert.equal(created.canManage,true);assert.equal(created.candidates.find(person=>person.accountId==='ren').name,'Fixture Ren');
 await denied(await f.mutate('/groups',{name:'Forged'},{account:'ren'}));await denied(await f.request('/groups',{account:'guest'}));
 const read=await ok(await f.request('/groups/'+created.group.id,{account:'ren'}));assert.equal(read.canManage,false);assert.deepEqual(read.members,[]);assert.deepEqual(read.candidates,[]);
 await denied(await f.request('/pages/private',{account:'admin'}));await denied(await f.request('/pages/private/group-grants',{account:'admin'}));
 await denied(await f.mutate('/groups/'+created.group.id+'/members',{accountId:'guest',confirmAccessChange:true}));
});
test('group page grants respect inheritance stops, direct denies, archive and generation changes',async t=>{
 const f=await fixture(t),{group}=await f.create();await ok(await f.mutate('/groups/'+group.id+'/members',{accountId:'ren',confirmAccessChange:true}));await grant(f,group);
 assert.equal((await ok(await f.request('/pages/private',{account:'ren'}))).page.capabilities.includes('editBody'),true);await ok(await f.request('/pages/child',{account:'ren'}));await denied(await f.request('/pages/boundary',{account:'ren'}));
 const exported=await ok(await f.request('/export?format=json',{account:'ren'}));assert.match(JSON.stringify(exported),/Synthetic private/);assert.doesNotMatch(JSON.stringify(exported),/Synthetic boundary/);
 await ok(await f.mutate('/pages/private/grants',{accountId:'ren',permission:'deny'}));await denied(await f.request('/pages/private',{account:'ren'}));await ok(await f.request('/pages/child',{account:'ren'}));
 await ok(await f.mutate('/groups/'+group.id+'/archive',{archived:true,confirmAccessChange:true}));await denied(await f.request('/pages/child',{account:'ren'}));
 await ok(await f.mutate('/groups/'+group.id+'/archive',{archived:false,confirmAccessChange:true}));await ok(await f.request('/pages/child',{account:'ren'}));
 f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('member-ren-new','ren');await denied(await f.request('/pages/child',{account:'ren'}));await ok(await f.mutate('/groups/'+group.id+'/members',{accountId:'ren',confirmAccessChange:true}));await ok(await f.request('/pages/child',{account:'ren'}));
});
test('group mutations fence principal roster races and do not orphan the last page manager',async t=>{
 const f=await fixture(t),{group}=await f.create(),prior=await f.revision();f.beforeWrite=()=>f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('ren-replaced','ren');await denied(await f.mutate('/groups/'+group.id+'/members',{accountId:'ren',confirmAccessChange:true}),409);assert.equal(await f.revision(),prior);
 await ok(await f.mutate('/groups/'+group.id+'/members',{accountId:'ren',confirmAccessChange:true}));await grant(f,group,'full');
 const saved=await f.raw.read('studio','aoi');saved.payload.grants=saved.payload.grants.filter(g=>g.id!=='aoi-grant');saved.payload.grantBindings=saved.payload.grantBindings.filter(g=>g.grantId!=='aoi-grant');validateContentPayload(saved.payload,'studio');f.db.prepare('UPDATE yumunio_account_content SET payload_json=? WHERE workspace_id=?').run(JSON.stringify(saved.payload),'studio');
 const revision=await f.revision();await denied(await f.mutate('/groups/'+group.id+'/archive',{archived:true,confirmAccessChange:true}),409);assert.equal(await f.revision(),revision);await ok(await f.request('/pages/private',{account:'ren'}));
});
test('withdrawing or shrinking an inherited group deny requires current authority over every affected descendant',async t=>{
 for(const mode of ['delete','shrink']){
  const f=await fixture(t),{group}=await f.create();await ok(await f.mutate('/groups/'+group.id+'/members',{accountId:'admin',confirmAccessChange:true}));const shared=await grant(f,group,'deny',true),grantId=shared.grants[0].id;
  await ok(await f.mutate('/pages/private/grants',{accountId:'ren',permission:'full'}));await ok(await f.mutate('/pages/child/grants',{accountId:'ren',permission:'deny'}));await ok(await f.mutate('/pages/child/grants',{accountId:'admin',permission:'viewer'}));
  assert.ok((await ok(await f.request('/pages/private',{account:'ren'}))).page.capabilities.includes('manage'));await denied(await f.request('/pages/child',{account:'ren'}));await denied(await f.request('/pages/child',{account:'admin'}));
  const before=await f.raw.read('studio','aoi'),body=mode==='delete'?{grantId,confirmAccessChange:true}:{groupId:group.id,permission:'deny',includeDescendants:false,confirmAccessChange:true},response=await f.mutate('/pages/private/group-grants',body,{account:'ren',method:mode==='delete'?'DELETE':'POST'});
  const rejected=await denied(response);assert.equal(rejected.error.code,'CONTENT_NOT_FOUND');assert.deepEqual(await f.raw.read('studio','aoi'),before,mode+' cannot change the aggregate or document');await denied(await f.request('/pages/child',{account:'admin'}));
 }
});
test('forged scope, missing confirmation and stale revisions preserve the aggregate',async t=>{
 const f=await fixture(t),{group}=await f.create(),revision=await f.revision();
 await denied(await f.mutate('/groups/'+group.id+'/members',{accountId:'ren',confirmAccessChange:false}),400);await denied(await f.request('/groups/'+group.id,{method:'PATCH',body:{expectedRevision:revision-1,name:'Other',confirmAccessChange:true}}),409);await denied(await f.mutate('/pages/private/group-grants',{groupId:group.id,permission:'administrator',includeDescendants:false,confirmAccessChange:true}),400);assert.equal(await f.revision(),revision);
 await denied(await f.request('/groups',{headers:{'X-Yumunio-Expected-Account':'ren'}}));
});
test('old policy and strict optional groups remain compatible without invoking accessors',()=>{
 assert.deepEqual(validateGroupState({}),{groups:[],groupMembers:[],groupGrants:[]});assert.throws(()=>validateGroupState({groups:null}));let invoked=0;const value={};Object.defineProperty(value,'groups',{enumerable:true,get(){invoked++;return[];}});assert.throws(()=>validateGroupState(value));assert.equal(invoked,0);
 const state=accountContentPolicy({pages:[],grants:[],grantBindings:[]},[],'studio');assert.deepEqual(createPageAccessEvaluator(state)({workspaceId:'studio',pageId:'missing',accountId:'aoi'}).capabilities,[]);
});
