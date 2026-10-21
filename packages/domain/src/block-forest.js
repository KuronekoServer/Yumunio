/** Pure, bounded forest moves shared by the editor preview and the account API. */
export const BLOCK_MOVE_NESTING=8;
export class BlockForestMoveError extends TypeError{constructor(code='INVALID_BLOCK_MOVE',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new BlockForestMoveError(code,status);};
import {isSimpleTableData} from './simple-table.js';
import {isAttachmentBlock} from './attachment-block-model.js';
import {TEXT_BLOCK_TYPES,BLOCK_PARENT_TYPES,GENERATED_BLOCK_TYPES,isBookmarkBlock,isDatabaseBlock,isSyncedBlock} from './block-types.js';
import {isColumnWrapper} from './block-layout.js';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const editable=new Set([...TEXT_BLOCK_TYPES,...GENERATED_BLOCK_TYPES,'divider']);
const parents=new Set(BLOCK_PARENT_TYPES);
const layout=isColumnWrapper;
const group=block=>block?.type==='columns'&&layout(block)&&[2,3].includes(block.children.length)&&block.children.every(child=>child?.type==='column'&&layout(child));
function locations(blocks){
 const result=new Map();let count=0;
 const visit=(items,ancestors=[])=>{if(!Array.isArray(items)||ancestors.length>64)fail('INVALID_BLOCK_TREE');for(let index=0;index<items.length;index++){
  const block=items[index];if(!block||typeof block!=='object'||!id(block.id)||!id(block.type)||result.has(block.id)||++count>10000)fail('INVALID_BLOCK_TREE');
  if(block.type==='columns'&&(!group(block)||ancestors.some(parent=>parent.type==='columns'))||block.type==='column'&&(!layout(block)||ancestors.at(-1)?.type!=='columns'))fail('BLOCK_COLUMNS_STRUCTURE',409);
  result.set(block.id,{block,siblings:items,index,ancestors,depth:ancestors.length,order:count});if(block.children!==undefined)visit(block.children,[...ancestors,block]);
 }};visit(blocks);return result;
}
function writablePath(location){const path=[...location.ancestors,location.block];return location.ancestors.every((parent,index)=>parent.data?.purpose!=='import-source'&&(parent.type==='columns'?group(parent)&&path[index+1]?.type==='column':parent.type==='column'?layout(parent)&&path[index-1]?.type==='columns':parents.has(parent.type)));}
function writableRoot(location){return location&&location.depth<BLOCK_MOVE_NESTING&&location.block.data?.purpose!=='import-source'&&(editable.has(location.block.type)||(isDatabaseBlock(location.block)||isSyncedBlock(location.block))||isBookmarkBlock(location.block)||group(location.block)||isAttachmentBlock(location.block)||location.block.type==='table'&&isSimpleTableData(location.block.data)&&!Object.hasOwn(location.block,'children'))&&writablePath(location);}
function writableParent(location){return location&&location.depth<BLOCK_MOVE_NESTING&&parents.has(location.block.type)&&location.block.data?.purpose!=='import-source'&&writablePath(location)&&(location.block.type!=='column'||layout(location.block)&&location.ancestors.at(-1)?.type==='columns');}
const height=block=>block.children?.length?1+Math.max(...block.children.map(height)):0;
function selection(map,blockIds){
 if(!Array.isArray(blockIds)||!blockIds.length||blockIds.length>10000||blockIds.some(value=>!id(value)))fail('INVALID_BLOCK_SELECTION');
 const chosen=new Set(blockIds);for(const value of chosen)if(!map.has(value))fail('CONTENT_NOT_FOUND',404);
 const roots=[...map.values()].filter(location=>chosen.has(location.block.id)&&!location.ancestors.some(parent=>chosen.has(parent.id)));
 for(const root of roots)if(!writableRoot(root))fail('BLOCK_NESTING_READ_ONLY',409);return roots;
}
/** A preview captures one tree index; no IDs or editor nodes change during dragging. */
export function createBlockColumnPlanner(blocks){
 const map=locations(blocks),containsColumns=block=>block.type==='columns'||!!block.children?.some(containsColumns);
 return({blockIds,targetId,side})=>{
  if(!['left','right'].includes(side))fail('BLOCK_COLUMNS_STRUCTURE');
  const roots=selection(map,blockIds),target=map.get(targetId),chosen=new Set(roots.map(row=>row.block.id));
  if(!target||!writableRoot(target))fail('BLOCK_NESTING_READ_ONLY',409);
  if(chosen.has(targetId)||target.ancestors.some(block=>chosen.has(block.id))||roots.some(row=>row.ancestors.some(block=>block.id===targetId)))fail('BLOCK_MOVE_CYCLE');
  if(containsColumns(target.block)||roots.some(row=>containsColumns(row.block))||target.ancestors.some(block=>['columns','column'].includes(block.type)))fail('BLOCK_COLUMNS_NESTED',409);
  if([target,...roots].some(row=>target.depth+2+height(row.block)>=BLOCK_MOVE_NESTING))fail('BLOCK_NESTING_LIMIT',409);
  if(map.size+3>10000)fail('INVALID_BLOCK_TREE');
  return{blockIds:roots.map(row=>row.block.id),targetId,side};
 };
}
/** Move intact blocks beside another block, creating two fixed column wrappers atomically. */
export function arrangeBlockColumns(blocks,{blockIds,targetId,side,groupId,columnIds}){
 const plan=createBlockColumnPlanner(blocks)({blockIds,targetId,side}),used=locations(blocks),ids=[groupId,...(columnIds??[])];
 if(ids.length!==3||new Set(ids).size!==3||ids.some(value=>!id(value)||used.has(value)))fail('INVALID_BLOCK_TREE');
 const next=structuredClone(blocks),map=locations(next),moving=plan.blockIds.map(key=>map.get(key).block);
 for(const key of plan.blockIds){const row=map.get(key);row.siblings.splice(row.siblings.indexOf(row.block),1);}
 const target=map.get(targetId),columnBodies=side==='left'?[moving,[target.block]]:[[target.block],moving],group={id:groupId,type:'columns',children:columnBodies.map((children,index)=>({id:columnIds[index],type:'column',children}))};
 target.siblings.splice(target.siblings.indexOf(target.block),1,group);locations(next);return{blocks:next,groupId,columnIds:[...columnIds],blockIds:plan.blockIds};
}
/** Normalize ancestors once, retain document order, and validate the entire move before copying. */
export function planBlockForestMove(sourceBlocks,targetBlocks,{blockIds,parentBlockId=null,index,sameDocument=false}={}){
 const source=locations(sourceBlocks),target=sameDocument?source:locations(targetBlocks),roots=selection(source,blockIds),parent=parentBlockId===null?null:target.get(parentBlockId);
 if(parentBlockId!==null&&(!id(parentBlockId)||!parent))fail('CONTENT_NOT_FOUND',404);
 if(parent&&!writableParent(parent))fail('BLOCK_PARENT_UNSUPPORTED',409);
 const destination=parent?.block.children??(parent?[]:sameDocument?sourceBlocks:targetBlocks);
 if(!Number.isSafeInteger(index)||index<0||index>destination.length)fail('INVALID_BLOCK_INDEX');
 const chosen=new Set(roots.map(root=>root.block.id)),depth=parent?parent.depth+1:0;
 if(sameDocument&&parent&&(chosen.has(parent.block.id)||parent.ancestors.some(item=>chosen.has(item.id))))fail('BLOCK_MOVE_CYCLE');
 for(const root of roots){
  if(depth+height(root.block)>=BLOCK_MOVE_NESTING)fail('BLOCK_NESTING_LIMIT',409);
  const subtree=locations([root.block]);
  if([...subtree.values()].some(item=>item.block.type==='columns')&&parent&&[...parent.ancestors,parent.block].some(item=>['columns','column'].includes(item.type)))fail('BLOCK_COLUMNS_NESTED',409);
  if(!sameDocument)for(const item of subtree.values()){
   if(target.has(item.block.id))fail('BLOCK_ID_CONFLICT',409);
   if(item.block.data?.purpose==='import-source'||!['columns','column'].includes(item.block.type)&&!writableRoot(item))fail('BLOCK_NESTING_READ_ONLY',409);
   if(Array.isArray(item.block.data?.links)&&item.block.data.links.some(link=>link?.attachmentId))fail('BLOCK_ATTACHMENTS_UNSUPPORTED',409);
  }
 }
 return{blockIds:roots.map(root=>root.block.id),parentBlockId,index,sameDocument};
}
/** No caller-owned tree is mutated on either success or failure. Empty fixed column wrappers remain. */
export function moveBlockForest(sourceBlocks,targetBlocks,operation){
 const plan=planBlockForestMove(sourceBlocks,targetBlocks,operation),source=structuredClone(sourceBlocks),target=plan.sameDocument?source:structuredClone(targetBlocks),map=locations(source),targetMap=plan.sameDocument?map:locations(target),roots=plan.blockIds.map(value=>map.get(value));
 const destination=plan.parentBlockId===null?target:(targetMap.get(plan.parentBlockId).block.children??=[]),removedBefore=roots.filter(root=>root.siblings===destination&&root.index<plan.index).length,groups=new Map();
 for(const root of roots){if(!groups.has(root.siblings))groups.set(root.siblings,[]);groups.get(root.siblings).push(root);}
 for(const[siblings,items]of groups)for(const item of items.sort((left,right)=>right.index-left.index))siblings.splice(item.index,1);
 destination.splice(plan.index-removedBefore,0,...roots.map(root=>root.block));locations(source);locations(target);
 return{sourceBlocks:source,targetBlocks:target,blockIds:plan.blockIds};
}
