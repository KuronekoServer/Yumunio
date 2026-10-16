import {assertId} from '@yumunio/domain';
import {CollaborationError,editableRoomKeys} from './index.js';

export const PRESENCE_LIMITS=Object.freeze({ttlMs:30000,heartbeatMs:10000,participants:64,clientsPerAccount:8});
const fail=()=>{throw new CollaborationError('INVALID_ROOM_PRESENCE');};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();};
export const validPresenceClientId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const boundary=(text,index)=>Number.isSafeInteger(index)&&index>=0&&index<=text.length&&!(index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]));
export function validatePresenceCursor(value,draft){
 if(value===null)return null;exact(value,['blockId','start','end','direction']);try{assertId(value.blockId);}catch{fail();}
 if(!['forward','backward','none'].includes(value.direction)||value.start>value.end||!editableRoomKeys(draft).includes('block:'+value.blockId))fail();
 let field;const visit=items=>{for(const block of items){if(block.id===value.blockId)field=block;if(block.children)visit(block.children);}};visit(draft.blocks);
 if(!field||!boundary(field.data.text,value.start)||!boundary(field.data.text,value.end))fail();
 return{blockId:value.blockId,start:value.start,end:value.end,direction:value.start===value.end?'none':value.direction};
}
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
/** Reject unknown wire metadata; a newer text basis hides cursors until normal CRDT sync. */
export function validatePresenceSnapshot(value,{pageId,epoch,sequence,documentVersion,draft}={}){
 exact(value,['pageId','epoch','sequence','documentVersion','selfId','ttlMs','serverTime','participants']);
 if(value.pageId!==pageId||value.epoch!==epoch||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Number.isSafeInteger(value.documentVersion)||value.documentVersion<1||value.ttlMs!==PRESENCE_LIMITS.ttlMs||!timestamp(value.serverTime)||value.selfId!==null&&!/^[a-f0-9]{32}$/.test(value.selfId)||!Array.isArray(value.participants)||value.participants.length>PRESENCE_LIMITS.participants)fail();
 const ids=new Set(),sameBasis=value.sequence===sequence&&value.documentVersion===documentVersion;
 const participants=value.participants.map(item=>{
  exact(item,['id','displayName','self','cursor','expiresAt']);
  if(!/^[a-f0-9]{32}$/.test(item.id)||ids.has(item.id)||typeof item.displayName!=='string'||!item.displayName.length||Array.from(item.displayName).length>240||/[\u0000-\u001f\u007f]/.test(item.displayName)||typeof item.self!=='boolean'||item.self!==(item.id===value.selfId)||!timestamp(item.expiresAt)||Date.parse(item.expiresAt)<=Date.parse(value.serverTime)||Date.parse(item.expiresAt)-Date.parse(value.serverTime)>PRESENCE_LIMITS.ttlMs)fail();
  ids.add(item.id);return{...item,cursor:sameBasis?validatePresenceCursor(item.cursor,draft):null};
 });
 return{...value,participants};
}
