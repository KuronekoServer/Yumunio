import {validateMentions,rebaseMentions} from './mentions.js';
import {validateSimpleTableData} from './simple-table.js';
import {isAttachmentBlock} from './attachment-block-model.js';
import {RICH_BLOCK_TYPES,validateBlockPresentation} from './block-types.js';
import {validateCollectionEnvelope,validateCollectionValue,parseCollectionValue,isComputedProperty,recordPatch} from './collections-model.js';
import {validatePageLinks,rebasePageLinks} from './page-links.js';
import { validateInlineMarks, rebaseInlineMarks } from './inline-text.js';
const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
export function validateInlineBlockMetadata(blocks) {
  let count=0;
  const visit=(items,depth)=> {
    if(!Array.isArray(items)||depth>64)throw new Error('INVALID_INLINE_BLOCKS');
    for(const block of items) {
      if(!block || typeof block!=='object' || ++count>10000)throw new Error('INVALID_INLINE_BLOCKS');
      validateBlockPresentation(block.data);
      if(block.type==='table'&&block.data?.format==='simple-table-v1'){validateSimpleTableData(block.data);if(Object.hasOwn(block,'children'))throw new Error('INVALID_INLINE_BLOCKS');}
      if(['file','image'].includes(block.type)&&block.data?.format==='attachment-v1'&&!isAttachmentBlock(block))throw new Error('INVALID_INLINE_BLOCKS');
      if(block.data && Object.hasOwn(block.data,'mentions')){if(!RICH_BLOCK_TYPES.includes(block.type)||block.data.purpose==='import-source')throw new Error('INVALID_INLINE_BLOCKS');validateMentions(block.data.text,block.data.mentions,{allowUnavailable:true});}
      if(block.data && Object.hasOwn(block.data,'links'))validatePageLinks(block.data.text,block.data.links,{allowUnavailable:true});
      if(block.data && Object.hasOwn(block.data,'marks')) {
        if(!RICH_BLOCK_TYPES.includes(block.type)||block.data.purpose==='import-source')throw new Error('INVALID_INLINE_BLOCKS');
        validateInlineMarks(block.data.text,block.data.marks);
      }
      if(block.children!==undefined)visit(block.children,depth+1);
    }
  };
  visit(blocks,0); return blocks;
}
export function editableBlockData(data, text, marks, links, mentions) {
  const next = { ...data, text };
  const tagged=mentions===undefined?(data?.mentions?rebaseMentions(data.text,text,data.mentions):[]):validateMentions(text,mentions,{allowUnavailable:true});
  if(tagged.length)next.mentions=tagged;else delete next.mentions;
  const references=links===undefined?(data?.links?rebasePageLinks(data.text,text,data.links):[]):validatePageLinks(text,links,{allowUnavailable:true});
  if(references.length)next.links=references;else delete next.links;
  const updated = marks === undefined ? (data?.marks ? rebaseInlineMarks(data.text, text, data.marks) : []) : validateInlineMarks(text, marks);
  if (updated.length) next.marks = updated; else delete next.marks;
  return next;
}
export function readableLinks(data) {
  if (typeof data?.text !== 'string' || !Array.isArray(data.links)) return [];
  const result = []; let end = 0;
  for (const link of data.links) {
    if (!link || !Number.isSafeInteger(link.start) || !Number.isSafeInteger(link.end) || link.start < end || link.end <= link.start || link.end > data.text.length ||
        typeof link.label !== 'string' || data.text.slice(link.start,link.end) !== link.label ||
        (link.unavailable !== true && !validId(link.pageId)) || (link.fragment !== undefined && typeof link.fragment !== 'string') || (link.attachmentId !== undefined && !validId(link.attachmentId))) continue;
    end = link.end; result.push({start:link.start,end:link.end,label:link.label,...(link.unavailable === true ? {unavailable:true} : {pageId:link.pageId,...(link.attachmentId === undefined ? {} : {attachmentId:link.attachmentId}),...(link.fragment === undefined ? {} : {fragment:link.fragment})})});
  }
  return result;
}
function sourcePropertiesFor(collection) {
  const properties=collection.sourceProperties??collection.properties;
  if(!Array.isArray(properties))throw new Error('INVALID_COLLECTION');
  const ids=new Set();for(const property of properties){
    if(!validId(property.id)||ids.has(property.id)||typeof property.name!=='string'||property.type!=='text')throw new Error('INVALID_COLLECTION');ids.add(property.id);
  }
  return properties;
}
function validateSources(record,sourceProperties){
  if(record.sourceKind!==undefined&&record.sourceKind!=='manual')throw new Error('INVALID_COLLECTION');
  const expected=record.sourceKind==='manual'?[]:sourceProperties;
  if(!record.sourceValues||typeof record.sourceValues!=='object'||Array.isArray(record.sourceValues)||expected.some(property=>typeof record.sourceValues[property.id]!=='string')||Object.keys(record.sourceValues).some(key=>!expected.some(property=>property.id===key)))throw new Error('INVALID_COLLECTION');
}
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const inputValue=(property,value)=>property.type==='text'?clone(value):value===null||value===undefined?'':property.type==='checkbox'?value===true?'true':'false':property.type==='number'?String(value):clone(value);
export class CollectionEdits {
  constructor(envelope,{workspaceId,collectionId}={}){
    try{
      this.envelope=validateCollectionEnvelope(envelope,{workspaceId,collectionId});
      const sourceProperties=sourcePropertiesFor(this.collection),pages=new Set();
      for(const record of this.collection.records){validateSources(record,sourceProperties);if(pages.has(record.pageId))throw new Error('INVALID_COLLECTION');pages.add(record.pageId);}
    }catch{throw new Error('INVALID_COLLECTION');}
    this.drafts=new Map();this.conflict=false;
  }
  get collection(){return this.envelope.collection;}
  get revision(){return this.envelope.revision;}
  get dirty(){return this.drafts.size>0;}
  record(recordId){return this.collection.records.find(record=>record.id===recordId);}
  property(propertyId){return this.collection.properties.find(property=>property.id===propertyId);}
  values(recordId){const record=this.record(recordId);return record?{...clone(record.values),...clone(this.drafts.get(recordId)??{})}:undefined;}
  rawValue(recordId,propertyId){const record=this.record(recordId);if(!record||!this.property(propertyId))return undefined;const draft=this.drafts.get(recordId);return clone(draft&&Object.hasOwn(draft,propertyId)?draft[propertyId]:record.values[propertyId]);}
  dirtyPropertyIds(recordId){return Object.keys(this.drafts.get(recordId)??{});}
  canEdit(recordId,propertyId){
    const record=this.record(recordId);if(this.conflict||!record?.capabilities.includes('editRecordValues'))return false;
    if(propertyId===undefined)return true;const property=this.property(propertyId);return!!property&&!isComputedProperty(property)&&!record.redactedProperties?.includes(propertyId);
  }
  changes(recordId){
    const record=this.record(recordId);if(!record)return{};const changes={};
    for(const key of this.dirtyPropertyIds(recordId)){
      if(!this.canEdit(recordId,key))throw new Error('INVALID_RECORD_EDIT');
      const property=this.property(key),value=parseCollectionValue(property,this.drafts.get(recordId)[key]);
      validateCollectionValue(property,value);if(!same(value,record.values[key]))Object.defineProperty(changes,key,{value,enumerable:true});
    }
    return changes;
  }
  patch(recordId){
    if(this.conflict)throw new Error('INVALID_RECORD_EDIT');const record=this.record(recordId);if(!record)throw new Error('INVALID_RECORD_EDIT');
    const values=this.changes(recordId);return recordPatch(record,{expectedRevision:this.revision,title:record.title,values,dirtyPropertyIds:Object.keys(values),properties:this.collection.properties});
  }
  setRaw(recordId,propertyId,raw){
    if(!this.canEdit(recordId,propertyId))throw new Error('INVALID_RECORD_EDIT');const property=this.property(propertyId);
    if(!(raw===null||typeof raw==='boolean'||typeof raw==='number'&&Number.isFinite(raw)||typeof raw==='string'&&raw.length<=100000||Array.isArray(raw)&&raw.length<=1000&&raw.every(item=>typeof item==='string'&&item.length<=100000)))throw new Error('INVALID_RECORD_EDIT');
    const values={...this.drafts.get(recordId)},original=this.record(recordId).values[propertyId];
    if(same(raw,original)||same(raw,inputValue(property,original)))delete values[propertyId];else Object.defineProperty(values,propertyId,{value:clone(raw),enumerable:true,configurable:true,writable:true});
    if(Object.keys(values).length)this.drafts.set(recordId,values);else this.drafts.delete(recordId);
  }
  set(recordId,propertyId,value){
    if(!this.canEdit(recordId,propertyId))throw new Error('INVALID_RECORD_EDIT');
    try{validateCollectionValue(this.property(propertyId),value);}catch{throw new Error('INVALID_RECORD_EDIT');}
    const values={...this.drafts.get(recordId)};if(same(value,this.record(recordId).values[propertyId]))delete values[propertyId];else Object.defineProperty(values,propertyId,{value:clone(value),enumerable:true,configurable:true,writable:true});
    if(Object.keys(values).length)this.drafts.set(recordId,values);else this.drafts.delete(recordId);
  }
  advanceDocumentBasis({expectedRevision,revision:nextRevision,pageId,title}){
    if(this.conflict||expectedRevision!==this.revision||!revision(nextRevision)||nextRevision<=expectedRevision||!validId(pageId)||typeof title!=='string'||title.length>240)throw new Error('INVALID_COLLECTION');
    const record=this.collection.records.find(record=>record.pageId===pageId);
    if(pageId!==this.envelope.pageId&&!record)throw new Error('INVALID_COLLECTION');
    if(pageId===this.envelope.pageId)this.envelope.collection.title=title;else record.title=title;
    this.envelope.revision=nextRevision;
  }
  markConflict(){this.conflict=true;}
  markUnknown(){this.conflict=true;}
  discard(recordId){this.drafts.delete(recordId);}
  accept(response,recordId){
    const current=this.record(recordId);
    if(response?.collectionId!==this.collection.id||response.record?.id!==recordId||!revision(response.revision)||response.revision<=this.revision||!current)throw new Error('INVALID_COLLECTION');
    const candidate=clone(this.envelope);candidate.revision=response.revision;candidate.collection.records=candidate.collection.records.map(record=>record.id===recordId?clone(response.record):record);
    let checked;try{checked=validateCollectionEnvelope(candidate,{workspaceId:this.collection.workspaceId,collectionId:this.collection.id});validateSources(response.record,sourcePropertiesFor(this.collection));}catch{throw new Error('INVALID_COLLECTION');}
    if(response.record.pageId!==current.pageId||response.record.title!==current.title||response.record.sourceKind!==current.sourceKind||!same(response.record.sourceValues,current.sourceValues))throw new Error('INVALID_COLLECTION');
    const changes=this.changes(recordId);if(Object.entries(changes).some(([key,value])=>!same(response.record.values[key],value)))throw new Error('INVALID_COLLECTION');
    this.envelope=checked;this.drafts.delete(recordId);
  }
}

