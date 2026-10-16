import {assertId,createPageAccessEvaluator} from '@yumunio/domain';
import {PRESENCE_LIMITS,validPresenceClientId,validatePresenceCursor} from '@yumunio/collaboration/presence';
import {RoomPresenceStoreError} from './room-presence-store.js';

const fail=(code='INVALID_ROOM_PRESENCE',status=400)=>{throw new RoomPresenceStoreError(code,status);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();};
const integer=value=>{if(!Number.isSafeInteger(value)||value<1||value>=Number.MAX_SAFE_INTEGER)fail();};
const json=value=>Response.json(value,{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
/** Called after the same live page/session/ticket authorization as normal room reads. */
export async function handleRoomPresence(ctx,{room,item,verify,fresh}){
 const {request,workspaceId,pageId,accountId,roomSecret,readJson,roomPresenceStore:store,session,now,policy}=ctx;
 if(!store)fail('ROOM_PRESENCE_UNAVAILABLE',503);
 let sessionId;try{sessionId=assertId(session?.session?.id);}catch{fail('CONTENT_NOT_FOUND',404);}
 if(!['GET','POST','DELETE'].includes(request.method))fail('METHOD_NOT_ALLOWED',405);
 const input=request.method==='GET'?null:await readJson(request),clientId=input?.clientId??request.headers.get('x-yumunio-presence-client');
 if(!validPresenceClientId(clientId))fail();
 if(input){exact(input,request.method==='POST'?['epoch','ticket','clientId','sequence','documentVersion','cursor']:['epoch','ticket','clientId']);if(input.epoch!==room.epoch)fail('ROOM_EPOCH_CHANGED',409);}
 const token=input?.ticket??request.headers.get('x-yumunio-room-ticket');await verify(token,room);
 let state=await fresh(),currentItem=state.payload.pages.find(value=>value.page.id===pageId),currentRoom=state.payload.rooms?.find(value=>value.pageId===pageId&&value.documentVersion===currentItem?.document.version);
 if(!currentRoom||currentRoom.epoch!==room.epoch)fail('ROOM_EPOCH_CHANGED',409);await verify(token,currentRoom,state.actor);
 const stamp=now(),scope={workspaceId,pageId,epoch:room.epoch,accountId,membershipId:state.actor.id,actorRole:state.actor.role,sessionId,expectedRevision:state.saved.revision,now:stamp};
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(roomSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['yumunio-presence-v1',workspaceId,pageId,room.epoch,accountId,state.actor.id,sessionId,clientId])))),selfId=Array.from(signature.subarray(0,16),byte=>byte.toString(16).padStart(2,'0')).join('');
 if(request.method==='DELETE'){await store.leave(scope,selfId);return json({left:true});}
 if(request.method==='POST'){
  integer(input.sequence);integer(input.documentVersion);
  const sameBasis=input.sequence===currentRoom.sequence&&input.documentVersion===currentRoom.documentVersion;
  const cursor=sameBasis?validatePresenceCursor(input.cursor,{title:currentItem.page.title,blocks:currentItem.document.blocks}):null;
  await store.publish(scope,{id:selfId,clientId,sequence:currentRoom.sequence,documentVersion:currentRoom.documentVersion,cursor,expiresAt:new Date(Date.parse(stamp)+PRESENCE_LIMITS.ttlMs).toISOString()});
 }
 // Re-read both the requester and all candidate principals before releasing names or offsets.
 state=await fresh();currentItem=state.payload.pages.find(value=>value.page.id===pageId);currentRoom=state.payload.rooms?.find(value=>value.pageId===pageId&&value.documentVersion===currentItem?.document.version);
 if(!currentRoom||currentRoom.epoch!==room.epoch)fail('ROOM_EPOCH_CHANGED',409);
 const serverTime=now(),latest={...scope,membershipId:state.actor.id,actorRole:state.actor.role,expectedRevision:state.saved.revision,now:serverTime},rows=await store.list(latest),evaluate=createPageAccessEvaluator(policy(state.payload,state.saved.principals,workspaceId));
 const participants=[];
 for(const row of rows){const person=state.saved.principals.find(value=>value.accountId===row.accountId&&value.id===row.membershipId&&value.role===row.actorRole&&value.emailVerified);if(!person||!evaluate({accountId:row.accountId,workspaceId,pageId}).capabilities.includes('read'))continue;
  let cursor=null;if(row.sequence===currentRoom.sequence&&row.documentVersion===currentRoom.documentVersion)try{cursor=validatePresenceCursor(row.cursor,{title:currentItem.page.title,blocks:currentItem.document.blocks});}catch{}
  const name=typeof person.displayName==='string'?person.displayName.replace(/[\u0000-\u001f\u007f]/g,'').trim():'',displayName=!name||name===person.accountId?'Participant':Array.from(name).slice(0,240).join('');participants.push({id:row.id,displayName,self:row.id===selfId,cursor,expiresAt:row.expiresAt});
 }
 return json({pageId,epoch:room.epoch,sequence:currentRoom.sequence,documentVersion:currentRoom.documentVersion,selfId,ttlMs:PRESENCE_LIMITS.ttlMs,serverTime,participants});
}
