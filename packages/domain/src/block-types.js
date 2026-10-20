import {safeInlineHref} from './inline.js';

export const TEXT_BLOCK_TYPES=Object.freeze(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote','callout','toggle','code','equation']);
export const RICH_BLOCK_TYPES=Object.freeze(TEXT_BLOCK_TYPES.filter(type=>!['code','equation'].includes(type)));
export const BLOCK_PARENT_TYPES=Object.freeze(['paragraph','bulleted-list','numbered-list','quote','checklist','callout','toggle','column']);
export const GENERATED_BLOCK_TYPES=Object.freeze(['table-of-contents','breadcrumb']);
export const BLOCK_COLORS=Object.freeze(['default','gray','brown','orange','yellow','green','blue','purple','pink','red']);
export function validBlockIcon(value){return typeof value==='string'&&value.length<=32&&!/[\u0000-\u001f\u007f]/.test(value)&&value.isWellFormed();}
export function isBookmarkBlock(block){try{return block?.type==='bookmark'&&block.data?.format==='web-link-v1'&&typeof block.data.text==='string'&&block.data.text.length<=240&&typeof block.data.url==='string'&&safeInlineHref(block.data.url)===block.data.url&&!Object.hasOwn(block,'children');}catch{return false;}}
export function validateBlockPresentation(data){if(!data||typeof data!=='object')return;if(Object.hasOwn(data,'color')&&!BLOCK_COLORS.includes(data.color)||Object.hasOwn(data,'background')&&!BLOCK_COLORS.includes(data.background)||Object.hasOwn(data,'icon')&&!validBlockIcon(data.icon))throw new TypeError('INVALID_BLOCK_PRESENTATION');}

const referenceId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** Synced placements carry a source reference, never a snapshot of its private content. */
export function isSyncedBlock(block){const data=block?.data;return block?.type==='synced-block'&&!Object.hasOwn(block,'children')&&data?.format==='synced-page-v1'&&referenceId(data.pageId)&&Object.keys(data).length===2;}
/** A placement contains configuration only. Rows are read through the source database ACL. */
export function isDatabaseBlock(block){
 const data=block?.data,view=data?.view;
 return block?.type==='database'&&!Object.hasOwn(block,'children')&&data?.format==='collection-view-v1'&&referenceId(data.collectionId)&&
  Object.keys(data).every(key=>['format','collectionId','view','visiblePropertyIds'].includes(key))&&view&&typeof view==='object'&&!Array.isArray(view)&&
  typeof view.name==='string'&&view.name.trim().length>0&&view.name.length<=128&&['table','board','list','gallery','calendar','timeline','chart','feed'].includes(view.type)&&
  Array.isArray(view.filters)&&view.filters.length<=20&&Array.isArray(view.sorts)&&view.sorts.length<=5&&
  Object.keys(view).every(key=>['name','type','filters','sorts','groupBy','datePropertyId','endDatePropertyId','chart'].includes(key))&&
  ['groupBy','datePropertyId','endDatePropertyId'].every(key=>view[key]===null||referenceId(view[key]))&&
  (data.visiblePropertyIds===null||Array.isArray(data.visiblePropertyIds)&&data.visiblePropertyIds.length<=128&&new Set(data.visiblePropertyIds).size===data.visiblePropertyIds.length&&data.visiblePropertyIds.every(referenceId));
}
