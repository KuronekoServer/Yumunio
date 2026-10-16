import test from 'node:test';
import assert from 'node:assert/strict';
import {createColumnResizeReview} from '../public/column-resize-review.js';
import {EditorHistory} from '../public/editor-model.js';
import {resizeEditorColumns} from '../public/editor-tree.js';
const paragraph=(id,text=id)=>({id,type:'paragraph',data:{text}});
function fixture(){const draft={title:'Unfinished title',blocks:[{id:'group',type:'columns',children:[{id:'left',type:'column',children:[paragraph('a')]},{id:'middle',type:'column',children:[paragraph('b')]},{id:'right',type:'column',children:[paragraph('c')]}]}]},current={draft,scope:JSON.stringify(['actor','workspace','page',2]),generation:5,history:new EditorHistory(draft),enabled:true};return{draft,current,review:createColumnResizeReview({...current,groupId:'group',count:2})};}
test('review does not mutate the live dirty draft and applies its reviewed merge once',()=>{
 const f=fixture(),before=structuredClone(f.draft);assert.deepEqual(f.review.plan.movedRootIds,['c']);assert.equal(f.review.plan.movedBlockCount,1);assert.deepEqual(f.draft,before);assert.equal(f.review.current(f.current),true);
 const result=f.review.apply(f.current);assert.equal(result.changed,true);assert.deepEqual(result.blocks[0].children[1].children.map(block=>block.id),['b','c']);assert.deepEqual(f.draft,before);assert.equal(f.review.current(f.current),false);assert.throws(()=>f.review.apply(f.current),/REVIEW_CHANGED/);
});
test('actor, workspace, page, selection, draft and dirty-generation changes fence an old confirmation',()=>{
 const cases=[value=>value.scope=JSON.stringify(['other','workspace','page',2]),value=>value.scope=JSON.stringify(['actor','other','page',2]),value=>value.scope=JSON.stringify(['actor','workspace','other',2]),value=>value.scope=JSON.stringify(['actor','workspace','page',3]),value=>value.draft=structuredClone(value.draft),value=>value.generation++,value=>value.generation--];
 for(const mutate of cases){const f=fixture(),before=structuredClone(f.draft);mutate(f.current);assert.equal(f.review.current(f.current),false);assert.throws(()=>f.review.apply(f.current),/REVIEW_CHANGED/);assert.deepEqual(f.draft,before);}
});
test('same-object body replacements or reviewed payload edits cannot be confirmed with stale counts',()=>{
 for(const modify of [draft=>draft.blocks=structuredClone(draft.blocks),draft=>draft.blocks[0].children[2].children.push(paragraph('later')),draft=>draft.blocks[0].children[2].children[0].data.text='Changed after review',draft=>draft.blocks[0].children[0].data={future:true},draft=>draft.blocks[0].children.pop()]){const f=fixture();modify(f.draft);const before=structuredClone(f.draft);assert.equal(f.review.current(f.current),false);assert.throws(()=>f.review.apply(f.current),/REVIEW_CHANGED/);assert.deepEqual(f.draft,before);}
});
test('closing or replacing a review, readonly state, a room or save-stop gate prevents any tree edit',()=>{
 const f=fixture(),before=structuredClone(f.draft);assert.equal(f.review.current({...f.current,enabled:false}),false);assert.throws(()=>f.review.apply({...f.current,enabled:false}),/REVIEW_CHANGED/);assert.deepEqual(f.draft,before);f.review.cancel();assert.equal(f.review.current(f.current),false);assert.throws(()=>f.review.apply(f.current),/REVIEW_CHANGED/);
 const newer=createColumnResizeReview({...f.current,groupId:'group',count:2});assert.equal(newer.current(f.current),true);assert.deepEqual(f.draft,before);
});
test('a failed ID allocation changes neither draft nor review, while no-op reviews allocate nothing',()=>{
 const f=fixture();f.draft.blocks[0].children.pop();const review=createColumnResizeReview({...f.current,groupId:'group',count:3}),before=structuredClone(f.draft);assert.throws(()=>review.apply(f.current,{createId:()=> 'a'}),/INVALID_BLOCK_TREE/);assert.deepEqual(f.draft,before);assert.equal(review.current(f.current),true);
 const noop=createColumnResizeReview({...f.current,groupId:'group',count:2});assert.equal(noop.plan.changed,false);assert.equal(noop.apply(f.current,{createId:()=>assert.fail('must not allocate')}).changed,false);assert.deepEqual(f.draft,before);
});
test('unavailable or replaced history cannot discard the original draft or undo stack',()=>{
 const f=fixture(),before=structuredClone(f.draft),prior=structuredClone({current:f.current.history.current,past:f.current.history.past,future:f.current.history.future});
 assert.throws(()=>createColumnResizeReview({...f.current,history:null,groupId:'group',count:2}),/EDITOR_HISTORY_UNAVAILABLE/);assert.throws(()=>f.review.apply({...f.current,history:null}),/EDITOR_HISTORY_UNAVAILABLE/);
 assert.equal(f.review.current({...f.current,history:new EditorHistory(f.draft)}),false);assert.throws(()=>f.review.apply({...f.current,history:new EditorHistory(f.draft)}),/REVIEW_CHANGED/);
 assert.deepEqual(f.draft,before);assert.deepEqual({current:f.current.history.current,past:f.current.history.past,future:f.current.history.future},prior);
 const noop=createColumnResizeReview({...f.current,history:null,groupId:'group',count:3});assert.equal(noop.apply({...f.current,history:null}).changed,false);
});
test('a layout addition crossing the existing snapshot byte limit leaves body and history intact',()=>{
 const f=fixture();f.draft.blocks[0].children.pop();const text=f.draft.blocks[0].children[0].children[0].data;
 text.text='';const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length,base=bytes({draft:f.draft,selection:null});text.text='x'.repeat(899990-base);assert.equal(bytes({draft:f.draft,selection:null}),899990);
 f.current.history=new EditorHistory(f.draft);const review=createColumnResizeReview({...f.current,groupId:'group',count:3}),before=structuredClone(f.draft),prior=structuredClone({current:f.current.history.current,past:f.current.history.past,future:f.current.history.future});let sequence=0;
 assert.throws(()=>review.apply(f.current,{createId:()=> 'added-'+ ++sequence}),/EDITOR_HISTORY_TOO_LARGE/);assert.deepEqual(f.draft,before);assert.deepEqual({current:f.current.history.current,past:f.current.history.past,future:f.current.history.future},prior);assert.equal(review.current(f.current),true);
});
test('selection bytes and a custom history budget must still leave one exact Undo step',()=>{
 const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length,historyState=history=>structuredClone({current:history.current,past:history.past,future:history.future});
 for(const kind of ['selection','budget']){
  const f=fixture();f.draft.blocks[0].children.pop();const selection={blockId:'a'.repeat(128),start:0,end:0},payload=f.draft.blocks[0].children[0].children[0].data;payload.text='';let sequence=0;
  const template=resizeEditorColumns(f.draft.blocks,{groupId:'group',count:3,createId:()=> 's'+ ++sequence}),addedBytes=bytes({draft:{...f.draft,blocks:template.blocks},selection:null})-bytes({draft:f.draft,selection:null}),selectionBytes=bytes(selection)-4,base=bytes({draft:f.draft,selection:null});
  const desired=kind==='selection'?900000-addedBytes-Math.floor(selectionBytes/2):500000;payload.text='x'.repeat(desired-base);
  f.current.history=new EditorHistory(f.draft,{maxSteps:1,maxBytes:kind==='budget'?900000:8*1024*1024});if(kind==='selection')f.current.history.record(f.draft,{selection});
  const before=structuredClone(f.draft),prior=historyState(f.current.history),review=createColumnResizeReview({...f.current,groupId:'group',count:3});sequence=0;
  assert.throws(()=>review.apply(f.current,{createId:()=> 's'+ ++sequence}),/EDITOR_HISTORY_TOO_LARGE/,kind);assert.deepEqual(f.draft,before);assert.deepEqual(historyState(f.current.history),prior);
 }
});
