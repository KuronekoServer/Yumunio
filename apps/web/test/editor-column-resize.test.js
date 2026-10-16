import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks} from '../../../packages/domain/src/index.js';
import {EditorHistory} from '../public/editor-model.js';

import {planEditorColumnsResize,resizeEditorColumns,indexEditorBlocks} from '../public/editor-tree.js';
const paragraph=(id,text=id,extra={})=>({id,type:'paragraph',data:{text},...extra});
const columns=(children=[[],[]])=>({id:'layout',type:'columns',children:children.map((items,index)=>({id:'column-'+index,type:'column',children:items}))});
const generator=()=>{let number=0;return()=> 'new-layout-'+ ++number;};
const rich=()=>paragraph('rich','Aoi Page',{data:{text:'Aoi Page',marks:[{start:0,end:3,styles:['bold','italic']}],links:[{start:4,end:8,label:'Page',pageId:'linked-page'}],mentions:[{kind:'person',start:0,end:3,accountId:'aoi',membershipId:'current-aoi'},{kind:'page',start:4,end:8,pageId:'linked-page'}],future:{opaque:['kept']}},children:[{id:'future-child',type:'future',data:{payload:{v:1,items:[2,3]}}}]});
const assertRejected=(input,options,pattern)=>{const before=structuredClone(input);assert.throws(()=>resizeEditorColumns(input,options),pattern);assert.deepEqual(input,before);};

test('adding a third column preserves existing wrapper IDs, bodies, metadata and unrelated document order',()=>{
 const layout=columns([[paragraph('left')],[rich()]]),input=[paragraph('before'),paragraph('parent','',{children:[layout]}),paragraph('after')],before=structuredClone(input),review=planEditorColumnsResize(input,{groupId:'layout',count:3});
 assert.deepEqual(review,{groupId:'layout',fromCount:2,toCount:3,changed:true,removedColumnId:null,targetColumnId:null,movedRootIds:[],movedBlockCount:0});assert.equal(Object.isFrozen(review),true);assert.equal(Object.isFrozen(review.movedRootIds),true);assert.deepEqual(input,before);
 const result=resizeEditorColumns(input,{groupId:'layout',count:3,createId:generator()}),next=result.blocks[1].children[0];assert.equal(result.changed,true);assert.equal(next.id,layout.id);assert.deepEqual(next.children.slice(0,2),layout.children);assert.deepEqual(next.children[2],{id:'new-layout-1',type:'column',children:[{id:'new-layout-2',type:'paragraph',data:{text:''}}]});assert.equal(result.focusId,'new-layout-2');assert.deepEqual(result.blocks[0],input[0]);assert.deepEqual(result.blocks[2],input[2]);assert.deepEqual(input,before);validateBlocks(result.blocks);
});

test('reducing to two columns moves complete rightmost subtrees after the second column in document order',()=>{
 const source=paragraph('source','Immutable original',{data:{text:'Immutable original',purpose:'import-source',future:{preserved:true}}}),opaque={id:'unknown',type:'future',data:{arbitrary:{list:['one','two']}}},layout=columns([[paragraph('left')],[paragraph('middle')],[rich(),opaque,source]]);layout.data={};layout.children[1].data={};
 const input=[paragraph('before'),layout,paragraph('after')],before=structuredClone(input),review=planEditorColumnsResize(input,{groupId:'layout',count:2});assert.deepEqual(review.movedRootIds,['rich','unknown','source']);assert.equal(review.movedBlockCount,4);assert.equal(review.removedColumnId,'column-2');assert.equal(review.targetColumnId,'column-1');assert.deepEqual(input,before);
 const result=resizeEditorColumns(input,{groupId:'layout',count:2,createId:()=>assert.fail('no new IDs during reduction')}),next=result.blocks[1];assert.equal(result.focusId,null);assert.equal(result.groupId,'layout');assert.deepEqual(next,{...layout,children:[layout.children[0],{...layout.children[1],children:[...layout.children[1].children,...layout.children[2].children]}]});assert.deepEqual(input,before);assert.equal(indexEditorBlocks(result.blocks).has('column-2'),false);assert.deepEqual(result.blocks[0],input[0]);assert.deepEqual(result.blocks[2],input[2]);validateBlocks(result.blocks);
});

test('empty rightmost columns need no invented content and a same-count request is a true no-op',()=>{
 const input=[columns([[paragraph('a')],[],[]])],before=structuredClone(input),review=planEditorColumnsResize(input,{groupId:'layout',count:2});assert.deepEqual(review.movedRootIds,[]);assert.equal(review.movedBlockCount,0);assert.equal(review.changed,true);
 const result=resizeEditorColumns(input,{groupId:'layout',count:2});assert.deepEqual(result.blocks[0].children,[input[0].children[0],input[0].children[1]]);validateBlocks(result.blocks);assert.deepEqual(input,before);
 const noop=resizeEditorColumns(input,{groupId:'layout',count:3,createId:()=>assert.fail('same count does not mint IDs')});assert.equal(noop.changed,false);assert.equal(noop.blocks,input);assert.equal(noop.focusId,null);assert.equal(planEditorColumnsResize(input,{groupId:'layout',count:3}).changed,false);
});

