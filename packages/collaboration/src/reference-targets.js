import {validatePageLinks,validateMentions} from '@yumunio/domain';
import {CollaborationError} from './index.js';

const fail=()=>{throw new CollaborationError('ROOM_CONTENT_UNSUPPORTED');};
/** Target IDs stay outside the shared CRDT byte stream. Each authenticated
 * response projects this registry with the viewer's current permissions. */
export function validateReferenceTargets(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).length>1000)fail();
 for(const[token,record]of Object.entries(value)){
  if(!/^(?:reference:[A-Za-z0-9._:-]{1,128}|(?:links|mentions):[A-Za-z0-9._:-]{1,128}:\d{1,4})$/.test(token)||!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).length!==3||!['kind','text','entry'].every(key=>Object.hasOwn(record,key))||!['links','mentions'].includes(record.kind)||typeof record.text!=='string')fail();
  try{(record.kind==='links'?validatePageLinks:validateMentions)(record.text,[record.entry],{allowUnavailable:true,allowMembershipIds:true});}catch{fail();}
  if(record.entry.start!==0||record.entry.end!==record.text.length)fail();
 }
 return value;
}
export function unavailableReference(kind,entry){return kind==='links'?{start:entry.start,end:entry.end,label:entry.label,unavailable:true}:{kind:entry.kind,start:entry.start,end:entry.end,unavailable:true};}
export function recordReferenceTarget(base,token,kind,text,entry){
 const record={kind,text,entry:{...entry,start:0,end:text.length}};
 base.references={...base.references,[token]:record};validateReferenceTargets(base.references);return record;
}
