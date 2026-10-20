import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),origin='https://synced.example',stamp='2026-10-20T00:00:00.000Z';
function fixture(t){const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());for(const id of ['owner','member']){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);}db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run('workspace','workspace','workspace',stamp);for(const id of ['owner','member'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('m-'+id,'workspace',id,id,stamp);const store=createSqliteContentStore(db);let sequence=0;const api=createAccountContentApi({store,origin,now:()=>stamp,createId:()=> 'generated-'+ ++sequence,resolveSession:async request=>({user:{id:request.headers.get('x-account'),emailVerified:true}})});return{store,request:(path,method='GET',body,account='owner')=>api(new Request(origin+'/api/content/workspaces/workspace'+path,{method,headers:{Origin:origin,'Content-Type':'application/json','x-account':account,'X-Yumunio-Expected-Account':account},...(body?{body:JSON.stringify(body)}:{})}))};}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
const paragraph=(id,text)=>({id,type:'paragraph',data:{text}}),placement=(id,pageId)=>({id,type:'synced-block',data:{format:'synced-page-v1',pageId}});
test('synced placements share a canonical source without widening source permissions; detach and removal affect only a placement',async t=>{
 const f=fixture(t);let revision=0;const create=async(title,blocks)=>ok(await f.request('/pages','POST',{expectedRevision:revision++,title,blocks}),201);
 const source=await create('Common steps',[paragraph('notice','Private common instructions')]),a=await create('Project A',[paragraph('intro','Description'),placement('sync-a',source.page.id)]),b=await create('Project B',[placement('sync-b',source.page.id)]);
 await ok(await f.request('/pages/'+a.page.id+'/grants','POST',{expectedRevision:revision++,accountId:'member',permission:'editor'}));
 const destination=await ok(await f.request('/pages/'+a.page.id,'GET',undefined,'member'));assert.doesNotMatch(JSON.stringify(destination),/Private common instructions/);assert.equal((await f.request('/pages/'+source.page.id,'GET',undefined,'member')).status,404);
 const bad=await f.request('/pages/'+a.page.id,'PATCH',{expectedRevision:revision,expectedVersion:1,blocks:[placement('forged',source.page.id)]},'member');assert.equal(bad.status,404);
 await ok(await f.request('/pages/'+a.page.id,'PATCH',{expectedRevision:revision++,expectedVersion:1,blocks:[paragraph('intro','Updated description'),placement('sync-a',source.page.id)]},'member'));
 await ok(await f.request('/pages/'+source.page.id+'/grants','POST',{expectedRevision:revision++,accountId:'member',permission:'editor'}));assert.equal((await ok(await f.request('/pages/'+source.page.id,'GET',undefined,'member'))).document.blocks[0].data.text,'Private common instructions');
 await ok(await f.request('/pages/'+source.page.id,'PATCH',{expectedRevision:revision++,expectedVersion:1,blocks:[paragraph('notice','Updated common instructions')]},'member'));
 for(const pageId of [a.page.id,b.page.id]){const page=await ok(await f.request('/pages/'+pageId));assert.equal(page.document.blocks.at(-1).data.pageId,source.page.id);}assert.equal((await ok(await f.request('/pages/'+source.page.id))).document.blocks[0].data.text,'Updated common instructions');
 await ok(await f.request('/pages/'+a.page.id,'PATCH',{expectedRevision:revision++,expectedVersion:2,blocks:[paragraph('intro','Updated description'),paragraph('copy','Updated common instructions')]}));
 await ok(await f.request('/pages/'+b.page.id,'PATCH',{expectedRevision:revision++,expectedVersion:1,blocks:[]}));assert.equal((await ok(await f.request('/pages/'+source.page.id))).document.blocks[0].data.text,'Updated common instructions');assert.equal((await ok(await f.request('/pages/'+a.page.id))).document.blocks[1].type,'paragraph');
 await ok(await f.request('/pages/'+source.page.id+'/grants','POST',{expectedRevision:revision++,accountId:'member',permission:'deny'}));assert.equal((await f.request('/pages/'+source.page.id,'GET',undefined,'member')).status,404);
 const saved=await f.store.read('workspace','owner');assert.equal(saved.payload.pages.filter(item=>JSON.stringify(item.document.blocks).includes('Updated common instructions')).length,2);
});
