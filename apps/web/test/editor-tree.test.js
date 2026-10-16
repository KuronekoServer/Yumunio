import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBlocks } from '../../../packages/domain/src/index.js';
import { EditorHistory } from '../public/editor-model.js';
import { indexEditorBlocks, canEditNestedBlock, planEditorNesting, createEditorNestingPlanner, nestEditorBlock, insertEditorBlock, splitEditorBlock, mergeEditorBlock, removeEditorBlock, MAX_EDITOR_NESTING } from '../public/editor-tree.js';
const block = (id, text = id, extra = {}) => ({ id, type: 'paragraph', data: { text }, ...extra });

test('nested indexing captures precise siblings and rejects duplicate IDs, cycles and malformed children', () => {
  const blocks = [block('a','A',{children:[block('b','B',{children:[block('c')]})]}),block('d')];
  const found = indexEditorBlocks(blocks).get('c'); assert.equal(found.depth,2); assert.equal(found.parentId,'b');assert.equal(found.order,2);
  assert.equal(found.siblings[0],found.block);assert.equal(found.ancestors[0],blocks[0]);
  assert.throws(()=>indexEditorBlocks([block('a'),block('a')])); assert.throws(()=>indexEditorBlocks([block('a','',{children:{}})]));
  const cyclic=block('cycle');cyclic.children=[cyclic];assert.throws(()=>indexEditorBlocks([cyclic]));
});
test('single-block indent/outdent keeps subtree, metadata and stable IDs without mutating input', () => {
  const input=[block('a'),block('b','😀',{data:{text:'😀',marks:[{start:0,end:2,styles:['bold']}],extra:{saved:true}},children:[block('child')]}),block('c')];
  const saved=structuredClone(input), nested=nestEditorBlock(input,'b','indent');assert.deepEqual(input,saved);assert.equal(nested[0].children[0].id,'b');
  assert.deepEqual(nestEditorBlock(nested,'b','outdent'),[{...saved[0],children:[]},...saved.slice(1)]);validateBlocks(nested);
  assert.throws(()=>planEditorNesting(input,'a','indent'),/NO_PREVIOUS/);assert.throws(()=>planEditorNesting(input,'a','outdent'),/AT_ROOT/);
  assert.throws(()=>nestEditorBlock([block('code','',{type:'code'}),block('b')],'b','indent'),/PARENT_UNSUPPORTED/);
});
test('new hierarchy respects the explicit depth limit and preserves existing deeper readonly content', () => {
  const root=block('depth-0');let cursor=root;
  for(let i=1;i<MAX_EDITOR_NESTING;i++){cursor.children=[block('depth-'+i),block('sibling-'+i)];cursor=cursor.children[0];}
  const saved=structuredClone(root);assert.throws(()=>nestEditorBlock([root],'sibling-7','indent'),/NESTING_LIMIT/);assert.deepEqual(root,saved);
  cursor.children=[block('legacy-deep')];assert.equal(canEditNestedBlock(indexEditorBlocks([root]).get('legacy-deep')),false);
  assert.equal(indexEditorBlocks([root]).get('legacy-deep').block.data.text,'legacy-deep');
});
test('append validates duplicate IDs, depth and readonly source ancestry before changing a tree', () => {
  const blocks=[block('a'),block('source','original',{type:'code',data:{text:'original',purpose:'import-source'},children:[block('future-child')]})];
  const added=insertEditorBlock(blocks,{parentId:'a',index:0,block:block('b')});assert.equal(added[0].children[0].id,'b');assert.equal(blocks[0].children,undefined);
  assert.throws(()=>insertEditorBlock(blocks,{parentId:'source',index:0,block:block('c')}),/READ_ONLY/);
  assert.equal(canEditNestedBlock(indexEditorBlocks(blocks).get('future-child')),false);
  assert.throws(()=>insertEditorBlock(blocks,{parentId:null,index:0,block:block('a')}));
});
test('nested Enter splits a selected UTF16 range and preserves source blocks and surrounding children', () => {
  const blocks=[block('a','parent',{children:[block('b','A😀B',{data:{text:'A😀B',checked:true,marks:[{start:1,end:3,styles:['italic']}]} }),block('source','unchanged',{type:'code',data:{text:'unchanged',purpose:'import-source'}})]})];
  const result=splitEditorBlock(blocks,{blockId:'b',start:1,end:1,newId:'next'});
  assert.deepEqual(result.blocks[0].children.map(item=>item.id),['b','next','source']);assert.equal(result.blocks[0].children[1].data.text,'😀B');
  assert.deepEqual(result.blocks[0].children[1].data.marks,[{start:0,end:2,styles:['italic']}]);assert.deepEqual(result.blocks[0].children[2],blocks[0].children[1]);
  assert.throws(()=>splitEditorBlock(blocks,{blockId:'b',start:2,end:2,newId:'next'}));validateBlocks(result.blocks);
});
test('Enter on an empty nested item outdents it; selected text is removed when leaving a list', () => {
  const input=[block('a','A',{children:[block('empty','',{type:'bulleted-list'})]})];
  const result=splitEditorBlock(input,{blockId:'empty',start:0,end:0,newId:'unused'});assert.deepEqual(result.blocks.map(item=>item.id),['a','empty']);
  const root=[block('item','Selected',{type:'bulleted-list'})], converted=splitEditorBlock(root,{blockId:'item',start:0,end:8,newId:'unused'});
  assert.equal(converted.blocks[0].type,'paragraph');assert.equal(converted.blocks[0].data.text,'');
});
test('Backspace joins siblings with exact marks and outdents a first child without merging into its parent', () => {
  const input=[block('parent','P',{children:[block('a','A',{data:{text:'A',marks:[{start:0,end:1,styles:['bold']}]}}),block('b','😀',{data:{text:'😀',marks:[{start:0,end:2,styles:['italic']}]}})]})];
  const merged=mergeEditorBlock(input,'b');assert.equal(merged.blocks[0].children[0].data.text,'A😀');assert.deepEqual(merged.blocks[0].children[0].data.marks,[{start:0,end:1,styles:['bold']},{start:1,end:3,styles:['italic']}]);
  const out=mergeEditorBlock(input,'a');assert.deepEqual(out.blocks.map(item=>item.id),['parent','a']);assert.equal(out.blocks[0].children[0].id,'b');assert.equal(input[0].children.length,2);
  assert.throws(()=>mergeEditorBlock([block('a','A',{children:[block('child')]}),block('b')],'b'),/CHILDREN_JOIN/);
});
test('nested delete requires explicit subtree confirmation and history restores all source and marks', () => {
  const original=[block('a'),block('b','B',{children:[block('source','raw',{type:'code',data:{text:'raw',purpose:'import-source'}})]})];
  assert.throws(()=>removeEditorBlock(original,'b'),/HAS_CHILDREN/);
  const history=new EditorHistory({title:'Note',blocks:original});const nested=nestEditorBlock(original,'b','indent');history.record({title:'Note',blocks:nested});
  const deleted=removeEditorBlock(nested,'b',{confirmChildren:true});history.record({title:'Note',blocks:deleted});
  assert.deepEqual(history.undo().draft.blocks,nested);assert.deepEqual(history.undo().draft.blocks,original);assert.deepEqual(history.redo().draft.blocks,nested);
  assert.equal(deleted[0].children.length,0);assert.equal(original[1].children[0].data.text,'raw');
});

