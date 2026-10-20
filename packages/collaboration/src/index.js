import * as Y from 'yjs';
import { assertTitle, validateBlocks, rebaseInlineMarks, rebasePageLinks, rebaseMentions, TEXT_BLOCK_TYPES, BLOCK_PARENT_TYPES } from '@yumunio/domain';

export { Y };
export const ROOM_LIMITS = Object.freeze({ updateBytes: 64000, stateBytes: 160000, documentBytes: 240000,
  structs: 12000, updateStructs: 2000, clients: 64, logicalLength: 240000, blockCount: 1000 });
const encoder = new TextEncoder();
const editableTypes = new Set(TEXT_BLOCK_TYPES);
const editableParentTypes = new Set([...BLOCK_PARENT_TYPES,'columns']);
const maxEditableDepth = 8;
export class CollaborationError extends Error {
  constructor(code = 'INVALID_ROOM_UPDATE', status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new CollaborationError(code, status); };
const size = value => encoder.encode(JSON.stringify(value)).length;

/** V1 text-only wire grammar is inspected before Yjs allocates structs or content arrays. */
export function inspectUpdate(input, { state = false, protocol = 1 } = {}) {
  if (!(input instanceof Uint8Array) || !input.length || input.byteLength > (state ? ROOM_LIMITS.stateBytes : ROOM_LIMITS.updateBytes)) fail('ROOM_TOO_LARGE',413);
  const bytes = new Uint8Array(input); let offset = 0, structs = 0, logical = 0, ranges = 0;
  const number = () => {
    let result = 0, power = 1;
    for (let n = 0; n < 8; n++) {
      if (offset >= bytes.length) fail(); const byte = bytes[offset++];
      result += (byte & 127) * power;
      if (!Number.isSafeInteger(result)) fail();
      if (!(byte & 128)) return result;
      power *= 128;
    }
    fail();
  };
  const bounded = (value, maximum) => { if (value > maximum) fail('ROOM_TOO_LARGE',413); return value; };
  const id = () => { bounded(number(),0xffffffff); bounded(number(),ROOM_LIMITS.logicalLength); };
  const string = (maximum = ROOM_LIMITS.logicalLength) => {
    const length = bounded(number(),maximum);
    if (offset + length > bytes.length) fail();
    let value; try { value = new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset,offset+length)); } catch { fail(); }
    offset += length; return value;
  };
  const clients = bounded(number(),ROOM_LIMITS.clients);
  for (let i = 0; i < clients; i++) {
    const count = number(); structs += count;
    bounded(structs,state ? ROOM_LIMITS.structs : ROOM_LIMITS.updateStructs);
    bounded(number(),0xffffffff); const clock = bounded(number(),ROOM_LIMITS.logicalLength);
    let clientLength = 0;
    for (let j = 0; j < count; j++) {
      if (offset >= bytes.length) fail(); const info = bytes[offset++], content = info & 31;
      let length;
      if (info === 0 || info === 10) length = number();
      else {
        if (![1,4,...(protocol===2?[6,8]:[])].includes(content)) fail('ROOM_CONTENT_UNSUPPORTED');
        if (info & 128) id(); if (info & 64) id();
        if (!(info & 192)) { const parent = number(); if (parent === 1) string(256); else if (parent === 0) id(); else fail(); }
        if (info & 32) {if(protocol!==2||content!==8)fail('ROOM_CONTENT_UNSUPPORTED');string(128);}
        if(content===6){string(64);const encoded=string(4096);let value;try{value=JSON.parse(encoded);}catch{fail();}if(value!==null&&typeof value!=='boolean'&&typeof value!=='string')fail('ROOM_CONTENT_UNSUPPORTED');length=1;}
        else if(content===8){length=bounded(number(),ROOM_LIMITS.blockCount*2);for(let n=0;n<length;n++){if(bytes[offset++]!==119)fail('ROOM_CONTENT_UNSUPPORTED');const value=string(8192);logical+=value.length;bounded(logical,ROOM_LIMITS.logicalLength);}}
        else length = content === 1 ? number() : string().length;
      }
      if (length < 1) fail(); logical += length; clientLength += length;
      bounded(logical,ROOM_LIMITS.logicalLength); bounded(clock+clientLength,ROOM_LIMITS.logicalLength);
    }
  }
  const deleteClients = bounded(number(),ROOM_LIMITS.clients);
  let deletedLength = 0;
  for (let i = 0; i < deleteClients; i++) {
    bounded(number(),0xffffffff); const count = number(); ranges += count; bounded(ranges,ROOM_LIMITS.structs);
    for (let j = 0; j < count; j++) {
      const clock = number(), length = number(); if (length < 1) fail();
      bounded(clock+length,ROOM_LIMITS.logicalLength); deletedLength += length;
      bounded(deletedLength,ROOM_LIMITS.logicalLength);
    }
  }
  if (offset !== bytes.length) fail();
  return { bytes, structs, logicalLength: logical, deleteRanges: ranges };
}

