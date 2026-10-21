import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mountWorkspaceCollectionView,validateWorkspaceCollectionRead} from '../public/workspace-collection-view.js';
import {CollectionEdits} from '../public/workspace-data.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const catalog=JSON.parse(await readFile(new URL('../public/collections-locales/en.json',import.meta.url),'utf8'));
const labels=(key,values={})=>Object.entries(values).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),catalog[key]??key);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function value(viewId=null,revision=4){const views=['table','board','list','gallery','feed'].map(type=>({id:type,name:'Saved '+type,type,filters:[],sorts:[],groupBy:type==='board'?'status':null,datePropertyId:null,endDatePropertyId:null}));return{revision,pageId:'container',capabilities:['read','manage'],collection:{id:'tasks',workspaceId:'studio',title:'Tasks',properties:[{id:'status',name:'Status',type:'select',options:['Todo','Done']},{id:'notes',name:'Notes',type:'text'}],views,sourceProperties:[],sourceHeaders:[],records:[{id:'row',pageId:'row-page',title:'Private row',values:{status:'Todo',notes:'Original'},sourceKind:'manual',sourceValues:{},capabilities:['read','editBody','editRecordValues','manage']}]},...(viewId?{view:views.find(view=>view.id===viewId)}:{})};}
const model=(id=null,revision=4)=>new CollectionEdits(value(id,revision),{workspaceId:'studio',collectionId:'tasks'});
function fixture(t,{initial=null,initialEnvelope,read,write,createView,prepare,confirm=true,writeAllowed=true,tableRow}={}){
 const f=settingsDomFixture(t),root=f.doc.createElement('section');f.background.append(root);let current=true,currentModel=initialEnvelope?new CollectionEdits(initialEnvelope,{workspaceId:'studio',collectionId:'tasks'}):model(initial);const calls=[],errors=[],busy=[],selected=[],controllers=[];
 const controller=mountWorkspaceCollectionView({root,getModel:()=>currentModel,isCurrent:()=>current,canRead:()=>true,canWrite:()=>writeAllowed,
  readView:async(id,options)=>{calls.push({kind:'read',id,options});return read?read(id,options):model(id,currentModel.revision);},
  createView:createView?async(body,options)=>{calls.push({kind:'create',body,options});return createView(body,options);}:undefined,
  writeBoard:async(intent,options)=>{calls.push({kind:'write',intent,options});return write?write(intent,options):{revision:intent.body.expectedRevision+1,collectionId:'tasks',viewId:'board',record:{...currentModel.record('row'),values:{...currentModel.record('row').values,status:intent.targetValue}},boardOrder:{recordIds:['row']}};},
  prepare:prepare??(()=>true),confirmDiscard:async()=>confirm,onModel:next=>{currentModel=next;},onAccepted:result=>{currentModel.envelope.revision=result.revision;},onSelected:id=>selected.push(id),onError:(error,context)=>errors.push({error,context}),onBusyChange:(...args)=>busy.push(args),labels,projectionOptions:()=>({onEdit:()=>{},onOpenPage:()=>{},...(tableRow?{tableRow}:{})}),boardFactory:options=>{const entry={options,destroyed:false};controllers.push(entry);return{active:false,destroy(){entry.destroyed=true;},cancel(){}};},selectedViewId:initial});
 return{...f,root,controller,calls,errors,busy,selected,controllers,get model(){return currentModel;},setCurrent:value=>{current=value;}};
}

test('saved views switch inside their section while body nodes, live selection and an unrelated body draft remain intact',async t=>{
 const f=fixture(t),nodes=[...f.editor.childNodes];f.select(f.editor,2,8);const selection=f.selection.getRangeAt(0);await f.controller.ready;
 for(const view of ['board','gallery','feed',null]){assert.equal(await f.controller.switchView(view),true);assert.equal(f.model.envelope.view?.id??null,view);assert.deepEqual(f.editor.childNodes,nodes);assert.equal(f.selection.getRangeAt(0),selection);assert.equal(f.editor.textContent,'Unchanged body draft');}
 assert.deepEqual(f.selected,['board','gallery','feed',null]);assert.equal(f.calls.filter(call=>call.kind==='write').length,0);f.controller.destroy();
});

