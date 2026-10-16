import {validateInlineMarks} from './inline-text.js';
import {validatePageLinks} from './page-links.js';
import {validateSimpleTableData} from './simple-table.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MARK_TYPES=new Set(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote']);
const own=(value,key)=>Object.hasOwn(value,key);
const fail=()=>{throw Object.assign(new TypeError('INVALID_PAGE_SAVE_RESULT'),{code:'INVALID_PAGE_SAVE_RESULT'});};
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min&&value<Number.MAX_SAFE_INTEGER;
const id=value=>typeof value==='string'&&ID.test(value);
function exact(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!own(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))fail();
}
function capturedJson(value){
 let nodes=0,chars=0;const seen=new Set();
 const visit=(item,depth)=>{
  if(++nodes>100000||depth>64)fail();
  if(item===null||typeof item==='boolean')return;
  if(typeof item==='string'){chars+=item.length;if(chars>1048576)fail();return;}
  if(typeof item==='number'){if(!Number.isFinite(item))fail();return;}
  if(!item||typeof item!=='object'||seen.has(item))fail();
  const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);if(array?prototype!==Array.prototype:![Object.prototype,null].includes(prototype))fail();
  seen.add(item);const descriptors=Object.getOwnPropertyDescriptors(item),keys=Reflect.ownKeys(descriptors);
  if(array){if(item.length>100000||keys.length!==item.length+1)fail();for(let i=0;i<item.length;i++){const descriptor=descriptors[i];if(!descriptor?.enumerable||!own(descriptor,'value'))fail();visit(descriptor.value,depth+1);}}
  else for(const key of keys){const descriptor=descriptors[key];if(typeof key!=='string'||!descriptor.enumerable||!own(descriptor,'value'))fail();chars+=key.length;visit(descriptor.value,depth+1);}
  seen.delete(item);
 };
 visit(value,0);const encoded=JSON.stringify(value);if(new TextEncoder().encode(encoded).length>1048576)fail();return JSON.parse(encoded);
}
function utc(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail();}
function blocks(value){
 if(!Array.isArray(value))fail();let count=0;const ids=new Set();
 const visit=items=>{for(const block of items){if(!block||typeof block!=='object'||Array.isArray(block)||!id(block.id)||!id(block.type)||ids.has(block.id)||++count>10000)fail();ids.add(block.id);
  if(own(block,'data')){if(!block.data||typeof block.data!=='object'||Array.isArray(block.data))fail();if(block.type==='table'&&block.data.format==='simple-table-v1'){validateSimpleTableData(block.data);if(own(block,'children'))fail();}if(own(block.data,'links'))validatePageLinks(block.data.text,block.data.links,{allowUnavailable:true});if(own(block.data,'marks')){if(!MARK_TYPES.has(block.type)||block.data.purpose==='import-source')fail();validateInlineMarks(block.data.text,block.data.marks);}}
  if(own(block,'children')){if(!Array.isArray(block.children))fail();visit(block.children);}
 }};visit(value);
}
function same(a,b){
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 if(Array.isArray(a)&&a.length!==b.length)return false;
 const left=Object.keys(a).sort(),right=Object.keys(b).sort();return left.length===right.length&&left.every((key,index)=>key===right[index]&&same(a[key],b[key]));
}
/** Compare already-validated JSON block arrays: object key order is irrelevant; array order and values are exact. */
export function pageBlocksEqual(a,b){return Array.isArray(a)&&Array.isArray(b)&&same(a,b);}
function savedBlocksMatch(sent,saved){
 const normalized=structuredClone(saved);
 const visit=(before,after)=>{
  if(before.length!==after.length)fail();
  for(let index=0;index<before.length;index++){
   const source=before[index],target=after[index];
   if(Array.isArray(source.data?.links)){
    if(!Array.isArray(target.data?.links)||source.data.links.length!==target.data.links.length)fail();
    for(let i=0;i<source.data.links.length;i++){
     const original=source.data.links[i],projected=target.data.links[i];if(same(original,projected))continue;
     if(original.unavailable===true||projected.unavailable!==true||projected.start!==original.start||projected.end!==original.end||projected.label!==original.label)fail();
     // Backend projection may only remove the target identity; it may not substitute a new target.
     exact(projected,['start','end','label','unavailable']);target.data.links[i]=structuredClone(original);
    }
   }
   if(Array.isArray(source.children)){if(!Array.isArray(target.children))fail();visit(source.children,target.children);}
  }
 };visit(sent,normalized);if(!same(sent,normalized))fail();
}
/** Validate a known ordinary-page PATCH acknowledgement. Account/generation guards belong to the caller. */
export function validateSavedPage(sentBasis,response,{workspaceId,pageId}={}){
 try{
  if(!id(workspaceId)||!id(pageId))fail();const sent=capturedJson(sentBasis),saved=capturedJson(response);
  exact(sent,['expectedRevision','expectedVersion','title','blocks']);
  if(!integer(sent.expectedRevision)||!integer(sent.expectedVersion,1)||typeof sent.title!=='string'||sent.title.length>240)fail();blocks(sent.blocks);
  exact(saved,['revision','page','document'],['attachments']);
  if(saved.revision!==sent.expectedRevision+1||!Number.isSafeInteger(saved.revision))fail();
  const page=saved.page,document=saved.document;
  exact(page,['id','workspaceId','title','parentId','createdAt','updatedAt','trashedAt','version','capabilities'],['collectionId','recordId','teamspaceId','sidebarSection']);
  exact(document,['pageId','workspaceId','version','updatedAt','blocks']);
  if(page.id!==pageId||page.workspaceId!==workspaceId||document.pageId!==pageId||document.workspaceId!==workspaceId||document.version!==sent.expectedVersion+1||page.version!==document.version||!Number.isSafeInteger(document.version)||page.title!==sent.title||page.trashedAt!==null||page.parentId!==null&&(!id(page.parentId)||page.parentId===pageId))fail();
  if(!Array.isArray(page.capabilities)||page.capabilities.length>32||page.capabilities.some(capability=>typeof capability!=='string'||!id(capability))||new Set(page.capabilities).size!==page.capabilities.length||!page.capabilities.includes('read'))fail();
  for(const key of ['collectionId','recordId'])if(own(page,key)&&!id(page[key]))fail();
  if(own(page,'teamspaceId')&&page.teamspaceId!==null&&!id(page.teamspaceId))fail();
  if(own(page,'sidebarSection')&&!['personal','shared','legacy','teamspace'].includes(page.sidebarSection))fail();
  utc(page.createdAt);utc(page.updatedAt);utc(document.updatedAt);if(document.updatedAt!==page.updatedAt)fail();
  blocks(document.blocks);savedBlocksMatch(sent.blocks,document.blocks);
  if(own(saved,'attachments')){if(!Array.isArray(saved.attachments)||saved.attachments.length>1000)fail();const seen=new Set();for(const attachment of saved.attachments){exact(attachment,['id','name','mediaType','size']);if(!id(attachment.id)||seen.has(attachment.id)||typeof attachment.name!=='string'||attachment.name.length>255||typeof attachment.mediaType!=='string'||attachment.mediaType.length>255||!Number.isSafeInteger(attachment.size)||attachment.size<0||attachment.size>16*1024*1024)fail();seen.add(attachment.id);}}
  return saved;
 }catch{fail();}
}
