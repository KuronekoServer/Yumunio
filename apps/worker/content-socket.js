import {authorizeContentSocket,checkContentSocket,processContentSocketFrame} from '../../packages/identity/src/content-changes.js';

/** Reuses the ROOMS binding with a distinct workspace key. Socket attachments
 * survive hibernation; neither content nor credentials are broadcast. */
export class WorkspaceEvents{
 constructor(ctx,services){this.ctx=ctx;this.services=services;}
 send(socket,value){try{socket.send(JSON.stringify(value));}catch{try{socket.close(1011);}catch{}}}
 async notify(){
  const sockets=this.ctx.getWebSockets();if(!sockets.length)return;
  const {services}=await this.services();
  await Promise.allSettled(sockets.map(async socket=>{const state=socket.deserializeAttachment();try{const head=await checkContentSocket(state,request=>services.content(request));if(!head){this.send(socket,{type:'denied'});socket.close(4003);return;}state.head=JSON.stringify(head);socket.serializeAttachment(state);this.send(socket,{type:'changed'});}catch{socket.close(1011);}}));
 }
 async fetch(request){
  if(request.url==='https://events.internal/changed'&&request.method==='POST'){await this.notify();return new Response(null,{status:204});}
  const {services,origin}=await this.services(),state=await authorizeContentSocket(request,{origin,resolveSession:req=>services.identity.auth.api.getSession({headers:req.headers}),content:services.content});
  if(state instanceof Response)return state;
  const sockets=this.ctx.getWebSockets();if(sockets.length>=128||sockets.filter(socket=>socket.deserializeAttachment()?.accountId===state.accountId).length>=8)return new Response(null,{status:429});
  const[client,socket]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(socket);socket.serializeAttachment(state);this.send(socket,{type:'ready'});
  if(!await this.ctx.storage.getAlarm())await this.ctx.storage.setAlarm(Date.now()+30000);
  return new Response(null,{status:101,webSocket:client});
 }
 async message(socket,message){try{const state=socket.deserializeAttachment(),{services}=await this.services(),reply=await processContentSocketFrame(state,message,request=>services.content(request));if(!reply){this.send(socket,{type:'denied'});socket.close(4003);return;}socket.serializeAttachment(state);this.send(socket,reply);}catch(error){socket.close(error.message==='CONTENT_SOCKET_RETRY'?1011:1008);}}
 async alarm(){
  // A heartbeat rechecks the current session and membership. Expired peers must
  // not remain subscribed during hibernation or silently regain access.
  for(const socket of this.ctx.getWebSockets())if(Date.now()-(socket.deserializeAttachment()?.lastSeen??0)>90000)socket.close(1001);
  if(this.ctx.getWebSockets().length)await this.ctx.storage.setAlarm(Date.now()+30000);
 }
}