const withDates=()=>{const data=value();data.collection.properties.push({id:'due',name:'Due',type:'date'});data.collection.records[0].values.due='2026-10-21';return data;};

test('an existing database can add a missing saved calendar and switch back to its table without rewriting rows or body',async t=>{
 const saved=withDates(),f=fixture(t,{initialEnvelope:saved,createView:async body=>{assert.equal(body.expectedRevision,4);saved.revision=5;saved.collection.views.push({id:'saved-calendar',...structuredClone(body.view)});return{revision:5,collectionId:'tasks',viewId:'saved-calendar'};},read:async id=>new CollectionEdits({...structuredClone(saved),...(id?{view:saved.collection.views.find(view=>view.id===id)}:{})},{workspaceId:'studio',collectionId:'tasks'})});const nodes=[...f.editor.childNodes],rows=structuredClone(saved.collection.records);await f.controller.ready;
 assert.equal(await f.controller.addView('calendar'),true);assert.equal(f.model.envelope.view.type,'calendar');assert.equal(f.model.envelope.view.datePropertyId,'due');assert.equal(f.model.revision,5);assert.deepEqual(f.model.collection.records,rows);assert.deepEqual(f.editor.childNodes,nodes);assert.equal(f.calls.filter(call=>call.kind==='create').length,1);
 assert.equal(await f.controller.switchView('table'),true);assert.equal(await f.controller.switchView('saved-calendar'),true);assert.deepEqual(f.selected,['saved-calendar','table','saved-calendar']);assert.equal(f.calls.filter(call=>call.kind==='create').length,1);f.controller.destroy();
});

test('saved-view creation requires current manage rights and never repeats an acknowledged write after refresh failure',async t=>{
 const seed=withDates();seed.capabilities=['read'];const viewer=fixture(t,{initialEnvelope:seed,createView:()=>assert.fail('read-only creation')});assert.equal(await viewer.controller.addView('calendar'),false);viewer.controller.destroy();
 const failed=fixture(t,{initialEnvelope:withDates(),createView:async()=>({revision:5,collectionId:'tasks',viewId:'calendar-created'}),read:async()=>{throw Object.assign(Error('Unavailable'),{status:503});}});assert.equal(await failed.controller.addView('calendar'),false);assert.equal(failed.errors[0].context.acknowledged,true);assert.equal(await failed.controller.addView('calendar'),false);assert.equal(failed.calls.filter(call=>call.kind==='create').length,1);assert.equal(failed.editor.textContent,'Unchanged body draft');failed.controller.destroy();
});

test('refresh keeps table scroll and the selected record while replacing only the current projection',async t=>{
 const f=fixture(t);await f.controller.ready;const nodes=[...f.editor.childNodes],scroll=f.root.querySelector('.collection-scroll');scroll.scrollTop=420;scroll.scrollLeft=160;f.root.querySelector('[data-record-id]').classList.add('record-selected');
 await f.controller.refresh();assert.equal(f.root.querySelector('.collection-scroll').scrollTop,420);assert.equal(f.root.querySelector('.collection-scroll').scrollLeft,160);assert.equal(f.root.querySelector('.record-selected').dataset.recordId,'row');assert.deepEqual(f.editor.childNodes,nodes);f.controller.destroy();
});

test('a canceled dirty-row review never fetches or discards properties; a failed accepted read also preserves the raw draft',async t=>{
 const canceled=fixture(t,{confirm:false});canceled.model.setRaw('row','notes','Unsaved');assert.equal(await canceled.controller.switchView('list'),false);assert.equal(canceled.calls.length,0);assert.equal(canceled.model.rawValue('row','notes'),'Unsaved');canceled.controller.destroy();
 const failed=fixture(t,{read:async()=>{throw Object.assign(new Error('offline'),{status:503});}});failed.model.setRaw('row','notes','Keep this');assert.equal(await failed.controller.switchView('list'),false);assert.equal(failed.model.rawValue('row','notes'),'Keep this');assert.equal(failed.model.dirty,true);assert.equal(failed.calls.length,1);failed.controller.destroy();
 const accepted=fixture(t);accepted.model.setRaw('row','notes','Explicitly discarded');assert.equal(await accepted.controller.switchView('list'),true);assert.equal(accepted.model.dirty,false);assert.equal(accepted.model.rawValue('row','notes'),'Original');accepted.controller.destroy();
});

