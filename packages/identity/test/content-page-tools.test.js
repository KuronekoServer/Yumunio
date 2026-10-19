import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {defaultPageAppearance} from '@yumunio/domain';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),stamp='2026-10-19T00:00:00.000Z',workspaceId='tools',origin='https://tools.example.invalid';
async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(workspaceId,'Tools','tools',stamp);
 for(const [id,role]of [['member','member'],['viewer','guest'],['other','member']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,role,stamp);}
 const page=(id,parentId=null)=>({page:{id,workspaceId,parentId,title:id,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId,version:1,updatedAt:stamp,blocks:[{id:'block-'+id,type:'paragraph',data:{text:'Original body'}}]},inheritPermissions:parentId!==null});
 const payload={schemaVersion:1,pages:[page('root'),page('child','root'),page('hidden')],grants:[],grantBindings:[],attachments:[{id:'asset',pageId:'root',name:'cover.png',mediaType:'image/png',size:24,checksum:'a'.repeat(64),profileId:'local',objectKey:'workspace/blob'}]};
 for(const [accountId,pageId,permission]of [['member','root','full'],['viewer','root','viewer'],['other','hidden','full']]){const id='grant-'+accountId;payload.grants.push({id,workspaceId,pageId,accountId,permission,includeDescendants:true,status:'active'});payload.grantBindings.push({grantId:id,membershipId:'membership-'+accountId});}
 const raw=createSqliteContentStore(db);await raw.write(workspaceId,'member',{expectedRevision:0,payload,actorMembershipId:'membership-member',actorRole:'member'});let beforeWrite=null,count=0;
 const api=createAccountContentApi({origin,store:{read:(...args)=>raw.read(...args),async write(...args){if(beforeWrite){const run=beforeWrite;beforeWrite=null;await run();}return raw.write(...args);}},now:()=>stamp,createId:()=> 'generated-'+ ++count,resolveSession:async request=>({user:{id:request.headers.get('x-actor'),emailVerified:true}})});
 const request=(path,{actor='member',method='GET',body,headers={}}={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{Origin:origin,'Content-Type':'application/json','x-actor':actor,'X-Yumunio-Expected-Account':actor,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return{db,payload,raw,request,setBeforeWrite:run=>beforeWrite=run};
}
const appearance=(f,value,extra={})=>f.request('/pages/root/appearance',{method:'PATCH',body:{expectedRevision:1,expectedVersion:1,appearance:value},...extra});
const copy=(f,extra={})=>f.request('/pages/root/duplicate',{method:'POST',body:{expectedRevision:1,expectedVersion:1,title:'My copy',includeChildren:true},...extra});
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json()).error.code,code);}