function blockTexts(blocks) {
  validateBlocks(blocks); const fields = new Map(); let count = 0;
  const visit = (items,depth=0,mutableAncestors=true) => { for (const block of items) {
    if (++count > ROOM_LIMITS.blockCount) fail('ROOM_TOO_LARGE',413);
    const mutable=mutableAncestors&&depth<maxEditableDepth&&block.data?.purpose!=='import-source';
    if (mutable && editableTypes.has(block.type) && typeof block.data?.text === 'string') {
      if (block.data.text.length > 100000) fail('ROOM_TOO_LARGE',413);
      fields.set('block:'+block.id,block.data.text);
    }
    if (block.children) visit(block.children,depth+1,mutableAncestors&&block.data?.purpose!=='import-source'&&editableParentTypes.has(block.type));
  } };
  visit(blocks); return fields;
}
function draft(value) {
  if (!value || typeof value !== 'object') fail();
  assertTitle(value.title); const fields = blockTexts(value.blocks);
  if (size({title:value.title,blocks:value.blocks}) > ROOM_LIMITS.documentBytes) fail('ROOM_TOO_LARGE',413);
  return fields;
}

export function createRoomDocument(value) {
  const fields = draft(value), doc = new Y.Doc({gc:true});
  doc.transact(() => {
    doc.getText('title').insert(0,value.title);
    for (const [key,text] of fields) doc.getText(key).insert(0,text);
  });
  validateRoomDocument(doc,value); return doc;
}
export const editableRoomKeys = value => ['title',...draft(value).keys()];
export function loadRoomDocument(input, baseline, {requireBaselineMatch=true} = {}) {
  const {bytes} = inspectUpdate(input,{state:true}), doc = new Y.Doc({gc:true});
  try { Y.applyUpdate(doc,bytes); const derived=validateRoomDocument(doc,baseline);
    if(requireBaselineMatch&&JSON.stringify(derived)!==JSON.stringify({title:baseline.title,blocks:baseline.blocks}))fail('ROOM_BASELINE_MISMATCH');
    return doc; }
  catch (error) { doc.destroy(); if (error instanceof CollaborationError) throw error; fail(); }
}

