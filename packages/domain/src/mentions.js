export const MENTION_LIMITS=Object.freeze({text:100000,perBlock:100});
export class MentionsError extends TypeError {constructor(){super('INVALID_MENTIONS');this.name='MentionsError';this.code='INVALID_MENTIONS';}}
const fail=()=>{throw new MentionsError();};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function plain(value){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))fail();}
function textValue(value){if(typeof value!=='string'||value.length>MENTION_LIMITS.text)fail();}
export function isMentionBoundary(text,offset){return typeof text==='string'&&Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&!(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]));}
function range(text,start,end){textValue(text);if(!isMentionBoundary(text,start)||!isMentionBoundary(text,end)||start>end)fail();}
function dateValue(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-'))fail();const date=new Date(value+'T00:00:00.000Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)fail();}
/** ID/date-only references. Visible labels are the underlying text, never authority. */
export function validateMentions(text,mentions,{allowUnavailable=false,allowMembershipIds=false}={}){
 textValue(text);if(!Array.isArray(mentions)||Object.getPrototypeOf(mentions)!==Array.prototype||mentions.length>MENTION_LIMITS.perBlock||Reflect.ownKeys(mentions).length!==mentions.length+1)fail();
 for(let index=0;index<mentions.length;index++){const descriptor=Object.getOwnPropertyDescriptor(mentions,String(index));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();}
 let previous=0;
 return mentions.map(mention=>{plain(mention);if(!['person','page','date'].includes(mention.kind))fail();range(text,mention.start,mention.end);if(mention.start<previous||mention.start===mention.end)fail();
  const base=['kind','start','end'];let required,allowed;
  if(Object.hasOwn(mention,'unavailable')){if(!allowUnavailable||mention.unavailable!==true||mention.kind==='date')fail();required=allowed=[...base,'unavailable'];}
  else if(mention.kind==='person'){required=[...base,'accountId'];allowed=[...required,...(allowMembershipIds?['membershipId']:[])];if(!id(mention.accountId)||Object.hasOwn(mention,'membershipId')&&!id(mention.membershipId))fail();}
  else if(mention.kind==='page'){required=allowed=[...base,'pageId'];if(!id(mention.pageId))fail();}
  else{required=allowed=[...base,'date'];dateValue(mention.date);}
  if(Object.keys(mention).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(mention,key)))fail();previous=mention.end;return{...mention};
 });
}
const internal={allowUnavailable:true,allowMembershipIds:true};
/** Intersecting an entity removes its metadata as a whole; boundary insertions stay outside. */
export function replaceMentions(text,mentions,start,end,inserted){range(text,start,end);textValue(inserted);const source=validateMentions(text,mentions,internal),next=text.slice(0,start)+inserted+text.slice(end);textValue(next);const delta=inserted.length-(end-start),result=[];for(const mention of source){if(mention.end<=start)result.push({...mention});else if(mention.start>=end)result.push({...mention,start:mention.start+delta,end:mention.end+delta});}return validateMentions(next,result,internal);}
/** Conservative single replacement for IME, external plain-text edits and CRDT materialization. */
export function rebaseMentions(before,after,mentions){textValue(before);textValue(after);const source=validateMentions(before,mentions,internal);if(before===after)return source;let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;while(!isMentionBoundary(before,start)||!isMentionBoundary(after,start))start--;let oldEnd=before.length,newEnd=after.length;while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}while(!isMentionBoundary(before,oldEnd)||!isMentionBoundary(after,newEnd)){oldEnd++;newEnd++;}return replaceMentions(before,source,start,oldEnd,after.slice(start,newEnd));}
export function removeMentions(text,mentions,start,end){range(text,start,end);const source=validateMentions(text,mentions,internal);return start===end?source:source.filter(mention=>mention.end<=start||mention.start>=end);}
export function setMention(text,mentions,start,end,target){range(text,start,end);plain(target);if(start===end||Object.hasOwn(target,'start')||Object.hasOwn(target,'end'))fail();const entry=validateMentions(text,[{...target,start,end}],internal)[0],next=removeMentions(text,mentions,start,end);next.push(entry);next.sort((left,right)=>left.start-right.start);return validateMentions(text,next,internal);}
export function splitMentions(text,mentions,start,end){range(text,start,end);const source=validateMentions(text,mentions,internal);return{beforeMentions:validateMentions(text.slice(0,start),source.filter(mention=>mention.end<=start),internal),afterMentions:validateMentions(text.slice(end),source.filter(mention=>mention.start>=end).map(mention=>({...mention,start:mention.start-end,end:mention.end-end})),internal)};}
export function joinMentions(before,left,after,right){textValue(before);textValue(after);return validateMentions(before+after,[...validateMentions(before,left,internal),...validateMentions(after,right,internal).map(mention=>({...mention,start:mention.start+before.length,end:mention.end+before.length}))],internal);}
