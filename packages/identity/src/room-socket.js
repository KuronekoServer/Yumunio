/** Shared, page-scoped WebSocket protocol. The existing content API remains the
 * authority for sessions, membership, room epochs and every Yjs update. */
export const ROOM_SOCKET_LIMITS=Object.freeze({messageBytes:100000,responseBytes:400000,peers:64,accountPeers:8,queued:8,idleMs:90000});
const route=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/room(?:\/ws)?$/;
const allowedHeaders=new Set(['x-yumunio-expected-account','x-yumunio-room-protocol','x-yumunio-room-features','x-yumunio-room-extensions','x-yumunio-room-ticket','x-yumunio-state-vector','x-yumunio-presence-client']);
const fail=()=>{throw Object.assign(new Error('Invalid room socket request.'),{code:'ROOM_SOCKET_PROTOCOL'});};
export function roomSocketScope(path){const match=route.exec(path);return match?{workspaceId:match[1],pageId:match[2],path:'/api/content/workspaces/'+match[1]+'/pages/'+match[2]+'/room'}:null;}
export function roomSocketRoute(path){return /^\/api\/content\/workspaces\/[A-Za-z0-9._:-]+\/pages\/[A-Za-z0-9._:-]+\/room(?:\/(?:ws|open|updates|renew|presence))?$/.test(path);}
const errorResponse=(code,status)=>Response.json({error:{code}},{status,headers:{'Cache-Control':'no-store'}});
export async function authorizeRoomSocket(request,{origin,resolveSession,content}){
 const url=new URL(request.url),scope=roomSocketScope(url.pathname);
 if(!scope||!url.pathname.endsWith('/ws')||url.origin!==origin||url.search||url.hash||request.method!=='GET'||request.headers.get('origin')!==origin||request.headers.get('upgrade')?.toLowerCase()!=='websocket')return errorResponse('ROOM_SOCKET_ORIGIN',403);
 const cookie=request.headers.get('cookie')??'';
 if(!cookie||cookie.length>8192)return errorResponse('CONTENT_NOT_FOUND',401);
 const session=await resolveSession(request),accountId=session?.user?.id;
 if(!accountId||session.user.emailVerified!==true)return errorResponse('CONTENT_NOT_FOUND',401);
 const headers={Cookie:cookie,Origin:origin,'X-Yumunio-Expected-Account':accountId};
 const visible=await content(new Request(origin+scope.path.slice(0,-5),{headers}));
 if(!visible.ok)return errorResponse('CONTENT_NOT_FOUND',visible.status);
 return{...scope,origin,accountId,cookie,createdAt:Date.now(),lastSeen:Date.now(),lastId:0,joined:null,rateAt:Date.now(),rate:0,presence:null};
}
export function roomSocketRequest(state,{suffix='',method='GET',headers={},body}){
 return new Request(state.origin+state.path+suffix,{method,headers:{Cookie:state.cookie,Origin:state.origin,...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
export async function processRoomSocketFrame(state,raw,dispatch){
 if(typeof raw!=='string'||raw.length>ROOM_SOCKET_LIMITS.messageBytes||new TextEncoder().encode(raw).length>ROOM_SOCKET_LIMITS.messageBytes)fail();
 let message;try{message=JSON.parse(raw);}catch{fail();}
 if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).some(key=>!['type','id','suffix','method','headers','body'].includes(key))||message.type!=='request'||!Number.isSafeInteger(message.id)||message.id<=state.lastId||!['','/updates','/renew','/presence'].includes(message.suffix)||!['GET','POST','DELETE'].includes(message.method)||!message.headers||typeof message.headers!=='object'||Array.isArray(message.headers))fail();
 const {id,suffix,method,body}=message;
 if(suffix===''&&method!=='GET'||['/updates','/renew'].includes(suffix)&&method!=='POST'||(method==='GET')!==!Object.hasOwn(message,'body'))fail();
 const headers={};
 for(const[key,value]of Object.entries(message.headers)){const name=key.toLowerCase();if(!allowedHeaders.has(name)||Object.hasOwn(headers,name)||typeof value!=='string'||value.length>4096||/[\r\n\0]/.test(value))fail();headers[name]=value;}
 if(headers['x-yumunio-expected-account']!==state.accountId||headers['x-yumunio-room-protocol']!=='2'||!state.joined&&suffix!=='')fail();
 const now=Date.now();if(now-state.rateAt>=10000){state.rate=0;state.rateAt=now;}if(++state.rate>250)fail();
 state.lastId=id;state.lastSeen=now;
 const response=await dispatch(roomSocketRequest(state,{suffix,method,headers,body}));
 const value=await response.json();
 if(response.ok){
  if(suffix===''||suffix==='/renew')state.joined={...headers,'x-yumunio-room-ticket':value.ticket??headers['x-yumunio-room-ticket']};
  if(state.joined)delete state.joined['x-yumunio-state-vector'];
  if(suffix==='/presence'&&method==='POST')state.presence=body;
  if(suffix==='/presence'&&method==='DELETE')state.presence=null;
 }
 return{reply:{type:'response',id,status:response.status,body:value},changed:response.ok&&(suffix==='/updates'||suffix==='/presence'&&method!=='GET')?(suffix==='/updates'?'content':'presence'):null,denied:[401,403,404].includes(response.status)||['ROOM_EPOCH_CHANGED','ROOM_PROTOCOL_UNSUPPORTED','ROOM_NOT_EDITABLE'].includes(value.error?.code)};
}
/** No content or activity notification is sent to a peer without a fresh check. */
export async function checkRoomSocketPeer(state,dispatch){
 if(!state.joined||Date.now()-state.lastSeen>ROOM_SOCKET_LIMITS.idleMs)return false;
 const response=await dispatch(roomSocketRequest(state,{headers:state.joined}));
 return response.ok;
}
export async function leaveRoomSocket(state,dispatch){
 if(!state.presence)return;
 await dispatch(roomSocketRequest(state,{suffix:'/presence',method:'DELETE',headers:state.joined,body:{epoch:state.presence.epoch,ticket:state.joined['x-yumunio-room-ticket'],clientId:state.presence.clientId}}));
 state.presence=null;
}
