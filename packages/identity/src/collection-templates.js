import {assertId,assertTitle,validateBlocks,validatePropertyValues,createPageAccessEvaluator} from '@yumunio/domain';
import {preparePageLinkBlocks,ContentPageLinksError} from './content-page-links.js';
import {prepareMentionBlocks} from './content-mentions.js';
import {prepareSyncedBlocks} from './content-synced.js';
const computed=property=>['formula','rollup','created_time','last_edited_time'].includes(property.type);
export function templateDefaults(properties,values,{exact,fail}){
 exact(values,properties.filter(property=>!computed(property)).map(property=>property.id),[]);
 return validatePropertyValues(properties.map(property=>({...property,required:false})),structuredClone(values));
}
export function validateCollectionTemplates(entry,pages,pageBindings,{exact,fail}){
 if(entry.templates===undefined)return;if(!Array.isArray(entry.templates)||entry.templates.length>20)fail();const ids=new Set();
 for(const template of entry.templates){exact(template,['id','name','pageId','values']);assertId(template.id);assertId(template.pageId);assertTitle(template.name);if(!template.name.trim()||ids.has(template.id)||!pages.has(template.pageId)||pageBindings.has(template.pageId)||pages.get(template.pageId).page.parentId!==entry.pageId)fail();ids.add(template.id);pageBindings.add(template.pageId);templateDefaults(entry.collection.properties,template.values,{exact,fail});}
}
export function readableTemplate(context,entry,id,{missing}){
 assertId(id);const template=entry.templates?.find(template=>template.id===id);if(!template||!context.access(template.pageId).includes('read'))missing();return template;
}
/** Each applied body and attachment has a new page-owned identity; private bytes may be shared. */
export function applyCollectionTemplate(context,template,destination,mint){
 const source=context.payload.pages.find(item=>item.page.id===template.pageId),attachments=new Map();
 const copy=items=>items.map(block=>{const result={...structuredClone(block),id:mint()};if(result.children)result.children=copy(result.children);for(const link of result.data?.links??[])if(link.attachmentId){if(link.unavailable||link.pageId!==template.pageId)throw new ContentPageLinksError('CONTENT_NOT_FOUND',404);let target=attachments.get(link.attachmentId);if(!target){const original=context.payload.attachments?.find(row=>row.id===link.attachmentId&&row.pageId===template.pageId);if(!original)throw new ContentPageLinksError('CONTENT_NOT_FOUND',404);target={...original,id:mint(),pageId:destination.page.id};context.payload.attachments.push(target);attachments.set(original.id,target);}link.pageId=destination.page.id;link.attachmentId=target.id;}return result;});
 const evaluate=createPageAccessEvaluator(context.policy(context.payload,context.saved.principals,context.workspaceId)),access=pageId=>evaluate({accountId:context.accountId,workspaceId:context.workspaceId,pageId}).capabilities;
 const prepared=prepareMentionBlocks({blocks:preparePageLinkBlocks({blocks:prepareSyncedBlocks({blocks:copy(source.document.blocks),access,pageId:destination.page.id}),access,attachments:context.payload.attachments??[],pageId:destination.page.id}),access,principals:context.saved.principals,personCanRead:(accountId,pageId)=>evaluate({accountId,workspaceId:context.workspaceId,pageId}).capabilities.includes('read'),pageId:destination.page.id});destination.document.blocks=prepared.blocks;return prepared.guards;
}
export async function handleCollectionTemplates(context,entry,helpers){
 const {exact,fail,missing,conflict,revision,requireManage,mintFactory,privatePage,commit,checkReferences,entryIn,projectTemplates}=helpers,{request,payload,saved,templateId}=context;
 if(request.method==='GET')return helpers.json({revision:saved.revision,templates:projectTemplates(entry,context)});
 requireManage(context,entry.pageId);if(context.actor.role==='guest')missing();if(!['POST','PATCH','DELETE'].includes(request.method)||request.method==='POST'&&templateId||request.method!=='POST'&&!templateId)fail('METHOD_NOT_ALLOWED',405);
 const current=templateId?readableTemplate(context,entry,templateId,{missing}):null;if(current&&!context.access(current.pageId).includes('editBody'))missing();
 const data=await context.readJson(request);exact(data,request.method==='DELETE'?['expectedRevision']:request.method==='POST'?['expectedRevision','name','values','blocks']:['expectedRevision','name','values'],request.method==='POST'?['expectedRevision','name','values']:['expectedRevision']);revision(data.expectedRevision);if(data.expectedRevision!==saved.revision)conflict();
 if(data.name!==undefined){assertTitle(data.name);if(!data.name.trim())fail();}let guards=[];
 if(data.values!==undefined){templateDefaults(entry.collection.properties,data.values,{exact,fail});guards=checkReferences(entry.collection.properties,data.values,context);}
 let id=templateId,pageId=current?.pageId;
 if(request.method==='POST'){
  if((entry.templates?.length??0)>=20)fail('CONTENT_TOO_LARGE',413);validateBlocks(data.blocks??[]);const mint=mintFactory(payload,context.createId),page=privatePage(context,{title:data.name,parentId:entry.pageId,inheritPermissions:true,mint});id=mint();pageId=page.page.id;
  // Use the same reference preparation as normal pages, including attachment ownership and mention access.
  const prepared=helpers.prepareBlocks(data.blocks??[],[],pageId);page.document.blocks=prepared.blocks;guards.push(...prepared.guards);entry.templates??=[];entry.templates.push({id,name:data.name,pageId,values:structuredClone(data.values)});
 }else if(request.method==='PATCH'){
  if(data.name===undefined&&data.values===undefined)fail();if(data.name!==undefined)current.name=data.name;if(data.values!==undefined)current.values={...current.values,...structuredClone(data.values)};
 }else entry.templates=entry.templates.filter(template=>template.id!==templateId);
 entry.collection.updatedAt=context.now();return commit(context,{status:request.method==='POST'?201:200,guards,result:{collectionId:entry.collection.id,templateId:id,pageId,...(request.method==='DELETE'?{removed:true}:{})},authorizeFresh:fresh=>{const freshEntry=entryIn(fresh,entry.collection.id);requireManage(fresh,freshEntry.pageId);if(current){const freshTemplate=readableTemplate(fresh,freshEntry,templateId,{missing});if(!fresh.access(freshTemplate.pageId).includes('editBody'))missing();}if(data.values)checkReferences(freshEntry.collection.properties,data.values,fresh);}});
}
