import test from 'node:test';
import assert from 'node:assert/strict';
import {moveBlockForest,planBlockForestMove} from '../src/block-forest.js';
import {validateBlocks} from '../src/index.js';
const block=(id,children)=>({id,type:'paragraph',data:{text:id,...(id==='a'?{future:{retained:true}}:{})},...(children?{children}:{})});
const layout=()=>({id:'layout',type:'columns',children:[{id:'left',type:'column',children:[block('column-text')]},{id:'right',type:'column',children:[]}]});
const ids=blocks=>blocks.map(block=>block.id),move=(source,target,blockIds,extra={})=>moveBlockForest(source,target,{blockIds,parentBlockId:null,index:target.length,...extra});
test('cross-document selection is one document-order forest, preserving IDs, layout and nested payloads without mutating inputs',()=>{
 const source=[block('a',[block('child')]),layout(),block('b'),block('keep')],target=[block('existing')],before=structuredClone({source,target}),result=move(source,target,['b','child','column-text','a','layout','a']);
 assert.deepEqual(result.blockIds,['a','layout','b']);assert.deepEqual(ids(result.sourceBlocks),['keep']);assert.deepEqual(result.targetBlocks,[target[0],...source.slice(0,3)]);assert.deepEqual({source,target},before);validateBlocks(result.sourceBlocks);validateBlocks(result.targetBlocks);
});
test('moving all content out of columns preserves the fixed wrappers and can fill an empty target column',()=>{
 const source=[layout()],target=[{...layout(),id:'other',children:[{id:'other-left',type:'column',children:[]},{id:'other-right',type:'column',children:[]}]}],result=move(source,target,['column-text'],{parentBlockId:'other-right',index:0});
 assert.deepEqual(result.sourceBlocks[0].children.map(column=>column.children),[[],[]]);assert.deepEqual(ids(result.targetBlocks[0].children[1].children),['column-text']);validateBlocks(result.sourceBlocks);validateBlocks(result.targetBlocks);
 assert.deepEqual(move([block('last')],[],['last']).sourceBlocks,[]);
});
test('same-document forests remove original siblings once and adjust the insertion index before the entire forest',()=>{
 const blocks=[block('a'),block('b'),block('c'),block('d')],result=move(blocks,blocks,['b','a'],{sameDocument:true,index:4});assert.deepEqual(ids(result.sourceBlocks),['c','d','a','b']);assert.equal(result.sourceBlocks,result.targetBlocks);assert.deepEqual(ids(blocks),['a','b','c','d']);
});
test('every selected root is checked before any detached content can escape an invalid selection',()=>{
 const source=[block('a'),block('b')],target=[],before=structuredClone(source);
 for(const selected of [[],['a','missing'],['a',null],Array(10001).fill('a')])assert.throws(()=>move(source,target,selected));assert.deepEqual(source,before);assert.deepEqual(target,[]);
 assert.throws(()=>move(source,[block('b')],['a','b']),error=>error.code==='BLOCK_ID_CONFLICT');assert.deepEqual(source,before);
});
test('a readonly root, hidden ancestor, import source or unknown descendant cannot be partially moved between pages',()=>{
 const original=[block('a'),{id:'raw',type:'code',data:{text:'private',purpose:'import-source'}},{id:'future',type:'future',children:[block('under-future')]},block('holder',[{id:'unknown-child',type:'future',data:{opaque:true}}])];
 for(const selected of [['a','raw'],['under-future'],['holder'],['future']]){const source=structuredClone(original);assert.throws(()=>move(source,[],selected),error=>error.code==='BLOCK_NESTING_READ_ONLY');assert.deepEqual(source,original);}
 const same=move([original[3],block('after')],[original[3],block('after')],['holder'],{sameDocument:true,index:2});assert.equal(same.targetBlocks[1].children[0].data.opaque,true);
});
test('page-bound attachment references reject the entire forest, including a reference in a later descendant',()=>{
 const source=[block('a'),block('b',[{id:'file',type:'paragraph',data:{text:'file',links:[{attachmentId:'private-file'}]}}])],before=structuredClone(source);assert.throws(()=>move(source,[],['a','b']),error=>error.code==='BLOCK_ATTACHMENTS_UNSUPPORTED');assert.deepEqual(source,before);
});
test('fixed wrappers, nested layouts, cycles, unsupported parents and complete subtree depth fail before mutation',()=>{
 const source=[block('a',[block('child')]),layout()],target=[{id:'code',type:'code',data:{text:'readonly-parent'}},block('p')];
 for(const [selected,extra,code]of [[['left'],{},'BLOCK_NESTING_READ_ONLY'],[['layout'],{parentBlockId:'right',sameDocument:true,index:0},'BLOCK_MOVE_CYCLE'],[['a'],{parentBlockId:'child',sameDocument:true,index:0},'BLOCK_MOVE_CYCLE']])assert.throws(()=>move(source,source,selected,extra),error=>error.code===code);
 const other=[{...layout(),id:'other-layout',children:[{id:'other-left',type:'column',children:[]},{id:'other-right',type:'column',children:[]}]}];assert.throws(()=>move(source,other,['layout'],{parentBlockId:'other-right',index:0}),error=>error.code==='BLOCK_COLUMNS_NESTED');
 assert.throws(()=>move(source,target,['a'],{parentBlockId:'code',index:0}),error=>error.code==='BLOCK_PARENT_UNSUPPORTED');
 let deep=block('deep');for(let index=0;index<7;index++)deep=block('depth-'+index,[deep]);assert.throws(()=>move([deep],target,['depth-6'],{parentBlockId:'p',index:0}),error=>error.code==='BLOCK_NESTING_LIMIT');
 const invalid=[{...layout(),children:[{id:'one',type:'column',children:[]}]}];assert.throws(()=>planBlockForestMove(invalid,[],{blockIds:['layout'],index:0}),error=>error.code==='BLOCK_COLUMNS_STRUCTURE');
});
