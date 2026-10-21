import {indexEditorBlocks,normalizeEditorBlockSelection,canEditNestedBlock,MAX_EDITOR_NESTING} from './editor-tree.js';
import {TEXT_BLOCK_TYPES,GENERATED_BLOCK_TYPES,validateBlockPresentation,isBookmarkBlock,isDatabaseBlock,isSyncedBlock} from './block-types.js';
import {validateInlineMarks,isInlineBoundary} from './inline-text.js';
import {validatePageLinks} from './page-links.js';
import {validateMentions} from './mentions.js';
import {validateSimpleTableData} from './simple-table.js';
import {isAttachmentBlock} from './attachment-block-model.js';
import {isColumnWrapper} from './block-layout.js';

export const BLOCK_CLIPBOARD_TYPE='application/x-yumunio-blocks+json';
const limit=800000,fail=code=>{throw new TypeError(code||'INVALID_BLOCK_CLIPBOARD');};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const own=(value,key)=>Object.hasOwn(value,key),clone=value=>structuredClone(value);
const contextValid=value=>value&&typeof value.origin==='string'&&new URL(value.origin).origin===value.origin&&['workspaceId','pageId','accountId'].every(key=>validId(value[key]));
const encode=value=>{let binary='';for(const byte of new TextEncoder().encode(value))binary+=String.fromCharCode(byte);return btoa(binary);};
const decode=value=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),char=>char.charCodeAt(0)));
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

