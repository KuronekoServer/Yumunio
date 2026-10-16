import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageBlockTransfer,validatePageBlockTransferResult} from '../public/block-transfer.js';
const block=(id,children)=>({id,type:'paragraph',data:{text:id},...(children?{children}:{})});
const envelope=(id,blocks,revision=4,version=2)=>({revision,page:{id,workspaceId:'studio',capabilities:['read','editBody']},document:{pageId:id,workspaceId:'studio',version,blocks}});
function sample(){return [envelope('source',[block('parent',[block('child')]),block('last')]),envelope('target',[block('existing')],6,3)];}
const acknowledgement=transfer=>({revision:transfer.body.expectedRevision+1,blockIds:[...transfer.body.blockIds],sourcePageId:transfer.sourcePageId,targetPageId:transfer.targetPageId,sourceVersion:transfer.sourceVersion+1,targetVersion:transfer.targetVersion+1});
test('the reviewed transfer captures normalized document order and both versions without mutating either page',()=>{
 const [source,target]=sample(),before=structuredClone([source,target]),selected=['last','child','parent'];
 const transfer=createPageBlockTransfer(source,target,selected);selected.length=0;
 assert.deepEqual(transfer.body,{expectedRevision:6,expectedVersion:2,targetPageId:'target',targetExpectedVersion:3,blockIds:['parent','last'],parentBlockId:null,index:1});
 assert.deepEqual([source,target],before);assert.throws(()=>transfer.body.blockIds.push('child'));assert.throws(()=>transfer.body.index=0);
 assert.deepEqual(validatePageBlockTransferResult(acknowledgement(transfer),transfer),acknowledgement(transfer));
});
test('unreadable destinations, changed workspace context and impossible versions cannot produce a reviewed transfer',()=>{
 for(const patch of [value=>value.page.capabilities=['read'],value=>value.page.workspaceId='other',value=>value.document.workspaceId='other',value=>value.revision=3,value=>value.document.version=0,value=>value.document.version=Number.MAX_SAFE_INTEGER,value=>value.page.id='source']){
  const [source,target]=sample();patch(target);assert.throws(()=>createPageBlockTransfer(source,target,['parent']));
 }
 const [source,target]=sample();assert.throws(()=>createPageBlockTransfer(source,target,['parent','missing']));assert.equal(source.document.blocks.length,2);
});
test('only the exact forest and next source, target and aggregate versions acknowledge a move',()=>{
 const transfer=createPageBlockTransfer(...sample(),['last','parent']);
 for(const patch of [value=>value.blockIds.reverse(),value=>value.blockIds.push('child'),value=>value.blockIds=['parent','parent'],value=>value.sourceVersion--,value=>value.targetVersion++,value=>value.revision--,value=>value.sourcePageId='another',value=>value.targetPageId='another',value=>value.blockId='parent',value=>delete value.targetVersion]){
  const result=acknowledgement(transfer);patch(result);assert.throws(()=>validatePageBlockTransferResult(result,transfer),{code:'INVALID_BLOCK_TRANSFER_RESPONSE'});
 }
});
test('reviewed insertion into an empty fixed column keeps the entire forest and attachment-bound selections fail before review',()=>{
 const[source,target]=sample();target.document.blocks=[{id:'layout',type:'columns',children:[{id:'left',type:'column',children:[]},{id:'right',type:'column',children:[]}]}];const transfer=createPageBlockTransfer(source,target,['last','child','parent'],{parentBlockId:'right',index:0});assert.deepEqual(transfer.body.blockIds,['parent','last']);assert.equal(transfer.body.parentBlockId,'right');assert.equal(transfer.body.index,0);
 source.document.blocks[1].data.links=[{attachmentId:'page-bound-file'}];const before=structuredClone(source);assert.throws(()=>createPageBlockTransfer(source,target,['parent','last']),{code:'BLOCK_ATTACHMENTS_UNSUPPORTED'});assert.deepEqual(source,before);
});
