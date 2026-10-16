import test from 'node:test';
import assert from 'node:assert/strict';
import {moveBlockForest,planBlockForestMove} from '../../../packages/domain/src/block-forest.js';
import {normalizeEditorBlockSelection,moveEditorBlocksTo,indexEditorBlocks} from '../public/editor-tree.js';
const block=(id,children)=>({id,type:'paragraph',data:{text:id},...(children?{children}:{})});
test('server and editor forest normalization agree for reversed, repeated and ancestor-overlapping checkbox selections',()=>{
 const source=[block('a',[block('child')]),block('b'),block('c')],selected=['c','child','a','a'];assert.deepEqual(planBlockForestMove(source,[],{blockIds:selected,index:0}).blockIds,normalizeEditorBlockSelection(source,selected));
 const server=moveBlockForest(source,source,{blockIds:['b','a'],parentBlockId:'c',index:0,sameDocument:true}),editor=moveEditorBlocksTo(source,{blockIds:['b','a'],targetId:'c',placement:'inside'});assert.deepEqual(server.targetBlocks,editor);
});
test('a cross-page preview leaves the saved source untouched and preserves the same canonical column subtree the API will move',()=>{
 const source=[{id:'group',type:'columns',children:[{id:'left',type:'column',children:[block('a')]},{id:'right',type:'column',children:[]}]},block('keep')],before=structuredClone(source),selected=['a','group'],normalized=normalizeEditorBlockSelection(source,selected),result=moveBlockForest(source,[],{blockIds:selected,index:0});assert.deepEqual(result.blockIds,normalized);assert.deepEqual(result.targetBlocks,[source[0]]);assert.deepEqual(source,before);assert.equal(indexEditorBlocks(result.targetBlocks).get('a').depth,2);
});
