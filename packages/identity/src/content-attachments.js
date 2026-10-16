import { assertId, assertJsonSerializable, assertPlainObject, createPageAccessEvaluator } from '@yumunio/domain';
import { ContentAssetError, verifiedBytes, handleAssetRequest } from './content-assets.js';
const fail=(code='INVALID_CONTENT',status=400)=>{throw new ContentAssetError(code,status);};
const missing=()=>fail('CONTENT_NOT_FOUND',404);
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
const project=row=>({id:row.id,name:row.name,mediaType:row.mediaType,size:row.size});
export function listPageUploads(context){
  if(context.request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
  if(!context.access(context.pageId).includes('editBody'))missing();
  return json({revision:context.saved.revision,pageId:context.pageId,uploads:(context.payload.pendingBlobs??[]).filter(row=>row.pageId===context.pageId&&row.accountId===context.accountId&&row.membershipId===context.actor.id).map(row=>({...project(row),uploadId:row.importId,sourceId:row.sourceId,checksum:row.checksum,status:row.status}))});
}
export async function commitPageAttachment(context){
  const {request,pageId,assetId,importId,payload,saved,actor,accountId,workspaceId}=context;
  if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);assertId(assetId);
  const item=payload.pages.find(row=>row.page.id===pageId);
  if(!item||!context.access(pageId).includes('editBody'))missing();
  const body=await context.readJson(request);assertPlainObject(body);assertJsonSerializable(body);
  if(Object.keys(body).length!==2||!Object.hasOwn(body,'expectedRevision')||!Object.hasOwn(body,'expectedVersion')||![body.expectedRevision,body.expectedVersion].every(value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER))fail();
  const existing=payload.attachments?.find(row=>row.id===assetId&&row.pageId===pageId);
  if(existing)return json({revision:saved.revision,version:item.document.version,attachment:project(existing),replayed:true});
  const staged=payload.pendingBlobs?.find(row=>row.id===assetId&&row.pageId===pageId&&row.importId===importId&&row.accountId===accountId&&row.membershipId===actor.id&&row.status==='ready');
  if(!staged)missing();if(body.expectedRevision!==saved.revision||body.expectedVersion!==item.document.version)fail('CONTENT_CONFLICT',409);
  await verifiedBytes(context.blobStore,staged);
  const attachment={id:staged.id,pageId,name:staged.name,mediaType:staged.mediaType,size:staged.size,checksum:staged.checksum,profileId:staged.profileId,objectKey:staged.objectKey};
  payload.pendingBlobs=payload.pendingBlobs.filter(row=>row.id!==staged.id);payload.attachments??=[];payload.attachments.push(attachment);
  const captured=context.validatePayload(payload,workspaceId);
  try{const written=await context.store.write(workspaceId,accountId,{expectedRevision:saved.revision,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});return json({revision:written.revision,version:item.document.version,attachment:project(attachment),replayed:false},201);}
  catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;
    const fresh=await context.store.read(workspaceId,accountId),principal=fresh?.principals.find(row=>row.accountId===accountId&&row.id===actor.id&&row.role===actor.role&&row.emailVerified);if(!principal)missing();
    const latest=context.readPayload(fresh,workspaceId),evaluate=createPageAccessEvaluator(context.policy(latest,fresh.principals,workspaceId));if(!evaluate({accountId,workspaceId,pageId}).capabilities.includes('editBody'))missing();
    const committed=latest.attachments?.find(row=>row.id===assetId&&row.pageId===pageId);if(committed)return json({revision:fresh.revision,version:latest.pages.find(row=>row.page.id===pageId).document.version,attachment:project(committed),replayed:true});
    fail('CONTENT_CONFLICT',409);
  }
}

/** Metadata removal and a durable deletion fence precede external blob IO. */
export async function removePageAttachment(context){
  const {request,pageId,assetId,payload,saved,actor,accountId,workspaceId}=context;
  if(request.method!=='DELETE')fail('METHOD_NOT_ALLOWED',405);
  if(!context.access(pageId).includes('editBody'))missing();
  const item=payload.pages.find(row=>row.page.id===pageId),body=await context.readJson(request);assertPlainObject(body);assertJsonSerializable(body);
  if(Object.keys(body).length!==2||!Object.hasOwn(body,'expectedRevision')||!Object.hasOwn(body,'expectedVersion')||![body.expectedRevision,body.expectedVersion].every(value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER))fail();
  const attachment=payload.attachments?.find(row=>row.id===assetId&&row.pageId===pageId);
  let revision=saved.revision,cleanup=(payload.pendingBlobs??[]).find(row=>row.id===assetId&&row.pageId===pageId&&row.accountId===accountId&&row.membershipId===actor.id&&row.status==='deleting');
  if(!attachment&&!cleanup)return json({revision,version:item.document.version,removed:true,replayed:true});
  if(body.expectedRevision!==revision||body.expectedVersion!==item.document.version)fail('CONTENT_CONFLICT',409);
  if(attachment){
    cleanup={...attachment,importId:'remove-'+crypto.randomUUID(),sourceId:'attachment-delete',accountId,membershipId:actor.id,status:'deleting'};
    payload.attachments=payload.attachments.filter(row=>row.id!==assetId);payload.pendingBlobs??=[];payload.pendingBlobs.push(cleanup);
    const captured=context.validatePayload(payload,workspaceId);
    try{revision=(await context.store.write(workspaceId,accountId,{expectedRevision:revision,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]})).revision;}
    catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;const fresh=await context.store.read(workspaceId,accountId),principal=fresh?.principals.find(row=>row.accountId===accountId&&row.id===actor.id&&row.role===actor.role&&row.emailVerified);if(!principal)missing();const latest=context.readPayload(fresh,workspaceId);if(!createPageAccessEvaluator(context.policy(latest,fresh.principals,workspaceId))({accountId,workspaceId,pageId}).capabilities.includes('editBody'))missing();fail('CONTENT_CONFLICT',409);}
  }
  const cleanupRequest=new Request(request.url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision})});
  const result=await handleAssetRequest({...context,request:cleanupRequest,importId:cleanup.importId,assetId:cleanup.id,saved:{...saved,revision}});
  return json({...await result.json(),version:item.document.version,replayed:false});
}
