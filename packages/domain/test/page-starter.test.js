import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePageStarter,instantiateStructuredPageStarter,pageStarterFromReceipt} from '../src/page-starter.js';
import {validateDocument,validateCollection} from '../src/index.js';
const labels={intro:'Intro',name:'Tasks',status:'Status',assignee:'Assignee',due:'Due',todo:'To do',doing:'Doing',done:'Done',first:'First',second:'Second',third:'Third',summary:'Summary',details:'Notes',tableView:'Table',boardView:'Board'};

test('database recipes generate real views, properties and independently editable record bodies',()=>{
 for(const type of ['board','table']){
  const recipe={type,labels},before=structuredClone(recipe),a=instantiateStructuredPageStarter(recipe),b=instantiateStructuredPageStarter(recipe),stamp='2026-10-21T00:00:00.000Z';
  validateDocument({workspaceId:'studio',pageId:'new-page',version:1,blocks:a.blocks,updatedAt:stamp});
  const db=a.database;validateCollection({id:db.id,workspaceId:'studio',title:db.title,properties:db.properties,records:db.records.map(({id,values})=>({id,values})),createdAt:stamp,updatedAt:stamp});
  assert.equal(a.blocks[1].data.view.type,type);assert.equal(a.blocks[1].data.collectionId,db.id);assert.equal(db.records.length,3);assert.deepEqual(db.views.map(view=>view.type),['table','board']);assert.equal(db.views[1].groupBy,db.properties[0].id);
  assert.ok(a.ids.every(id=>!b.ids.includes(id)));assert.deepEqual(pageStarterFromReceipt(recipe,{type,ids:a.ids}),a);
  db.records[0].blocks[0].data.text='Edited';assert.equal(b.database.records[0].blocks[0].data.text,labels.summary);assert.deepEqual(recipe,before);
 }
});

test('recipes reject references, arbitrary structure, malformed strings and ID reuse',()=>{
 const recipe={type:'board',labels};
 for(const invalid of [{...recipe,collectionId:'private'},{...recipe,blocks:[]},{...recipe,type:'gallery'},{...recipe,labels:{...labels,pageId:'private'}},{...recipe,labels:{...labels,intro:'x\0'}},{...recipe,labels:{...labels,done:labels.todo}},{...recipe,labels:{...labels,name:'x'.repeat(121)}}])assert.throws(()=>validatePageStarter(invalid));
 assert.throws(()=>instantiateStructuredPageStarter(recipe,()=>'duplicate'));assert.throws(()=>instantiateStructuredPageStarter(recipe,()=>'invalid id'));
 const malicious={type:'board'};Object.defineProperty(malicious,'labels',{get(){throw Error('Must not execute');},enumerable:true});assert.throws(()=>validatePageStarter(malicious),/INVALID_PAGE_STARTER/);
});

test('dated starter views use the same due field and round-trip receipts while old recipes retain their original tree',()=>{
 const recipe={type:'table',labels:{...labels,calendarView:'Calendar',timelineView:'Timeline'}},plan=instantiateStructuredPageStarter(recipe),due=plan.database.properties.find(property=>property.type==='date').id;
 assert.deepEqual(plan.database.views.map(view=>view.type),['table','board','calendar','timeline']);assert.equal(plan.database.views[2].datePropertyId,due);assert.equal(plan.database.views[3].endDatePropertyId,due);assert.deepEqual(pageStarterFromReceipt(recipe,{type:recipe.type,ids:plan.ids}),plan);
 const legacy={type:'board',labels},old=instantiateStructuredPageStarter(legacy);assert.equal(old.database.views.length,2);assert.deepEqual(pageStarterFromReceipt(legacy,{type:legacy.type,ids:old.ids}),old);
 for(const key of ['calendarView','timelineView'])assert.throws(()=>validatePageStarter({type:'board',labels:{...labels,[key]:'Only one'}}));
});
