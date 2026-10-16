import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBlocks } from '../../../packages/domain/src/index.js';
import { EditorHistory } from '../public/editor-model.js';
import { PageAutosave } from '../public/page-autosave.js';
import { planEditorBlockMove, createEditorMovePlanner, moveEditorBlockTo, editorDropPlacement, indexEditorBlocks, MAX_EDITOR_NESTING } from '../public/editor-tree.js';
const block = (id, extra = {}) => ({id,type:'paragraph',data:{text:id},...extra});

test('cross-parent movement preserves the complete subtree and inline and imported metadata', () => {
  const source=block('moving',{data:{text:'A\u{1f600}B',marks:[{start:1,end:3,styles:['bold']}],links:[{start:3,end:4,label:'B',pageId:'page-b'}]},children:[block('raw',{type:'code',data:{text:'Original source',purpose:'import-source',source:{original:true}}})]});
  const input=[block('old',{children:[block('first'),source,block('last')]}),block('new',{children:[block('existing')]})],saved=structuredClone(input);
  const result=moveEditorBlockTo(input,{blockId:'moving',targetId:'existing',placement:'before'});
  assert.deepEqual(input,saved);assert.deepEqual(result[0].children.map(item=>item.id),['first','last']);
  assert.deepEqual(result[1].children.map(item=>item.id),['moving','existing']);assert.deepEqual(result[1].children[0],source);
  assert.equal(indexEditorBlocks(result).size,indexEditorBlocks(input).size);validateBlocks(result);
});

test('moving a root inside another parent appends after its children and can be moved back after that parent', () => {
  const input=[block('a',{children:[block('a-child')]}),block('b',{children:[block('b-child')]}),block('c')];
  const nested=moveEditorBlockTo(input,{blockId:'b',targetId:'a',placement:'inside'});
  assert.deepEqual(nested.map(item=>item.id),['a','c']);assert.deepEqual(nested[0].children.map(item=>item.id),['a-child','b']);
  const restored=moveEditorBlockTo(nested,{blockId:'b',targetId:'a',placement:'after'});
  assert.deepEqual(restored,input);validateBlocks(nested);
});

test('before after and end use stable pre-removal sibling indexes in both directions', () => {
  const input=['a','b','c','d'].map(id=>block(id));
  for(const [source,target,placement,expected]of [
    ['a','c','after',['b','c','a','d']],['d','b','before',['a','d','b','c']],
    ['b','c','before',['a','b','c','d']],['b','a','after',['a','b','c','d']]
  ])assert.deepEqual(moveEditorBlockTo(input,{blockId:source,targetId:target,placement}).map(item=>item.id),expected);
  const nested=[block('parent',{children:[block('child')]}),block('last')];
  const result=moveEditorBlockTo(nested,{blockId:'child',placement:'end'});
  assert.deepEqual(result.map(item=>item.id),['parent','last','child']);assert.equal(result[0].children.length,0);
  assert.throws(()=>planEditorBlockMove(input,{blockId:'a',targetId:'b',placement:'end'}),/INVALID_BLOCK_MOVE/);
});

test('self and descendant destinations are rejected before changing the caller tree', () => {
  const input=[block('parent',{children:[block('child',{children:[block('grandchild')]})]}),block('other')],saved=structuredClone(input);
  for(const placement of ['before','after','inside']){
    assert.throws(()=>moveEditorBlockTo(input,{blockId:'parent',targetId:'parent',placement}),/BLOCK_MOVE_SELF/);
    for(const targetId of ['child','grandchild'])assert.throws(()=>moveEditorBlockTo(input,{blockId:'parent',targetId,placement}),/BLOCK_MOVE_CYCLE/);
  }
  assert.deepEqual(input,saved);
});

test('source references and unsupported ancestry stay readonly while surrounding root positions remain usable', () => {
  const input=[block('editable'),block('source',{type:'code',data:{text:'raw',purpose:'import-source'},children:[block('hidden-child')]}),block('code',{type:'code',children:[block('code-child')]})];
  for(const blockId of ['source','hidden-child','code-child'])assert.throws(()=>moveEditorBlockTo(input,{blockId,placement:'end'}),/READ_ONLY/);
  for(const targetId of ['source','hidden-child','code','code-child'])assert.throws(()=>moveEditorBlockTo(input,{blockId:'editable',targetId,placement:'inside'}),/READ_ONLY|PARENT_UNSUPPORTED/);
  for(const targetId of ['hidden-child','code-child'])assert.throws(()=>moveEditorBlockTo(input,{blockId:'editable',targetId,placement:'before'}),/READ_ONLY|PARENT_UNSUPPORTED/);
  const result=moveEditorBlockTo(input,{blockId:'editable',targetId:'source',placement:'after'});
  assert.deepEqual(result.map(item=>item.id),['source','editable','code']);assert.deepEqual(result[0],input[1]);
});