export function pageMoveTargets(pages,pageId) {
 const source=pages.find(page=>page.id===pageId); if(!source || source.recordId)return [];
 const byId=new Map(pages.map(page=>[page.id,page]));
 return pages.filter(page=> {
  if(page.id===pageId || page.trashedAt!==null || !page.capabilities?.includes('manage'))return false;
  let cursor=page; const seen=new Set();
  while(cursor) { if(seen.has(cursor.id) || cursor.id===pageId || cursor.trashedAt!==null || !cursor.capabilities?.includes('read'))return false; seen.add(cursor.id); if(cursor.parentId===null)return true; cursor=byId.get(cursor.parentId); }
  return false;
 });
}

export function mergeSavedPageAttachments(current, saved) {
  if (saved?.page?.id !== current?.page?.id || saved?.page?.workspaceId !== current?.page?.workspaceId || Object.hasOwn(saved, 'attachments') || !Array.isArray(current?.attachments)) return saved;
  return { ...saved, attachments: structuredClone(current.attachments) };
}

export function mapRoomSelection(previous, next, selection) {
  if (!selection || !previous || !next) return null;
  const find = (items, id) => { for (const block of items || []) { if (block.id === id) return block.data?.text; const nested = find(block.children, id); if (nested !== undefined) return nested; } };
  const before = selection.title ? previous.title : find(previous.blocks, selection.blockId);
  const after = selection.title ? next.title : find(next.blocks, selection.blockId);
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const oldEnd = before.length - suffix, newEnd = after.length - suffix;
  const offset = value => {
    const position = Math.max(0, Math.min(before.length, Number.isInteger(value) ? value : 0));
    if (position < prefix) return position;
    if (position >= oldEnd) return Math.max(0, Math.min(after.length, position + after.length - before.length));
    return prefix + Math.min(position - prefix, newEnd - prefix);
  };
  const start = offset(selection.start), end = Math.max(start, offset(selection.end ?? selection.start));
  return { ...selection, start, end };
}
