import { assertId, assertPlainObject, assertTitle,validateBlocks,createPageAccessEvaluator, validateDocument, validatePage } from '@yumunio/domain';
import { Y,CollaborationError, ROOM_LIMITS, createRoomDocument, encodeRoomState, applyRoomUpdate, roomDiff, toBase64, fromBase64,
 structuredRoomFeatures,createStructuredRoom,applyStructuredUpdate,structuredRoomDiff,STRUCTURED_ROOM_FEATURES } from '@yumunio/collaboration';
import { rememberPage, trimHistory } from './content-history.js';
import {preparePageLinkBlocks} from './content-page-links.js';
import {prepareSyncedBlocks} from './content-synced.js';
import {prepareMentionBlocks} from './content-mentions.js';
import {handleRoomPresence} from './content-room-presence.js';
import {RoomPresenceStoreError} from './room-presence-store.js';

const encoder = new TextEncoder();
const TICKET_TTL_MS=15*60*1000,TICKET_RENEW_GRACE_MS=5*60*1000;
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json = (value,status=200) => Response.json(value,{status,headers});
export class ContentRoomError extends Error { constructor(code,status=400) {super(code);this.code=code;this.status=status;} }
const fail = (code='INVALID_ROOM_REQUEST',status=400) => {throw new ContentRoomError(code,status);};
const missing = () => fail('CONTENT_NOT_FOUND',404);
const exact = (value,keys) => {assertPlainObject(value);if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();};
const revision = value => {if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail();};
const baseline = item => ({title:item.page.title,blocks:item.document.blocks});
const same = (left,right) => left.length===right.length && left.every((value,index)=>value===right[index]);

export function invalidateRooms(payload,pageIds) {
  if (!payload.rooms) return;
  const ids = new Set(pageIds); payload.rooms = payload.rooms.filter(room=>!ids.has(room.pageId));
}
export function validateRooms(payload,pages) {
  if (!Object.hasOwn(payload,'rooms'))return;
  if (!Array.isArray(payload.rooms)||payload.rooms.length>8)fail();
  const ids=new Set();
  for(const room of payload.rooms) {
    exact(room,['pageId','epoch','sequence','documentVersion','state','checkpointed',...(room.protocol===2?['protocol','seed',...(Object.hasOwn(room,'features')?['features']:[])]:[])]);assertId(room.pageId);assertId(room.epoch);
    if(Object.hasOwn(room,'features')&&(!Array.isArray(room.features)||!room.features.length||new Set(room.features).size!==room.features.length||room.features.some(feature=>!STRUCTURED_ROOM_FEATURES.includes(feature))))fail();
    if(room.protocol===2){exact(room.seed,['title','blocks']);assertTitle(room.seed.title);validateBlocks(room.seed.blocks);if(encoder.encode(JSON.stringify(room.seed)).length>ROOM_LIMITS.documentBytes)fail();}
    if(ids.has(room.pageId)||!pages.has(room.pageId)||!Number.isSafeInteger(room.sequence)||room.sequence<1||room.sequence>=Number.MAX_SAFE_INTEGER||
      !Number.isSafeInteger(room.documentVersion)||room.documentVersion<1||room.documentVersion>pages.get(room.pageId).document.version||typeof room.checkpointed!=='boolean')fail();
    fromBase64(room.state);ids.add(room.pageId);
  }
}