test('appearance is validated, versioned and restored in read/save projections without changing sharing',async t=>{
 const f=await fixture(t),value={...defaultPageAppearance(),icon:'📘',coverAttachmentId:'asset',fullWidth:true,locked:true};
 const response=await appearance(f,value);assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),{revision:2,pageId:'root',version:2,appearance:value});
 const loaded=await(await f.request('/pages/root',{actor:'viewer'})).json();assert.deepEqual(loaded.page.appearance,value);assert.equal(loaded.document.version,2);
 const saved=await f.raw.read(workspaceId,'member');assert.equal(saved.payload.history.length,1);assert.deepEqual(saved.payload.grants,f.payload.grants);
 await error(await appearance(f,value),409,'CONTENT_CONFLICT');await error(await appearance(f,value,{actor:'viewer'}),404,'CONTENT_NOT_FOUND');
 const unlock=await f.request('/pages/root/appearance',{method:'PATCH',body:{expectedRevision:2,expectedVersion:2,appearance:{...value,locked:false}}});assert.equal(unlock.status,200);
});
test('invalid icons, colors, covers, actor expectations and method calls never write page settings',async t=>{
 const f=await fixture(t);
 for(const value of [{...defaultPageAppearance(),icon:'\u0000'},{...defaultPageAppearance(),extra:true},{...defaultPageAppearance(),fullWidth:'yes'}])await error(await appearance(f,value),400,'INVALID_PAGE_APPEARANCE');
 await error(await appearance(f,{...defaultPageAppearance(),coverAttachmentId:'foreign-asset'}),404,'CONTENT_NOT_FOUND');
 await error(await appearance(f,defaultPageAppearance(),{headers:{'X-Yumunio-Expected-Account':'other'}}),404,'CONTENT_NOT_FOUND');
 await error(await f.request('/pages/root/appearance'),405,'METHOD_NOT_ALLOWED');assert.equal((await f.raw.read(workspaceId,'member')).revision,1);
});
test('page duplication remaps the complete subtree, blocks and attachments, strips person references, and creates only private access',async t=>{
 const f=await fixture(t),saved=await f.raw.read(workspaceId,'member'),root=saved.payload.pages[0];
 root.page.appearance={...defaultPageAppearance(),coverAttachmentId:'asset',locked:true};
 root.document.blocks=[{id:'root-block',type:'callout',data:{text:'child person cover.png',icon:'💡',links:[{start:0,end:5,label:'child',pageId:'child',fragment:'block-block-child'},{start:13,end:22,label:'cover.png',pageId:'root',attachmentId:'asset'}],mentions:[{kind:'person',start:6,end:12,accountId:'viewer',membershipId:'membership-viewer'}]}}];
 await f.raw.write(workspaceId,'member',{expectedRevision:1,payload:validateContentPayload(saved.payload,workspaceId),actorMembershipId:'membership-member',actorRole:'member'});
 const response=await copy(f,{body:{expectedRevision:2,expectedVersion:1,title:'My copy',includeChildren:true}});assert.equal(response.status,201,await response.clone().text());const result=await response.json();assert.equal(result.pageCount,2);
 const copyPage=await(await f.request('/pages/'+result.pageId)).json(),after=await f.raw.read(workspaceId,'member'),child=after.payload.pages.find(row=>row.page.parentId===result.pageId),asset=after.payload.attachments.find(row=>row.pageId===result.pageId);
 assert.equal(copyPage.page.title,'My copy');assert.equal(copyPage.page.appearance.locked,false);assert.equal(copyPage.page.appearance.coverAttachmentId,asset.id);assert.notEqual(asset.id,'asset');assert.equal(asset.objectKey,'workspace/blob');
 const block=copyPage.document.blocks[0];assert.notEqual(block.id,'root-block');assert.equal(block.data.links[0].pageId,child.page.id);assert.equal(block.data.links[0].fragment,'block-'+child.document.blocks[0].id);assert.equal(block.data.links[1].attachmentId,asset.id);assert.deepEqual(block.data.mentions,[]);
 const viewerPages=await(await f.request('/pages',{actor:'viewer'})).json();assert.ok(!viewerPages.pages.some(page=>page.id===result.pageId));await error(await f.request('/pages/'+result.pageId,{actor:'other'}),404,'CONTENT_NOT_FOUND');
 assert.equal(after.payload.pages.find(row=>row.page.id==='root').document.blocks[0].id,'root-block');
});
test('duplication rejects guests, hidden descendants and concurrent access revocation without partial copies',async t=>{
 const f=await fixture(t);await error(await copy(f,{actor:'viewer'}),404,'CONTENT_NOT_FOUND');
 f.setBeforeWrite(async()=>{const saved=await f.raw.read(workspaceId,'member');saved.payload.grants.find(row=>row.accountId==='member').status='revoked';await f.raw.write(workspaceId,'member',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});});
 await error(await copy(f),404,'CONTENT_NOT_FOUND');assert.equal((await f.raw.read(workspaceId,'member')).payload.pages.length,3);
 const g=await fixture(t),saved=await g.raw.read(workspaceId,'member');saved.payload.pages.find(row=>row.page.id==='child').inheritPermissions=false;await g.raw.write(workspaceId,'member',{expectedRevision:1,payload:saved.payload,actorMembershipId:'membership-member',actorRole:'member'});
 await error(await copy(g,{body:{expectedRevision:2,expectedVersion:1,title:'Copy',includeChildren:true}}),404,'CONTENT_NOT_FOUND');assert.equal((await g.raw.read(workspaceId,'member')).payload.pages.length,3);
});
test('favorites belong to the active account membership, survive reload and do not edit the document',async t=>{
 const f=await fixture(t),response=await f.request('/pages/root/favorite',{actor:'viewer',method:'PATCH',body:{expectedRevision:1,expectedVersion:1,favorite:true}});assert.equal(response.status,200,await response.clone().text());
 const own=await(await f.request('/pages/root',{actor:'viewer'})).json(),other=await(await f.request('/pages/root')).json();assert.equal(own.page.favorite,true);assert.equal(own.document.version,1);assert.equal(other.page.favorite,undefined);
 assert.equal((await(await f.request('/pages',{actor:'viewer'})).json()).pages.find(row=>row.id==='root').favorite,true);
 const removed=await f.request('/pages/root/favorite',{actor:'viewer',method:'PATCH',body:{expectedRevision:2,expectedVersion:1,favorite:false}});assert.equal(removed.status,200);assert.equal((await(await f.request('/pages/root',{actor:'viewer'})).json()).page.favorite,undefined);
});
