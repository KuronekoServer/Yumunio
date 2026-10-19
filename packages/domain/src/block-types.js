import {safeInlineHref} from './inline.js';

export const TEXT_BLOCK_TYPES=Object.freeze(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote','callout','toggle','code','equation']);
export const RICH_BLOCK_TYPES=Object.freeze(TEXT_BLOCK_TYPES.filter(type=>!['code','equation'].includes(type)));
export const BLOCK_PARENT_TYPES=Object.freeze(['paragraph','bulleted-list','numbered-list','quote','checklist','callout','toggle','column']);
export const GENERATED_BLOCK_TYPES=Object.freeze(['table-of-contents','breadcrumb']);
export const BLOCK_COLORS=Object.freeze(['default','gray','brown','orange','yellow','green','blue','purple','pink','red']);
export function validBlockIcon(value){return typeof value==='string'&&value.length<=32&&!/[\u0000-\u001f\u007f]/.test(value)&&value.isWellFormed();}
export function isBookmarkBlock(block){try{return block?.type==='bookmark'&&block.data?.format==='web-link-v1'&&typeof block.data.text==='string'&&block.data.text.length<=240&&typeof block.data.url==='string'&&safeInlineHref(block.data.url)===block.data.url&&!Object.hasOwn(block,'children');}catch{return false;}}
export function validateBlockPresentation(data){if(!data||typeof data!=='object')return;if(Object.hasOwn(data,'color')&&!BLOCK_COLORS.includes(data.color)||Object.hasOwn(data,'background')&&!BLOCK_COLORS.includes(data.background)||Object.hasOwn(data,'icon')&&!validBlockIcon(data.icon))throw new TypeError('INVALID_BLOCK_PRESENTATION');}
