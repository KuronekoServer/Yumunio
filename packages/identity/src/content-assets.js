import { assertId, assertJsonSerializable, assertPlainObject, createPageAccessEvaluator } from '@yumunio/domain';

const FILE_LIMIT=16*1024*1024, IMPORT_LIMIT=64*1024*1024, PAGE_UPLOAD_LIMIT=32*1024*1024, WORKSPACE_LIMIT=256*1024*1024;
const responseHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(value,status=200)=>Response.json(value,{status,headers:responseHeaders});
export class ContentAssetError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
const fail=(code='INVALID_CONTENT',status=400)=>{throw new ContentAssetError(code,status);};
const missing=()=>fail('CONTENT_NOT_FOUND',404);
const unavailable=()=>fail('CONTENT_UNAVAILABLE',503);
const conflict=()=>fail('CONTENT_CONFLICT',409);
function object(value,keys,required=keys){
  assertJsonSerializable(value);assertPlainObject(value);
  if(Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail();
}
function writableRevision(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('INVALID_REVISION');return value;}
const own=(row,actor,accountId,importId,pageId=null)=>row.importId===importId&&row.accountId===accountId&&row.membershipId===actor.id&&(row.pageId??null)===pageId;
const publicAsset=row=>({assetId:row.id,sourceId:row.sourceId,name:row.name,mediaType:row.mediaType,size:row.size,checksum:row.checksum,status:row.status});
function metadata(row){
  if(typeof row.name!=='string'||!row.name.trim()||row.name.length>255||['.','..'].includes(row.name)||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\]/.test(row.name))fail();
  try{encodeURIComponent(row.name);}catch{fail();}
  if(typeof row.mediaType!=='string'||row.mediaType.length>128||! /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(row.mediaType)||
    !Number.isSafeInteger(row.size)||row.size<0||row.size>FILE_LIMIT||typeof row.checksum!=='string'||! /^[a-f0-9]{64}$/.test(row.checksum))fail();
}
function location(row){
  assertId(row.profileId);
  if(typeof row.objectKey!=='string'||row.objectKey.length>512||! /^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(row.objectKey)||row.objectKey.split('/').some(part=>!part||part.length>128))fail();
}
export function validateAssetPayload(payload,pages){
  const pending=payload.pendingBlobs??[],attachments=payload.attachments??[];
  if(!Array.isArray(pending)||pending.length>1000||!Array.isArray(attachments)||attachments.length>1000)fail();
  const ids=new Set(),sources=new Set(),locations=new Map(),imports=new Map();
  for(const row of pending){
    object(row,['id','importId','sourceId','accountId','membershipId','name','mediaType','size','checksum','profileId','objectKey','status','pageId'],['id','importId','sourceId','accountId','membershipId','name','mediaType','size','checksum','profileId','objectKey','status']);
    if(Object.hasOwn(row,'pageId')&&!pages.has(assertId(row.pageId)))fail();
    for(const key of ['id','importId','sourceId','accountId','membershipId'])assertId(row[key]);metadata(row);location(row);
    const source=JSON.stringify([row.importId,row.accountId,row.membershipId,row.pageId??null,row.sourceId]);
    if(ids.has(row.id)||sources.has(source)||!['reserved','ready','deleting'].includes(row.status))fail();
    ids.add(row.id);sources.add(source);
    const importKey=JSON.stringify([row.importId,row.accountId,row.membershipId]);const quota=imports.get(importKey)??{size:0,pageUploadSize:0,count:0};
    quota.size+=row.size;if(row.pageId!==undefined)quota.pageUploadSize+=row.size;quota.count++;imports.set(importKey,quota);
    if(quota.size>IMPORT_LIMIT||quota.pageUploadSize>PAGE_UPLOAD_LIMIT||quota.count>100)fail('CONTENT_TOO_LARGE',413);
  }
  for(const row of attachments){
    object(row,['id','pageId','name','mediaType','size','checksum','profileId','objectKey']);assertId(row.id);assertId(row.pageId);metadata(row);location(row);
    if(ids.has(row.id)||!pages.has(row.pageId))fail();ids.add(row.id);
  }
  let total=0;
  for(const row of [...pending,...attachments]){
    const key=JSON.stringify([row.profileId,row.objectKey]);const previous=locations.get(key);
    if(previous&&(previous.size!==row.size||previous.checksum!==row.checksum))fail();
    if(!previous){locations.set(key,row);total+=row.size;}
  }
  if(total>WORKSPACE_LIMIT)fail('CONTENT_TOO_LARGE',413);
}
export function validateImportAssets(data,pages){
  const assets=data.assets??[];if(!Array.isArray(assets)||assets.length>100)fail();
  const sources=new Map(),ids=new Set();let bindings=0;
  for(const row of assets){
    object(row,['sourceId','assetId','pageSourceIds']);assertId(row.sourceId);assertId(row.assetId);
    if(sources.has(row.sourceId)||ids.has(row.assetId)||!Array.isArray(row.pageSourceIds)||!row.pageSourceIds.length||new Set(row.pageSourceIds).size!==row.pageSourceIds.length)fail();
    for(const pageId of row.pageSourceIds)if(!pages.has(assertId(pageId)))fail();
    bindings+=row.pageSourceIds.length;if(bindings>1000)fail('CONTENT_TOO_LARGE',413);
    sources.set(row.sourceId,row);ids.add(row.assetId);
  }
  return sources;
}
export function consumeImportAssets({data,payload,actor,accountId,pageIds,mint,blobStore}){
  const bindings=new Map();
  for(const source of data.assets??[]){
    const row=payload.pendingBlobs?.find(item=>item.id===source.assetId&&item.sourceId===source.sourceId&&own(item,actor,accountId,data.importId));
    if(!row||row.status!=='ready')missing();
    if(!blobStore||blobStore.profileId!==row.profileId)unavailable();
    payload.attachments??=[];
    for(const sourcePageId of source.pageSourceIds){
      const id=mint(),pageId=pageIds.get(sourcePageId);
      payload.attachments.push({id,pageId,name:row.name,mediaType:row.mediaType,size:row.size,checksum:row.checksum,profileId:row.profileId,objectKey:row.objectKey});
      bindings.set(JSON.stringify([source.sourceId,sourcePageId]),{pageId,attachmentId:id});
    }
    payload.pendingBlobs=payload.pendingBlobs.filter(item=>item.id!==row.id);
  }
  return bindings;
}
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');}
export async function verifiedBytes(blobStore,row){
  if(!blobStore||blobStore.profileId!==row.profileId)unavailable();
  let bytes;try{bytes=await blobStore.get(row.objectKey);}catch{unavailable();}
  if(!(bytes instanceof Uint8Array)||bytes.length!==row.size||bytes.length>FILE_LIMIT||await hash(bytes)!==row.checksum)unavailable();
  return bytes;
}
async function bodyBytes(request,size){
  if(!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers.get('content-type')??''))fail('CONTENT_TYPE',415);
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==size))fail();
  if(!request.body){if(size===0)return new Uint8Array();fail();}
  const reader=request.body.getReader(),chunks=[];let total=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
      if(total>size||total>FILE_LIMIT){try{await reader.cancel();}catch{}fail('CONTENT_TOO_LARGE',413);}chunks.push(value);}
    if(total!==size)fail();
    const bytes=new Uint8Array(total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return bytes;
  }finally{reader.releaseLock();}
}
export async function handleAssetRequest({request,importId,assetId,blobStore,store,saved,payload,actor,accountId,workspaceId,readJson,readPayload,validatePayload,pageId=null,access,policy}){
  assertId(importId);if(assetId)assertId(assetId);
  if(pageId!==null){assertId(pageId);if(!access(pageId).includes('editBody'))missing();}
  else if(!['owner','admin','member'].includes(actor.role))missing();
  const ownRows=()=> (payload.pendingBlobs??[]).filter(row=>own(row,actor,accountId,importId,pageId));
  if(request.method==='GET'&&!assetId)return json({revision:saved.revision,assets:ownRows().map(publicAsset)});
  const checkLive=async()=>{
    const fresh=await store.read(workspaceId,accountId);
    const principal=fresh?.principals.find(item=>item.accountId===accountId&&item.id===actor.id&&item.emailVerified);
    if(!principal||principal.role!==actor.role||pageId===null&&!['owner','admin','member'].includes(principal.role))missing();
    const current=readPayload(fresh,workspaceId);
    if(pageId!==null&&!createPageAccessEvaluator(policy(current,fresh.principals,workspaceId))({accountId,workspaceId,pageId}).capabilities.includes('editBody'))missing();
    return {fresh,current,principal};
  };
  const commit=async(current,expected)=>{
    const captured=validatePayload(current,workspaceId);
    try{return await store.write(workspaceId,accountId,{expectedRevision:expected,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});}
    catch(cause){if(cause?.code!=='CONTENT_CONFLICT')throw cause;await checkLive();conflict();}
  };
  if(!blobStore)unavailable();
  if(request.method==='POST'&&!assetId){
    const data=await readJson(request);object(data,['expectedRevision','sourceId','name','mediaType','size','checksum']);writableRevision(data.expectedRevision);assertId(data.sourceId);metadata(data);
    const receipt=payload.imports?.find(row=>row.importId===importId);
    if(receipt){if(receipt.accountId!==accountId||receipt.membershipId!==actor.id)missing();conflict();}
    const existing=ownRows().find(row=>row.sourceId===data.sourceId);
    if(existing){
      if(['name','mediaType','size','checksum'].some(key=>existing[key]!==data[key])||existing.status==='deleting')conflict();
      return json({revision:saved.revision,assetId:existing.id,status:existing.status});
    }
    if(data.expectedRevision!==saved.revision)conflict();
    const row={id:crypto.randomUUID(),importId,sourceId:data.sourceId,accountId,membershipId:actor.id,name:data.name,mediaType:data.mediaType,size:data.size,checksum:data.checksum,
      profileId:blobStore.profileId,objectKey:'objects/'+crypto.randomUUID(),status:'reserved',...(pageId===null?{}:{pageId})};
    payload.pendingBlobs??=[];payload.pendingBlobs.push(row);const written=await commit(payload,saved.revision);
    return json({revision:written.revision,assetId:row.id,status:row.status},201);
  }
  const row=ownRows().find(row=>row.id===assetId);if(!row)missing();
  if(blobStore.profileId!==row.profileId)unavailable();
  if(request.method==='PUT'){
    const header=request.headers.get('x-yumunio-expected-revision');if(header===null||!/^(?:0|[1-9]\d*)$/.test(header))fail('INVALID_REVISION');
    const expected=writableRevision(Number(header));if(row.status==='deleting')missing();
    if(expected!==saved.revision&&row.status!=='ready')conflict();
    const bytes=await bodyBytes(request,row.size);if(await hash(bytes)!==row.checksum)fail();
    if(row.status==='ready')return json({revision:saved.revision,assetId:row.id,status:row.status});
    try{
      const result=await blobStore.put(row.objectKey,bytes);if(result?.size!==row.size||result?.checksum!==row.checksum)unavailable();
    }catch(cause){if(cause?.code!=='BLOB_EXISTS')unavailable();await verifiedBytes(blobStore,row);}
    row.status='ready';let written;
    try{written=await commit(payload,saved.revision);}catch(cause){
      // A cancelled reservation can finish uploading late; never delete an object that became referenced.
      try{
        const fresh=await store.read(workspaceId,accountId);
        if(fresh){const current=readPayload(fresh,workspaceId);
          if(![...(current.pendingBlobs??[]),...(current.attachments??[])].some(item=>item.profileId===row.profileId&&item.objectKey===row.objectKey))await blobStore.delete(row.objectKey);}
      }catch{}
      throw cause;
    }
    return json({revision:written.revision,assetId:row.id,status:row.status});
  }
  if(request.method==='DELETE'){
    const data=await readJson(request);object(data,['expectedRevision']);writableRevision(data.expectedRevision);if(data.expectedRevision!==saved.revision)conflict();
    if(row.status!=='deleting'){row.status='deleting';await commit(payload,saved.revision);}
    const referenced=[...(payload.attachments??[]),...(payload.pendingBlobs??[]).filter(item=>item.id!==row.id)].some(item=>item.profileId===row.profileId&&item.objectKey===row.objectKey);
    if(!referenced)try{await blobStore.delete(row.objectKey);}catch{unavailable();}
    const {fresh,current}=await checkLive();const remaining=current.pendingBlobs?.find(item=>item.id===row.id&&own(item,actor,accountId,importId,pageId));
    if(!remaining||remaining.status!=='deleting')missing();
    current.pendingBlobs=current.pendingBlobs.filter(item=>item.id!==row.id);const written=await commit(current,fresh.revision);
    return json({revision:written.revision,removed:true});
  }
  fail('METHOD_NOT_ALLOWED',405);
}
export function rasterMediaType(bytes){
 const starts=values=>values.every((value,index)=>bytes[index]===value),ascii=(start,end)=>String.fromCharCode(...bytes.slice(start,end));
 if(bytes.length>=24&&starts([137,80,78,71,13,10,26,10])&&ascii(12,16)==='IHDR')return 'image/png';
 if(bytes.length>=4&&starts([255,216,255]))return 'image/jpeg';
 if(bytes.length>=10&&['GIF87a','GIF89a'].includes(ascii(0,6)))return 'image/gif';
 if(bytes.length>=16&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(ascii(12,16)))return 'image/webp';
 return null;
}
export function previewMediaType(bytes,declared){
 const image=rasterMediaType(bytes);if(image)return image===declared?image:null;
 const ascii=(start,end)=>String.fromCharCode(...bytes.slice(start,end)),starts=values=>values.every((value,index)=>bytes[index]===value);
 if(declared==='application/pdf'&&/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(ascii(0,8)))return declared;
 if(declared==='audio/mpeg'&&(ascii(0,3)==='ID3'||bytes.length>3&&bytes[0]===255&&(bytes[1]&224)===224))return declared;
 if(['audio/wav','audio/x-wav'].includes(declared)&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')return declared;
 if(['audio/ogg','video/ogg'].includes(declared)&&ascii(0,4)==='OggS')return declared;
 if(['audio/mp4','video/mp4'].includes(declared)&&bytes.length>=12&&ascii(4,8)==='ftyp')return declared;
 if(['audio/webm','video/webm'].includes(declared)&&bytes.length>=4&&starts([26,69,223,163]))return declared;
 return null;
}
export async function downloadAttachment({blobStore,attachment,authorize,preview=false,range=null}){
  const bytes=await verifiedBytes(blobStore,attachment);if(!await authorize())missing();
  const mediaType=preview?previewMediaType(bytes,attachment.mediaType):null;
  if(preview&&!mediaType)fail('CONTENT_TYPE',415);
  const name=encodeURIComponent(attachment.name).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
  const headers={...responseHeaders,'Content-Type':mediaType??'application/octet-stream','Accept-Ranges':'bytes',
    'Content-Disposition':(preview?'inline':'attachment')+"; filename=\"attachment.bin\"; filename*=UTF-8''"+name,
    'Content-Security-Policy':mediaType==='application/pdf'?"default-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'":"default-src 'none'; sandbox"};
  if(range){
   const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start,end;
   if(match&&(match[1]||match[2])){start=match[1]?Number(match[1]):Math.max(0,bytes.length-Number(match[2]));end=match[1]?(match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1):bytes.length-1;}
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=bytes.length||end<start)return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+bytes.length,'Content-Length':'0'}});
   const chunk=bytes.slice(start,end+1);return new Response(chunk,{status:206,headers:{...headers,'Content-Length':String(chunk.length),'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
  }
  return new Response(bytes,{headers:{...headers,'Content-Length':String(bytes.length)}});
}
