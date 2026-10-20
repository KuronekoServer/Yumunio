import { invalidateRooms } from './content-room.js';
import {pruneAssignmentNotifications} from './content-activity.js';
import {importSourceText,assertId,assertJsonSerializable,assertPlainObject,createPageAccessEvaluator,pageTeamspace,isSimpleTableData,simpleTableToMarkdown} from '@yumunio/domain';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(value,status=200)=>Response.json(value,{status,headers});
export class ContentPagesError extends Error {constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const fail=(code='INVALID_CONTENT',status=400)=>{throw new ContentPagesError(code,status);};
const missing=()=>fail('CONTENT_NOT_FOUND',404);
const conflict=()=>fail('CONTENT_CONFLICT',409);
function exact(value,allowed,required=allowed){assertJsonSerializable(value);assertPlainObject(value);if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail();}
function revision(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('INVALID_REVISION');}
function tree(payload,rootId,{stopAtTrash=false}={}){
  const children=new Map();for(const item of payload.pages){if(!children.has(item.page.parentId))children.set(item.page.parentId,[]);children.get(item.page.parentId).push(item);}
  const root=payload.pages.find(item=>item.page.id===rootId);if(!root)return[];const result=[],queue=[root];
  for(let i=0;i<queue.length;i++){const item=queue[i];if(stopAtTrash&&item.page.trashedAt!==null)continue;result.push(item);queue.push(...(children.get(item.page.id)??[]));}
  return result;
}
function untrashedAccess(payload,principals,workspaceId,accountId,policy){
  const state=policy(payload,principals,workspaceId);state.pages=state.pages.map(page=>({...page,trashedAt:null}));const evaluate=createPageAccessEvaluator(state);
  return pageId=>evaluate({accountId,workspaceId,pageId}).capabilities;
}
function ancestryVisible(payload,id,access){
  const pages=new Map(payload.pages.map(item=>[item.page.id,item]));let cursor=id;
  while(cursor!==null){const item=pages.get(cursor);if(!item||item.page.trashedAt!==null||!access(cursor).includes('read'))missing();cursor=item.page.parentId;}
}
function positionPage(payload,item,beforeId,parentId,access){
  if(beforeId!==null){assertId(beforeId);const target=payload.pages.find(row=>row.page.id===beforeId);
    if(!target||target===item||target.page.trashedAt!==null||target.page.parentId!==parentId||!access(beforeId).includes('read'))missing();
  }
  payload.pages.splice(payload.pages.indexOf(item),1);
  payload.pages.splice(beforeId===null?payload.pages.length:payload.pages.findIndex(row=>row.page.id===beforeId),0,item);
}
async function reorderPage(ctx,item,data){
  const {payload,saved,workspaceId,accountId,actor,access,policy,store,readPayload,validatePayload}=ctx;
  exact(data,['expectedRevision','parentId','beforeId']);revision(data.expectedRevision);
  ancestryVisible(payload,item.page.parentId,access);
  if(data.expectedRevision!==saved.revision)conflict();
  if(data.beforeId!==null){const state=policy(payload,saved.principals,workspaceId),sourceTeam=pageTeamspace(state,workspaceId,item.page.id),targetTeam=pageTeamspace(state,workspaceId,data.beforeId);
    if((sourceTeam?.id??null)!==(targetTeam?.id??null))missing();
  }
  positionPage(payload,item,data.beforeId,data.parentId,access);
  const captured=validatePayload(payload,workspaceId);
  try{const written=await store.write(workspaceId,accountId,{expectedRevision:saved.revision,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});return json({revision:written.revision,pageId:item.page.id,affectedPageCount:1,reordered:true});}
  catch(cause){if(cause?.code!=='CONTENT_CONFLICT')throw cause;
    const fresh=await store.read(workspaceId,accountId),principal=fresh?.principals.find(row=>row.accountId===accountId&&row.id===actor.id&&row.emailVerified&&row.role===actor.role);
    if(!principal)missing();const latest=readPayload(fresh,workspaceId),evaluate=createPageAccessEvaluator(policy(latest,fresh.principals,workspaceId)),can=id=>evaluate({accountId,workspaceId,pageId:id}).capabilities;
    if(!can(item.page.id).includes('manage')||data.beforeId!==null&&!can(data.beforeId).includes('read'))missing();ancestryVisible(latest,item.page.parentId,can);conflict();
  }
}
export function validateTrashGroups(payload,pages){
  if(!Object.hasOwn(payload,'trashGroups'))return;
  if(!Array.isArray(payload.trashGroups)||payload.trashGroups.length>1000)fail();const ids=new Set(),bound=new Set();
  for(const group of payload.trashGroups){
    exact(group,['id','rootPageId','pageIds','trashedAt']);assertId(group.id);assertId(group.rootPageId);
    if(ids.has(group.id)||!pages.has(group.rootPageId)||!Array.isArray(group.pageIds)||!group.pageIds.length||new Set(group.pageIds).size!==group.pageIds.length||!group.pageIds.includes(group.rootPageId))fail();
    ids.add(group.id);
    if(typeof group.trashedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(group.trashedAt)||!Number.isFinite(Date.parse(group.trashedAt))||new Date(group.trashedAt).toISOString()!==group.trashedAt)fail();
    for(const id of group.pageIds){assertId(id);const item=pages.get(id);if(bound.has(id)||!item||item.page.trashedAt!==group.trashedAt)fail();bound.add(id);
      if(id!==group.rootPageId&&!group.pageIds.includes(item.page.parentId))fail();}
  }
}
function trashGroups(payload){
  const groups=[...(payload.trashGroups??[])],bound=new Set(groups.flatMap(group=>group.pageIds));const pages=new Map(payload.pages.map(item=>[item.page.id,item]));
  for(const item of payload.pages){
    if(item.page.trashedAt===null||bound.has(item.page.id))continue;
    const parent=pages.get(item.page.parentId);if(parent?.page.trashedAt!==null&&parent&&!bound.has(parent.page.id))continue;
    const rows=tree(payload,item.page.id).filter(row=>!bound.has(row.page.id));
    groups.push({id:null,rootPageId:item.page.id,pageIds:rows.map(row=>row.page.id),trashedAt:item.page.trashedAt});
    for(const row of rows)bound.add(row.page.id);
  }
  return groups;
}
export function listTrash({payload,saved,workspaceId,accountId,actor,policy}){
  if(actor.role==='guest')return json({workspaceId,revision:saved.revision,pages:[]});
  const access=untrashedAccess(payload,saved.principals,workspaceId,accountId,policy);const pages=new Map(payload.pages.map(item=>[item.page.id,item]));
  const groups=trashGroups(payload).filter(group=>group.pageIds.every(id=>access(id).includes('manage')));
  const visible=new Set(groups.flatMap(group=>group.pageIds));
  return json({workspaceId,revision:saved.revision,pages:groups.map(group=>{const item=pages.get(group.rootPageId);return{...item.page,
    parentId:visible.has(item.page.parentId)?item.page.parentId:null,version:item.document.version,capabilities:['restore'],pageCount:group.pageIds.length};})});
}
export async function handlePageLifecycle(ctx){
  const {request,action,pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload,now,createId}=ctx;
  const item=payload.pages.find(row=>row.page.id===pageId);if(!item||actor.role==='guest')missing();
  if((action==='location'&&request.method!=='PATCH')||(action==='trash'&&request.method!=='DELETE')||(action==='restore'&&request.method!=='POST'))fail('METHOD_NOT_ALLOWED',405);
  let data;
  if(action==='location'){
    if(item.page.trashedAt!==null||!access(pageId).includes('manage'))missing();data=await readJson(request);
    // Ordering changes navigation only; keep the live document and room intact.
    if(Object.hasOwn(data??{},'beforeId')&&data.parentId===item.page.parentId&&!Object.hasOwn(data,'inheritPermissions'))return reorderPage(ctx,item,data);
  }
  const underlying=untrashedAccess(payload,saved.principals,workspaceId,accountId,policy);
  let group=null,affected;
  if(action==='restore'){
    group=trashGroups(payload).find(row=>row.rootPageId===pageId);if(!group)missing();affected=payload.pages.filter(row=>group.pageIds.includes(row.page.id));
    if(!affected.every(row=>underlying(row.page.id).includes('manage')))missing();
  }else{
    if(item.page.trashedAt!==null||!access(pageId).includes('manage'))missing();
    affected=tree(payload,pageId,{stopAtTrash:action==='trash'});
    if(!affected.every(row=>(action==='location'?underlying:access)(row.page.id).includes('manage')))missing();
    if(action==='location')ancestryVisible(payload,item.page.parentId,access);
  }
  if(action!=='location')data=await readJson(request);
  exact(data,action==='trash'?['expectedRevision']:action==='location'?['expectedRevision','parentId','inheritPermissions','beforeId']:['expectedRevision','parentId','inheritPermissions'],action==='location'?['expectedRevision','parentId']:['expectedRevision']);revision(data.expectedRevision);
  if(data.expectedRevision!==saved.revision)conflict();
  const stamp=now();let parentId=item.page.parentId;
  if(action!=='trash'){
    parentId=Object.hasOwn(data,'parentId')?data.parentId:item.page.parentId;if(parentId!==null)assertId(parentId);
    if(Object.hasOwn(data,'inheritPermissions')&&typeof data.inheritPermissions!=='boolean')fail();
    if(parentId!==null){if(affected.some(row=>row.page.id===parentId))fail('HIERARCHY_CYCLE');if(!access(parentId).includes('manage'))missing();ancestryVisible(payload,parentId,access);}
    const rowBinding=payload.collections?.flatMap(entry=>[...entry.recordPages,...(entry.templates??[])].map(row=>({...row,container:entry.pageId}))).find(row=>row.pageId===pageId);
    if(rowBinding&&rowBinding.container!==parentId)fail('COLLECTION_ROW_LOCATION',409);
  }
  if(action==='location'||action==='restore'){
    const placement=policy(payload,saved.principals,workspaceId),sourceTeam=pageTeamspace(placement,workspaceId,pageId),targetTeam=parentId===null?(payload.teamspacePages??[]).some(binding=>binding.pageId===pageId)?sourceTeam:null:pageTeamspace(placement,workspaceId,parentId);
    if((sourceTeam?.id??null)!==(targetTeam?.id??null))fail('PAGE_TEAMSPACE_REVIEW_REQUIRED',409);
    if(parentId!==null){if(payload.teamspacePages)payload.teamspacePages=payload.teamspacePages.filter(binding=>binding.pageId!==pageId);if(payload.personalPageOwners)payload.personalPageOwners=payload.personalPageOwners.filter(owner=>owner.pageId!==pageId);}
  }
  if(affected.some(row=>row.document.version===Number.MAX_SAFE_INTEGER))conflict();
  if(action==='location'&&Object.hasOwn(data,'beforeId'))positionPage(payload,item,data.beforeId,parentId,access);
  if(action==='trash'){
    const id=assertId(createId());if(payload.trashGroups?.some(row=>row.id===id))fail('CONTENT_UNAVAILABLE',503);
    payload.trashGroups??=[];payload.trashGroups.push({id,rootPageId:pageId,pageIds:affected.map(row=>row.page.id),trashedAt:stamp});
  }else{
    item.page.parentId=parentId;item.inheritPermissions=parentId!==null&&(data.inheritPermissions??false);
    // An inherited manager retains an explicit, generation-bound grant after leaving its previous parent.
    const bindingIds=new Set(payload.grantBindings.filter(row=>row.membershipId===actor.id).map(row=>row.grantId));
    if(!payload.grants.some(row=>bindingIds.has(row.id)&&row.pageId===pageId&&row.accountId===accountId&&row.permission==='full'&&row.includeDescendants&&row.status==='active')){
      const id=assertId(createId());if(payload.grants.some(row=>row.id===id))fail('CONTENT_UNAVAILABLE',503);
      payload.grants.push({id,workspaceId,pageId,accountId,permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId:id,membershipId:actor.id});
    }
    if(action==='restore'&&group.id!==null)payload.trashGroups=payload.trashGroups.filter(row=>row.id!==group.id);
  }
  if(action==='trash')pruneAssignmentNotifications(payload,{pageIds:affected.map(row=>row.page.id)});
  invalidateRooms(payload,affected.map(row=>row.page.id));
  for(const row of affected){row.page.updatedAt=stamp;if(action!=='location')row.page.trashedAt=action==='trash'?stamp:null;row.document.updatedAt=stamp;row.document.version++;}
  const after=untrashedAccess(payload,saved.principals,workspaceId,accountId,policy);
  if(!affected.every(row=>after(row.page.id).includes('manage')))fail('LAST_PAGE_MANAGER',409);
  const captured=validatePayload(payload,workspaceId);
  try{
    const written=await store.write(workspaceId,accountId,{expectedRevision:saved.revision,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});
    return json({revision:written.revision,pageId,affectedPageCount:affected.length});
  }catch(cause){
    if(cause?.code!=='CONTENT_CONFLICT')throw cause;
    const fresh=await store.read(workspaceId,accountId);const principal=fresh?.principals.find(row=>row.accountId===accountId&&row.id===actor.id&&row.emailVerified);
    if(!principal||principal.role!==actor.role||principal.role==='guest')missing();
    const latest=readPayload(fresh,workspaceId);const live=untrashedAccess(latest,fresh.principals,workspaceId,accountId,policy);
    if(!affected.every(row=>live(row.page.id).includes('manage')))missing();
    if(action!=='trash'&&parentId!==null){const current=policy(latest,fresh.principals,workspaceId),evaluate=createPageAccessEvaluator(current);const targetAccess=id=>evaluate({accountId,workspaceId,pageId:id}).capabilities;
      if(!targetAccess(parentId).includes('manage'))missing();ancestryVisible(latest,parentId,targetAccess);}
    conflict();
  }
}
function textBlocks(blocks){const parts=[];for(const block of blocks){if(typeof block.data?.text==='string')parts.push(block.data.text);if(block.type==='table'&&isSimpleTableData(block.data))parts.push(block.data.rows.map(row=>row.join(' ')).join('\n'));if(block.children)parts.push(textBlocks(block.children));}return parts.join('\n');}
const normalized=value=>value.normalize('NFKC').toLowerCase();
export function searchPages({query,payload,saved,workspaceId,visible,project}){
  if(typeof query!=='string'||!query.trim()||Array.from(query).length>100||/[\u0000-\u001f\u007f-\u009f]/.test(query))fail();
  const term=normalized(query.trim()),results=[];let truncated=false;
  for(const item of payload.pages){if(!visible.has(item.page.id))continue;const text=textBlocks(item.document.blocks);const lower=normalized(text);
    if(!normalized(item.page.title).includes(term)&&!lower.includes(term))continue;
    if(results.length===100){truncated=true;break;}const index=lower.indexOf(term);const chars=Array.from(lower);const start=index<0?0:Math.max(0,Array.from(lower.slice(0,index)).length-40);
    results.push({page:project(item),snippet:chars.slice(start,start+160).join('')});}
  return json({workspaceId,revision:saved.revision,results,truncated});
}
const encoder=new TextEncoder(),MAX_EXPORT=16*1024*1024;
const crcTable=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let bit=0;bit<8;bit++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let n=0xffffffff;for(const byte of bytes)n=crcTable[(n^byte)&255]^(n>>>8);return(n^0xffffffff)>>>0;}
function zipFiles(entries,stamp){
  let total=22;const files=entries.map(entry=>{const name=encoder.encode(entry.name);total+=76+2*name.length+entry.bytes.length;return{...entry,name,crc:crc32(entry.bytes)};});
  if(total>MAX_EXPORT||files.length>2100)fail('CONTENT_TOO_LARGE',413);const output=new Uint8Array(total),view=new DataView(output.buffer);
  const d=new Date(stamp),year=Math.min(2107,Math.max(1980,d.getUTCFullYear())),date=((year-1980)<<9)|((d.getUTCMonth()+1)<<5)|d.getUTCDate(),time=(d.getUTCHours()<<11)|(d.getUTCMinutes()<<5)|(d.getUTCSeconds()>>>1);let offset=0;
  for(const file of files){file.offset=offset;view.setUint32(offset,0x04034b50,true);view.setUint16(offset+4,20,true);view.setUint16(offset+6,0x800,true);view.setUint16(offset+10,time,true);view.setUint16(offset+12,date,true);
    view.setUint32(offset+14,file.crc,true);view.setUint32(offset+18,file.bytes.length,true);view.setUint32(offset+22,file.bytes.length,true);view.setUint16(offset+26,file.name.length,true);
    output.set(file.name,offset+30);output.set(file.bytes,offset+30+file.name.length);offset+=30+file.name.length+file.bytes.length;}
  const central=offset;for(const file of files){view.setUint32(offset,0x02014b50,true);view.setUint16(offset+4,20,true);view.setUint16(offset+6,20,true);view.setUint16(offset+8,0x800,true);view.setUint16(offset+12,time,true);view.setUint16(offset+14,date,true);
    view.setUint32(offset+16,file.crc,true);view.setUint32(offset+20,file.bytes.length,true);view.setUint32(offset+24,file.bytes.length,true);view.setUint16(offset+28,file.name.length,true);view.setUint32(offset+42,file.offset,true);output.set(file.name,offset+46);offset+=46+file.name.length;}
  view.setUint32(offset,0x06054b50,true);view.setUint16(offset+8,files.length,true);view.setUint16(offset+10,files.length,true);view.setUint32(offset+12,offset-central,true);view.setUint32(offset+16,central,true);return output;
}
const safeText=value=>String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
const markdown=value=>safeText(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~\-]/g,char=>'\\'+char);
function blockMarkdown(block,files){
  if(block.type==='table'&&isSimpleTableData(block.data))return simpleTableToMarkdown(block.data);
  const text=importSourceText(block)??(typeof block.data?.text==='string'?block.data.text:'');let result;
  if(block.type==='code')result=safeText(text).split(/\r?\n/).map(line=>'    '+line).join('\n');
  else{let offset=0;result='';for(const link of Array.isArray(block.data?.links)?block.data.links:[]){
    if(!Number.isSafeInteger(link.start)||!Number.isSafeInteger(link.end)||link.start<offset||link.end>text.length||text.slice(link.start,link.end)!==link.label)continue;
    result+=markdown(text.slice(offset,link.start));const target=link.attachmentId?null:files.get(link.pageId);
    let fragment='';try{if(typeof link.fragment==='string')fragment='#'+encodeURIComponent(link.fragment);}catch{}
    result+=target?'['+markdown(link.label)+']('+target+fragment+')':markdown(link.label);offset=link.end;}result+=markdown(text.slice(offset));}
  return result+(block.children?.length?'\n\n'+block.children.map(child=>blockMarkdown(child,files)).join('\n\n'):'');
}
function csv(value){let text=typeof value==='string'?value:value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);text=safeText(text);if(/^[\s\p{Cc}\p{Cf}=+\-@]/u.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';}
export function exportPages({format,payload,saved,workspaceId,visible,projectDocument,projectCollection,now}){
  if(!['json','zip'].includes(format))fail();const exportedAt=now();const warnings=['Attachment binaries are not included; attachments are a manifest only.','This readable-content export excludes permissions, sessions, receipts, trash and history and is not a full backup.'];
  const pages=payload.pages.filter(item=>visible.has(item.page.id)).map(item=>({page:{...item.page,parentId:visible.has(item.page.parentId)?item.page.parentId:null},document:projectDocument(item.document,visible)}));
  const collections=(payload.collections??[]).filter(entry=>visible.has(entry.pageId)).map(entry=>{
    const projected=typeof projectCollection==='function'?projectCollection(entry):null;
    const records=(projected?.records??entry.collection.records).filter(row=>visible.has(entry.recordPages.find(binding=>binding.recordId===row.id).pageId)).map(row=>{
      const binding=entry.recordPages.find(item=>item.recordId===row.id),values=structuredClone(row.values);
      if(!projected)for(const property of entry.collection.properties){if(property.type==='person')values[property.id]=null;if(property.type==='relation')values[property.id]=Array.isArray(values[property.id])?[]:null;}
      return{id:row.id,pageId:binding.pageId,...(typeof row.title==='string'?{title:row.title}:{}),values,sourceValues:binding.sourceValues,...(binding.sourceKind?{sourceKind:binding.sourceKind}:{})};
    });
    return{pageId:entry.pageId,collection:{...entry.collection,...(projected?{title:projected.title,properties:projected.properties}:{}),sourceHeaders:entry.sourceHeaders,sourceProperties:entry.sourceProperties??projected?.properties??entry.collection.properties,records}};
  });
  const attachments=(payload.attachments??[]).filter(row=>visible.has(row.pageId)).map(row=>({id:row.id,pageId:row.pageId,name:row.name,mediaType:row.mediaType,size:row.size}));
  const data={schemaVersion:1,kind:'yumunio-account-content-export',workspaceId,exportedAt,pages,collections,attachments,warnings};
  const bytes=encoder.encode(JSON.stringify(data));if(bytes.length>MAX_EXPORT)fail('CONTENT_TOO_LARGE',413);let output=bytes;
  if(format==='zip'){
    const entries=[{name:'content.json',bytes}],files=new Map(pages.map((item,index)=>[item.page.id,'page-'+String(index+1).padStart(4,'0')+'.md']));
    for(const item of pages)entries.push({name:files.get(item.page.id),bytes:encoder.encode('# '+markdown(item.page.title)+'\n\n'+item.document.blocks.map(block=>blockMarkdown(block,files)).join('\n\n')+'\n')});
    for(let index=0;index<collections.length;index++){const collection=collections[index].collection;entries.push({name:'collection-'+String(index+1).padStart(4,'0')+'.csv',bytes:encoder.encode([['Record ID',...collection.properties.map(property=>property.name)].map(csv).join(','),
      ...collection.records.map(row=>[row.id,...collection.properties.map(property=>row.values[property.id])].map(csv).join(','))].join('\r\n')+'\r\n')});}
    entries.push({name:'manifest.json',bytes:encoder.encode(JSON.stringify({kind:data.kind,exportedAt,files:entries.map(entry=>entry.name),attachments,warnings,csvFormulaProtection:'Values starting with spreadsheet formula markers or whitespace are prefixed with an apostrophe; content.json retains the originals.'}))});
    output=zipFiles(entries,exportedAt);
  }
  return new Response(output,{headers:{...headers,'Content-Type':format==='zip'?'application/zip':'application/json; charset=utf-8',
    'Content-Disposition':'attachment; filename="yumunio-account-'+exportedAt.slice(0,10)+'.'+format+'"','Content-Length':String(output.length)}});
}
