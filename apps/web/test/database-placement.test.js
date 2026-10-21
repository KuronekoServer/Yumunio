import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDatabaseView,databaseViewForType,mountDatabasePlacement} from '../public/database-placement.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const dto=()=>({revision:4,pageId:'source',capabilities:['read','manage'],collection:{id:'tasks',workspaceId:'studio',title:'Private source',properties:[{id:'note',name:'Note',type:'text'}],views:[],records:[{id:'row',pageId:'row-page',title:'Private title',values:{note:'One'},sourceValues:{},sourceKind:'manual',capabilities:['read','editBody','editRecordValues']}]},view:{...defaultDatabaseView(),id:'placement'}});
function fixture(t,options={}){const f=settingsDomFixture(t),root=f.doc.createElement('section');Object.defineProperty(root,'ownerDocument',{value:f.doc});f.background.append(root);let response=dto(),current=true;const opened=[],reads=[],lost=[];const block={id:'inline',type:'database',data:{format:'collection-view-v1',collectionId:'tasks',view:defaultDatabaseView(),visiblePropertyIds:['note']}};
 const controller=mountDatabasePlacement({root,getBlock:()=>block,workspaceId:'studio',initialRead:options.initialRead,initialState:options.initialState,request:async(path,request)=>{reads.push({path,body:request.body});if(options.reply)return options.reply(request);if(response instanceof Error)throw response;return structuredClone(response);},isCurrent:()=>current,canConfigure:()=>options.canConfigure??true,t:key=>key,fieldT:key=>key,onChangeView:options.onChangeView?view=>options.onChangeView(view,block):undefined,onConfigure:()=>{},onNewRecord:()=>{},onOpenRecord:row=>opened.push(row.id),onRevision:()=>{},onAccessLost:()=>lost.push(true)});t.after(()=>controller.destroy());
 return{...f,root,block,controller,opened,reads,lost,setResponse:value=>{response=value;},setCurrent:value=>{current=value;}};
}

test('local title visibility and height update without replacing the list, scroll, selection or source settings',async t=>{
 const f=fixture(t);await f.controller.ready;const list=f.root.querySelector('.collection-scroll');list.scrollLeft=65;list.scrollTop=180;f.root.querySelector('.record-title').dispatch('click');f.block.data.presentation={title:'My tasks',icon:'📋',height:320,showTitle:false};f.controller.updatePresentation();assert.equal(f.root.querySelector('strong').hidden,true);assert.equal(f.root.querySelector('strong').textContent,'📋 My tasks');assert.equal(f.root.style['--database-height'],'320px');assert.equal(f.root.querySelector('.collection-scroll'),list);assert.equal(list.scrollLeft,65);assert.equal(list.scrollTop,180);assert.equal(f.controller.envelope.collection.title,'Private source');assert.equal(f.root.querySelector('.record-selected').dataset.recordId,'row');f.setResponse(Object.assign(new Error('lost'),{status:403}));await f.controller.refresh();assert.doesNotMatch(f.root.textContent,/Private source|Private title|My tasks/);
});

const datedDto=view=>{const value=dto();value.collection.properties.push({id:'status',name:'Status',type:'status',options:['Todo','Done']},{id:'due',name:'Due',type:'date'},{id:'end',name:'End',type:'date'});Object.assign(value.collection.records[0].values,{status:'Todo',due:'2026-10-21',end:null});value.view={...structuredClone(view),id:'placement'};return value;};

test('an authorized page context paints immediately and structural remote refresh retains list state',async t=>{
 const initial=dto(),left=fixture(t,{initialRead:initial});await left.controller.ready;assert.equal(left.reads.length,0);
 const scroll=left.root.querySelector('.collection-scroll');scroll.scrollLeft=80;scroll.scrollTop=160;left.root.querySelector('.record-title').dispatch('click');
 const state=left.controller.captureState(),right=fixture(t,{initialRead:initial,initialState:state});await right.controller.ready;
 assert.equal(right.root.querySelector('.collection-scroll').scrollLeft,80);assert.equal(right.root.querySelector('.collection-scroll').scrollTop,160);assert.equal(right.root.querySelector('.record-selected').dataset.recordId,'row');
 right.setResponse(Object.assign(Error('revoked'),{status:404}));await right.controller.refresh(true);assert.equal(right.reads.length,1);assert.doesNotMatch(right.root.textContent,/Private source|Private title/);
});