test('destroy and stale scope discard late view responses and release only their own activity without touching body input',async t=>{
 for(const mode of ['destroy','scope']){const gate=deferred(),f=fixture(t,{read:()=>gate.promise});const old=f.model,pending=f.controller.switchView('board');await flush();assert.equal(f.controller.busy,true);if(mode==='destroy')f.controller.destroy();else f.setCurrent(false);gate.resolve(model('board'));assert.equal(await pending,false);assert.equal(f.model,old);assert.equal(f.editor.textContent,'Unchanged body draft');assert.deepEqual(f.busy,[[true,'read'],[false,'read']]);if(mode==='destroy')assert.equal(f.root.textContent,'');else f.controller.destroy();}
});

test('a view read locks host table inputs and refuses replacement if a late property edit arrives after the initial dirty review',async t=>{
 for(const initiallyDirty of [false,true]){const gate=deferred();let f;const tableRow=(record,index,{readOnly})=>{const row=f.doc.createElement('tr'),input=f.doc.createElement('input');input.readOnly=readOnly;input.value=record.values.notes;row.append(input);return row;};
  // The initial mount paints synchronously, so install the host row renderer after fixture construction.
  f=fixture(t,{read:()=>gate.promise});f.controller.destroy();const root=f.doc.createElement('section');f.background.append(root);let currentModel=f.model;const errors=[];
  const controller=mountWorkspaceCollectionView({root,getModel:()=>currentModel,isCurrent:()=>true,canRead:()=>true,canWrite:()=>true,readView:()=>gate.promise,onModel:next=>{currentModel=next;},confirmDiscard:async()=>true,onError:error=>errors.push(error),labels,projectionOptions:()=>({tableRow}),selectedViewId:null});
  if(initiallyDirty)currentModel.setRaw('row','notes','Reviewed original draft');const original=currentModel,pending=controller.switchView('list');await flush();assert.equal(root.querySelector('input').readOnly,true);
  currentModel.setRaw('row','notes','Late input must survive');gate.resolve(model('list'));assert.equal(await pending,false);assert.equal(currentModel,original);assert.equal(currentModel.rawValue('row','notes'),'Late input must survive');assert.equal(errors[0].code,'PROPERTY_DRAFT_CHANGED');assert.match(root.textContent,/input changed/);assert.equal(root.querySelector('input').readOnly,false);assert.equal(f.editor.textContent,'Unchanged body draft');controller.destroy();
 }
});

test('an actor or resource loss erases the previous private projection even when its host scope disappears in the error callback',async t=>{
 const f=settingsDomFixture(t),root=f.doc.createElement('section');f.background.append(root);let current=true;const original=model(),errors=[];
 const controller=mountWorkspaceCollectionView({root,getModel:()=>original,isCurrent:()=>current,canRead:()=>true,canWrite:()=>true,readView:async()=>{throw Object.assign(new Error('changed'),{code:'ACCOUNT_CHANGED',status:401});},onModel:()=>assert.fail(),onError:(error,context)=>{errors.push(context);current=false;},labels,projectionOptions:()=>({}),selectedViewId:null});assert.match(root.textContent,/Private row/);assert.equal(await controller.switchView('list'),false);assert.doesNotMatch(root.textContent,/Private row|Original|Saved board/);assert.equal(errors[0].lost,true);assert.equal(f.editor.textContent,'Unchanged body draft');controller.destroy();
});

