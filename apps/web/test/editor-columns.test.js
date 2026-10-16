import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks} from '../../../packages/domain/src/index.js';
import {EditorHistory} from '../public/editor-model.js';
import {indexEditorBlocks,canEditNestedBlock,canEditEditorParent,insertEditorBlock,insertEditorColumns,wrapEditorBlockInColumns,unwrapEditorColumns,moveEditorBlockTo,moveEditorBlocksTo,normalizeEditorBlockSelection,nestEditorBlock,splitEditorBlock,mergeEditorBlock} from '../public/editor-tree.js';
import {projectBlockDrop,validateBlockDrop} from '../public/block-dnd.js';
const block=(id,text=id,extra={})=>({id,type:'paragraph',data:{text},...extra});
const ids=items=>items.map(item=>item.id);
const generator=()=>{let number=0;return()=>`layout-${++number}`;};
const layout=(children=[[],[]])=>({id:'group',type:'columns',children:children.map((items,index)=>({id:'column-'+index,type:'column',children:items}))});

test('explicit two and three column insertion creates valid unique containers and editable paragraphs without changing existing data',()=>{
 for(const count of [2,3]){
  const input=[block('before'),block('after')],saved=structuredClone(input),result=insertEditorColumns(input,{count,index:1,createId:generator()});
  assert.deepEqual(input,saved);assert.deepEqual(ids(result.blocks),['before',result.groupId,'after']);
  const group=result.blocks[1];assert.equal(group.type,'columns');assert.equal(group.children.length,count);assert.equal(indexEditorBlocks(result.blocks).size,3+count*2);
  for(const column of group.children){assert.equal(column.type,'column');assert.equal(column.children[0].data.text,'');assert.equal(canEditEditorParent(indexEditorBlocks(result.blocks).get(column.id)),true);assert.equal(canEditNestedBlock(indexEditorBlocks(result.blocks).get(column.id)),false);}
  assert.equal(result.focusId,group.children[0].children[0].id);validateBlocks(result.blocks);
 }
});

test('wrapping and removing columns preserve exact source IDs, nested metadata, formatting, links and mentions',()=>{
 const item=block('source','Aoi page',{data:{text:'Aoi page',marks:[{start:0,end:3,styles:['bold']}],links:[{start:4,end:8,label:'page',pageId:'page-a'}],mentions:[{kind:'person',start:0,end:3,accountId:'aoi'}],future:{keep:true}},children:[{id:'raw',type:'future',data:{opaque:[1,2,3]}}]});
 const input=[block('before'),item,block('after')],saved=structuredClone(input),wrapped=wrapEditorBlockInColumns(input,{blockId:'source',count:3,createId:generator()});
 assert.deepEqual(input,saved);assert.deepEqual(wrapped.blocks[1].children[0].children,[item]);assert.equal(indexEditorBlocks(wrapped.blocks).get('source').depth,2);
 const unwrapped=unwrapEditorColumns(wrapped.blocks,wrapped.groupId);assert.deepEqual(unwrapped.blocks[1],item);assert.deepEqual(ids(unwrapped.blocks),['before','source',...wrapped.blocks[1].children.slice(1).map(column=>column.children[0].id),'after']);validateBlocks(wrapped.blocks);validateBlocks(unwrapped.blocks);
});

test('removing a layout flattens column order and retains every unknown child payload, including empty columns',()=>{
 const original=layout([[block('one'),{id:'opaque',type:'future',data:{payload:{private:true}}}],[],[block('three')]]),input=[block('before'),original,block('after')],saved=structuredClone(input);
 const result=unwrapEditorColumns(input,'group');assert.deepEqual(input,saved);assert.deepEqual(result.blocks,[input[0],...original.children[0].children,...original.children[2].children,input[2]]);validateBlocks(result.blocks);
 assert.deepEqual(unwrapEditorColumns([layout()],'group').blocks,[]);
});