async function signingKey(secret) {
  if(typeof secret!=='string'||secret.length<32||secret.length>4096)fail('ROOM_UNAVAILABLE',503);
  return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
const base64url = bytes => toBase64(bytes).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
function unurl(value) {
  if(typeof value!=='string'||!value.length||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))fail();
  return fromBase64(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4),2048);
}
async function ticketFor({secret,accountId,actor,workspaceId,pageId,room,editable,stamp}) {
  const expiresAt=stamp+TICKET_TTL_MS;
  const value={version:room.protocol===2?2:1,accountId,membershipId:actor.id,workspaceId,pageId,epoch:room.epoch,editable,expiresAt};
  const data=base64url(encoder.encode(JSON.stringify(value)));
  const signature=new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(secret),encoder.encode('yumunio-room-v1.'+data)));
  return {ticket:data+'.'+base64url(signature),expiresAt:new Date(expiresAt).toISOString()};
}
async function verifyTicket(token,{secret,accountId,actor,workspaceId,pageId,room,stamp,write,renew=false}) {
  if(typeof token!=='string'||token.length>2500)missing();
  const parts=token.split('.');if(parts.length!==2)missing();
  let value;
  try {
    if(!await crypto.subtle.verify('HMAC',await signingKey(secret),unurl(parts[1]),encoder.encode('yumunio-room-v1.'+parts[0])))missing();
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unurl(parts[0])));
    exact(value,['version','accountId','membershipId','workspaceId','pageId','epoch','editable','expiresAt']);
  } catch {missing();}
  if(value.version!==(room.protocol===2?2:1)||value.accountId!==accountId||value.membershipId!==actor.id||value.workspaceId!==workspaceId||value.pageId!==pageId||
    typeof value.editable!=='boolean'||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=stamp-(renew?TICKET_RENEW_GRACE_MS:0)||value.expiresAt>stamp+TICKET_TTL_MS)missing();
  if(value.epoch!==room.epoch)fail('ROOM_EPOCH_CHANGED',409);
  if(write&&!value.editable)missing();
  return value;
}
function currentRoom(payload,item) {return payload.rooms?.find(room=>room.pageId===item.page.id&&room.documentVersion===item.document.version);}
const requireFeatures=(request,room)=>{if(room?.features?.includes('check-state')&&request.headers.get('x-yumunio-room-features')!=='check-state'||room?.features?.includes('block-transforms')&&request.headers.get('x-yumunio-room-extensions')!=='block-transforms'||room?.features?.includes('content-blocks')&&request.headers.get('x-yumunio-room-content')!=='content-blocks'||room?.features?.includes('block-layout')&&request.headers.get('x-yumunio-room-layout')!=='block-layout')fail('ROOM_PROTOCOL_UNSUPPORTED',409);};
const diff=(room,item,vector=null)=>{const result=room.protocol===2?structuredRoomDiff(fromBase64(room.state),room.seed,vector,{expectedDraft:baseline(item)}):roomDiff(fromBase64(room.state),baseline(item),vector);if(result.features?.some(feature=>!room.features?.includes(feature)))fail('ROOM_UNAVAILABLE',503);return result;};

