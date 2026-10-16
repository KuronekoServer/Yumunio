import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderCollectionProjection} from '../public/collection-projection.js';
import {collectionBoardModel,prepareBoardOrderMove} from '../public/board-move-model.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const catalog=JSON.parse(await readFile(new URL('../public/collections-locales/en.json',import.meta.url),'utf8'));
const t=(key,values={})=>Object.entries(values).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),catalog[key]??key);
function envelope(type='table',count=2){
 const views=['table','board','list','gallery','calendar','timeline','chart','feed'].map(type=>({id:type+'-view',name:type,type,filters:[],sorts:[],groupBy:['board','chart'].includes(type)?'status':null,datePropertyId:['calendar','timeline'].includes(type)?'date':null,endDatePropertyId:type==='timeline'?'end':null,...(type==='chart'?{chart:{type:'bar',aggregation:'count',valuePropertyId:null}}:{})}));
 const value={revision:4,pageId:'collection-page',capabilities:['read','manage'],collection:{id:'tasks',workspaceId:'studio',title:'Tasks',properties:[{id:'status',name:'Status',type:'select',options:['Todo','Done']},{id:'date',name:'Date',type:'date'},{id:'end',name:'End',type:'date'}],views,records:Array.from({length:count},(_,index)=>({id:'record-'+index,pageId:'page-'+index,title:'<img src=x onerror=bad> '+index,values:{status:'Todo',date:'2026-10-16',end:'2026-10-17'},sourceKind:'manual',sourceValues:{},capabilities:['read','editBody','editRecordValues','manage']}))},view:views.find(view=>view.type===type)};
 if(type==='chart')value.chart={status:'available',groups:[{value:'Todo',count,numericCount:0,result:count}]};return value;
}

test('all eight saved projections render from the same DTO without interpreting user HTML or replacing background body nodes',tcase=>{
 const f=settingsDomFixture(tcase),bodyNodes=[...f.editor.childNodes],opened=[];
 const create=f.doc.createElement;f.doc.createElement=tag=>{const node=create(tag);Object.defineProperty(node,'lastChild',{get:()=>node.childNodes.at(-1)});return node;};
 for(const type of ['table','board','list','gallery','calendar','timeline','chart','feed']){
  const data=envelope(type),result=renderCollectionProjection({document:f.doc,envelope:data,t,month:'2026-10',onOpenPage:record=>opened.push(record.id)});f.background.append(result.element);
  assert.equal(result.element.dataset.collectionViewType,type);assert.equal(result.element.querySelector('img'),null);assert.ok(result.element.textContent.length>0);assert.deepEqual(f.editor.childNodes,bodyNodes);if(type==='feed'){result.element.querySelector('.feed-title').dispatch('click');assert.equal(opened.at(-1),'record-0');}result.element.remove();
 }
});

test('board exposes typed current targets and fences stale hosts, readonly rows and sorted views before a commit callback',tcase=>{
 const f=settingsDomFixture(tcase),data=envelope('board'),moves=[];let current=true;
 const result=renderCollectionProjection({document:f.doc,envelope:data,t,available:()=>current,onBoardDrop:move=>{moves.push(move);return true;}});f.background.append(result.element);assert.equal(result.board.canMove('record-0'),true);
 const target=[...result.element.querySelectorAll('[data-board-dnd-target]')].find(node=>node.dataset.boardDndLabel.includes('Done'));assert.ok(target);assert.equal(result.board.canDrop('record-0',target.dataset.boardDndTarget),true);assert.equal(result.board.onCommit({recordId:'record-0',targetKey:target.dataset.boardDndTarget}),true);assert.deepEqual(moves,[{recordId:'record-0',targetValue:'Done',beforeRecordId:null}]);
 current=false;assert.equal(result.board.getScope(),null);assert.equal(result.board.canMove('record-0'),false);assert.equal(result.board.onCommit({recordId:'record-0',targetKey:target.dataset.boardDndTarget}),false);assert.equal(moves.length,1);
 for(const variant of ['readonly','sorted','no-handler']){const input=envelope('board');if(variant==='readonly')input.collection.records[0].capabilities=['read'];if(variant==='sorted')input.view.sorts=[{propertyId:'date',direction:'asc'}];const view=renderCollectionProjection({document:f.doc,envelope:input,t,...(variant==='no-handler'?{}:{onBoardDrop:()=>true})});assert.equal(view.board.canMove('record-0'),false);assert.equal(view.element.querySelector('[data-board-dnd-handle]').disabled,true);}
});

