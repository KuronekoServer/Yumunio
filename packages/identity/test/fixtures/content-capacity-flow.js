import assert from 'node:assert/strict';
import {contentHead} from '../../src/content-codec.js';
const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
export async function exerciseContentCapacity({request,owner,member,inspect,restart}){
 const workspaceId='capacity-workspace',base='/api/content/workspaces/'+workspaceId,pages=base+'/pages',text='Fictional Markdown body. '.repeat(4500),raw_cells={number:0,empty:'',boolean:false,missing:null,nested:['original']};let revision=0,last;
 for(let index=0;index<10;index++){
  last=await ok(await request(pages,{method:'POST',account:owner,body:{expectedRevision:revision,title:'Capacity note '+index,blocks:[{id:'body-'+index,type:'paragraph',data:{text,raw_cells}}]}}),201);assert.equal(last.revision,revision+1);revision=last.revision;
 }
 let physical=await inspect();assert.equal(physical.revision,revision);assert.ok(contentHead(physical.head));assert.ok(physical.chunkCount>1&&physical.chunkCount<=32);assert.ok(physical.largestRowBytes<=256000);assert.ok(Buffer.byteLength(physical.head)<1000);
 const path=pages+'/'+last.page.id;let page=await ok(await request(path,{account:owner}));assert.equal(page.document.blocks[0].data.text,text);assert.deepEqual(page.document.blocks[0].data.raw_cells,raw_cells);assert.equal((await request(path,{account:member})).status,404);
 page=await ok(await request(path,{method:'PATCH',account:owner,body:{expectedRevision:revision,expectedVersion:1,title:'Saved after crossing 900KB'}}));revision=page.revision;assert.equal(page.document.version,2);
 assert.equal((await request(path,{method:'PATCH',account:owner,body:{expectedRevision:revision-1,expectedVersion:1,title:'Stale overwrite'}})).status,409);assert.equal((await inspect()).revision,revision);
 const changed=await ok(await request('/api/collaboration/workspaces/'+workspaceId+'/members/capacity-membership-member',{method:'PATCH',account:owner,body:{expectedRevision:revision,role:'admin'}}));assert.equal(changed.revision,revision+1);revision=changed.revision;assert.equal((await request(path,{account:member})).status,404);
 const issued=await ok(await request('/api/integrations/tokens',{method:'POST',account:owner,body:{requestId:crypto.randomUUID(),expectedRevision:revision,workspaceId,pageId:last.page.id,name:'Synthetic capacity token',scopes:['page:read','document:read','document:write'],expiresAt:new Date(Date.now()+86400000).toISOString(),confirmPageAccess:true}}),201),headers={Authorization:'Bearer '+issued.token},external='/api/v1/pages/'+last.page.id+'/document';assert.equal((await request(external,{headers})).status,200);
 const updated=await ok(await request(external,{method:'PATCH',headers,body:{expectedVersion:2,title:'Scoped capacity update'}}));assert.equal(updated.document.version,3);revision++;assert.equal((await inspect()).revision,revision);
 await ok(await request('/api/integrations/tokens/'+issued.metadata.id,{method:'DELETE',account:owner,body:{expectedVersion:issued.metadata.version}}));assert.equal((await request(external,{headers})).status,401);
 const exported=await ok(await request(base+'/export?format=json',{account:owner}));assert.equal(exported.pages.length,10);assert.equal(exported.pages.find(item=>item.page.id===last.page.id).document.blocks[0].data.text,text);
 await restart();page=await ok(await request(path,{account:owner}));assert.equal(page.revision,revision);assert.equal(page.page.title,'Scoped capacity update');assert.equal(page.document.blocks[0].data.text,text);assert.deepEqual(page.document.blocks[0].data.raw_cells,raw_cells);assert.equal((await request(external,{headers})).status,401);physical=await inspect();assert.equal(physical.revision,revision);assert.ok(contentHead(physical.head));
}