test('invalid counts, missing groups, duplicate identities and unrelated blocks fail before changing input',()=>{
 for(const count of [0,1,4,'2',null,Number.NaN])assertRejected([columns()],{groupId:'layout',count},/COLUMNS_STRUCTURE/);
 assertRejected([columns()],{groupId:'missing',count:3},/READ_ONLY/);assertRejected([paragraph('text')],{groupId:'text',count:3},/COLUMNS_STRUCTURE/);
 assertRejected([columns([[paragraph('duplicate')],[paragraph('duplicate')]])],{groupId:'layout',count:3},/INVALID_BLOCK_TREE/);
});

test('readonly ancestors and future wrapper metadata are rejected rather than discarded',()=>{
 for(const parent of [paragraph('parent','source',{data:{text:'source',purpose:'import-source'},children:[columns()]}),{id:'future-parent',type:'future',children:[columns()]},{id:'code-parent',type:'code',data:{text:''},children:[columns()]}])assertRejected([parent],{groupId:'layout',count:3},/READ_ONLY/);
 for(const modify of [group=>group.data={unknown:true},group=>group.future='unknown',group=>group.children[0].data={purpose:'import-source'},group=>group.children[0].future=true,group=>group.children[0].data=null]){const group=columns();modify(group);assertRejected([group],{groupId:'layout',count:3},/READ_ONLY/);}
});

test('malformed and nested column structures remain uneditable',()=>{
 for(const count of [1,4])assertRejected([columns(Array.from({length:count},()=>[]))],{groupId:'layout',count:2},/READ_ONLY/);
 const wrong=columns();wrong.children[1].type='paragraph';assertRejected([wrong],{groupId:'layout',count:3},/READ_ONLY/);
 const nested={...columns(),id:'nested',children:[{id:'nested-left',type:'column',children:[]},{id:'nested-right',type:'column',children:[]}]};assertRejected([columns([[paragraph('holder','',{children:[nested]})],[]])],{groupId:'layout',count:3},/COLUMNS_NESTED/);
 assertRejected([columns([[{id:'orphan-column',type:'column',children:[]}],[]])],{groupId:'layout',count:3},/COLUMNS_STRUCTURE/);
 assertRejected([columns([[nested],[]])],{groupId:'nested',count:3},/READ_ONLY/);
});

test('new IDs cannot collide with existing content, each other or the ID grammar',()=>{
 for(const createId of [()=> 'layout',()=> 'column-0',()=> 'child',()=> 'new-repeated',()=> '',()=> 'bad id'])assertRejected([columns([[paragraph('child')],[]])],{groupId:'layout',count:3,createId},/INVALID_BLOCK_TREE/);
 assertRejected([columns()],{groupId:'layout',count:3,createId:null},/COLUMNS_STRUCTURE/);
});

test('a newly added paragraph must remain within the editor nesting limit while reduction never deepens existing content',()=>{
 const nest=group=>{for(let index=0;index<6;index++)group=paragraph('parent-'+index,'',{children:[group]});return[group];};
 assertRejected(nest(columns()),{groupId:'layout',count:3},/NESTING_LIMIT/);
 const input=nest(columns([[paragraph('left')],[],[rich()]])),result=resizeEditorColumns(input,{groupId:'layout',count:2});assert.equal(indexEditorBlocks(result.blocks).get('rich').depth,indexEditorBlocks(input).get('rich').depth);assert.deepEqual(indexEditorBlocks(result.blocks).get('rich').block,indexEditorBlocks(input).get('rich').block);validateBlocks(result.blocks);
});

test('column resizing rejects a document-wide block-count overflow without partial mutation',()=>{
 const input=[columns(),...Array.from({length:9996},(_,index)=>paragraph('existing-'+index))];assert.equal(indexEditorBlocks(input).size,9999);assertRejected(input,{groupId:'layout',count:3,createId:generator()},/INVALID_BLOCK_TREE/);
});

test('each resize is exactly one Undo/Redo step and retains the original rich data and stable child IDs',()=>{
 for(const count of [2,3]){const original={title:'Columns',blocks:[columns(count===2?[[paragraph('left')],[rich()],[paragraph('right')]]:[[paragraph('left')],[rich()]])]},history=new EditorHistory(original),result=resizeEditorColumns(original.blocks,{groupId:'layout',count,createId:generator()}),changed={...original,blocks:result.blocks};history.record(changed);assert.deepEqual(history.undo().draft,original);assert.equal(history.canUndo,false);assert.deepEqual(history.redo().draft,changed);assert.equal(history.canRedo,false);assert.deepEqual(indexEditorBlocks(changed.blocks).get('rich').block,indexEditorBlocks(original.blocks).get('rich').block);}
});