/** Called only after central exact-Origin, expected-account, verified-session and fresh membership guards. */
export async function handleRoom(ctx) {
  const {request,action,pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload,now,createId,roomSecret}=ctx;
  if(!roomSecret)fail('ROOM_UNAVAILABLE',503);
  const item=payload.pages.find(row=>row.page.id===pageId);
  if(!item||!access(pageId).includes('read'))missing();
  const expected=request.headers.get('x-yumunio-expected-account');if(expected!==accountId)missing();
  const editable=access(pageId).includes('editBody'),stamp=Date.parse(now());if(!Number.isFinite(stamp))fail('ROOM_UNAVAILABLE',503);
  let room=currentRoom(payload,item);
  // Corrupt persisted CRDT state is a server availability error, not a client validation error.
  if(room)try{diff(room,item);}catch{fail('ROOM_UNAVAILABLE',503);}
  requireFeatures(request,room);
  if(action==='open') {
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
    const data=await readJson(request);exact(data,['expectedRevision',...(Object.hasOwn(data,'protocol')?['protocol']:[]),...(Object.hasOwn(data,'reset')?['reset']:[])]);revision(data.expectedRevision);
    if(Object.hasOwn(data,'protocol')&&data.protocol!==2||Object.hasOwn(data,'reset')&&(data.reset!==true||data.protocol!==2))fail('ROOM_PROTOCOL_UNSUPPORTED',409);
    const protocol=data.protocol??1;if(room?.protocol===2&&protocol!==2)fail('ROOM_PROTOCOL_UNSUPPORTED',409);
    if(protocol===2&&(room?.protocol!==2||data.reset===true)){if(!editable)missing();if(data.expectedRevision!==saved.revision)fail('CONTENT_CONFLICT',409);room=null;}
    if(!room) {
      if(!editable)missing();if(data.expectedRevision!==saved.revision)fail('CONTENT_CONFLICT',409);
      if(item.document.version>=Number.MAX_SAFE_INTEGER)fail('CONTENT_CONFLICT',409);
      const doc=protocol===2?createStructuredRoom(baseline(item)):createRoomDocument(baseline(item));let state,features=[];try{if(protocol===2)features=structuredRoomFeatures(doc,baseline(item));requireFeatures(request,{features});state=protocol===2?Y.encodeStateAsUpdate(doc):encodeRoomState(doc);}finally{doc.destroy();}
      room={pageId,epoch:assertId(createId()),sequence:1,documentVersion:item.document.version,state:toBase64(state),checkpointed:false,...(protocol===2?{protocol:2,seed:baseline(item),...(features.length?{features}:{})}:{})};
      invalidateRooms(payload,[pageId]);payload.rooms??=[];
      if(payload.rooms.length>=8)fail('ROOM_CAPACITY',409);payload.rooms.push(room);
      const captured=validatePayload(payload,workspaceId);
      try {
        const written=await store.write(workspaceId,accountId,{expectedRevision:saved.revision,payload:captured,actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});
        const sync=diff(room,item);
        return json({revision:written.revision,pageId,epoch:room.epoch,sequence:room.sequence,documentVersion:room.documentVersion,editable,
          ...await ticketFor({secret:roomSecret,accountId,actor,workspaceId,pageId,room,editable,stamp}),update:toBase64(sync.update),stateVector:toBase64(sync.stateVector),...openingMetadata()},201);
      }catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;await freshAccess(ctx,'editBody');fail('CONTENT_CONFLICT',409);}
    }
    const sync=diff(room,item);
    return json({revision:saved.revision,pageId,epoch:room.epoch,sequence:room.sequence,documentVersion:room.documentVersion,editable,
      ...await ticketFor({secret:roomSecret,accountId,actor,workspaceId,pageId,room,editable,stamp}),update:toBase64(sync.update),stateVector:toBase64(sync.stateVector),...openingMetadata()});
  }
  if(!room)fail('ROOM_EPOCH_CHANGED',409);
  if(room.protocol===2&&request.headers.get('x-yumunio-room-protocol')!=='2')fail('ROOM_PROTOCOL_UNSUPPORTED',409);
  if(action==='presence')return handleRoomPresence(ctx,{room,item,
    verify:(token,current,principal=actor)=>{requireFeatures(request,current);return verifyTicket(token,{secret:roomSecret,accountId,actor:principal,workspaceId,pageId,room:current,stamp:Date.parse(now()),write:false});},
    fresh:async()=>{const fresh=await freshAccess(ctx,'read',actor.id);requireFeatures(request,currentRoomFor(fresh.payload,fresh.payload.pages.find(row=>row.page.id===pageId)));return fresh;}});
  if(action==='renew') {
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
    const data=await readJson(request);exact(data,['epoch','ticket']);assertId(data.epoch);
    const prior=await verifyTicket(data.ticket,{secret:roomSecret,accountId,actor,workspaceId,pageId,room,stamp,write:false,renew:true});
    if(data.epoch!==room.epoch)fail('ROOM_EPOCH_CHANGED',409);
    const fresh=await freshAccess(ctx,prior.editable?'editBody':'read',prior.membershipId),nextItem=fresh.payload.pages.find(row=>row.page.id===pageId),nextRoom=currentRoomFor(fresh.payload,nextItem);
    if(!nextRoom||nextRoom.epoch!==data.epoch)fail('ROOM_EPOCH_CHANGED',409);
    requireFeatures(request,nextRoom);
    try{diff(nextRoom,nextItem);}catch{fail('ROOM_UNAVAILABLE',503);}
    const renewedStamp=Date.parse(now());if(!Number.isFinite(renewedStamp))fail('ROOM_UNAVAILABLE',503);
    await verifyTicket(data.ticket,{secret:roomSecret,accountId,actor:fresh.actor,workspaceId,pageId,room:nextRoom,stamp:renewedStamp,write:false,renew:true});
    return json({revision:fresh.saved.revision,pageId,epoch:nextRoom.epoch,sequence:nextRoom.sequence,documentVersion:nextRoom.documentVersion,editable:prior.editable,
      ...await ticketFor({secret:roomSecret,accountId,actor:fresh.actor,workspaceId,pageId,room:nextRoom,editable:prior.editable,stamp:renewedStamp})});
  }
  if(action==='state') {
    if(request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
    const scoped=await verifyTicket(request.headers.get('x-yumunio-room-ticket'),{secret:roomSecret,accountId,actor,workspaceId,pageId,room,stamp,write:false});
    const vector=request.headers.has('x-yumunio-state-vector')?fromBase64(request.headers.get('x-yumunio-state-vector'),1024):null;
    const sync=diff(room,item,vector);
    return json({revision:saved.revision,pageId,epoch:room.epoch,sequence:room.sequence,documentVersion:room.documentVersion,editable:editable&&scoped.editable,update:toBase64(sync.update),stateVector:toBase64(sync.stateVector),...(room.protocol===2?{protocol:2}:{})});
  }
  if(action!=='updates'||request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
  if(!editable)missing();
  const data=await readJson(request);exact(data,['epoch','ticket','update']);assertId(data.epoch);
  const update=fromBase64(data.update,ROOM_LIMITS.updateBytes);
  const initialMembership=actor.id;
  let current={saved,payload,actor,item,room};
  for(let attempt=0;attempt<4;attempt++) {
    const {saved:currentSaved,payload:currentPayload,actor:currentActor,item:currentItem,room:currentRoom}=current;
    requireFeatures(request,currentRoom);
    if(data.epoch!==currentRoom.epoch)fail('ROOM_EPOCH_CHANGED',409);
    await verifyTicket(data.ticket,{secret:roomSecret,accountId,actor:currentActor,workspaceId,pageId,room:currentRoom,stamp:Date.parse(now()),write:true});
    const previous=fromBase64(currentRoom.state),applied=currentRoom.protocol===2?applyStructuredUpdate(previous,update,currentRoom.seed,{expectedDraft:baseline(currentItem)}):applyRoomUpdate(previous,update,baseline(currentItem));
    if(applied.features?.length){requireFeatures(request,{features:applied.features});currentRoom.features=STRUCTURED_ROOM_FEATURES.filter(feature=>currentRoom.features?.includes(feature)||applied.features.includes(feature));}
    if(same(previous,applied.state))return response(currentSaved.revision,currentRoom,applied);
    if(currentRoom.sequence>=Number.MAX_SAFE_INTEGER-1||currentItem.document.version>=Number.MAX_SAFE_INTEGER-1)fail('ROOM_CAPACITY',409);
    const stamp=now(),changed=JSON.stringify(applied.draft)!==JSON.stringify(baseline(currentItem));let guards=[];
    if(changed&&applied.features?.includes('content-blocks')){const evaluate=createPageAccessEvaluator(policy(currentPayload,currentSaved.principals,workspaceId)),referenceAccess=id=>evaluate({accountId,workspaceId,pageId:id}).capabilities;
      const checked=prepareMentionBlocks({blocks:preparePageLinkBlocks({blocks:prepareSyncedBlocks({blocks:applied.draft.blocks,previousBlocks:currentItem.document.blocks,access:referenceAccess,pageId}),previousBlocks:currentItem.document.blocks,access:referenceAccess,attachments:currentPayload.attachments??[],pageId}),previousBlocks:currentItem.document.blocks,access:referenceAccess,principals:currentSaved.principals,personCanRead:(accountId,pageId)=>evaluate({accountId,workspaceId,pageId}).capabilities.includes('read'),pageId});guards=checked.guards;
    }
    if(changed) {
      if(!currentRoom.checkpointed){rememberPage(currentPayload,currentItem,{actorId:accountId,now,createId});currentRoom.checkpointed=true;}
      currentItem.page=validatePage({...currentItem.page,title:applied.draft.title,updatedAt:stamp});
      currentItem.document=validateDocument({...currentItem.document,blocks:applied.draft.blocks,version:currentItem.document.version+1,updatedAt:stamp});
    }
    currentRoom.documentVersion=currentItem.document.version;currentRoom.sequence++;currentRoom.state=toBase64(applied.state);
    trimHistory(currentPayload);
    const captured=validatePayload(currentPayload,workspaceId);
    try {
      const written=await store.write(workspaceId,accountId,{expectedRevision:currentSaved.revision,payload:captured,actorMembershipId:currentActor.id,actorRole:currentActor.role,guardMemberships:guards});
      return response(written.revision,currentRoom,applied);
    }catch(error) {
      if(error?.code!=='CONTENT_CONFLICT')throw error;
      const fresh=await freshAccess(ctx,'editBody',initialMembership),nextItem=fresh.payload.pages.find(row=>row.page.id===pageId),nextRoom=currentRoomFor(fresh.payload,nextItem);
      if(!nextRoom||nextRoom.epoch!==data.epoch)fail('ROOM_EPOCH_CHANGED',409);
      try{diff(nextRoom,nextItem);}catch{fail('ROOM_UNAVAILABLE',503);}
      current={...fresh,item:nextItem,room:nextRoom};
    }
  }
  fail('CONTENT_CONFLICT',409);
  function response(revision,room,applied) {return json({revision,pageId,epoch:room.epoch,sequence:room.sequence,documentVersion:room.documentVersion,editable:true,update:toBase64(applied.state),stateVector:toBase64(applied.stateVector),acknowledged:true,...(room.protocol===2?{protocol:2}:{})});}
  function openingMetadata(){if(room.protocol!==2)return{};if(typeof ctx.projectDocument!=='function')fail('ROOM_UNAVAILABLE',503);const visible=new Set(payload.pages.filter(row=>access(row.page.id).includes('read')).map(row=>row.page.id));return{protocol:2,supportedFeatures:STRUCTURED_ROOM_FEATURES.filter(feature=>(feature!=='block-transforms'||request.headers.get('x-yumunio-room-extensions')==='block-transforms')&&(feature!=='content-blocks'||request.headers.get('x-yumunio-room-content')==='content-blocks')&&(feature!=='block-layout'||request.headers.get('x-yumunio-room-layout')==='block-layout')),seed:{title:room.seed.title,blocks:ctx.projectDocument({...item.document,blocks:room.seed.blocks},visible).blocks}};}
}
const currentRoomFor=currentRoom;
async function freshAccess(ctx,capability,membershipId=ctx.actor.id) {
  const {store,workspaceId,accountId,pageId,readPayload,policy}=ctx;
  const saved=await store.read(workspaceId,accountId);
  const actor=saved?.principals.find(row=>row.accountId===accountId&&row.id===membershipId&&row.emailVerified);
  if(!actor)missing();const payload=readPayload(saved,workspaceId);
  if(!createPageAccessEvaluator(policy(payload,saved.principals,workspaceId))({accountId,workspaceId,pageId}).capabilities.includes(capability))missing();
  return {saved,payload,actor};
}

export const isRoomError = error => error instanceof ContentRoomError||error instanceof CollaborationError||error instanceof RoomPresenceStoreError;