/** Clipboard data is untrusted. Keep only known, validated presentation and content. */
function cleanBlocks(blocks,{source,target=source,createId,allowAttachmentTransfer=false}={}){
 if(!contextValid(source)||!contextValid(target)||!Array.isArray(blocks)||!blocks.length)fail();
 const sameWorkspace=source.origin===target.origin&&source.workspaceId===target.workspaceId&&source.accountId===target.accountId;
 const samePage=sameWorkspace&&source.pageId===target.pageId,seen=new Set();let count=0;
 const visit=(block,depth,parentType)=>{
  if(!block||typeof block!=='object'||Array.isArray(block)||depth>=MAX_EDITOR_NESTING||++count>500||!validId(block.id)||seen.has(block.id))fail();seen.add(block.id);
  const type=block.type,data=block.data??{},next={id:createId?createId():block.id,type};
  if(!validId(next.id)||!data||typeof data!=='object'||Array.isArray(data)||own(data,'purpose'))fail();
  if(TEXT_BLOCK_TYPES.includes(type)){
   if(typeof data.text!=='string'||!data.text.isWellFormed()||data.text.length>100000||type==='equation'&&data.text.length>10000)fail();
   next.data={text:data.text};
   for(const key of ['color','background','icon'])if(own(data,key))next.data[key]=data[key];validateBlockPresentation(next.data);
   if(type==='heading'){if(![1,2,3].includes(data.level))fail();next.data.level=data.level;}
   if(type==='checklist'){if(typeof data.checked!=='boolean')fail();next.data.checked=data.checked;}
   if(type==='numbered-list'&&own(data,'start')){if(!Number.isSafeInteger(data.start)||data.start<1)fail();next.data.start=data.start;}
   if(type==='code'&&own(data,'language')){if(typeof data.language!=='string'||data.language.length>100)fail();next.data.language=data.language;}
   if(data.marks?.length)next.data.marks=validateInlineMarks(data.text,data.marks);
   if(data.links?.length){const links=validatePageLinks(data.text,data.links,{allowUnavailable:true});if(!samePage&&links.some(link=>link.attachmentId)&&!(sameWorkspace&&allowAttachmentTransfer))fail('BLOCK_CLIPBOARD_ATTACHMENT_PAGE');if(sameWorkspace)next.data.links=links;}
   if(data.mentions?.length){const mentions=validateMentions(data.text,data.mentions,{allowUnavailable:true});if(sameWorkspace)next.data.mentions=mentions;}
  }else if(type==='table'){validateSimpleTableData(data);next.data=clone(data);}
  else if(isAttachmentBlock(block)){if(!samePage&&!(sameWorkspace&&allowAttachmentTransfer))fail('BLOCK_CLIPBOARD_ATTACHMENT_PAGE');next.data={format:data.format,text:data.text,links:validatePageLinks(data.text,data.links,{allowUnavailable:true}),...(data.layout?{layout:clone(data.layout)}:{})};}
  else if((isDatabaseBlock(block)||isSyncedBlock(block))){if(!sameWorkspace)fail('BLOCK_CLIPBOARD_UNSUPPORTED');next.data=clone(data);}
  else if(isBookmarkBlock(block))next.data={format:data.format,text:data.text,url:data.url};
  else if(type==='column'){if(parentType!=='columns'||!isColumnWrapper(block))fail();}
  else if(type==='columns'){if(!isColumnWrapper(block)||![2,3].includes(block.children.length)||block.children.some(child=>child.type!=='column'))fail();if(block.data)next.data=clone(block.data);}
  else if(!['divider',...GENERATED_BLOCK_TYPES].includes(type))fail('BLOCK_CLIPBOARD_UNSUPPORTED');
  if(own(block,'children')){if(!Array.isArray(block.children))fail();next.children=block.children.map(child=>visit(child,depth+1,type));}
  return next;
 };
 const cleaned=blocks.map(block=>visit(block,0,null)),locations=indexEditorBlocks(cleaned);
 for(const location of locations.values())if(location.block.type!=='column'&&!canEditNestedBlock(location))fail('BLOCK_CLIPBOARD_UNSUPPORTED');
 return cleaned;
}
function plainBlocks(blocks){return blocks.map(block=>{
 const text=block.type==='table'?block.data.rows.map(row=>row.join('\t')).join('\n'):block.data?.text??'';
 return (block.type==='checklist'?(block.data.checked?'[x] ':'[ ] '):block.type==='bulleted-list'?'• ':'')+text+(block.children?.length?'\n'+plainBlocks(block.children):'');
}).join('\n');}
function htmlBlocks(blocks){return blocks.map(block=>{
 if(block.type==='table')return '<table>'+block.data.rows.map(row=>'<tr>'+row.map(cell=>'<td>'+escape(cell)+'</td>').join('')+'</tr>').join('')+'</table>';
 const tag=block.type==='heading'?'h'+block.data.level:({heading1:'h1',heading2:'h2',quote:'blockquote',code:'pre'})[block.type]??'p';
 return (block.type==='divider'?'<hr>':'<'+tag+'>'+htmlInline(block.data)+'</'+tag+'>')+(block.children?htmlBlocks(block.children):'');
}).join('');}
function htmlInline(data){const text=data?.text??'',marks=data?.marks??[],edges=[...new Set([0,text.length,...marks.flatMap(mark=>[mark.start,mark.end])])].sort((a,b)=>a-b);return edges.slice(0,-1).map((start,index)=>{const end=edges[index+1],mark=marks.find(mark=>mark.start<=start&&mark.end>=end);let value=escape(text.slice(start,end)).replaceAll('\n','<br>');for(const style of mark?.styles??[]){const tag={bold:'strong',italic:'em',underline:'u',strike:'s',code:'code'}[style];value='<'+tag+'>'+value+'</'+tag+'>';}if(mark?.href)value='<a href="'+escape(mark.href)+'">'+value+'</a>';return value;}).join('');}
export function serializeEditorBlockClipboard(blocks,blockIds,context){
 const locations=indexEditorBlocks(blocks),roots=normalizeEditorBlockSelection(blocks,blockIds),cleaned=cleanBlocks(roots.map(id=>locations.get(id).block),{source:context});
 const json=JSON.stringify({format:'yumunio-blocks',version:1,context,blocks:cleaned});if(new TextEncoder().encode(json).length>limit)fail('CLIPBOARD_DOCUMENT_TOO_LARGE');
 return{json,text:plainBlocks(cleaned),html:'<div data-yumunio-blocks="'+encode(json)+'">'+htmlBlocks(cleaned)+'</div>'};
}
export function readEditorBlockClipboard(data,context,{createId=()=>crypto.randomUUID(),allowAttachmentTransfer=false}={}){
 let json=data?.getData?.(BLOCK_CLIPBOARD_TYPE)||'';
 if(!json){const html=data?.getData?.('text/html')||'';if(html.length>limit*3)fail('CLIPBOARD_DOCUMENT_TOO_LARGE');const match=/data-yumunio-blocks="([A-Za-z0-9+/=]+)"/.exec(html);if(!match)return null;json=decode(match[1]);}
 if(new TextEncoder().encode(json).length>limit)fail('CLIPBOARD_DOCUMENT_TOO_LARGE');
 let value;try{value=JSON.parse(json);}catch{fail();}
 if(value?.format!=='yumunio-blocks'||value.version!==1)fail();
 return cleanBlocks(value.blocks,{source:value.context,target:context,createId,allowAttachmentTransfer});
}
/** Clip partial end paragraphs while retaining intervening blocks, hierarchy and inline formatting. */
export function serializeEditorTextSelection(blocks,{startBlockId,start,endBlockId,end},context){
 const locations=indexEditorBlocks(blocks),first=locations.get(startBlockId),last=locations.get(endBlockId);
 if(!first||!last||first.order>=last.order||!isInlineBoundary(first.block.data?.text,start)||!isInlineBoundary(last.block.data?.text,end))fail();
 const clip=(data,left,right)=>{const result={...data,text:data.text.slice(left,right)};if(data.marks)result.marks=data.marks.filter(mark=>mark.start<right&&mark.end>left).map(mark=>({...mark,start:Math.max(left,mark.start)-left,end:Math.min(right,mark.end)-left}));for(const key of ['links','mentions'])if(data[key])result[key]=data[key].filter(entry=>entry.start>=left&&entry.end<=right).map(entry=>({...entry,start:entry.start-left,end:entry.end-left}));return result;};
 const visit=items=>items.flatMap(block=>{const at=locations.get(block.id).order,children=visit(block.children??[]);if(at<first.order||at>last.order){if(!children.length)return[];return[{...clone(block),data:typeof block.data?.text==='string'?clip(block.data,0,0):clone(block.data??{}),children}];}const next=clone(block);if(block.id===startBlockId)next.data=clip(block.data,start,block.data.text.length);if(block.id===endBlockId)next.data=clip(block.data,0,end);if(block.children)next.children=children;return[next];});
 const selected=visit(blocks);return serializeEditorBlockClipboard(selected,selected.map(block=>block.id),context);
}
export function captureEditorTextSelection(root,blocks){
 const selection=root.ownerDocument.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return null;const range=selection.getRangeAt(0),element=node=>node?.nodeType===1?node:node?.parentElement,first=element(range.startContainer)?.closest('.inline-editor[data-block-id]'),last=element(range.endContainer)?.closest('.inline-editor[data-block-id]');
 if(!first||!last||first===last||!root.contains(first)||!root.contains(last)||first.dataset.pageId!==last.dataset.pageId)return null;
 const offset=(editor,node,at)=>{const prefix=root.ownerDocument.createRange();prefix.selectNodeContents(editor);prefix.setEnd(node,at);return prefix.toString().length;};
 return{startBlockId:first.dataset.blockId,start:offset(first,range.startContainer,range.startOffset),endBlockId:last.dataset.blockId,end:offset(last,range.endContainer,range.endOffset)};
}
/** Mutation must happen only after the complete clipboard write succeeds. */
export function writeEditorBlockClipboard(data,value){if(!data?.setData)fail();data.setData('text/plain',value.text);data.setData('text/html',value.html);data.setData(BLOCK_CLIPBOARD_TYPE,value.json);}