test('splitting a parent retains its exact child subtree, while joining refuses to absorb children',()=>{
 const source=block('raw','source',{type:'code',data:{text:'source',purpose:'import-source',extra:{future:true}}});
 const input=[block('parent','AB',{children:[block('child','Child',{children:[source]})]})],saved=structuredClone(input);
 const result=splitEditorBlock(input,{blockId:'parent',start:1,end:1,newId:'after'});
 assert.equal(result.blocks[0].data.text,'A');assert.equal(result.blocks[1].data.text,'B');assert.deepEqual(result.blocks[0].children,input[0].children);
 assert.throws(()=>mergeEditorBlock(result.blocks,'after'),/CHILDREN_JOIN/);assert.deepEqual(input,saved);validateBlocks(result.blocks);
});
test('outdenting one of several children preserves sibling order and each remaining nested subtree',()=>{
 const input=[block('a','A',{children:[block('first'),block('chosen','C',{children:[block('leaf')]}),block('last')]}),block('after')];
 const result=nestEditorBlock(input,'chosen','outdent');
 assert.deepEqual(result.map(item=>item.id),['a','chosen','after']);assert.deepEqual(result[0].children.map(item=>item.id),['first','last']);assert.equal(result[1].children[0].id,'leaf');validateBlocks(result);
});
test('oversize sibling merge is rejected before caller text, marks or structure changes',()=>{
 const input=[block('parent','P',{children:[block('a','a'.repeat(100000)),block('b','B')]})],saved=structuredClone(input);
 assert.throws(()=>mergeEditorBlock(input,'b'));assert.deepEqual(input,saved);
});

test('render planner captures a hierarchy once and stays isolated from later draft mutations',()=>{
 const input=[block('parent'),block('child')],plan=createEditorNestingPlanner(input);
 assert.deepEqual(plan('child','indent'),{blockId:'child',parentId:'parent',index:0});
 input[0].type='code';input.push(block('later'));
 assert.deepEqual(plan('child','indent'),{blockId:'child',parentId:'parent',index:0});
 assert.throws(()=>plan('later','indent'),/READ_ONLY/);assert.throws(()=>planEditorNesting(input,'child','indent'),/PARENT_UNSUPPORTED/);
});
