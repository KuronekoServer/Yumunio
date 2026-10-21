import test from 'node:test';
import assert from 'node:assert/strict';
import {renderCollectionProjection} from '../public/collection-projection.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const data=()=>({revision:1,pageId:'source',capabilities:['read','manage'],collection:{id:'tasks',workspaceId:'studio',title:'Tasks',properties:[{id:'status',name:'Status',type:'status',options:['Todo','Done']},{id:'date',name:'Date',type:'date'}],views:[],records:[{id:'row',pageId:'row-page',title:'Task',values:{status:'Todo',date:null},sourceKind:'manual',sourceValues:{},capabilities:['read','editBody','editRecordValues']}]},view:{id:'board',name:'Board',type:'board',filters:[],sorts:[],groupBy:'status',datePropertyId:null,endDatePropertyId:null}});
test('a card opens from its body or Enter while controls, selection and IME remain independent',t=>{
 const f=settingsDomFixture(t),opened=[],result=renderCollectionProjection({document:f.doc,envelope:data(),t:key=>key,onOpenRecord:row=>opened.push(row.id)});f.background.append(result.element);const card=result.element.querySelector('[data-record-id]');card.dispatch('click');card.dispatch('keydown',{target:card,key:'Enter'});assert.deepEqual(opened,['row','row']);
 const title=card.querySelector('.record-title');card.dispatch('click',{target:title});card.dispatch('click',{ctrlKey:true});card.dispatch('click',{defaultPrevented:true});card.dispatch('keydown',{target:card,key:'Enter',isComposing:true});f.doc.getSelection=()=>({isCollapsed:false});card.dispatch('click');assert.equal(opened.length,2);
 assert.equal(card.getAttribute('role'),'group');assert.equal(card.getAttribute('tabindex'),'0');assert.equal(card.querySelector('dl').childNodes.length,0,'group and empty values do not repeat inside a card');
});
