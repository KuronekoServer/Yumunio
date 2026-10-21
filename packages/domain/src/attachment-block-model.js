import {validatePageLinks} from './page-links.js';
import {validAttachmentLayout} from './block-layout.js';

/** Attachment references use the existing page-bound, permission-projected link contract. */
export function isAttachmentBlock(block){
 if(!['file','image'].includes(block?.type)||block.data?.format!=='attachment-v1'||typeof block.data.text!=='string'||!block.data.text||Object.hasOwn(block,'children')||Object.hasOwn(block.data,'layout')&&!validAttachmentLayout(block.data.layout))return false;
 try{validatePageLinks(block.data.text,block.data.links,{allowUnavailable:true});return block.data.links.length===1&&block.data.links[0].start===0&&block.data.links[0].end===block.data.text.length&&(block.data.links[0].unavailable===true||typeof block.data.links[0].attachmentId==='string');}catch{return false;}
}
