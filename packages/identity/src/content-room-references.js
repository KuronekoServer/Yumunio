import {createPageAccessEvaluator} from '@yumunio/domain';
import {validateReferenceTargets} from '@yumunio/collaboration';
import {preparePageLinkBlocks} from './content-page-links.js';
import {prepareMentionBlocks,projectMentionBlocks} from './content-mentions.js';

const missing=()=>{throw Object.assign(new Error('CONTENT_NOT_FOUND'),{code:'CONTENT_NOT_FOUND',status:404});};
const same=(a,b)=>JSON.stringify(Object.fromEntries(Object.entries(a).sort()))===JSON.stringify(Object.fromEntries(Object.entries(b).sort()));
function context({payload,saved,policy,workspaceId,accountId,pageId}){
 const evaluate=createPageAccessEvaluator(policy(payload,saved.principals,workspaceId));
 return{access:id=>evaluate({accountId,workspaceId,pageId:id}).capabilities,personCanRead:(id,source)=>evaluate({accountId:id,workspaceId,pageId:source}).capabilities.includes('read'),pageId,principals:saved.principals};
}
export function mergeRoomReferenceTargets(options){
 const {seed,targets}=options;if(!targets)return{seed,guards:[]};validateReferenceTargets(targets);
 const next=structuredClone(seed),refs={...seed.references},guards=new Map(),ctx=context(options);
 for(const[token,record]of Object.entries(targets)){
  const old=refs[token];
  if(old){const entry={...record.entry,...(old.entry.membershipId&&!Object.hasOwn(record.entry,'membershipId')?{membershipId:old.entry.membershipId}:{})};if(old.kind!==record.kind||old.text!==record.text||!same(old.entry,entry))missing();continue;}
  if(record.entry.unavailable)missing();
  const block={id:'reference',type:'paragraph',data:{text:record.text,[record.kind]:[record.entry]}};
  const checked=prepareMentionBlocks({blocks:preparePageLinkBlocks({blocks:[block],access:ctx.access,attachments:options.payload.attachments??[],pageId:ctx.pageId}),...ctx});
  refs[token]={...record,entry:checked.blocks[0].data[record.kind][0]};for(const guard of checked.guards)guards.set(guard.id,guard);
 }
 if(guards.size>16)throw Object.assign(new Error('CONTENT_TOO_LARGE'),{code:'CONTENT_TOO_LARGE',status:413});
 next.references=refs;validateReferenceTargets(refs);return{seed:next,guards:[...guards.values()]};
}
export function projectRoomReferenceTargets(options){
 const refs=options.seed.references;if(!refs)return{};const ctx=context(options),result={};
 for(const[token,record]of Object.entries(refs)){
  let entry=record.entry;
  if(record.kind==='links'){
   if(entry.unavailable||!ctx.access(entry.pageId).includes('read'))entry={start:0,end:record.text.length,label:record.text,unavailable:true};
  }else entry=projectMentionBlocks({blocks:[{id:'reference',type:'paragraph',data:{text:record.text,mentions:[entry]}}],pageId:ctx.pageId,principals:ctx.principals,personCanRead:ctx.personCanRead,canReadPage:id=>ctx.access(id).includes('read')})[0].data.mentions[0];
  result[token]={...record,entry};
 }
 return result;
}
