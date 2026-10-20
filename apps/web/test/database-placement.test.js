import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDatabaseView,mountDatabasePlacement} from '../public/database-placement.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const dto=()=>({revision:4,pageId:'source',capabilities:['read','manage'],collection:{id:'tasks',workspaceId:'studio',title:'Private source',properties:[{id:'note',name:'Note',type:'text'}],views:[],records:[{id:'row',pageId:'row-page',title:'Private title',values:{note:'One'},sourceValues:{},sourceKind:'manual',capabilities:['read','editBody','editRecordValues']}]},view:{...defaultDatabaseView(),id:'placement'}});
function fixture(t){const f=settingsDomFixture(t),root=f.doc.createElement('section');Object.defineProperty(root,'ownerDocument',{value:f.doc});f.background.append(root);let response=dto(),current=true;const opened=[],reads=[],lost=[];const block={id:'inline',type:'database',data:{format:'collection-view-v1',collectionId:'tasks',view:defaultDatabaseView(),visiblePropertyIds:['note']}};
 const controller=mountDatabasePlacement({root,getBlock:()=>block,workspaceId:'studio',request:async(path,options)=>{reads.push({path,body:options.body});if(response instanceof Error)throw response;return structuredClone(response);},isCurrent:()=>current,canConfigure:()=>true,t:key=>key,fieldT:key=>key,onConfigure:()=>{},onNewRecord:()=>{},onOpenRecord:row=>opened.push(row.id),onRevision:()=>{},onAccessLost:()=>lost.push(true)});t.after(()=>controller.destroy());
 return{...f,root,controller,opened,reads,lost,setResponse:value=>{response=value;},setCurrent:value=>{current=value;}};
}
test('an inline refresh keeps selection, list scroll and the surrounding editor without changing placement settings',async t=>{
 const f=fixture(t),nodes=[...f.editor.childNodes];await f.controller.ready;f.root.querySelector('.record-title').dispatch('click');assert.deepEqual(f.opened,['row']);const scroll=f.root.querySelector('.collection-scroll');scroll.scrollTop=240;scroll.scrollLeft=80;
 const updated=dto();updated.revision=5;updated.collection.records[0].values.note='Changed elsewhere';f.setResponse(updated);await f.controller.refresh();assert.match(f.root.textContent,/Changed elsewhere/);assert.equal(f.root.querySelector('.record-selected').dataset.recordId,'row');assert.equal(f.root.querySelector('.collection-scroll').scrollTop,240);assert.equal(f.root.querySelector('.collection-scroll').scrollLeft,80);assert.deepEqual(f.editor.childNodes,nodes);assert.deepEqual(f.reads[0].body,{view:defaultDatabaseView()});
});
test('revocation erases private data and informs the host; a destroyed or stale placement never paints a response',async t=>{
 const f=fixture(t);await f.controller.ready;f.setResponse(Object.assign(new Error('lost'),{status:404}));await f.controller.refresh();assert.doesNotMatch(f.root.textContent,/Private source|Private title|One/);assert.equal(f.lost.length,1);assert.equal(f.controller.envelope,null);
 f.setCurrent(false);const reads=f.reads.length;await f.controller.refresh();assert.equal(f.reads.length,reads);
});