test('table keeps a host inline editor row while calendar month controls and feed windows stay local to the projection',tcase=>{
 const f=settingsDomFixture(tcase),row=f.doc.createElement('tr'),input=f.doc.createElement('input');input.value='Unsaved property';row.append(input);const result=renderCollectionProjection({document:f.doc,envelope:envelope(),t,tableRow:()=>row});f.background.append(result.element);assert.equal(result.element.querySelector('input'),input);assert.equal(input.value,'Unsaved property');
 const months=[],calendar=renderCollectionProjection({document:f.doc,envelope:envelope('calendar'),t,month:'2026-10',onMonth:offset=>months.push(offset)});calendar.element.querySelectorAll('button').find(button=>button.textContent===t('nextMonth')).dispatch('click');assert.deepEqual(months,[1]);assert.equal(f.editor.textContent,'Unchanged body draft');
 const create=f.doc.createElement;f.doc.createElement=tag=>{const node=create(tag);node.replaceWith=next=>{const parent=node.parentElement;parent.insertBefore(next,node);node.remove();};return node;};const feed=renderCollectionProjection({document:f.doc,envelope:envelope('feed',21),t,onOpenPage:()=>{}});f.background.append(feed.element);assert.equal(feed.element.querySelectorAll('.feed-card').length,20);feed.element.querySelectorAll('button').find(button=>button.textContent===t('feedShowMore')).dispatch('click');assert.equal(feed.element.querySelectorAll('.feed-card').length,21);assert.equal(f.editor.textContent,'Unchanged body draft');
});

test('select board columns stay in schema order after a saved cross-column move without changing model or write order',tcase=>{
 const f=settingsDomFixture(tcase),data=envelope('board',4);data.collection.properties[0].options=['Todo','Doing','Done'];
 for(const[index,value]of ['Todo','Doing','Done',null].entries())data.collection.records[index].values.status=value;
 const headings=result=>result.element.querySelectorAll('.collection-column').map(column=>column.childNodes[0].childNodes[0].textContent);
 const before=renderCollectionProjection({document:f.doc,envelope:data,t});assert.deepEqual(headings(before),['Todo','Doing','Done',t('empty')]);
 // The persisted visible order now starts with Doing; the empty Todo column must stay first.
 data.collection.records[0].values.status='Doing';data.view.boardOrder={recordIds:['record-1','record-0','record-2','record-3']};
 const source=structuredClone(data),model=collectionBoardModel(data),intent=prepareBoardOrderMove(data,{recordId:'record-0',targetValue:'Todo'}),moves=[];
 assert.deepEqual(model.groups.map(group=>group.value),['Doing','Done',null,'Todo']);
 const result=renderCollectionProjection({document:f.doc,envelope:data,t,onBoardDrop:move=>{moves.push(move);return true;}});f.background.append(result.element);
 assert.deepEqual(headings(result),['Todo','Doing','Done',t('empty')]);
 assert.deepEqual(result.element.querySelectorAll('.collection-column')[1].querySelectorAll('[data-board-dnd-card]').map(card=>card.dataset.boardDndCard),['record-1','record-0']);
 const target=result.element.querySelector('.collection-column').querySelector('.board-drop-end');assert.equal(result.board.onCommit({recordId:'record-0',targetKey:target.dataset.boardDndTarget}),true);
 assert.deepEqual(moves,[{recordId:'record-0',targetValue:'Todo',beforeRecordId:null}]);
 assert.deepEqual(prepareBoardOrderMove(data,moves[0]).body,intent.body);assert.deepEqual(intent.body.boardMove.visibleRecordIds,['record-1','record-0','record-2','record-3']);
 assert.deepEqual(data,source);assert.deepEqual(collectionBoardModel(data).groups,model.groups);assert.equal(f.editor.textContent,'Unchanged body draft');
});

test('non-select board columns retain first-visible group order including an unset group between values',tcase=>{
 const f=settingsDomFixture(tcase),data=envelope('board',3);data.collection.properties[0]={id:'status',name:'Group',type:'text'};
 for(const[index,value]of ['B',null,'A'].entries())data.collection.records[index].values.status=value;
 const source=structuredClone(data),result=renderCollectionProjection({document:f.doc,envelope:data,t});
 assert.deepEqual(result.element.querySelectorAll('.collection-column').map(column=>column.childNodes[0].childNodes[0].textContent),['B',t('empty'),'A']);assert.deepEqual(data,source);
});
