import assert from 'node:assert/strict';
import {pageStarterFromReceipt} from '../../../domain/src/page-starter.js';
export const starterRecipe=type=>({type,labels:type==='simple-table'?{intro:'Write directly into cells.',item:'Item',value:'Details',note:'Notes',first:'First item'}:{intro:'Track your tasks.',name:'Tasks',status:'Status',assignee:'Assignee',due:'Due',todo:'To do',doing:'In progress',done:'Done',first:'First task',second:'Review together',third:'Explore the board',summary:'Summary',details:'Notes',tableView:'Table',boardView:'Board',calendarView:'Calendar',timelineView:'Timeline'}});

/** Shared Node/SQLite and actual workerd/D1 scenario, including source ACLs and atomic failure. */
export async function verifyPageStarterFlow({request,workspaceId,owner,viewer}){
 const base='/api/content/workspaces/'+workspaceId;
 const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
 const denied=async(response,status)=>{assert.equal(response.status,status,await response.clone().text());const data=await response.json();assert.deepEqual(Object.keys(data),['error']);return data;};
 const get=path=>request(base+path,{account:owner});let revision=(await ok(await get('/pages'))).revision;
 const created=[];
 for(const type of ['board','table','simple-table','board']){
  const recipe=starterRecipe(type),before=revision;
  const result=await ok(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:revision,title:'Starter '+type,starter:recipe}}),201);revision=result.revision;assert.equal(revision,before+1);
  const plan=pageStarterFromReceipt(recipe,result.starter);assert.deepEqual(result.document.blocks,plan.blocks);
  const page=await ok(await get('/pages/'+result.page.id));assert.deepEqual(page.document.blocks,plan.blocks);assert.ok(page.page.capabilities.includes('manage'));
  created.push({result,plan});
 }
 const [first,second,simple,copy]=created;assert.notEqual(first.plan.database.id,copy.plan.database.id);assert.ok(first.plan.ids.every(id=>!copy.plan.ids.includes(id)));assert.equal(simple.plan.database,undefined);assert.equal(simple.result.document.blocks[1].data.format,'simple-table-v1');
 const db=first.plan.database,collectionPath='/collections/'+db.id;
 let collection=await ok(await get(collectionPath));assert.equal(collection.collection.records.length,3);assert.deepEqual(collection.collection.views.map(view=>view.type),['table','board','calendar','timeline']);
 for(const target of ['/pages/'+first.result.page.id,'/pages/'+db.pageId,collectionPath,'/pages/'+db.records[0].pageId])await denied(await request(base+target,{account:viewer}),404);
 const grant=async includeDescendants=>{const result=await ok(await request(base+'/pages/'+first.result.page.id+'/grants',{method:'POST',account:owner,body:{expectedRevision:revision,accountId:viewer.id,permission:'editor',includeDescendants}}));revision=result.revision;};
 await grant(false);await ok(await request(base+'/pages/'+first.result.page.id,{account:viewer}));await denied(await request(base+collectionPath,{account:viewer}),404);
 await denied(await request(base+collectionPath+'/query',{method:'POST',account:viewer,body:{view:first.result.document.blocks[1].data.view}}),404);
 await grant(true);collection=await ok(await request(base+collectionPath,{account:viewer}));assert.equal(collection.collection.records.length,3);
 const row=collection.collection.records[0],status=db.properties[0].id,due=db.properties[2].id;
 const changed=await ok(await request(base+collectionPath+'/records/'+row.id,{method:'PATCH',account:viewer,body:{expectedRevision:revision,values:{[status]:'In progress',[due]:'2026-10-21'}}}));revision=changed.revision;
 let body=await ok(await request(base+'/pages/'+row.pageId,{account:viewer}));body.document.blocks[1].data.text='Edited beside the board';
 const saved=await ok(await request(base+'/pages/'+row.pageId,{method:'PATCH',account:viewer,body:{expectedRevision:revision,expectedVersion:body.document.version,blocks:body.document.blocks}}));revision=saved.revision;
 for(const view of db.views){const queried=await ok(await request(base+collectionPath+'/views/'+view.id,{account:viewer}));const updated=queried.collection.records.find(record=>record.id===row.id);assert.equal(updated.values[status],'In progress');assert.equal(updated.values[due],'2026-10-21');}
 const host=await ok(await get('/pages/'+first.result.page.id)),placement=host.document.blocks[1];
 placement.data.view={...db.views[2]};delete placement.data.view.id;placement.data.view.filters=[{propertyId:status,operator:'eq',value:'In progress'}];placement.data.view.sorts=[{propertyId:due,direction:'asc'}];placement.data.visiblePropertyIds=[status,due];
 const switched=await ok(await request(base+'/pages/'+host.page.id,{method:'PATCH',account:owner,body:{expectedRevision:revision,expectedVersion:host.document.version,blocks:host.document.blocks}}));revision=switched.revision;
 const reloaded=await ok(await get('/pages/'+host.page.id));assert.deepEqual(reloaded.document.blocks[1].data,placement.data);
 const calendar=await ok(await request(base+collectionPath+'/query',{method:'POST',account:viewer,body:{view:placement.data.view}}));assert.equal(calendar.view.type,'calendar');assert.equal(calendar.collection.records.length,2);assert.ok(calendar.collection.records.every(record=>record.values[status]==='In progress'));assert.deepEqual((await ok(await get(collectionPath))).collection.views,collection.collection.views);
 assert.equal((await ok(await get('/collections/'+copy.plan.database.id))).collection.records[0].values[copy.plan.database.properties[0].id],'To do');
 const before=await ok(await get('/pages'));
 for(const extra of [{starter:{...starterRecipe('board'),collectionId:db.id}},{starter:starterRecipe('board'),blocks:[]},{starter:{...starterRecipe('board'),type:'unknown'}}])await denied(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:revision,title:'Must not exist',...extra}}),400);
 const stale=await denied(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:revision-1,title:'Stale',starter:starterRecipe('board')}}),409);assert.equal(stale.error.code,'CONTENT_CONFLICT');
 assert.deepEqual(await ok(await get('/pages')),before);
 // Child-page placement, including beneath a database record, retains parent inheritance.
 const child=await ok(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:revision,title:'Nested table',parentId:row.pageId,starter:starterRecipe('table')}}),201);revision=child.revision;
 const nested=pageStarterFromReceipt(starterRecipe('table'),child.starter);assert.equal(child.page.parentId,row.pageId);assert.equal((await ok(await request(base+'/collections/'+nested.database.id,{account:viewer}))).collection.records.length,3);
 body=await ok(await get('/pages/'+row.pageId));assert.equal(body.document.blocks[1].data.text,'Edited beside the board');
 return{revision,pageId:first.result.page.id,collectionId:db.id,rowPageId:row.pageId,tableCollectionId:second.plan.database.id};
}