test('single block reordering and cross-column moves use intact trees and can append into an empty column',()=>{
 const input=[layout([[block('a'),block('b')],[]]),block('root')],saved=structuredClone(input);
 const moved=moveEditorBlockTo(input,{blockId:'a',targetId:'column-1',placement:'inside'});assert.deepEqual(ids(moved[0].children[0].children),['b']);assert.deepEqual(ids(moved[0].children[1].children),['a']);
 const reordered=moveEditorBlockTo(moved,{blockId:'root',targetId:'a',placement:'before'});assert.deepEqual(ids(reordered[0].children[1].children),['root','a']);
 const out=moveEditorBlockTo(reordered,{blockId:'a',targetId:'group',placement:'after'});assert.deepEqual(ids(out),['group','a']);assert.deepEqual(input,saved);validateBlocks(out);
});

test('selected forests cross columns in document order and ancestor selections do not duplicate descendants',()=>{
 const input=[layout([[block('a','A',{children:[block('child')]}),block('b')],[block('target')]])];
 assert.deepEqual(normalizeEditorBlockSelection(input,['child','b','a']),['a','b']);
 const result=moveEditorBlocksTo(input,{blockIds:['child','b','a'],targetId:'target',placement:'after'});
 assert.deepEqual(ids(result[0].children[0].children),[]);assert.deepEqual(ids(result[0].children[1].children),['target','a','b']);assert.deepEqual(result[0].children[1].children[1],input[0].children[0].children[0]);validateBlocks(result);
});

test('column wrappers cannot move, receive ordinary siblings, or be inserted without their group',()=>{
 const input=[layout([[block('a')],[]]),block('root')],saved=structuredClone(input);
 assert.throws(()=>moveEditorBlockTo(input,{blockId:'column-0',placement:'end'}),/READ_ONLY/);
 assert.throws(()=>moveEditorBlockTo(input,{blockId:'root',targetId:'column-0',placement:'before'}),/PARENT_UNSUPPORTED/);
 assert.throws(()=>moveEditorBlockTo(input,{blockId:'root',targetId:'group',placement:'inside'}),/PARENT_UNSUPPORTED/);
 assert.throws(()=>insertEditorBlock(input,{block:{id:'orphan',type:'column',children:[]},index:0}),/COLUMNS_STRUCTURE/);
 assert.throws(()=>normalizeEditorBlockSelection(input,['column-1']),/READ_ONLY/);assert.deepEqual(input,saved);
});

test('nested column groups are rejected for insertion, wrapping and subtree or forest moves before mutation',()=>{
 const input=[layout([[block('a')],[]]),block('holder','holder',{children:[{...layout(),id:'other',children:[{id:'other-0',type:'column',children:[]},{id:'other-1',type:'column',children:[]}]}]})],saved=structuredClone(input);
 assert.throws(()=>insertEditorColumns(input,{count:2,parentId:'column-0',index:0,createId:generator()}),/COLUMNS_NESTED/);
 assert.throws(()=>wrapEditorBlockInColumns(input,{blockId:'a',createId:generator()}),/COLUMNS_NESTED/);
 assert.throws(()=>wrapEditorBlockInColumns(input,{blockId:'holder',createId:generator()}),/COLUMNS_NESTED/);
 for(const blockId of ['holder','other'])assert.throws(()=>moveEditorBlockTo(input,{blockId,targetId:'column-0',placement:'inside'}),/COLUMNS_NESTED/);
 assert.throws(()=>moveEditorBlocksTo(input,{blockIds:['a','holder'],targetId:'column-1',placement:'inside'}),/COLUMNS_NESTED/);assert.deepEqual(input,saved);
});

test('layout creation validates count, unique IDs, source readability and complete subtree depth',()=>{
 assert.throws(()=>insertEditorColumns([],{count:4,index:0,createId:generator()}),/COLUMNS_STRUCTURE/);
 assert.throws(()=>insertEditorColumns([block('collision')],{count:2,index:0,createId:()=> 'collision'}),/INVALID_BLOCK_TREE/);
 assert.throws(()=>wrapEditorBlockInColumns([block('raw','source',{data:{text:'source',purpose:'import-source'}})],{blockId:'raw',createId:generator()}),/READ_ONLY/);
 let deep=block('deep-0');for(let index=1;index<7;index++)deep=block('deep-'+index,'',{children:[deep]});
 assert.throws(()=>wrapEditorBlockInColumns([deep],{blockId:'deep-6',createId:generator()}),/NESTING_LIMIT/);
});

