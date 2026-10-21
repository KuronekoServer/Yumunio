import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineDomFixture} from './fixtures/inline-dom.js';
import {createInlineEditor} from '../public/inline-editor.js';
import {prepareLivePagePatch} from '../public/live-page-patch.js';
const draft=text=>({title:'Project',blocks:[{id:'body',type:'paragraph',data:{text}},{id:'db',type:'database',data:{format:'collection-view-v1',collectionId:'tasks',view:{name:'Table',type:'table',filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null},visiblePropertyIds:null}}]});
function fixture(t){const dom=inlineDomFixture(t),element=createInlineEditor({text:'AB'});element.dataset={blockId:'body'};const title={value:'Project'},database={scrollLeft:80,scrollTop:120};const root={querySelector:()=>title,querySelectorAll:selector=>selector==='.inline-editor'?[element]:[],replaceChildren(){assert.fail('A text update must preserve the body and database DOM.');}};return{dom,element,title,root,database};}
test('clean live text changes preserve editor and database nodes and update the existing block graph',t=>{
 const f=fixture(t),before=draft('AB'),after=draft('AXB'),block=before.blocks[0],leaf=f.element.childNodes[0];f.dom.select(f.element,1);
 const plan=prepareLivePagePatch(f.root,before,after);assert.equal(plan.kind,'inline');assert.equal(plan.apply(),true);assert.equal(before.blocks[0],block);assert.equal(block.data.text,'AXB');assert.equal(f.element.childNodes[0],leaf);assert.equal(f.element.textContent,'AXB');assert.deepEqual(f.database,{scrollLeft:80,scrollTop:120});
});
test('composition and unrecorded input defer live application instead of overwriting the DOM',t=>{
 const f=fixture(t);f.element.dispatch('compositionstart');f.element.childNodes[0].replaceData(0,1,'変換');const leaf=f.element.childNodes[0];
 assert.equal(prepareLivePagePatch(f.root,draft('AB'),draft('remote')).kind,'deferred');assert.equal(f.element.childNodes[0],leaf);assert.equal(f.element.textContent,'変換B');
});
test('structural and database configuration changes use the host render, without touching the old graph',t=>{
 const f=fixture(t),before=draft('AB'),moved=structuredClone(before);moved.blocks.reverse();assert.equal(prepareLivePagePatch(f.root,before,moved).kind,'structural');
 const filtered=structuredClone(before);filtered.blocks[1].data.view.sorts=[{propertyId:'status',direction:'asc'}];assert.equal(prepareLivePagePatch(f.root,before,filtered).kind,'structural');assert.equal(before.blocks[1].data.view.sorts.length,0);
});
