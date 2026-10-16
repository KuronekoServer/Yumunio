import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks} from '../../../packages/domain/src/index.js';
import {EditorHistory} from '../public/editor-model.js';
import {PageAutosave} from '../public/page-autosave.js';
import {normalizeEditorBlockSelection,editorBlockSelectionRange,planEditorBlocksMove,createEditorMultiMovePlanner,moveEditorBlocksTo,indexEditorBlocks} from '../public/editor-tree.js';
const block=(id,extra={})=>({id,type:'paragraph',data:{text:id},...extra});
const ids=items=>items.map(item=>item.id);

test('selection normalizes duplicate and descendant choices to document-ordered forest roots',()=>{
 const source=block('source',{type:'code',data:{purpose:'import-source',text:'raw'}});
 const input=[block('parent',{children:[block('child'),source]}),block('last')];
 assert.deepEqual(normalizeEditorBlockSelection(input,['last','child','parent','parent','source']),['parent','last']);
 assert.throws(()=>normalizeEditorBlockSelection(input,['source']),/READ_ONLY/);
 for(const selected of [[],['missing'],[null],Array(10001).fill('parent')])assert.throws(()=>normalizeEditorBlockSelection(input,selected));
});

test('explicit checkbox ranges include both endpoints in either direction and skip readonly content',()=>{
 const input=[block('first',{children:[block('child')]}),block('source',{type:'code',data:{purpose:'import-source',text:'raw'},children:[block('locked')]}),block('last')];
 assert.deepEqual(editorBlockSelectionRange(input,'first','last'),['first','child','last']);
 assert.deepEqual(editorBlockSelectionRange(input,'last','first'),['first','child','last']);
 assert.deepEqual(editorBlockSelectionRange(input,'missing','last'),['last']);
 assert.throws(()=>editorBlockSelectionRange(input,'first','locked'),/READ_ONLY/);
});

test('mixed-parent forest moves as one ordered group and preserves exact subtrees, marks and references',()=>{
 const rich=block('rich',{data:{text:'A\u{1f600}B',marks:[{start:1,end:3,styles:['bold']}],links:[{start:3,end:4,label:'B',pageId:'page-b'}]},children:[block('raw',{type:'code',data:{purpose:'import-source',text:'Original',sourceModel:{kept:true}}})]});
 const input=[block('a',{children:[block('target'),block('a-child')]}),block('b',{children:[block('b-child')]}),rich,block('last')],before=structuredClone(input);
 const result=moveEditorBlocksTo(input,{blockIds:['rich','b-child','a-child'],targetId:'target',placement:'inside'});
 assert.deepEqual(input,before);assert.deepEqual(ids(result),['a','b','last']);
 assert.deepEqual(ids(result[0].children),['target']);assert.deepEqual(ids(result[0].children[0].children),['a-child','b-child','rich']);
 assert.deepEqual(result[0].children[0].children[2],rich);assert.deepEqual(result[1].children,[]);
 assert.equal(indexEditorBlocks(result).size,indexEditorBlocks(input).size);validateBlocks(result);
});

test('same-parent disjoint selections keep document order for before after and end in both directions',()=>{
 const input=['a','b','c','d','e'].map(id=>block(id));
 for(const [selected,targetId,placement,expected]of[
  [['d','b'],'a','before',['b','d','a','c','e']],
  [['a','c'],'d','after',['b','d','a','c','e']],
  [['e','c'],'b','before',['a','c','e','b','d']],
  [['d','b'],null,'end',['a','c','e','b','d']]
 ])assert.deepEqual(ids(moveEditorBlocksTo(input,{blockIds:selected,targetId,placement})),expected);
 assert.deepEqual(ids(input),['a','b','c','d','e']);
});

test('selected ancestors absorb selected descendants without duplicate insertion or data loss',()=>{
 const parent=block('parent',{children:[block('child',{children:[block('grandchild')]})]});
 const input=[parent,block('target')],result=moveEditorBlocksTo(input,{blockIds:['grandchild','child','parent'],targetId:'target',placement:'inside'});
 assert.deepEqual(ids(result),['target']);assert.deepEqual(result[0].children,[parent]);assert.equal(indexEditorBlocks(result).size,4);
});