test('an unchanged placement can move with its host DOM without refetching or losing focus, selection or scroll',async t=>{
 const f=fixture(t,{initialRead:dto()});await f.controller.ready;const list=f.root.querySelector('.collection-scroll'),button=f.root.querySelector('.record-title');
 list.scrollLeft=70;list.scrollTop=160;button.dispatch('click');button.focus();
 const wrapper=f.doc.createElement('section');f.background.append(wrapper);wrapper.append(f.controller.root);f.controller.updatePresentation();
 assert.equal(f.controller.matchesBlock(structuredClone(f.block)),true);assert.equal(f.reads.length,0);assert.equal(f.root.querySelector('.collection-scroll'),list);assert.equal(f.doc.activeElement,button);assert.equal(list.scrollLeft,70);assert.equal(list.scrollTop,160);assert.equal(f.root.querySelector('.record-selected').dataset.recordId,'row');
 const changed=structuredClone(f.block);changed.data.view.filters=[{propertyId:'note',operator:'not_empty'}];assert.equal(f.controller.matchesBlock(changed),false);changed.data=f.block.data;changed.type='paragraph';assert.equal(f.controller.matchesBlock(changed),false);
 f.setResponse(Object.assign(Error('revoked'),{status:404}));await f.controller.refresh();assert.doesNotMatch(f.root.textContent,/Private title|Private source/);
});

test('quick formats preserve filters, sorts and source rows; each placement retains its own view, scroll and selected record',async t=>{
 const writes=[],f=fixture(t,{reply:async request=>datedDto(request.body.view),onChangeView:(view,block)=>{writes.push(structuredClone(view));block.data.view=structuredClone(view);return true;}});await f.controller.ready;
 f.block.data.view.filters=[{propertyId:'status',operator:'eq',value:'Todo'}];f.block.data.view.sorts=[{propertyId:'due',direction:'asc'}];await f.controller.refresh(true);
 const body=[...f.editor.childNodes],source=structuredClone(f.controller.envelope.collection),originalColumns=structuredClone(f.block.data.visiblePropertyIds),scroll=f.root.querySelector('.collection-scroll');scroll.scrollTop=240;scroll.scrollLeft=80;f.root.querySelector('.record-title').dispatch('click');
 for(const type of ['board','calendar','timeline','table']){assert.equal(await f.controller.switchView(type),true);assert.equal(f.block.data.view.type,type);assert.deepEqual(f.block.data.view.filters,[{propertyId:'status',operator:'eq',value:'Todo'}]);assert.deepEqual(f.block.data.view.sorts,[{propertyId:'due',direction:'asc'}]);assert.deepEqual(f.block.data.visiblePropertyIds,originalColumns);assert.deepEqual(f.controller.envelope.collection,source);assert.equal(f.root.querySelector('.record-selected').dataset.recordId,'row');assert.deepEqual(f.editor.childNodes,body);}
 assert.equal(writes.length,4);assert.equal(f.root.querySelector('.collection-scroll').scrollTop,240);assert.equal(f.root.querySelector('.collection-scroll').scrollLeft,80);assert.equal(f.root.querySelector('[aria-pressed="true"]').textContent,'table');
});

test('read-only view switching never writes the host, survives refresh and leaves another placement unchanged',async t=>{
 let writes=0;const f=fixture(t,{canConfigure:false,reply:async request=>datedDto(request.body.view),onChangeView:()=>{writes++;}});await f.controller.ready;const saved=structuredClone(f.block);
 assert.equal(await f.controller.switchView('calendar'),true);assert.deepEqual(f.block,saved);assert.equal(writes,0);await f.controller.refresh(true);assert.equal(f.controller.envelope.view.type,'calendar');assert.deepEqual(f.block,saved);
 const other=fixture(t,{reply:async request=>datedDto(request.body.view)});await other.controller.ready;assert.equal(other.controller.envelope.view.type,'table');assert.equal(other.root.querySelector('.collection-calendar'),null);
});

test('missing dates, failed or mismatched queries and stale scope never persist an invalid view or expose revoked data',async t=>{
 const f=fixture(t);await f.controller.ready;const count=f.reads.length;assert.equal(await f.controller.switchView('calendar'),false);assert.equal(f.reads.length,count);assert.equal(f.root.querySelectorAll('.database-view-tab').find(button=>button.textContent==='calendar').disabled,true);
 let reject=false,mismatch=false,resolve,writes=0;const g=fixture(t,{reply:async request=>{if(reject)throw Object.assign(Error('denied'),{status:403});if(resolve===null)return new Promise(done=>{resolve=()=>done(datedDto(request.body.view));});return datedDto(mismatch?defaultDatabaseView():request.body.view);},onChangeView:()=>{writes++;return true;}});await g.controller.ready;
 mismatch=true;assert.equal(await g.controller.switchView('board'),false);assert.equal(g.controller.envelope.view.type,'table');assert.equal(writes,0);mismatch=false;resolve=null;const pending=g.controller.switchView('calendar');await Promise.resolve();g.setCurrent(false);resolve();assert.equal(await pending,false);assert.equal(writes,0);
 g.setCurrent(true);reject=true;assert.equal(await g.controller.switchView('calendar'),false);assert.doesNotMatch(g.root.textContent,/Private title|Private source/);assert.equal(g.controller.envelope,null);assert.equal(g.lost.length,1);
});

