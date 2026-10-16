import {assertId,assertJsonSerializable,assertPlainObject,assertTitle,rebaseInlineMarks,rebasePageLinks,rebaseMentions} from '@yumunio/domain';
import {createAccountContentApi,validateContentPayload} from './content.js';
import {API_TOKEN_SCOPES,API_TOKEN_LIMITS,tokenFail,tokenTimestamp,parseApiToken,tokenDigest,validateTokenRow,tokenPageContext,projectTokenPage} from './api-token-model.js';
import {createExternalTokenGuard} from './external-token-guard.js';

const unavailable=()=>tokenFail('API_TOKEN_UNAVAILABLE',401),invalid=()=>tokenFail('INVALID_API_TOKEN_REQUEST',400),readonly=()=>tokenFail('EXTERNAL_DOCUMENT_READ_ONLY',409);
const types=new Set(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote','divider','code']);
const dataKeys=type=>type==='divider'?[]:['text',...(type==='heading'?['level']:[]),...(type==='checklist'?['checked']:[])];
function exact(value,allowed,required=allowed){try{assertPlainObject(value);assertJsonSerializable(value);}catch{invalid();}if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))invalid();}
/** Bounded text blocks, with same-ID metadata retained and shared domain range rebasing. */
function editableBlocks(blocks,current){
 if(projectTokenPage(current,{document:true}).omittedBlocks)readonly();
 try{assertJsonSerializable(blocks);}catch{invalid();}
 if(new TextEncoder().encode(JSON.stringify(blocks)).length>API_TOKEN_LIMITS.documentBytes)tokenFail('API_DOCUMENT_TOO_LARGE',413);
 const previous=new Map(),remember=items=>{for(const block of items){previous.set(block.id,block);if(block.children)remember(block.children);}};remember(current.document.blocks);
 let count=0;const ids=new Set();
 const visit=(items,depth)=>{if(!Array.isArray(items))invalid();if(depth>API_TOKEN_LIMITS.depth)tokenFail('API_DOCUMENT_TOO_LARGE',413);return items.map(block=>{
  if(++count>API_TOKEN_LIMITS.blocks)tokenFail('API_DOCUMENT_TOO_LARGE',413);exact(block,['id','type','data','children'],['id','type']);
  try{assertId(block.id);}catch{invalid();}if(ids.has(block.id)||!types.has(block.type))invalid();ids.add(block.id);
  const keys=dataKeys(block.type);if(block.type==='divider'){if(Object.hasOwn(block,'data'))exact(block.data,[]);}else{exact(block.data,keys);if(typeof block.data.text!=='string'||block.data.text.length>100000||block.type==='heading'&&![1,2,3].includes(block.data.level)||block.type==='checklist'&&typeof block.data.checked!=='boolean')invalid();}
  const old=previous.get(block.id);if(old&&old.type!==block.type&&(Object.keys(old).some(key=>!['id','type','data','children'].includes(key))||Object.keys(old.data??{}).some(key=>!dataKeys(old.type).includes(key))))readonly();
  const next={...(old&&old.type===block.type?structuredClone(old):{}),id:block.id,type:block.type};delete next.children;
  if(block.type==='divider'){if(!old||old.type!==block.type)delete next.data;}else{
   next.data={...(old?.type===block.type?structuredClone(old.data??{}):{}),...block.data};
   if(old?.type===block.type&&old.data?.text!==block.data.text){try{if(old.data?.marks)next.data.marks=rebaseInlineMarks(old.data.text,block.data.text,old.data.marks);if(old.data?.links)next.data.links=rebasePageLinks(old.data.text,block.data.text,old.data.links);if(old.data?.mentions)next.data.mentions=rebaseMentions(old.data.text,block.data.text,old.data.mentions);}catch{readonly();}}
  }
  if(Object.hasOwn(block,'children'))next.children=visit(block.children,depth+1);
  return next;
 });};return visit(blocks,1);
}
/** Shared Bearer authorization and actions for REST and MCP. No cookie/session fallback. */
export function createExternalPageActions({store,contentStore,origin,enabled=false,now=()=>new Date().toISOString(),createId=()=>crypto.randomUUID()}={}){
 if(new URL(origin).origin!==origin||typeof enabled!=='boolean'||typeof now!=='function'||typeof createId!=='function'||enabled&&(typeof store?.readExternal!=='function'||typeof contentStore?.read!=='function'||typeof contentStore?.write!=='function'))throw Error('Invalid external page action configuration.');
 async function resolve({authorization,pageId,scope='page:read',requiredScopes=[]}={}){
  if(!enabled)tokenFail('API_TOKENS_DISABLED',503);
  if(!API_TOKEN_SCOPES.includes(scope)||!Array.isArray(requiredScopes)||!requiredScopes.every(value=>API_TOKEN_SCOPES.includes(value)))invalid();
  if(pageId!==undefined)try{assertId(pageId);}catch{invalid();}
  const parsed=typeof authorization==='string'&&authorization.startsWith('Bearer ')?parseApiToken(authorization.slice(7)):null;if(!parsed)unavailable();
  const tokenHash=await tokenDigest(parsed.token),stamp=tokenTimestamp(now()),value=await store.readExternal(parsed.locator,tokenHash,{now:stamp,pageId,scope});if(!value)unavailable();
  const row=validateTokenRow(value.token);if(row.id!==parsed.locator||row.tokenHash!==tokenHash||pageId!==undefined&&row.pageId!==pageId||row.revokedAt!==null||row.expiresAt<=tokenTimestamp(now())||![scope,...requiredScopes].every(value=>row.scopes.includes(value)))unavailable();
  const context=tokenPageContext(row,value.saved,validateContentPayload,{capability:scope==='document:write'?'editBody':'read'});if(!context)unavailable();
  const canEdit=!!tokenPageContext(row,value.saved,validateContentPayload,{capability:'editBody'}),scopes=row.scopes.filter(scope=>scope!=='document:write'||canEdit);
  return {row,context,scopes};
 }
 return Object.freeze({
  async authorize(options){const{row,scopes}=await resolve(options);return Object.freeze({pageId:row.pageId,scopes:Object.freeze([...scopes])});},
  async execute({authorization,pageId,action,input,requiredScopes=[]}={}){
   const scope={'page.read':'page:read','document.read':'document:read','document.write':'document:write'}[action];if(!scope)invalid();
   const {row,context}=await resolve({authorization,pageId,scope,requiredScopes});
   if(action!=='document.write'){if(input!==undefined)invalid();return projectTokenPage(context.page,{document:action==='document.read'});}
   exact(input,['expectedVersion','title','blocks'],['expectedVersion']);if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||input.expectedVersion>=Number.MAX_SAFE_INTEGER||!Object.hasOwn(input,'title')&&!Object.hasOwn(input,'blocks'))invalid();
   if(input.expectedVersion!==context.page.document.version)tokenFail('CONTENT_CONFLICT',409);
   const body={expectedRevision:context.revision,expectedVersion:input.expectedVersion};
   if(Object.hasOwn(input,'title')){try{assertTitle(input.title);}catch{invalid();}body.title=input.title;}
   if(Object.hasOwn(input,'blocks'))body.blocks=editableBlocks(input.blocks,context.page);
   // Ensure a successful mutation can always return the stable bounded external DTO.
   projectTokenPage({page:{...context.page.page,...(Object.hasOwn(body,'title')?{title:body.title}:{})},document:{...context.page.document,version:input.expectedVersion+1,...(body.blocks?{blocks:body.blocks}:{})}},{document:true});
   const guardedStore={read:contentStore.read.bind(contentStore),write:(workspaceId,accountId,options)=>contentStore.write(workspaceId,accountId,{...options,tokenGuard:createExternalTokenGuard(row,{now:tokenTimestamp(now()),requiredScopes:[scope,...requiredScopes]})})};
   const api=createAccountContentApi({store:guardedStore,origin,now,createId,inlineMentionNotifications:false,resolveSession:async()=>({user:{id:row.accountId,emailVerified:true}})});
   const response=await api(new Request(origin+'/api/content/workspaces/'+encodeURIComponent(row.workspaceId)+'/pages/'+encodeURIComponent(row.pageId),{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json','X-Yumunio-Expected-Account':row.accountId},body:JSON.stringify(body)}));
   const result=await response.json();if(!response.ok){if(response.status===404||response.status===409)await resolve({authorization,pageId:row.pageId,scope,requiredScopes});tokenFail(['CONTENT_CONFLICT','INVALID_CONTENT','CONTENT_NOT_FOUND'].includes(result.error?.code)?result.error.code:'API_TOKEN_UNAVAILABLE',response.status);}
   return projectTokenPage({page:result.page,document:result.document},{document:true});
  }
 });
}
