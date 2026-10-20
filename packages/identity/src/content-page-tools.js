import {assertId,assertJsonSerializable,assertPlainObject,validatePageAppearance,validateBlocks,createPageAccessEvaluator} from '@yumunio/domain';
import {ContentPagesError} from './content-pages.js';
import {rememberPage,trimHistory} from './content-history.js';
import {invalidateRooms} from './content-room.js';
const fail=(code='INVALID_CONTENT',status=400)=>{throw new ContentPagesError(code,status);};
const missing=()=>fail('CONTENT_NOT_FOUND',404);
function bodyOf(value,keys){assertJsonSerializable(value);assertPlainObject(value);if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1)fail();return value;}
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
export function validatePageFavorites(payload,pages){
 const rows=payload.pageFavorites??[],seen=new Set();if(!Array.isArray(rows)||rows.length>5000)fail();
 for(const row of rows){assertPlainObject(row);if(Object.keys(row).length!==3||!['accountId','membershipId','pageId'].every(key=>Object.hasOwn(row,key)))fail();for(const key of ['accountId','membershipId','pageId'])assertId(row[key]);const key=row.membershipId+'\0'+row.pageId;if(!pages.has(row.pageId)||seen.has(key))fail();seen.add(key);}
}
export async function handlePageTools(ctx){
 const {request,action,pageId,payload,saved,actor,accountId,workspaceId,access,now,createId}=ctx,item=payload.pages.find(row=>row.page.id===pageId);
 if(!item||item.page.trashedAt!==null||!access(pageId).includes(action==='appearance'?'editBody':'read'))missing();
 if(request.method!==(action==='duplicate'?'POST':'PATCH'))fail('METHOD_NOT_ALLOWED',405);
 const body=bodyOf(await ctx.readJson(request),action==='appearance'?['expectedRevision','expectedVersion','appearance']:action==='favorite'?['expectedRevision','expectedVersion','favorite']:['expectedRevision','expectedVersion','title','includeChildren']);
 if(body.expectedRevision!==saved.revision||body.expectedVersion!==item.document.version)fail('CONTENT_CONFLICT',409);
 const stamp=now();let targetPageId=pageId,result,requiredPages=[pageId];
 if(action==='favorite'){
  if(typeof body.favorite!=='boolean')fail();
  const rows=(payload.pageFavorites??[]).filter(row=>row.accountId!==accountId||row.membershipId===actor.id&&row.pageId!==pageId&&payload.pages.some(item=>item.page.id===row.pageId&&item.page.trashedAt===null)&&access(row.pageId).includes('read'));
  if(body.favorite){if(rows.filter(row=>row.membershipId===actor.id).length>=200)fail('CONTENT_TOO_LARGE',413);rows.push({accountId,membershipId:actor.id,pageId});}payload.pageFavorites=rows;
  result={pageId,version:item.document.version,favorite:body.favorite};
 }else if(action==='appearance'){
  let appearance;try{appearance=validatePageAppearance(body.appearance);}catch{fail('INVALID_PAGE_APPEARANCE');}
  if(appearance.coverAttachmentId&&!payload.attachments?.some(asset=>asset.id===appearance.coverAttachmentId&&asset.pageId===pageId&&['image/png','image/jpeg','image/gif','image/webp'].includes(asset.mediaType)))missing();
  if(item.document.version>=Number.MAX_SAFE_INTEGER)fail('CONTENT_CONFLICT',409);
  rememberPage(payload,item,{actorId:accountId,now,createId});invalidateRooms(payload,[pageId]);
  item.page={...item.page,appearance,updatedAt:stamp};item.document={...item.document,version:item.document.version+1,updatedAt:stamp};trimHistory(payload);result={pageId,version:item.document.version,appearance};
 }else{
  if(actor.role==='guest')missing();
  if(typeof body.title!=='string'||!body.title.trim()||body.title.length>240||typeof body.includeChildren!=='boolean')fail();
  const originals=[item];if(body.includeChildren)for(let index=0;index<originals.length;index++)originals.push(...payload.pages.filter(row=>row.page.parentId===originals[index].page.id&&row.page.trashedAt===null));
  if(originals.some(row=>!access(row.page.id).includes('read')))missing();
  requiredPages=originals.map(row=>row.page.id);
  const sourceIds=new Set(originals.map(row=>row.page.id));
  if(payload.collections?.some(collection=>sourceIds.has(collection.pageId)||collection.recordPages.some(row=>sourceIds.has(row.pageId))))fail('PAGE_COLLECTION_COPY_UNSUPPORTED',409);
  const used=new Set();const scan=blocks=>{for(const block of blocks){used.add(block.id);if(block.children)scan(block.children);}};
  for(const row of payload.pages){used.add(row.page.id);scan(row.document.blocks);}for(const row of [...(payload.attachments??[]),...(payload.pendingBlobs??[]),...payload.grants])used.add(row.id);
  const mint=()=>{const value=assertId(createId());if(used.has(value))fail('CONTENT_UNAVAILABLE',503);used.add(value);return value;};
  const pages=new Map(originals.map(row=>[row.page.id,mint()])),assets=new Map(),blocksByPage=new Map();targetPageId=pages.get(pageId);
  for(const row of originals){const ids=new Map(),visit=blocks=>{for(const block of blocks){ids.set(block.id,mint());if(block.children)visit(block.children);}};visit(row.document.blocks);blocksByPage.set(row.page.id,ids);}
  for(const asset of [...(payload.attachments??[])])if(sourceIds.has(asset.pageId)){const copy={...asset,id:mint(),pageId:pages.get(asset.pageId)};assets.set(asset.id,copy.id);payload.attachments.push(copy);}
  const copyBlocks=(blocks,sourcePageId)=>blocks.map(source=>{
   const block=structuredClone(source);block.id=blocksByPage.get(sourcePageId).get(source.id);
   if(block.data?.links)block.data.links=block.data.links.flatMap(link=>{
    if(link.unavailable||!access(link.pageId).includes('read'))return[];
    if(link.attachmentId){const asset=assets.get(link.attachmentId);return asset?[{...link,pageId:pages.get(link.pageId),attachmentId:asset}]:[];}
    const targetBlocks=blocksByPage.get(link.pageId),fragment=typeof link.fragment==='string'&&link.fragment.startsWith('block-')?targetBlocks?.get(link.fragment.slice(6)):null;
    return[{...link,pageId:pages.get(link.pageId)??link.pageId,...(fragment?{fragment:'block-'+fragment}:{})}];
   });
   if(block.data?.mentions)block.data.mentions=block.data.mentions.flatMap(mention=>mention.unavailable||mention.kind==='person'||mention.kind==='page'&&!access(mention.pageId).includes('read')?[]:[mention.kind==='page'?{...mention,pageId:pages.get(mention.pageId)??mention.pageId}:mention]);
   if(['file','image'].includes(block.type)&&block.data?.format==='attachment-v1'&&!block.data.links?.length){block.type='paragraph';block.data={text:block.data.text};}
   if(block.children)block.children=copyBlocks(block.children,sourcePageId);return block;
  });
  for(const row of originals){const id=pages.get(row.page.id),page={...row.page,id,parentId:row===item?null:pages.get(row.page.parentId),title:row===item?body.title:row.page.title,createdAt:stamp,updatedAt:stamp,trashedAt:null};
   if(page.appearance)page.appearance={...page.appearance,locked:false,coverAttachmentId:assets.get(page.appearance.coverAttachmentId)??null};
   const blocks=copyBlocks(row.document.blocks,row.page.id);validateBlocks(blocks);payload.pages.push({page,document:{pageId:id,workspaceId,version:1,blocks,updatedAt:stamp},inheritPermissions:row!==item});
  }
  payload.personalPageOwners??=[];payload.personalPageOwners.push({workspaceId,pageId:targetPageId,accountId,membershipId:actor.id});
  const grantId=mint();payload.grants.push({id:grantId,workspaceId,pageId:targetPageId,accountId,permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId,membershipId:actor.id});
  result={pageId:targetPageId,pageCount:originals.length};
 }
 const captured=ctx.validatePayload(payload,workspaceId);
 let written;try{written=await ctx.store.write(workspaceId,accountId,{expectedRevision:saved.revision,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});}
 catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;const fresh=await ctx.store.read(workspaceId,accountId);if(!fresh?.principals.some(row=>row.accountId===accountId&&row.id===actor.id&&row.role===actor.role&&row.emailVerified))missing();const latest=ctx.readPayload(fresh,workspaceId),evaluate=createPageAccessEvaluator(ctx.policy(latest,fresh.principals,workspaceId));if(requiredPages.some(id=>!evaluate({accountId,workspaceId,pageId:id}).capabilities.includes(action==='appearance'?'editBody':'read')))missing();fail('CONTENT_CONFLICT',409);}
 return json({revision:written.revision,...result},action==='duplicate'?201:200);
}
