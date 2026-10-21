import {projectCollectionRead,projectPlacementRead,ContentCollectionsError} from './content-collections.js';

/** A page, its properties and initial linked views share one authorized SQL
 * snapshot. The destination page never grants access to a source database. */
export async function readPageContext(ctx,item,{withContext=false,viewId=null,withDirectory=false}={}){
 const {payload,saved,accountId,bindings,access,peopleForPage}=ctx,pageId=item.page.id;
 if(!access(pageId).includes('read'))throw new ContentCollectionsError('CONTENT_NOT_FOUND',404);
 const attachments=(payload.attachments??[]).filter(row=>row.pageId===pageId).map(({id,name,mediaType,size})=>({id,name,mediaType,size}));
 const result={revision:saved.revision,page:ctx.projectPage(item),document:ctx.projectDocument(item.document),...(attachments.length?{attachments}:{})};
 if(!withContext)return result;
 const context=result.context={accountId,collection:null,people:[],placements:{},synced:{}};
 if(withDirectory)context.directory=await ctx.directory();
 const binding=bindings.get(pageId),entry=binding&&payload.collections?.find(entry=>entry.collection.id===binding.collectionId);
 if(entry&&access(entry.pageId).includes('read')){
  const view=viewId?entry.views?.find(view=>view.id===viewId):null;
  if(viewId&&!view)throw new ContentCollectionsError('CONTENT_NOT_FOUND',404);
  context.collection=projectCollectionRead(entry,ctx,view);context.people=context.collection.people??[];
 }else if(viewId)throw new ContentCollectionsError('CONTENT_NOT_FOUND',404);
 let count=0,bytes=0;
 function visit(blocks){for(const block of blocks){
  if(count<8&&bytes<1000000&&['database','synced-block'].includes(block.type)){
   count++;let value;
   try{
    if(block.type==='database'){
     const source=payload.collections?.find(entry=>entry.collection.id===block.data.collectionId);
     if(!source||!access(source.pageId).includes('read'))throw Object.assign(Error(),{status:404});
     value=projectPlacementRead(source,ctx,block.data.view);
    }else{
     const source=payload.pages.find(item=>item.page.id===block.data.pageId);
     if(!source||!access(source.page.id).includes('read'))throw Object.assign(Error(),{status:404});
     const assets=(payload.attachments??[]).filter(row=>row.pageId===source.page.id).map(({id,name,mediaType,size})=>({id,name,mediaType,size}));
     value={revision:saved.revision,page:ctx.projectPage(source),document:ctx.projectDocument(source.document),attachments:assets};
    }
   }catch(error){value={error:{status:error.status===404?404:400,code:error.status===404?'CONTENT_NOT_FOUND':'INVALID_CONTENT'}};}
   const size=JSON.stringify(value).length*2;
   if(bytes+size<=1000000){bytes+=size;(block.type==='database'?context.placements:context.synced)[block.id]=value;}
  }
  if(block.children)visit(block.children);
 }}
 visit(item.document.blocks);return result;
}
