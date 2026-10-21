import {createInstanceSetup} from '../../packages/identity/src/setup.js';
import {createD1SetupStore} from '../../packages/identity/src/setup-store.js';
import {createD1RecoveryStore,assertRecoveryReady} from '@yumunio/backup';
import {createWorkerAccountServices} from './identity.js';
import {authorizeRoomSocket,processRoomSocketFrame,checkRoomSocketPeer,leaveRoomSocket,ROOM_SOCKET_LIMITS,roomSocketRoute} from '../../packages/identity/src/room-socket.js';
import {contentChangesPath} from '../../packages/identity/src/content-changes.js';
import {WorkspaceEvents} from './content-socket.js';

/** One hibernating Durable Object per workspace/page. Yjs state is committed to
 * D1 before acknowledgement. Only socket IDs are attached to connections. */
export class PageRoom{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.tail=Promise.resolve();this.states=new Map();this.queued=new Map();this.events=new WorkspaceEvents(ctx,()=>this.services());}
 async services(){
  let env=this.env;
  if(env.YUMUNIO_INSTANCE_SECRET||env.YUMUNIO_SETUP_TOKEN){const setup=await createInstanceSetup({env,store:createD1SetupStore(env.DB),runtime:'worker'}),state=await setup.load();if(!state.data)throw Error('Setup required.');env=state.env;}
  await assertRecoveryReady(createD1RecoveryStore(env.DB));
  const services=await createWorkerAccountServices(env,undefined,this.ctx);if(!services)throw Error('Accounts required.');return{services,origin:env.YUMUNIO_PUBLIC_ORIGIN};
 }
 async dispatch(request){return(await this.services()).services.content(request);}
 enqueue(task){const result=this.tail.catch(()=>{}).then(task);this.tail=result.catch(()=>{});return result;}
 async state(socket){const id=socket.deserializeAttachment()?.id;if(!id)return null;let state=this.states.get(id);if(!state){state=await this.ctx.storage.get('socket:'+id);if(state)this.states.set(id,state);}return state?{id,state}:null;}
 send(socket,message){const text=JSON.stringify(message);if(new TextEncoder().encode(text).length>ROOM_SOCKET_LIMITS.responseBytes){socket.close(1013);return;}try{socket.send(text);}catch{socket.close(1011);}}
 async notify(kind,source){
  for(const socket of this.ctx.getWebSockets())if(socket!==source){const peer=await this.state(socket);if(!peer?.state.joined)continue;try{if(await checkRoomSocketPeer(peer.state,request=>this.dispatch(request)))this.send(socket,{type:'changed',kind});else socket.close(4003);}catch{socket.close(1011);}}
 }
 async fetch(request){
  if(request.url==='https://events.internal/changed'||contentChangesPath(new URL(request.url).pathname))return this.enqueue(()=>this.events.fetch(request));
  return this.enqueue(async()=>{
   try{
    // Only the Worker binding calls this URL; it is not a public route.
    if(request.url==='https://room.internal/changed'&&request.method==='POST'){await this.notify('content');return new Response(null,{status:204});}
    const url=new URL(request.url);if(!roomSocketRoute(url.pathname)||url.search)return new Response(null,{status:404});
    if(!url.pathname.endsWith('/ws')){
     const response=await this.dispatch(request);
     if(response.ok&&request.method!=='GET'&&/\/(?:updates|presence|open)$/.test(url.pathname))await this.notify(url.pathname.endsWith('/presence')?'presence':'content');
     return response;
    }
    const {services,origin}=await this.services();
    const state=await authorizeRoomSocket(request,{origin,resolveSession:req=>services.identity.auth.api.getSession({headers:req.headers}),content:services.content});
    if(state instanceof Response)return state;
    const peers=this.ctx.getWebSockets();if(peers.length>=ROOM_SOCKET_LIMITS.peers)return new Response(null,{status:429});
    let accountPeers=0;for(const peer of peers)if((await this.state(peer))?.state.accountId===state.accountId)accountPeers++;
    if(accountPeers>=ROOM_SOCKET_LIMITS.accountPeers)return new Response(null,{status:429});
    const pair=new WebSocketPair(),[client,socket]=Object.values(pair),id=crypto.randomUUID();
    await this.ctx.storage.put('socket:'+id,state);this.states.set(id,state);this.ctx.acceptWebSocket(socket);socket.serializeAttachment({id});
    if(!await this.ctx.storage.getAlarm())await this.ctx.storage.setAlarm(Date.now()+30000);
    return new Response(null,{status:101,webSocket:client});
   }catch{return Response.json({error:{code:'ROOM_SOCKET_UNAVAILABLE'}},{status:503});}
  });
 }
 async webSocketMessage(socket,message){
  if(socket.deserializeAttachment()?.kind==='workspace'){
   const count=(this.queued.get(socket)??0)+1;if(typeof message!=='string'||message.length>128||count>8){socket.close(1008);return;}this.queued.set(socket,count);
   try{return await this.enqueue(()=>this.events.message(socket,message));}finally{const left=(this.queued.get(socket)??1)-1;if(left)this.queued.set(socket,left);else this.queued.delete(socket);}
  }
  const count=(this.queued.get(socket)??0)+1;if(count>ROOM_SOCKET_LIMITS.queued){socket.close(1008);return;}this.queued.set(socket,count);
  try{await this.enqueue(async()=>{
   const peer=await this.state(socket);if(!peer){socket.close(1008);return;}
   try{const result=await processRoomSocketFrame(peer.state,message,request=>this.dispatch(request));await this.ctx.storage.put('socket:'+peer.id,peer.state);this.send(socket,result.reply);if(result.denied)socket.close(4003);else if(result.changed)await this.notify(result.changed,socket);}
   catch(error){socket.close(error.code==='ROOM_SOCKET_PROTOCOL'?1008:1011);}
  });}finally{const remaining=(this.queued.get(socket)??1)-1;if(remaining)this.queued.set(socket,remaining);else this.queued.delete(socket);}
 }
 async webSocketClose(socket,code=1000,reason=''){
  if(socket.deserializeAttachment()?.kind==='workspace'){try{socket.close(code,reason);}catch{}return;}
  try{socket.close(code,reason);}catch{}
  await this.enqueue(async()=>{const peer=await this.state(socket);if(!peer)return;this.states.delete(peer.id);await this.ctx.storage.delete('socket:'+peer.id);try{await leaveRoomSocket(peer.state,request=>this.dispatch(request));await this.notify('presence',socket);}catch{}});
 }
 async webSocketError(socket){try{socket.close(1011);}catch{}await this.webSocketClose(socket);}
 async alarm(){
  if(this.ctx.getWebSockets().some(socket=>socket.deserializeAttachment()?.kind==='workspace'))return this.enqueue(()=>this.events.alarm());
  await this.enqueue(async()=>{const sockets=this.ctx.getWebSockets();for(const socket of sockets){const peer=await this.state(socket);if(!peer||!peer.state.joined&&Date.now()-peer.state.createdAt>10000)socket.close(1008);else if(Date.now()-peer.state.lastSeen>ROOM_SOCKET_LIMITS.idleMs)socket.close(1001);}if(sockets.length)await this.ctx.storage.setAlarm(Date.now()+30000);});
 }
}