test('default type conversion prefers status, accepts one-day timelines, remembers chosen dates and rejects unsupported grouping',()=>{
 const view={...defaultDatabaseView(),filters:[{propertyId:'note',operator:'not_empty'}]},properties=datedDto(view).collection.properties,before=structuredClone(view);
 assert.equal(databaseViewForType(view,properties,'board').groupBy,'status');const timeline=databaseViewForType(view,properties,'timeline',{datePropertyId:'end',endDatePropertyId:'due'});assert.equal(timeline.datePropertyId,'end');assert.equal(timeline.endDatePropertyId,'due');const one=databaseViewForType(view,properties.filter(property=>property.id!=='end'),'timeline');assert.equal(one.datePropertyId,one.endDatePropertyId);assert.equal(databaseViewForType(view,[{id:'created',name:'Created',type:'created_time'}],'board'),null);assert.equal(databaseViewForType(view,properties,'feed'),null);assert.deepEqual(view,before);
});

test('a view chosen during background refresh runs after that read instead of losing the click',async t=>{
 let release,hold=false;const writes=[],f=fixture(t,{reply:request=>hold?new Promise(resolve=>{release=()=>{hold=false;resolve(datedDto(request.body.view));};}):Promise.resolve(datedDto(request.body.view)),onChangeView:(view,block)=>{writes.push(view.type);block.data.view=structuredClone(view);return true;}});await f.controller.ready;hold=true;const reading=f.controller.refresh(true),first=f.controller.switchView('board'),last=f.controller.switchView('calendar');assert.equal(await first,false);release();await reading;assert.equal(await last,true);assert.deepEqual(writes,['calendar']);assert.equal(f.controller.envelope.view.type,'calendar');
});

test('a placement uses the source timeline date binding without adopting its filters or guessing a second date column',async t=>{
 const f=fixture(t,{reply:async request=>{const data=datedDto(request.body.view);data.collection.views=[{id:'saved-timeline',...defaultDatabaseView('Schedule'),type:'timeline',datePropertyId:'end',endDatePropertyId:'due',filters:[{propertyId:'status',operator:'eq',value:'Done'}]}];return data;}});await f.controller.ready;assert.equal(await f.controller.switchView('timeline'),true);assert.equal(f.controller.envelope.view.datePropertyId,'end');assert.equal(f.controller.envelope.view.endDatePropertyId,'due');assert.deepEqual(f.controller.envelope.view.filters,[]);
 const point=databaseViewForType(defaultDatabaseView(),datedDto(defaultDatabaseView()).collection.properties,'timeline');assert.equal(point.datePropertyId,point.endDatePropertyId);
});
test('an inline refresh keeps selection, list scroll and the surrounding editor without changing placement settings',async t=>{
 const f=fixture(t),nodes=[...f.editor.childNodes];await f.controller.ready;f.root.querySelector('.record-title').dispatch('click');assert.deepEqual(f.opened,['row']);const scroll=f.root.querySelector('.collection-scroll');scroll.scrollTop=240;scroll.scrollLeft=80;
 const updated=dto();updated.revision=5;updated.collection.records[0].values.note='Changed elsewhere';f.setResponse(updated);await f.controller.refresh();assert.match(f.root.textContent,/Changed elsewhere/);assert.equal(f.root.querySelector('.record-selected').dataset.recordId,'row');assert.equal(f.root.querySelector('.collection-scroll').scrollTop,240);assert.equal(f.root.querySelector('.collection-scroll').scrollLeft,80);assert.deepEqual(f.editor.childNodes,nodes);assert.deepEqual(f.reads[0].body,{view:defaultDatabaseView()});
});
test('revocation erases private data and informs the host; a destroyed or stale placement never paints a response',async t=>{
 const f=fixture(t);await f.controller.ready;f.setResponse(Object.assign(new Error('lost'),{status:404}));await f.controller.refresh();assert.doesNotMatch(f.root.textContent,/Private source|Private title|One/);assert.equal(f.lost.length,1);assert.equal(f.controller.envelope,null);
 f.setCurrent(false);const reads=f.reads.length;await f.controller.refresh();assert.equal(f.reads.length,reads);
});
