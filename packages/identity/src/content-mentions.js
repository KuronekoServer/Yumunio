import {validateBlocks,validateMentions,rebaseMentions} from '@yumunio/domain';
export class ContentMentionsError extends Error{constructor(code='INVALID_CONTENT',status=400){super(code);this.code=code;this.status=status;}}
const invalid=()=>{throw new ContentMentionsError();},missing=()=>{throw new ContentMentionsError('CONTENT_NOT_FOUND',404);};
const options={allowUnavailable:true,allowMembershipIds:true};
const sameReference=(left,right)=>left.kind===right.kind&&(left.kind==='person'?left.accountId===right.accountId&&(!Object.hasOwn(right,'membershipId')||left.membershipId===right.membershipId):left.kind==='page'?left.pageId===right.pageId:left.date===right.date);
const sameRange=(left,right)=>left.kind===right.kind&&left.start===right.start&&left.end===right.end;
function indexBlocks(blocks){const result=new Map();const visit=items=>{for(const block of items){result.set(block.id,block);if(block.children)visit(block.children);}};visit(blocks);return result;}
/** Page-level bindings ignore ranges, labels and block placement, and never descend through opaque/source payloads. */
export function personMentionBindings(blocks){
 const result=new Map(),parents=new Set(['paragraph','bulleted-list','numbered-list','quote','checklist','columns','column']);
 const visit=items=>{for(const block of items){if(block.data?.purpose==='import-source')continue;
  for(const mention of block.data?.mentions??[])if(mention.kind==='person'&&!mention.unavailable&&mention.membershipId)result.set(mention.accountId+'\0'+mention.membershipId,{accountId:mention.accountId,membershipId:mention.membershipId});
  if(block.children&&parents.has(block.type))visit(block.children);
 }};visit(blocks);return result;
}
/** Only current verified readers of this page can be newly mentioned as people. */
export function prepareMentionBlocks({blocks,previousBlocks=[],access=()=>[],principals=[],personCanRead=()=>false,pageId}={}){
 validateBlocks(blocks);const previous=indexBlocks(previousBlocks),captured=structuredClone(blocks),people=new Map(principals.filter(person=>person.emailVerified).map(person=>[person.accountId,person])),guards=new Map(),pageAccess=new Map(),personAccess=new Map();
 const canReadPage=id=>{if(!pageAccess.has(id))pageAccess.set(id,access(id).includes('read'));return pageAccess.get(id);};
 const activePerson=mention=>{const person=people.get(mention.accountId);if(!person||mention.membershipId!==undefined&&mention.membershipId!==person.id)return null;if(!personAccess.has(person.accountId))personAccess.set(person.accountId,personCanRead(person.accountId,pageId)===true);return personAccess.get(person.accountId)?person:null;};
 const hidden=mention=>mention.kind==='page'?!canReadPage(mention.pageId):mention.kind==='person'?!activePerson(mention):false;
 const visit=items=>{for(const block of items){if(Object.hasOwn(block.data??{},'mentions')){
  let mentions;try{mentions=validateMentions(block.data.text,block.data.mentions,options);}catch{invalid();}
  const old=previous.get(block.id),surviving=old&&typeof old.data?.text==='string'&&Array.isArray(old.data.mentions)?rebaseMentions(old.data.text,block.data.text,old.data.mentions):[];
  block.data.mentions=mentions.map(mention=>{
   if(mention.kind==='date')return mention;
   const preserved=surviving.find(before=>!before.unavailable&&sameRange(before,mention)&&hidden(before)&&(mention.unavailable||sameReference(before,mention)));
   if(mention.unavailable){if(!preserved)invalid();return{...preserved};}
   if(mention.kind==='page'){if(!canReadPage(mention.pageId)){if(!preserved)missing();return{...preserved};}return mention;}
   const person=activePerson(mention);if(!person){if(!preserved)missing();return{...preserved};}
   guards.set(person.id,{id:person.id,accountId:person.accountId,role:person.role});
   return{kind:'person',start:mention.start,end:mention.end,accountId:person.accountId,membershipId:person.id};
  });
 }if(block.children)visit(block.children);}};visit(captured);if(guards.size>16)throw new ContentMentionsError('CONTENT_TOO_LARGE',413);return{blocks:captured,guards:[...guards.values()]};
}
/** Read projections remove generation IDs and unavailable account/page IDs; exports keep literal text only. */
export function projectMentionBlocks({blocks,pageId,canReadPage=()=>false,principals=[],personCanRead=()=>false,stripReferences=false}={}){
 const captured=structuredClone(blocks),people=new Map(principals.filter(person=>person.emailVerified).map(person=>[person.accountId,person]));
 const visit=items=>{for(const block of items){if(Array.isArray(block.data?.mentions)){
  if(stripReferences)delete block.data.mentions;
  else block.data.mentions=validateMentions(block.data.text,block.data.mentions,options).map(mention=>{
   if(mention.kind==='date')return mention;
   const person=mention.kind==='person'?people.get(mention.accountId):null;
   const available=!mention.unavailable&&(mention.kind==='page'?canReadPage(mention.pageId)===true:person&&mention.membershipId===person.id&&personCanRead(person.accountId,pageId)===true);
   if(!available)return{kind:mention.kind,start:mention.start,end:mention.end,unavailable:true};
   if(mention.kind==='person'){const{membershipId,...projected}=mention;return projected;}return mention;
  });
 }if(block.children)visit(block.children);}};visit(captured);return captured;
}