test('Enter and Backspace inside columns preserve mention ranges and fixed wrappers',()=>{
 const source=block('source','Aoi Page',{data:{text:'Aoi Page',mentions:[{kind:'person',start:0,end:3,accountId:'aoi'},{kind:'page',start:4,end:8,pageId:'page-a'}]}}),input=[layout([[source],[]])];
 const split=splitEditorBlock(input,{blockId:'source',start:4,end:4,newId:'split'});assert.deepEqual(split.blocks[0].children[0].children.map(block=>block.data.mentions),[[{kind:'person',start:0,end:3,accountId:'aoi'}],[{kind:'page',start:0,end:4,pageId:'page-a'}]]);
 const joined=mergeEditorBlock(split.blocks,'split');assert.deepEqual(joined.blocks,input);validateBlocks(joined.blocks);
 const cut=splitEditorBlock(input,{blockId:'source',start:1,end:2,newId:'cut'});assert.equal(cut.blocks[0].children[0].children[0].data.mentions,undefined);assert.deepEqual(cut.blocks[0].children[0].children[1].data.mentions,[{kind:'page',start:2,end:6,pageId:'page-a'}]);
});

test('outdenting or leaving an empty first column paragraph exits after the group without breaking its wrappers',()=>{
 const input=[layout([[block('empty','')],[block('other')]]),block('tail')];
 const expected=['group','empty','tail'];assert.deepEqual(ids(nestEditorBlock(input,'empty','outdent')),expected);
 assert.deepEqual(ids(splitEditorBlock(input,{blockId:'empty',start:0,end:0,newId:'unused'}).blocks),expected);
 assert.deepEqual(ids(mergeEditorBlock(input,'empty').blocks),expected);
 assert.equal(nestEditorBlock(input,'empty','outdent')[0].children[0].children.length,0);validateBlocks(nestEditorBlock(input,'empty','outdent'));
});

test('unknown wrapper metadata and malformed layout paths stay readonly instead of being discarded by unwrap',()=>{
 for(const mutate of [group=>group.data={future:true},group=>group.children.pop(),group=>group.children[0].future='keep',group=>group.children[0].data=null]){
  const group=layout([[block('a')],[]]);mutate(group);const input=[group],saved=structuredClone(input),locations=indexEditorBlocks(input);
  assert.equal(canEditNestedBlock(locations.get('group')),false);assert.equal(canEditNestedBlock(locations.get('a')),false);assert.throws(()=>unwrapEditorColumns(input,'group'),/READ_ONLY/);assert.deepEqual(input,saved);
 }
});

test('dnd projection accepts a column middle as an inside destination and rejects invalid structure and stale source paths',()=>{
 const input=[layout([[block('a')],[]]),block('root')],rect={left:200,top:20,width:150,height:36},point={x:250,y:38};
 const operation=projectBlockDrop({blocks:input,blockId:'a',targetId:'column-1',rect,point});assert.deepEqual(operation,{blockId:'a',targetId:'column-1',placement:'inside'});
 assert.equal(projectBlockDrop({blocks:input,blockId:'root',targetId:'column-0',placement:'before'}),null);
 assert.equal(projectBlockDrop({blocks:input,blockId:'group',targetId:'column-1',rect,point}),null);
 const latest=structuredClone(input);latest[0].data={purpose:'import-source'};assert.equal(validateBlockDrop({blocks:latest,...operation}),null);
});

test('wrap and unwrap each create one independent Undo entry with the original data retained',()=>{
 const initial={title:'Columns',blocks:[block('a'),block('b')]},history=new EditorHistory(initial),wrapped=wrapEditorBlockInColumns(initial.blocks,{blockId:'a',createId:generator()});
 const draft={...initial,blocks:wrapped.blocks};history.record(draft);const removed={...initial,blocks:unwrapEditorColumns(draft.blocks,wrapped.groupId).blocks};history.record(removed);
 assert.deepEqual(history.undo().draft,draft);assert.deepEqual(history.undo().draft,initial);assert.deepEqual(history.redo().draft,draft);assert.deepEqual(history.redo().draft,removed);
});