/** Only text changes are derived. All structure, types and readonly/source metadata remain server-owned. */
export function validateRoomDocument(doc, baseline) {
  const fields = draft(baseline), allowed = new Set(['title',...fields.keys()]);
  if (!(doc instanceof Y.Doc) || doc.store.pendingStructs || doc.store.pendingDs || doc.store.clients.size > ROOM_LIMITS.clients) fail();
  let structs = 0, logical = 0;
  for (const items of doc.store.clients.values()) for (const item of items) {
    if (++structs > ROOM_LIMITS.structs || !Number.isSafeInteger(item.length) || item.length < 1) fail('ROOM_TOO_LARGE',413);
    logical += item.length; if (logical > ROOM_LIMITS.logicalLength) fail('ROOM_TOO_LARGE',413);
  }
  for (const key of doc.share.keys()) if (!allowed.has(key)) fail('ROOM_CONTENT_UNSUPPORTED');
  const text = key => {
    // Root types loaded by applyUpdate are AbstractType until a typed getter binds them.
    const value = doc.getText(key);
    if (!(value instanceof Y.Text) || value.toDelta().some(part=>typeof part.insert !== 'string' || part.attributes)) fail('ROOM_CONTENT_UNSUPPORTED');
    return value.toString();
  };
  const title = text('title'); assertTitle(title);
  const blocks = structuredClone(baseline.blocks);
  const visit = items => { for (const block of items) {
    const key = 'block:'+block.id;
    if (fields.has(key)) {
      const value = text(key); if (value.length > 100000) fail('ROOM_TOO_LARGE',413);
      if (value !== block.data.text) {
        if (block.data.marks) {
          const marks = rebaseInlineMarks(block.data.text, value, block.data.marks);
          if (marks.length) block.data.marks = marks; else delete block.data.marks;
        }
        if (block.data.links) {const links=rebasePageLinks(block.data.text,value,block.data.links);if(links.length)block.data.links=links;else delete block.data.links;}
        if (block.data.mentions) {const mentions=rebaseMentions(block.data.text,value,block.data.mentions);if(mentions.length)block.data.mentions=mentions;else delete block.data.mentions;}
        block.data.text = value;
      }
    }
    if (block.children) visit(block.children);
  } };
  visit(blocks); const result = {title,blocks}; draft(result);
  if (Y.encodeStateAsUpdate(doc).byteLength > ROOM_LIMITS.stateBytes) fail('ROOM_TOO_LARGE',413);
  return result;
}
export function applyRoomUpdate(state, update, baseline) {
  const inspected = inspectUpdate(update), doc = loadRoomDocument(state,baseline);
  try {
    Y.applyUpdate(doc,inspected.bytes);
    const value = validateRoomDocument(doc,baseline), bytes = Y.encodeStateAsUpdate(doc);
    return {draft:value,state:bytes,stateVector:Y.encodeStateVector(doc)};
  } catch (error) { if (error instanceof CollaborationError) throw error; fail(); }
  finally { doc.destroy(); }
}
export function inspectStateVector(input) {
  if (!(input instanceof Uint8Array) || input.length > 1024) fail();
  let offset=0;
  const number=()=>{let result=0,power=1;for(let i=0;i<8;i++){if(offset>=input.length)fail();const byte=input[offset++];result+=(byte&127)*power;if(!Number.isSafeInteger(result))fail();if(!(byte&128))return result;power*=128;}fail();};
  const count=number();if(count>ROOM_LIMITS.clients)fail('ROOM_TOO_LARGE',413);
  const vector=new Map();
  for(let i=0;i<count;i++){const id=number(),clock=number();if(id>0xffffffff||clock>ROOM_LIMITS.logicalLength||vector.has(id))fail();vector.set(id,clock);}
  if(offset!==input.length)fail();return vector;
}
export const encodeRoomState = doc => { const state = Y.encodeStateAsUpdate(doc); inspectUpdate(state,{state:true}); return state; };
export function roomDiff(state, baseline, stateVector = null) {
  const doc = loadRoomDocument(state,baseline);
  try { if (stateVector) inspectStateVector(stateVector); return {update:Y.encodeStateAsUpdate(doc,stateVector ?? undefined),stateVector:Y.encodeStateVector(doc)}; }
  finally { doc.destroy(); }
}
export {createStructuredRoom,loadStructuredRoom,validateStructuredRoom,applyStructuredUpdate,structuredRoomDiff,structuredRoomOperation,structuredRoomPaste,structuredRoomFormat,structuredRoomText,structuredRoomTableKey,structuredRoomTablePosition,structuredRoomTableEdit,structuredRoomKeys,structuredRoomConflicts,structuredRoomFeatures,structuredRoomSelection,resolveStructuredRoomSelection,STRUCTURED_ROOM_LIMITS,STRUCTURED_ROOM_FEATURES} from './structure.js';
export function toBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) fail(); let result='';
  for(let i=0;i<bytes.length;i+=8192) result += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(result);
}
export function fromBase64(text, maximum = ROOM_LIMITS.stateBytes) {
  if (typeof text !== 'string' || text.length > Math.ceil(maximum/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail();
  const raw = atob(text); if(raw.length > maximum) fail('ROOM_TOO_LARGE',413);
  return Uint8Array.from(raw,char=>char.charCodeAt(0));
}
