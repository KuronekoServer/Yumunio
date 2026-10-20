import {splitPageLinks,joinPageLinks,rebasePageLinks,replacePageLinks} from './page-links.js';
import { EDITABLE_BLOCK_TYPES } from './editor-model.js';
import { splitInlineMarks, joinInlineMarks,replaceInlineMarks,validateInlineMarks } from './inline-text.js';
import { splitMentions, joinMentions, rebaseMentions,replaceMentions } from './mentions.js';
import {isSimpleTableData} from './simple-table.js';
import {isAttachmentBlock} from './attachment-block-model.js';
import {BLOCK_PARENT_TYPES,GENERATED_BLOCK_TYPES,isBookmarkBlock,isDatabaseBlock,isSyncedBlock} from './block-types.js';

export const MAX_EDITOR_NESTING = 8;
export const EDITOR_PARENT_TYPES = BLOCK_PARENT_TYPES;
const editable = new Set([...EDITABLE_BLOCK_TYPES, 'heading1', 'heading2']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail = code => { throw new TypeError(code); };
const clone = value => structuredClone(value);
export function indexEditorBlocks(blocks) {
  const locations = new Map(); let count = 0;
  const visit = (items, ancestors) => {
    if (!Array.isArray(items) || ancestors.length > 64) fail('INVALID_BLOCK_TREE');
    items.forEach((block, index) => {
      if (!block || typeof block !== 'object' || !id(block.id) || locations.has(block.id) || ++count > 10000) fail('INVALID_BLOCK_TREE');
      locations.set(block.id, { block, siblings: items, index, ancestors, parent: ancestors.at(-1) || null,
        parentId: ancestors.at(-1)?.id || null, depth: ancestors.length, order: count - 1 });
      if (block.children !== undefined) visit(block.children, [...ancestors, block]);
    });
  };
  visit(blocks, []); return locations;
}
const layoutRecord = block => !!block && Object.keys(block).every(key=>['id','type','data','children'].includes(key)) && (block.data===undefined||!!block.data&&typeof block.data==='object'&&!Array.isArray(block.data)&&Object.keys(block.data).length===0) && Array.isArray(block.children);
function columnsShape(block) { return block?.type==='columns' && layoutRecord(block) && [2,3].includes(block.children.length) && block.children.every(column=>column.type==='column'&&layoutRecord(column)); }
function editablePath(location) {
  const path=[...location.ancestors,location.block];let groups=0;
  return location.ancestors.every((parent,index)=>{
    if(parent.data?.purpose==='import-source')return false;
    if(parent.type==='columns')return ++groups===1&&columnsShape(parent)&&path[index+1]?.type==='column';
    if(parent.type==='column')return path[index-1]?.type==='columns'&&columnsShape(path[index-1])&&layoutRecord(parent);
    return EDITOR_PARENT_TYPES.includes(parent.type);
  });
}
export function canEditNestedBlock(location, { ignoreDepth = false } = {}) {
  return !!location && (ignoreDepth || location.depth < MAX_EDITOR_NESTING) && (editable.has(location.block.type)||GENERATED_BLOCK_TYPES.includes(location.block.type)&&!location.block.children||(isDatabaseBlock(location.block)||isSyncedBlock(location.block))||isBookmarkBlock(location.block)||columnsShape(location.block)||isAttachmentBlock(location.block)||location.block.type==='table'&&isSimpleTableData(location.block.data)&&!Object.hasOwn(location.block,'children')) &&
    location.block.data?.purpose !== 'import-source' && editablePath(location) && !(location.block.type==='columns'&&location.ancestors.some(parent=>parent.type==='columns'));
}
/** Fixed column wrappers can receive blocks, but cannot be selected or moved alone. */
export function canEditEditorParent(location) {
  return !!location && location.depth<MAX_EDITOR_NESTING && EDITOR_PARENT_TYPES.includes(location.block.type) &&
    (location.block.type==='column'?layoutRecord(location.block)&&location.parent?.type==='columns'&&editablePath(location):canEditNestedBlock(location));
}
function required(locations, blockId) {
  const location = locations.get(blockId);
  if (!canEditNestedBlock(location)) fail('BLOCK_NESTING_READ_ONLY');
  return location;
}
function requiredParent(locations,blockId) { const location=locations.get(blockId);if(!location||location.block.type!=='column'&&!canEditNestedBlock(location))fail('BLOCK_NESTING_READ_ONLY');if(!EDITOR_PARENT_TYPES.includes(location.block.type))fail('BLOCK_PARENT_UNSUPPORTED');if(!canEditEditorParent(location))fail('BLOCK_NESTING_READ_ONLY');return location; }
function containsColumns(block) { return block.type==='columns'||!!block.children?.some(containsColumns); }
function assertColumnsDestination(block,parent) {if(containsColumns(block)&&(parent?.block.type==='column'||parent?.ancestors.some(item=>['column','columns'].includes(item.type))))fail('BLOCK_COLUMNS_NESTED');}
function subtreeHeight(block) {
  return block.children?.length ? 1 + Math.max(...block.children.map(subtreeHeight)) : 0;
}
function planNesting(locations, blockId, direction) {
  const location = required(locations, blockId);
  if (direction === 'indent') {
    const parent = location.siblings[location.index - 1];
    if (!parent) fail('BLOCK_NO_PREVIOUS_SIBLING');
    if (!EDITOR_PARENT_TYPES.includes(parent.type) || parent.data?.purpose === 'import-source') fail('BLOCK_PARENT_UNSUPPORTED');
    if (location.depth + 1 + subtreeHeight(location.block) >= MAX_EDITOR_NESTING) fail('BLOCK_NESTING_LIMIT');
    return { blockId, parentId: parent.id, index: parent.children?.length || 0 };
  }
  if (direction === 'outdent') {
    if (!location.parent) fail('BLOCK_ALREADY_AT_ROOT');
    let parent = locations.get(location.parent.id);
    if(parent.block.type==='column')parent=locations.get(parent.parentId);
    return { blockId, parentId: parent.parentId, index: parent.index + 1 };
  }
  fail('INVALID_BLOCK_NESTING');
}
export function planEditorNesting(blocks, blockId, direction) { return planNesting(indexEditorBlocks(blocks), blockId, direction); }
/** Capture once for a render containing many blocks; later caller mutations do not change its decisions. */
export function createEditorNestingPlanner(blocks) {
  const locations = indexEditorBlocks(clone(blocks));
  return (blockId, direction) => planNesting(locations, blockId, direction);
}
function planMove(locations, rootLength, { blockId, targetId = null, placement }, heightOf = subtreeHeight) {
  const source = required(locations, blockId);
  let parentId = null, index = rootLength;
  if (placement === 'end') {
    if (targetId !== null) fail('INVALID_BLOCK_MOVE');
  } else {
    if (!['before', 'after', 'inside'].includes(placement) || !id(targetId)) fail('INVALID_BLOCK_MOVE');
    const target = locations.get(targetId);
    if (!target) fail('BLOCK_NOT_FOUND');
    if (targetId === blockId) fail('BLOCK_MOVE_SELF');
    if (target.ancestors.some(parent => parent.id === blockId)) fail('BLOCK_MOVE_CYCLE');
    if (placement === 'inside') {
      if (!EDITOR_PARENT_TYPES.includes(target.block.type)) fail('BLOCK_PARENT_UNSUPPORTED');
      if (!canEditEditorParent(target)) fail('BLOCK_NESTING_READ_ONLY');
      parentId = targetId; index = target.block.children?.length || 0;
    } else {
      parentId = target.parentId; index = target.index + (placement === 'after' ? 1 : 0);
    }
  }
  let depth = 0;
  if (parentId !== null) {
    const parent = requiredParent(locations, parentId);
    if (!EDITOR_PARENT_TYPES.includes(parent.block.type)) fail('BLOCK_PARENT_UNSUPPORTED');
    if (parentId === blockId || parent.ancestors.some(item => item.id === blockId)) fail('BLOCK_MOVE_CYCLE');
    depth = parent.depth + 1;
    assertColumnsDestination(source.block,parent);
  }
  if (depth + heightOf(source.block) >= MAX_EDITOR_NESTING) fail('BLOCK_NESTING_LIMIT');
  return { blockId, parentId, index };
}
/** Move an intact subtree relative to a visible target, with the editor's write/depth rules. */
export function planEditorBlockMove(blocks, operation) {
  return planMove(indexEditorBlocks(blocks), blocks.length, operation);
}
/** Drag previews use one isolated tree snapshot; the actual drop is validated again. */
export function createEditorMovePlanner(blocks) {
  const captured = clone(blocks), locations = indexEditorBlocks(captured), heights = new Map();
  const heightOf = block => {
    if (!heights.has(block.id)) heights.set(block.id, block.children?.length ? 1 + Math.max(...block.children.map(heightOf)) : 0);
    return heights.get(block.id);
  };
  return operation => planMove(locations, captured.length, operation, heightOf);
}
export function moveEditorBlockTo(blocks, operation) {
  return movePlannedBlock(blocks, planEditorBlockMove(blocks, operation));
}
function movePlannedBlock(blocks,{blockId,parentId,index}) {
  const next=clone(blocks),locations=indexEditorBlocks(next),source=required(locations,blockId);
  const destination=parentId===null?next:(requiredParent(locations,parentId).block.children??=[]);
  if(!Number.isSafeInteger(index)||index<0||index>destination.length)fail('INVALID_BLOCK_INDEX');
  source.siblings.splice(source.index,1);destination.splice(source.siblings===destination&&source.index<index?index-1:index,0,source.block);return next;
}
function selectedForest(locations,blockIds) {
  if(!Array.isArray(blockIds)||!blockIds.length||blockIds.length>10000||blockIds.some(value=>!id(value)))fail('INVALID_BLOCK_SELECTION');
  const chosen=new Set(blockIds);
  for(const blockId of chosen)if(!locations.has(blockId))fail('BLOCK_NOT_FOUND');
  const roots=[...locations.values()].filter(location=>chosen.has(location.block.id)&&!location.ancestors.some(parent=>chosen.has(parent.id)));
  for(const root of roots)required(locations,root.block.id);
  return roots;
}
/** Selected descendants travel with their selected ancestor, once, in document order. */
export function normalizeEditorBlockSelection(blocks,blockIds) {
  return selectedForest(indexEditorBlocks(blocks),blockIds).map(location=>location.block.id);
}
/** Inclusive document-order range for explicit checkbox selection; readonly rows are skipped. */
export function editorBlockSelectionRange(blocks,anchorId,targetId) {
  const locations=indexEditorBlocks(blocks),target=required(locations,targetId),anchor=locations.get(anchorId);
  if(!canEditNestedBlock(anchor))return[targetId];
  const first=Math.min(anchor.order,target.order),last=Math.max(anchor.order,target.order);
  return [...locations.values()].filter(location=>location.order>=first&&location.order<=last&&canEditNestedBlock(location)).map(location=>location.block.id);
}
function planForestMove(locations,rootLength,sources,{targetId=null,placement},heightOf=subtreeHeight) {
  const chosen=new Set(sources.map(location=>location.block.id)),target=targetId===null?null:locations.get(targetId);
  if(target&&(chosen.has(targetId)||target.ancestors.some(parent=>chosen.has(parent.id))))fail('BLOCK_MOVE_SELECTION');
  let destination;
  for(const source of sources){
    const planned=planMove(locations,rootLength,{blockId:source.block.id,targetId,placement},heightOf);
    if(!destination)destination=planned;
    else if(planned.parentId!==destination.parentId||planned.index!==destination.index)fail('INVALID_BLOCK_MOVE');
  }
  const sameParent=sources.every(source=>source.parentId===destination.parentId);
  const removedBefore=sources.filter(source=>source.parentId===destination.parentId&&source.index<destination.index).length;
  const contiguous=sameParent&&sources.every((source,index)=>source.index===sources[0].index+index);
  const changed=!(contiguous&&destination.index-removedBefore===sources[0].index);
  return {blockIds:sources.map(source=>source.block.id),parentId:destination.parentId,index:destination.index,changed};
}
export function planEditorBlocksMove(blocks,{blockIds,...operation}) {
  const locations=indexEditorBlocks(blocks);
  return planForestMove(locations,blocks.length,selectedForest(locations,blockIds),operation);
}
/** Capture one isolated document and selection for all destination previews. */
export function createEditorMultiMovePlanner(blocks,blockIds) {
  const captured=clone(blocks),locations=indexEditorBlocks(captured),sources=selectedForest(locations,blockIds),heights=new Map();
  const heightOf=block=>{
    if(!heights.has(block.id))heights.set(block.id,block.children?.length?1+Math.max(...block.children.map(heightOf)):0);
    return heights.get(block.id);
  };
  return operation=>planForestMove(locations,captured.length,sources,operation,heightOf);
}
/** Validate the latest tree, then detach and insert the complete forest as one change. */
export function moveEditorBlocksTo(blocks,operation) {
  const plan=planEditorBlocksMove(blocks,operation),next=clone(blocks),locations=indexEditorBlocks(next);
  if(!plan.changed)return next;
  const sources=plan.blockIds.map(blockId=>locations.get(blockId));
  let destination=next;
  if(plan.parentId!==null){const parent=locations.get(plan.parentId).block;destination=parent.children??=[];}
  const removedBefore=sources.filter(source=>source.siblings===destination&&source.index<plan.index).length;
  const groups=new Map();
  for(const source of sources){if(!groups.has(source.siblings))groups.set(source.siblings,[]);groups.get(source.siblings).push(source);}
  for(const [siblings,group]of groups)for(const source of group.sort((left,right)=>right.index-left.index))siblings.splice(source.index,1);
  destination.splice(plan.index-removedBefore,0,...sources.map(source=>source.block));
  indexEditorBlocks(next);return next;
}
/** The middle of a parent row nests a block; its upper/lower edges insert siblings. */
export function editorDropPlacement({ offset, height, canNest = false }) {
  if (!Number.isFinite(offset) || !Number.isFinite(height) || height <= 0) return null;
  const fraction = Math.max(0, Math.min(1, offset / height));
  if (canNest && fraction >= 0.3 && fraction <= 0.7) return 'inside';
  return fraction < 0.5 ? 'before' : 'after';
}
export function nestEditorBlock(blocks, blockId, direction) {
  const plan=planEditorNesting(blocks,blockId,direction),locations=indexEditorBlocks(blocks);assertColumnsDestination(locations.get(blockId).block,plan.parentId===null?null:locations.get(plan.parentId));return movePlannedBlock(blocks,plan);
}
/** Insert without mutating the caller, preserving unrelated future/source payloads. */
export function insertEditorBlock(blocks, { block, parentId = null, index }) {
  const locations = indexEditorBlocks(blocks), next = clone(blocks);
  if (!block || !id(block.id) || locations.has(block.id)) fail('INVALID_BLOCK_TREE');
  const captured = clone(block), added = indexEditorBlocks([captured]);
  if(captured.type==='column')fail('BLOCK_COLUMNS_STRUCTURE');
  if(captured.type==='columns'&&!columnsShape(captured))fail('BLOCK_COLUMNS_STRUCTURE');
  for (const key of added.keys()) if (locations.has(key)) fail('INVALID_BLOCK_TREE');
  let items = next, depth = 0;
  if (parentId !== null) {
    const parent = requiredParent(indexEditorBlocks(next), parentId);
    if (!EDITOR_PARENT_TYPES.includes(parent.block.type)) fail('BLOCK_PARENT_UNSUPPORTED');
    items = parent.block.children ??= []; depth = parent.depth + 1;
    assertColumnsDestination(captured,parent);
  }
  if (depth + subtreeHeight(captured) >= MAX_EDITOR_NESTING) fail('BLOCK_NESTING_LIMIT');
  if (!Number.isSafeInteger(index) || index < 0 || index > items.length) fail('INVALID_BLOCK_INDEX');
  items.splice(index, 0, captured); indexEditorBlocks(next); return next;
}

/** Insert pasted blocks at the caret without losing surrounding text or inline metadata. */
export function pasteInlineFragment(blocks,{blockId,start,end=start,text,marks=[]}={}){
 const next=clone(blocks),row=required(indexEditorBlocks(next),blockId),block=row.block,before=block.data?.text;
 if(!editable.has(block.type)||['code','equation','divider'].includes(block.type)||typeof before!=='string'||typeof text!=='string')fail('INVALID_CLIPBOARD_BLOCKS');
 const fragment=validateInlineMarks(text,marks),value=before.slice(0,start)+text+before.slice(end);
 const replaced=replaceInlineMarks(before,block.data.marks??[],start,end,text,{inherit:false});
 const combined=validateInlineMarks(value,[...replaced,...fragment.map(mark=>({...mark,start:mark.start+start,end:mark.end+start}))].sort((a,b)=>a.start-b.start));
 block.data=textData(block.data,value,combined,replacePageLinks(before,block.data.links??[],start,end,text),replaceMentions(before,block.data.mentions??[],start,end,text));
 return{blocks:next,focus:{blockId,start:start+text.length},changed:true};
}
export function pasteEditorBlocks(blocks,{blockId=null,parentId=null,index,start=0,end=start,inserted,createId=()=>crypto.randomUUID()}={}){
 if(!Array.isArray(inserted)||!inserted.length||inserted.length>500)fail('INVALID_CLIPBOARD_BLOCKS');
 let next=clone(blocks),locations=indexEditorBlocks(next),items=next,at=index;
 const added=clone(inserted),ids=indexEditorBlocks(added);
 for(const key of ids.keys())if(locations.has(key))fail('INVALID_BLOCK_TREE');
 const newId=()=>{const value=createId();if(!id(value)||ids.has(value)||locations.has(value))fail('INVALID_BLOCK_TREE');ids.set(value,{});return value;};
 let tail={id:newId(),type:'paragraph',data:{text:''}};
 if(blockId!==null){
  const location=required(locations,blockId),block=location.block,text=block.data?.text;
  if(!editable.has(block.type)||['code','equation','divider'].includes(block.type)||typeof text!=='string')fail('BLOCK_SPLIT_UNSUPPORTED');
  const marks=splitInlineMarks(text,block.data.marks??[],start,end),links=splitPageLinks(text,block.data.links??[],start,end),mentions=splitMentions(text,block.data.mentions??[],start,end);
  const before=text.slice(0,start),after=text.slice(end);items=location.siblings;at=location.index;
  block.data=textData(block.data,before,marks.beforeMarks,links.beforeLinks,mentions.beforeMentions);
  tail.data=textData({},after,marks.afterMarks,links.afterLinks,mentions.afterMentions);
  // Keep a parent with children and preserve non-paragraph block semantics.
  if(before||block.children?.length||block.type!=='paragraph')at++;else items.splice(at,1);
  parentId=location.parentId;
 }else if(parentId!==null){const parent=requiredParent(locations,parentId);items=parent.block.children??=[];}
 if(!Number.isSafeInteger(at)||at<0||at>items.length)fail('INVALID_BLOCK_INDEX');
 const depth=parentId===null?0:locations.get(parentId).depth+1;
 for(const block of added){if(depth+subtreeHeight(block)>=MAX_EDITOR_NESTING)fail('BLOCK_NESTING_LIMIT');assertColumnsDestination(block,parentId===null?null:locations.get(parentId));}
 items.splice(at,0,...added,tail);indexEditorBlocks(next);
 if(new TextEncoder().encode(JSON.stringify(next)).length>800000)fail('CLIPBOARD_DOCUMENT_TOO_LARGE');
 return {blocks:next,focus:{blockId:tail.id,start:0},lastInsertedId:added.at(-1).id,changed:true};
}

/** Duplicate complete selected subtrees with fresh IDs, retaining same-page attachment bindings. */
export function duplicateEditorBlocks(blocks,blockIds,{createId=()=>crypto.randomUUID()}={}){
 const selected=normalizeEditorBlockSelection(blocks,blockIds),next=clone(blocks),locations=indexEditorBlocks(next),used=new Set(locations.keys()),added=[];
 const duplicate=block=>{const copy=clone(block),id=createId();if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)||used.has(id))fail('INVALID_BLOCK_TREE');used.add(id);copy.id=id;if(copy.children)copy.children=copy.children.map(duplicate);return copy;};
 // Insert backwards so captured sibling indices stay valid.
 for(const blockId of [...selected].reverse()){
  const location=required(locations,blockId),copy=duplicate(location.block);location.siblings.splice(location.index+1,0,copy);added.unshift(copy.id);
 }
 indexEditorBlocks(next);if(new TextEncoder().encode(JSON.stringify(next)).length>800000)fail('CLIPBOARD_DOCUMENT_TOO_LARGE');return {blocks:next,blockIds:added,focus:{blockId:added[0],start:0},changed:true};
}
export function removeEditorBlocks(blocks,blockIds){
 const selected=normalizeEditorBlockSelection(blocks,blockIds),next=clone(blocks),locations=indexEditorBlocks(next);
 for(const blockId of [...selected].reverse()){const location=required(locations,blockId);location.siblings.splice(location.siblings.indexOf(location.block),1);}
 return{blocks:next,changed:true};
}
/** Replace a whole-block selection as one undoable edit; other subtrees stay intact. */
export function replaceEditorBlockSelection(blocks,blockIds,inserted,options={}){
 const selected=normalizeEditorBlockSelection(blocks,blockIds),first=indexEditorBlocks(blocks).get(selected[0]);
 const next=removeEditorBlocks(blocks,selected).blocks;
 return pasteEditorBlocks(next,{parentId:first.parentId,index:first.index,inserted,...options});
}
function columnsFactory(blocks,count,createId) {
  if(![2,3].includes(count)||typeof createId!=='function')fail('BLOCK_COLUMNS_STRUCTURE');
  const used=new Set(indexEditorBlocks(blocks).keys());
  const nextId=()=>{const value=createId();if(!id(value)||used.has(value))fail('INVALID_BLOCK_TREE');used.add(value);return value;};
  const group={id:nextId(),type:'columns',children:Array.from({length:count},()=>({id:nextId(),type:'column',children:[]}))};
  return {group,paragraph:()=>({id:nextId(),type:'paragraph',data:{text:''}})};
}
/** Create a two/three-column group only as an explicit structural edit. */
export function insertEditorColumns(blocks,{count=2,parentId=null,index,createId=()=>crypto.randomUUID()}={}) {
  const {group,paragraph}=columnsFactory(blocks,count,createId);for(const column of group.children)column.children.push(paragraph());
  const next=insertEditorBlock(blocks,{block:group,parentId,index});return{blocks:next,groupId:group.id,focusId:group.children[0].children[0].id};
}
/** Wrap the intact current subtree in the first column, leaving the other columns ready to type. */
export function wrapEditorBlockInColumns(blocks,{blockId,count=2,createId=()=>crypto.randomUUID()}={}) {
  const locations=indexEditorBlocks(blocks),source=required(locations,blockId);
  if(containsColumns(source.block)||source.ancestors.some(parent=>['columns','column'].includes(parent.type)))fail('BLOCK_COLUMNS_NESTED');
  if(source.depth+2+subtreeHeight(source.block)>=MAX_EDITOR_NESTING)fail('BLOCK_NESTING_LIMIT');
  const {group,paragraph}=columnsFactory(blocks,count,createId);group.children[0].children.push(clone(source.block));
  for(const column of group.children.slice(1))column.children.push(paragraph());
  const next=clone(blocks),target=indexEditorBlocks(next).get(blockId);target.siblings.splice(target.index,1,group);
  return{blocks:next,groupId:group.id,focusId:blockId};
}
/** Remove only empty structural wrappers; every child payload and ID remains in column/document order. */
export function unwrapEditorColumns(blocks,groupId) {
  const location=required(indexEditorBlocks(blocks),groupId);if(!columnsShape(location.block))fail('BLOCK_COLUMNS_STRUCTURE');
  const next=clone(blocks),target=indexEditorBlocks(next).get(groupId),children=target.block.children.flatMap(column=>column.children);
  target.siblings.splice(target.index,1,...children);indexEditorBlocks(next);
  return{blocks:next,focusId:children.find(block=>editable.has(block.type))?.id||null};
}
/** Review only: no body, wrapper, ID, or caller-owned data changes before confirmation. */
export function planEditorColumnsResize(blocks,{groupId,count}={}) {
  if(![2,3].includes(count))fail('BLOCK_COLUMNS_STRUCTURE');
  const locations=indexEditorBlocks(blocks),location=required(locations,groupId),group=location.block;
  if(!columnsShape(group))fail('BLOCK_COLUMNS_STRUCTURE');
  const checkChild=block=>{
    if(block.type==='columns')fail('BLOCK_COLUMNS_NESTED');
    if(block.type==='column')fail('BLOCK_COLUMNS_STRUCTURE');
    for(const child of block.children??[])checkChild(child);
  };
  for(const column of group.children)for(const child of column.children)checkChild(child);
  const fromCount=group.children.length,changed=fromCount!==count;
  if(changed&&count>fromCount&&location.depth+2>=MAX_EDITOR_NESTING)fail('BLOCK_NESTING_LIMIT');
  const removed=changed&&count<fromCount?group.children.at(-1):null,target=removed?group.children.at(-2):null;
  return Object.freeze({groupId,fromCount,toCount:count,changed,removedColumnId:removed?.id??null,targetColumnId:target?.id??null,
    movedRootIds:Object.freeze((removed?.children??[]).map(block=>block.id)),movedBlockCount:removed?indexEditorBlocks(removed.children).size:0});
}
/** Add one empty editable column, or move every rightmost subtree intact into its left neighbour. */
export function resizeEditorColumns(blocks,{groupId,count,createId=()=>crypto.randomUUID()}={}) {
  const plan=planEditorColumnsResize(blocks,{groupId,count});
  if(!plan.changed)return{blocks,groupId,changed:false,focusId:null};
  const next=clone(blocks),locations=indexEditorBlocks(next),group=locations.get(groupId).block;let focusId=null;
  if(count>plan.fromCount){
    if(typeof createId!=='function')fail('BLOCK_COLUMNS_STRUCTURE');
    const used=new Set(locations.keys()),nextId=()=>{const value=createId();if(!id(value)||used.has(value))fail('INVALID_BLOCK_TREE');used.add(value);return value;};
    const columnId=nextId();focusId=nextId();group.children.push({id:columnId,type:'column',children:[{id:focusId,type:'paragraph',data:{text:''}}]});
  }else{
    const removed=group.children.pop();group.children.at(-1).children.push(...removed.children);
  }
  indexEditorBlocks(next);return{blocks:next,groupId,changed:true,focusId};
}
function textData(data, text, marks, links, mentions) {
  const next = { ...data, text };
  const references=links??(data?.links?rebasePageLinks(data.text,text,data.links):[]);if(references.length)next.links=references;else delete next.links;
  if (marks.length) next.marks = marks; else delete next.marks;
  const nextMentions=mentions??(data?.mentions?rebaseMentions(data.text,text,data.mentions):[]);if(nextMentions.length)next.mentions=nextMentions;else delete next.mentions;
  return next;
}
export function splitEditorBlock(blocks, { blockId, start, end, newId }) {
  const next = clone(blocks), locations = indexEditorBlocks(next), location = required(locations, blockId), block = location.block;
  if (!editable.has(block.type) || ['code', 'divider'].includes(block.type) || typeof block.data?.text !== 'string' || !id(newId) || locations.has(newId)) fail('BLOCK_SPLIT_UNSUPPORTED');
  const text = block.data.text, split = splitInlineMarks(text, block.data.marks || [], start, end),links=splitPageLinks(text,block.data.links||[],start,end),mentions=splitMentions(text,block.data.mentions||[],start,end);
  const before = text.slice(0, start), after = text.slice(end);
  block.data = textData(block.data, before, split.beforeMarks,links.beforeLinks,mentions.beforeMentions);
  if (!before && !after && !block.children?.length) {
    if (location.parent) return { blocks: nestEditorBlock(next, blockId, 'outdent'), focus: { blockId, start: 0 }, changed: true };
    if (block.type !== 'paragraph') { block.type = 'paragraph'; return { blocks: next, focus: { blockId, start: 0 }, changed: true }; }
  }
  const added = { id: newId, type: ['checklist','bulleted-list','numbered-list','quote'].includes(block.type) ? block.type : 'paragraph',
    data: { text: after, ...(links.afterLinks.length?{links:links.afterLinks}:{}), ...(mentions.afterMentions.length?{mentions:mentions.afterMentions}:{}), ...(split.afterMarks.length ? { marks: split.afterMarks } : {}), ...(block.type === 'checklist' ? { checked: false } : {}),
      ...(block.type === 'numbered-list' ? { start: (block.data.start || 1) + 1 } : {}) } };
  location.siblings.splice(location.index + 1, 0, added); indexEditorBlocks(next);
  return { blocks: next, focus: { blockId: newId, start: 0 }, changed: true };
}
export function mergeEditorBlock(blocks, blockId) {
  const next = clone(blocks), locations = indexEditorBlocks(next), location = required(locations, blockId), block = location.block;
  if (!editable.has(block.type) || ['code','equation','divider'].includes(block.type) || typeof block.data?.text !== 'string') fail('BLOCK_MERGE_UNSUPPORTED');
  if (block.children?.length) fail('BLOCK_CHILDREN_JOIN_UNSUPPORTED');
  if (location.index === 0) {
    if (location.parent) return { blocks: nestEditorBlock(next, blockId, 'outdent'), focus: { blockId, start: 0 }, changed: true };
    if (block.type !== 'paragraph') { block.type = 'paragraph'; return { blocks: next, focus: { blockId, start: 0 }, changed: true }; }
    if (!block.data.text && next.length > 1) {
      next.shift(); return { blocks: next, focus: { blockId: next[0].id, start: 0 }, changed: true };
    }
    return { blocks: next, focus: { blockId, start: 0 }, changed: false };
  }
  const previous = location.siblings[location.index - 1], previousLocation = locations.get(previous.id);
  if (!canEditNestedBlock(previousLocation) || !editable.has(previous.type) || ['code','equation','divider'].includes(previous.type) || typeof previous.data?.text !== 'string') fail('BLOCK_MERGE_UNSUPPORTED');
  if (previous.children?.length) fail('BLOCK_CHILDREN_JOIN_UNSUPPORTED');
  const caret = previous.data.text.length, marks = joinInlineMarks(previous.data.text, previous.data.marks || [], block.data.text, block.data.marks || []);
  previous.data = textData(previous.data, previous.data.text + block.data.text, marks,joinPageLinks(previous.data.text,previous.data.links||[],block.data.text,block.data.links||[]),joinMentions(previous.data.text,previous.data.mentions||[],block.data.text,block.data.mentions||[]));
  location.siblings.splice(location.index, 1);
  return { blocks: next, focus: { blockId: previous.id, start: caret }, changed: true };
}
export function removeEditorBlock(blocks, blockId, { confirmChildren = false } = {}) {
  const next = clone(blocks), location = required(indexEditorBlocks(next), blockId);
  if (location.block.children?.length && !confirmChildren) fail('BLOCK_HAS_CHILDREN');
  location.siblings.splice(location.index, 1); return next;
}
