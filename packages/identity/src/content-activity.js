import {assertId,assertPlainObject,assertJsonSerializable,createPageAccessEvaluator} from '@yumunio/domain';
import {personMentionBindings} from './content-mentions.js';

export const ACTIVITY_LIMITS=Object.freeze({notifications:1000,bytes:240000});
export class ContentActivityError extends Error{constructor(code='INVALID_CONTENT',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new ContentActivityError(code,status);};
const own=(value,key)=>Object.hasOwn(value,key);
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
function capacity(payload){if((payload.activityNotifications?.length??0)+(payload.discussion?.notifications?.length??0)>ACTIVITY_LIMITS.notifications||size({comment:payload.discussion?.notifications??[],assignment:payload.activityNotifications??[]})>ACTIVITY_LIMITS.bytes)fail('NOTIFICATIONS_TOO_LARGE',413);}
const timestamp=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail();};
const fields=['id','collectionId','recordId','pageId','propertyId','recipientId','recipientMembershipId','authorId','authorMembershipId','createdAt','readAt'];
const inlineFields=['id','kind','pageId','recipientId','recipientMembershipId','authorId','authorMembershipId','createdAt','readAt'];
function discussionIds(payload){return new Set([...(payload.discussion?.notifications??[]).map(item=>item.id),...(payload.discussion?.threads??[]).flatMap(thread=>[thread.id,...thread.messages.map(message=>message.id)])]);}

