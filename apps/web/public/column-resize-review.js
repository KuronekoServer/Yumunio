import {indexEditorBlocks,planEditorColumnsResize,resizeEditorColumns} from './editor-tree.js';
import {EditorHistory} from './editor-model.js';
const changed=()=>{throw new TypeError('BLOCK_COLUMNS_REVIEW_CHANGED');};
const unavailable=()=>{throw new TypeError('EDITOR_HISTORY_UNAVAILABLE');};
/** One local review. The host supplies its current actor/page scope and structural-edit gate. */
export function createColumnResizeReview({draft,scope,generation,groupId,count,history}={}){
 if(!draft||!Array.isArray(draft.blocks)||typeof scope!=='string'||!scope||!Number.isSafeInteger(generation)||generation<0)changed();
 const plan=planEditorColumnsResize(draft.blocks,{groupId,count}),blocks=draft.blocks,signature=JSON.stringify(indexEditorBlocks(blocks).get(groupId).block);let settled=false;
 if(plan.changed&&!(history instanceof EditorHistory))unavailable();
 const current=value=>{
  if(settled||value?.enabled!==true||value.scope!==scope||value.draft!==draft||value.draft?.blocks!==blocks||value.generation!==generation||plan.changed&&value.history!==history)return false;
  try{return JSON.stringify(indexEditorBlocks(value.draft.blocks).get(groupId)?.block)===signature&&JSON.stringify(planEditorColumnsResize(value.draft.blocks,{groupId,count}))===JSON.stringify(plan);}catch{return false;}
 };
 return Object.freeze({plan,current,apply(value,{createId}={}){
  if(plan.changed&&!(value?.history instanceof EditorHistory))unavailable();if(!current(value))changed();
  const result=resizeEditorColumns(value.draft.blocks,{groupId,count,...(createId===undefined?{}:{createId})});
  if(result.changed){
   const candidate={...value.draft,blocks:result.blocks},selection=history.current.selection,probe=new EditorHistory(value.draft,{maxSteps:history.maxSteps,maxBytes:history.maxBytes});
   probe.record(value.draft,{selection});probe.record(candidate,{selection});if(!probe.canUndo)throw new RangeError('EDITOR_HISTORY_TOO_LARGE');
  }
  settled=true;return result;
 },cancel(){settled=true;}});
}