test('destinations within any selected subtree and invalid destinations fail before mutation',()=>{
 const input=[block('a',{children:[block('a-child')]}),block('b',{children:[block('b-child')]}),block('target')],before=structuredClone(input);
 for(const targetId of ['a','a-child','b','b-child'])for(const placement of ['before','after','inside'])assert.throws(()=>moveEditorBlocksTo(input,{blockIds:['a','b'],targetId,placement}),/BLOCK_MOVE_SELECTION/);
 for(const operation of [{blockIds:['a','b'],targetId:'missing',placement:'before'},{blockIds:['a','b'],targetId:'target',placement:'end'}])assert.throws(()=>moveEditorBlocksTo(input,operation));
 assert.deepEqual(input,before);
});

test('every selected root and the complete forest height are validated for readonly and nesting limits',()=>{
 const deep=block('level-0');let cursor=deep;for(let level=1;level<8;level++){cursor.children=[block('level-'+level)];cursor=cursor.children[0];}
 const input=[deep,block('leaf'),block('branch',{children:[block('tip')]}),block('source',{type:'code',data:{purpose:'import-source',text:'raw'},children:[block('locked')]})],before=structuredClone(input);
 for(const source of ['source','locked'])assert.throws(()=>moveEditorBlocksTo(input,{blockIds:['leaf',source],placement:'end'}),/READ_ONLY/);
 assert.throws(()=>moveEditorBlocksTo(input,{blockIds:['leaf','branch'],targetId:'level-6',placement:'inside'}),/NESTING_LIMIT/);
 const result=moveEditorBlocksTo(input,{blockIds:['leaf','branch'],targetId:'level-5',placement:'inside'});assert.equal(indexEditorBlocks(result).get('tip').depth,7);validateBlocks(result);
 assert.deepEqual(input,before);
});

test('contiguous same-position moves are explicit no-ops while separated selections change position',()=>{
 const input=['a','b','c','d'].map(id=>block(id));
 assert.equal(planEditorBlocksMove(input,{blockIds:['b','c'],targetId:'d',placement:'before'}).changed,false);
 assert.equal(planEditorBlocksMove(input,{blockIds:['b','c'],targetId:'a',placement:'after'}).changed,false);
 assert.equal(planEditorBlocksMove(input,{blockIds:['a','b','c','d'],placement:'end'}).changed,false);
 assert.equal(planEditorBlocksMove(input,{blockIds:['a','c'],targetId:'b',placement:'before'}).changed,true);
 assert.deepEqual(moveEditorBlocksTo(input,{blockIds:['b','c'],targetId:'d',placement:'before'}),input);
});

test('a captured batch preview is isolated but the committed forest checks the latest source and destination',()=>{
 const input=[block('a'),block('b'),block('target')],plan=createEditorMultiMovePlanner(input,['b','a']),operation={targetId:'target',placement:'inside'};
 assert.deepEqual(plan(operation).blockIds,['a','b']);input[2].type='code';assert.equal(plan(operation).changed,true);
 assert.throws(()=>moveEditorBlocksTo(input,{blockIds:['a','b'],...operation}),/PARENT_UNSUPPORTED/);
 input[2].type='paragraph';input.splice(1,1);assert.throws(()=>moveEditorBlocksTo(input,{blockIds:['a','b'],...operation}),/BLOCK_NOT_FOUND/);
});

test('one batch move is one Undo step and an Undo during an older save remains dirty until its own save',async()=>{
 const initial={title:'Draft',blocks:[block('a'),block('b'),block('target')]},history=new EditorHistory(initial);
 let draft=structuredClone(initial),saved=structuredClone(initial),generation=0,release;
 const snapshots=[],getState=()=>({scopeKey:'batch-fixture',generation,dirty:JSON.stringify(draft)!==JSON.stringify(saved),paused:false});
 const autosave=new PageAutosave({getState,save:async()=>{const snapshot=structuredClone(draft);snapshots.push(snapshot);if(snapshots.length===1)await new Promise(resolve=>{release=resolve;});saved=snapshot;return{status:'saved'};}});
 draft.blocks[0].data.text='Unsent input';history.record(draft,{group:'typing'});generation++;
 draft.blocks=moveEditorBlocksTo(draft.blocks,{blockIds:['a','b'],targetId:'target',placement:'inside'});history.record(draft);generation++;autosave.notify();
 const saving=autosave.flush();for(let tick=0;tick<5;tick++)await Promise.resolve();assert.equal(snapshots.length,1);
 draft=history.undo().draft;assert.deepEqual(ids(draft.blocks),['a','b','target']);assert.equal(draft.blocks[0].data.text,'Unsent input');generation++;autosave.notify();
 release();await saving;assert.equal(getState().dirty,true);await autosave.flush();autosave.stop();assert.deepEqual(saved,draft);assert.equal(snapshots.length,2);assert.deepEqual(history.redo().draft.blocks,snapshots[0].blocks);
});