test('a board move validates one captured CAS, reloads the filtered view and does not rewrite the body or replay an unknown ACK',async t=>{
 const f=fixture(t,{initial:'board',read:async id=>{const fresh=model(id,5);fresh.envelope.collection.records[0].values.status='Done';return fresh;}});assert.equal(await f.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null}),true);const writes=f.calls.filter(call=>call.kind==='write');assert.equal(writes.length,1);assert.deepEqual(writes[0].intent.body,{expectedRevision:4,boardMove:{recordId:'row',targetValue:'Done',beforeRecordId:null,visibleRecordIds:['row']}});assert.equal(f.model.revision,5);assert.equal(f.model.record('row').values.status,'Done');assert.equal(f.editor.textContent,'Unchanged body draft');f.controller.destroy();
 const unknown=fixture(t,{initial:'board',write:async()=>({revision:5,collectionId:'tasks',viewId:'board',boardOrder:{recordIds:[]}})});assert.equal(await unknown.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null}),false);assert.match(unknown.root.textContent,/result|confirmed|uncertain/i);assert.equal(await unknown.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null}),false);assert.equal(unknown.calls.filter(call=>call.kind==='write').length,1);assert.equal(unknown.errors[0].context.acknowledged,false);assert.equal(unknown.errors[0].context.mutation,true);unknown.controller.destroy();
});

test('read-only room use still switches views and opens rows while its board handles and writes stay disabled',async t=>{
 const f=fixture(t,{writeAllowed:false});assert.equal(await f.controller.switchView('board'),true);assert.equal(f.root.querySelector('[data-board-dnd-handle]').disabled,true);assert.equal(f.controllers.at(-1).options.canMove('row'),false);assert.equal(await f.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null}),false);assert.equal(await f.controller.switchView('list'),true);assert.equal(f.calls.filter(call=>call.kind==='write').length,0);f.controller.destroy();
});

test('known success followed by read failure reports refresh failure and destruction of an in-flight write reports uncertainty once',async t=>{
 const f=fixture(t,{initial:'board',read:async()=>{throw Object.assign(new Error('read failed'),{status:503});}});assert.equal(await f.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null}),false);assert.equal(f.errors[0].context.acknowledged,true);assert.equal(f.calls.filter(call=>call.kind==='write').length,1);assert.equal(await f.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null}),false);f.controller.destroy();
 const gate=deferred(),pending=fixture(t,{initial:'board',write:()=>gate.promise});const task=pending.controller.moveBoard({recordId:'row',targetValue:'Done',beforeRecordId:null});await flush();pending.controller.destroy();assert.equal(pending.errors.length,1);assert.equal(pending.errors[0].context.acknowledged,false);gate.resolve({});assert.equal(await task,false);assert.equal(pending.errors.length,1);assert.equal(pending.editor.textContent,'Unchanged body draft');
});

test('view reads advance only an unchanged canonical body at an identical revision and never accept a foreign container',()=>{
 const baseline={page:{id:'container',workspaceId:'studio',title:'Body'},document:{version:2,blocks:[{id:'body',type:'paragraph',data:{text:'Canonical'}}]}},page={...structuredClone(baseline),revision:5};const options={workspaceId:'studio',collectionId:'tasks',pageId:'container',baseline};assert.equal(validateWorkspaceCollectionRead(value('board',5),page,options).revision,5);
 for(const change of [x=>x.revision++,x=>x.page.id='foreign',x=>x.document.version++,x=>x.page.title='Changed',x=>x.document.blocks[0].data.text='Remote body']){const fresh=structuredClone(page);change(fresh);assert.throws(()=>validateWorkspaceCollectionRead(value('board',5),fresh,options),error=>error.code==='COLLECTION_READ_CHANGED');}
 const roomPage=structuredClone(page);roomPage.document.version=7;roomPage.document.blocks[0].data.text='Room canonical';assert.equal(validateWorkspaceCollectionRead(value('board',5),roomPage,{...options,inRoom:true}).revision,5);assert.equal(baseline.document.blocks[0].data.text,'Canonical');
 assert.throws(()=>validateWorkspaceCollectionRead(value('board',5),page,{...options,expectedViewId:'list'}),error=>error.code==='INVALID_RESPONSE');assert.throws(()=>validateWorkspaceCollectionRead(value('board',5),page,{...options,expectedViewId:null}),error=>error.code==='INVALID_RESPONSE');assert.equal(validateWorkspaceCollectionRead(value(null,5),page,{...options,expectedViewId:null}).revision,5);
});