/** Optional private event metadata. Old payloads/archives keep this field absent. */
export function validateActivityNotifications(payload,pages){
 if(!own(payload,'activityNotifications'))return;
 const rows=payload.activityNotifications;
 if(!Array.isArray(rows))fail();capacity(payload);
 const ids=discussionIds(payload),assignments=new Set();
 for(const item of rows){
  assertPlainObject(item);assertJsonSerializable(item);const inline=item.kind==='inline-mention',keys=inline?inlineFields:fields;if(Object.keys(item).length!==keys.length||keys.some(key=>!own(item,key)))fail();
  for(const key of keys.filter(key=>!['kind','createdAt','readAt'].includes(key)))assertId(item[key]);
  if(ids.has(item.id)||item.recipientId===item.authorId||!pages.has(item.pageId))fail();ids.add(item.id);timestamp(item.createdAt);if(item.readAt!==null)timestamp(item.readAt);
  const assignment=inline?'inline\0'+item.pageId+'\0'+item.recipientId+'\0'+item.recipientMembershipId:'assignment\0'+item.collectionId+'\0'+item.recordId+'\0'+item.propertyId;if(assignments.has(assignment))fail();assignments.add(assignment);
 }
}
function activeBinding(payload,item){
 const entry=(payload.collections??[]).find(entry=>entry.collection.id===item.collectionId),binding=entry?.recordPages.find(binding=>binding.recordId===item.recordId&&binding.pageId===item.pageId),row=entry?.collection.records.find(row=>row.id===item.recordId),property=entry?.collection.properties.find(property=>property.id===item.propertyId);
 return!!binding&&property?.type==='person'&&row?.values[property.id]===item.recipientId;
}
/** A schema change or assignment removal invalidates the old event; it cannot revive later. */
export function pruneAssignmentNotifications(payload,{collectionId=null,pageIds=null}={}){
 if(!own(payload,'activityNotifications'))return;
 const removed=pageIds?new Set(pageIds):null;
 payload.activityNotifications=payload.activityNotifications.filter(item=>!removed?.has(item.pageId)&&(item.kind==='inline-mention'||collectionId!==null&&item.collectionId!==collectionId||activeBinding(payload,item)));
}
export function assignmentNotifications(context){
 const payload=context.payload;
 return(payload.activityNotifications??[]).filter(item=>item.kind!=='inline-mention'&&item.recipientId===context.accountId&&item.recipientMembershipId===context.actor.id&&activeBinding(payload,item)&&context.access(item.pageId).includes('read')).map(item=>({id:item.id,pageId:item.pageId,pageTitle:payload.pages.find(page=>page.page.id===item.pageId).page.title,authorId:item.authorId,createdAt:item.createdAt,readAt:item.readAt,reason:'assignment'}));
}
/** A receipt remains private to the same live, verified reader generation and a currently present reference. */
export function inlineMentionNotifications(context){
 const pages=new Map(context.payload.pages.map(item=>[item.page.id,item])),bindings=new Map();
 return(context.payload.activityNotifications??[]).filter(item=>{
  if(item.kind!=='inline-mention'||item.recipientId!==context.accountId||item.recipientMembershipId!==context.actor.id||!context.actor.emailVerified||!context.access(item.pageId).includes('read'))return false;
  const page=pages.get(item.pageId);if(!page||page.page.trashedAt!==null)return false;
  if(!bindings.has(item.pageId))bindings.set(item.pageId,personMentionBindings(page.document.blocks));
  return bindings.get(item.pageId).has(item.recipientId+'\0'+item.recipientMembershipId);
 }).map(item=>({id:item.id,pageId:item.pageId,pageTitle:pages.get(item.pageId).page.title,authorId:item.authorId,createdAt:item.createdAt,readAt:item.readAt,reason:'inline-mention'}));
}
/** Mint-free commit hygiene for room, history, move and external-write paths as well as ordinary editing. */
export function pruneInlineMentionNotifications(payload){
 if(!payload.activityNotifications?.some(item=>item.kind==='inline-mention'))return;
 const pages=new Map(payload.pages.map(item=>[item.page.id,item])),bindings=new Map();
 payload.activityNotifications=payload.activityNotifications.filter(item=>{
  if(item.kind!=='inline-mention')return true;const page=pages.get(item.pageId);if(!page||page.page.trashedAt!==null)return false;
  if(!bindings.has(item.pageId))bindings.set(item.pageId,personMentionBindings(page.document.blocks));
  return bindings.get(item.pageId).has(item.recipientId+'\0'+item.recipientMembershipId);
 });
}
/** Only the normal existing-page editor calls this; imports, templates, moves and external APIs do not. */
export function recordInlineMentions(context,pageId,beforeBlocks,afterBlocks){
 const before=personMentionBindings(beforeBlocks),after=personMentionBindings(afterBlocks),people=new Map(context.saved.principals.filter(person=>person.emailVerified).map(person=>[person.accountId,person])),evaluate=createPageAccessEvaluator(context.policy(context.payload,context.saved.principals,context.workspaceId));
 const eligible=new Map([...after].filter(([,binding])=>{const person=people.get(binding.accountId);return person&&person.id===binding.membershipId&&evaluate({accountId:person.accountId,workspaceId:context.workspaceId,pageId}).capabilities.includes('read');}));
 if(own(context.payload,'activityNotifications'))context.payload.activityNotifications=context.payload.activityNotifications.filter(item=>item.kind!=='inline-mention'||item.pageId!==pageId||before.has(item.recipientId+'\0'+item.recipientMembershipId)&&eligible.has(item.recipientId+'\0'+item.recipientMembershipId));
 const guards=[];
 for(const[key,binding]of eligible){if(before.has(key)||binding.accountId===context.accountId)continue;const person=people.get(binding.accountId),id=assertId(context.createId());
  if(discussionIds(context.payload).has(id)||(context.payload.activityNotifications??[]).some(item=>item.id===id))fail('CONTENT_UNAVAILABLE',503);
  context.payload.activityNotifications??=[];context.payload.activityNotifications.push({id,kind:'inline-mention',pageId,recipientId:person.accountId,recipientMembershipId:person.id,authorId:context.accountId,authorMembershipId:context.actor.id,createdAt:context.now(),readAt:null});guards.push({id:person.id,accountId:person.accountId,role:person.role});
 }
 if(own(context.payload,'activityNotifications'))capacity(context.payload);return guards;
}
/** Derive new recipients from canonical value differences, never a caller's notification list. */
export function recordAssignments(context,entry,row,before){
 const changes=entry.collection.properties.filter(property=>property.type==='person'&&(before[property.id]??null)!==(row.values[property.id]??null));
 if(!changes.length)return[];
 const changed=new Set(changes.map(property=>property.id)),binding=entry.recordPages.find(binding=>binding.recordId===row.id);
 if(!binding)fail();
 if(own(context.payload,'activityNotifications'))context.payload.activityNotifications=context.payload.activityNotifications.filter(item=>item.collectionId!==entry.collection.id||item.recordId!==row.id||!changed.has(item.propertyId));
 const evaluate=createPageAccessEvaluator(context.policy(context.payload,context.saved.principals,context.workspaceId)),guards=[];
 for(const property of changes){
  const recipientId=row.values[property.id],person=context.saved.principals.find(person=>person.accountId===recipientId&&person.emailVerified);
  if(!person||person.accountId===context.accountId||!evaluate({accountId:person.accountId,workspaceId:context.workspaceId,pageId:binding.pageId}).capabilities.includes('read'))continue;
  const id=assertId(context.createId());if(discussionIds(context.payload).has(id)||(context.payload.activityNotifications??[]).some(item=>item.id===id))fail('CONTENT_UNAVAILABLE',503);
  context.payload.activityNotifications??=[];context.payload.activityNotifications.push({id,collectionId:entry.collection.id,recordId:row.id,pageId:binding.pageId,propertyId:property.id,recipientId:person.accountId,recipientMembershipId:person.id,authorId:context.accountId,authorMembershipId:context.actor.id,createdAt:context.now(),readAt:null});guards.push({id:person.id,accountId:person.accountId,role:person.role});
 }
 if(own(context.payload,'activityNotifications'))capacity(context.payload);
 return guards;
}
