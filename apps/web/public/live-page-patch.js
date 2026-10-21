import {indexEditorBlocks} from './editor-tree.js';
import {RICH_BLOCK_TYPES} from './block-types.js';
import {pageBlocksEqual} from './page-save-result.js';
import {readableLinks} from './workspace-data.js';
import {preflightInlineEditorPatch,patchInlineEditor} from './inline-editor.js';
import {prepareRoomCheckboxPatch,applyRoomCheckboxPatch} from './room-check-ui.js';
const inlineKeys=new Set(['text','marks','links','mentions','checked']);
const metadata=block=>({id:block.id,type:block.type,data:Object.fromEntries(Object.entries(block.data??{}).filter(([key])=>!inlineKeys.has(key)))});

/** Patch a clean remote text change without replacing the editor, linked DBs,
 * native selection or iframe. Structural changes use the host's normal render. */
export function prepareLivePagePatch(root,beforeDraft,afterDraft){
 const before=indexEditorBlocks(beforeDraft.blocks),after=indexEditorBlocks(afterDraft.blocks),title=root.querySelector('#page-title');
 if(!title||title.value!==beforeDraft.title)return{kind:'deferred'};
 if(before.size!==after.size)return{kind:'structural'};
 for(const[id,old]of before){const next=after.get(id);if(!next||old.parentId!==next.parentId||old.index!==next.index||old.block.type!==next.block.type||Object.hasOwn(old.block,'children')!==Object.hasOwn(next.block,'children'))return{kind:'structural'};
  if(RICH_BLOCK_TYPES.includes(old.block.type)){if(!pageBlocksEqual([metadata(old.block)],[metadata(next.block)]))return{kind:'structural'};}
  else if(!pageBlocksEqual([{id:old.block.id,type:old.block.type,data:old.block.data}],[{id:next.block.id,type:next.block.type,data:next.block.data}]))return{kind:'structural'};
 }
 const checks=prepareRoomCheckboxPatch(root,before,after);if(!checks)return{kind:'deferred'};
 const patches=[];
 for(const input of root.querySelectorAll('.inline-editor')){
  const old=before.get(input.dataset.blockId)?.block,next=after.get(input.dataset.blockId)?.block;
  if(typeof old?.data?.text!=='string'||typeof next?.data?.text!=='string')continue;
  if(pageBlocksEqual([{id:old.id,type:old.type,data:old.data}],[{id:next.id,type:next.type,data:next.data}]))continue;
  const snapshot={text:next.data.text,marks:next.data.marks??[],links:readableLinks(next.data),mentions:next.data.mentions??[]};
  if(!preflightInlineEditorPatch(input,snapshot,{expectedText:old.data.text}).ready)return{kind:'deferred'};
  patches.push({input,snapshot,expectedText:old.data.text,blockId:old.id});
 }
 return{kind:'inline',changedIds:patches.map(patch=>patch.blockId),apply(){
  if(!applyRoomCheckboxPatch(checks))return false;
  for(const{input,snapshot,expectedText}of patches)if(!patchInlineEditor(input,snapshot,{expectedText}).applied)return false;
  for(const[id,old]of before){const data=after.get(id).block.data;if(data===undefined)delete old.block.data;else old.block.data=structuredClone(data);}
  if(title.value!==afterDraft.title)title.value=afterDraft.title;beforeDraft.title=afterDraft.title;return true;
 }};
}