test('new placement checks the full subtree height against the editable depth limit', () => {
  const parent=block('level-0');let cursor=parent;
  for(let level=1;level<MAX_EDITOR_NESTING;level++){cursor.children=[block('level-'+level)];cursor=cursor.children[0];}
  const input=[parent,block('leaf'),block('branch',{children:[block('tip')]})],saved=structuredClone(input);
  assert.throws(()=>moveEditorBlockTo(input,{blockId:'leaf',targetId:'level-7',placement:'inside'}),/NESTING_LIMIT/);
  assert.throws(()=>moveEditorBlockTo(input,{blockId:'branch',targetId:'level-6',placement:'inside'}),/NESTING_LIMIT/);
  const result=moveEditorBlockTo(input,{blockId:'leaf',targetId:'level-6',placement:'inside'});
  assert.equal(indexEditorBlocks(result).get('leaf').depth,7);assert.deepEqual(input,saved);validateBlocks(result);
});

test('preview planners capture an isolated tree but the committed move validates the latest tree', () => {
  const input=[block('a'),block('b')],planner=createEditorMovePlanner(input),operation={blockId:'b',targetId:'a',placement:'inside'};
  assert.deepEqual(planner(operation),{blockId:'b',parentId:'a',index:0});
  input[0].type='code';assert.deepEqual(planner(operation),{blockId:'b',parentId:'a',index:0});
  assert.throws(()=>moveEditorBlockTo(input,operation),/PARENT_UNSUPPORTED/);
  input.push(block('later'));assert.throws(()=>planner({blockId:'later',placement:'end'}),/READ_ONLY/);
});

test('pointer placement gives nesting a middle zone while leaves retain before and after targets', () => {
  for(const height of [24,120]){
    assert.equal(editorDropPlacement({offset:0,height,canNest:true}),'before');
    assert.equal(editorDropPlacement({offset:height/2,height,canNest:true}),'inside');
    assert.equal(editorDropPlacement({offset:height,height,canNest:true}),'after');
    assert.equal(editorDropPlacement({offset:height*.4,height}),'before');
    assert.equal(editorDropPlacement({offset:height*.6,height}),'after');
  }
  for(const height of [0,-1,NaN,Infinity])assert.equal(editorDropPlacement({offset:0,height}),null);
});

test('a move is a separate undo step and autosave retains an undo made while the previous save is in flight', async () => {
  const initial={title:'Draft title',blocks:[block('a'),block('b')]},history=new EditorHistory(initial);
  let draft=structuredClone(initial),saved=structuredClone(initial),generation=0,resolveSave;
  const sends=[],state=()=>({scopeKey:'fixture:workspace:page',generation,dirty:JSON.stringify(draft)!==JSON.stringify(saved),paused:false});
  const autosave=new PageAutosave({getState:state,save:async()=>{
    const captured=structuredClone(draft);sends.push(captured);
    if(sends.length===1)await new Promise(resolve=>{resolveSave=resolve;});
    saved=captured;return{status:'saved'};
  }});
  draft.blocks[0].data.text='Unsent text';history.record(draft,{group:'typing'});generation++;
  draft.blocks=moveEditorBlockTo(draft.blocks,{blockId:'a',targetId:'b',placement:'inside'});history.record(draft);generation++;autosave.notify();
  const first=autosave.flush();for(let index=0;index<5;index++)await Promise.resolve();assert.equal(sends.length,1);
  draft=history.undo().draft;generation++;autosave.notify();assert.equal(draft.blocks[0].data.text,'Unsent text');assert.equal(draft.blocks[0].id,'a');
  resolveSave();await first;assert.equal(state().dirty,true);await autosave.flush();autosave.stop();
  assert.equal(sends.length,2);assert.deepEqual(saved,draft);assert.deepEqual(history.redo().draft.blocks,sends[0].blocks);validateBlocks(saved.blocks);
});
