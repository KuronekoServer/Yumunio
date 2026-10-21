import {WebSocketServer} from 'ws';
import {authorizeRoomSocket,roomSocketScope,processRoomSocketFrame,readRoomSocketPeer,leaveRoomSocket,ROOM_SOCKET_LIMITS} from '../../packages/identity/src/room-socket.js';

/** One Node process owns its page sockets. Persistence and authorization remain
 * in the configured SQLite/Postgres/MySQL content service. */
export function attachRoomSockets(server,{acquire,assertReady=async()=>{}}){
 const rooms=new Map(),sockets=new WebSocketServer({noServer:true,clientTracking:false,perMessageDeflate:false,maxPayload:ROOM_SOCKET_LIMITS.messageBytes});
 let total=0;
 const use=async task=>{const runtime=await acquire();try{await assertReady();if(runtime.setupRequired||!runtime.identity?.content||!runtime.identity?.auth)throw Error('Room service unavailable.');return await task(runtime);}finally{runtime.release?.();}};
 const dispatch=request=>use(runtime=>runtime.identity.content(request));
 const send=(peer,message)=>{const text=JSON.stringify(message);if(peer.socket.readyState!==1)return;if(Buffer.byteLength(text)>ROOM_SOCKET_LIMITS.responseBytes||peer.socket.bufferedAmount>ROOM_SOCKET_LIMITS.responseBytes){peer.socket.close(1013);return;}peer.socket.send(text);};
 async function notify(room,kind,source){
  await Promise.all([...room.peers].filter(peer=>peer!==source&&peer.state.joined&&peer.socket.readyState===1).map(async peer=>{
   try{const body=await readRoomSocketPeer(peer.state,dispatch);if(body)send(peer,kind==='content'&&peer.state.push?{type:'state',body}:{type:'changed',kind});else peer.socket.close(4003);}catch{peer.socket.close(1011);}
  }));
 }
 function queueNotify(room,kind,source){
  room.notifications??=new Map();const sources=room.notifications.get(kind)??new Set();sources.add(source);room.notifications.set(kind,sources);
  if(room.notifyTimer)return;
  // A short burst shares one fresh authorized fan-out. The next writer need
  // not wait for an intermediate state to be read back for every peer.
  room.notifyTimer=setTimeout(()=>{room.notifyTimer=null;room.tail=room.tail.catch(()=>{}).then(async()=>{const pending=room.notifications;room.notifications=new Map();for(const[kind,sources]of pending)await notify(room,kind,sources.size===1?[...sources][0]:null);});},4);room.notifyTimer.unref();
 }
 server.on('upgrade',async(request,socket,head)=>{
  try{if(!roomSocketScope(new URL(request.url,'http://localhost').pathname))return;}catch{return;}
  socket.on('error',()=>{});let timer;
  const reject=status=>{clearTimeout(timer);if(!socket.destroyed)socket.end('HTTP/1.1 '+status+' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
  try{
   timer=setTimeout(()=>socket.destroy(),10000);timer.unref();
   const state=await use(async runtime=>{
    const origin=runtime.publicOrigin||'http://127.0.0.1:'+server.address().port;
    if(request.headers.host!==new URL(origin).host)return new Response(null,{status:403});
    return authorizeRoomSocket(new Request(new URL(request.url,origin),{headers:request.headers}),{origin,resolveSession:req=>runtime.identity.auth.api.getSession({headers:req.headers}),content:runtime.identity.content});
   });
   if(state instanceof Response)return reject(state.status);
   let room=rooms.get(state.path);if(!room){room={peers:new Set(),tail:Promise.resolve()};rooms.set(state.path,room);}
   if(total>=512||room.peers.size>=ROOM_SOCKET_LIMITS.peers||[...room.peers].filter(peer=>peer.state.accountId===state.accountId).length>=ROOM_SOCKET_LIMITS.accountPeers)return reject(429);
   clearTimeout(timer);if(socket.destroyed)return;
   sockets.handleUpgrade(request,socket,head,websocket=>{
    const peer={socket:websocket,state,queued:0};room.peers.add(peer);total++;
    websocket.on('error',()=>{});
    websocket.on('message',(bytes,binary)=>{
     if(binary||++peer.queued>ROOM_SOCKET_LIMITS.queued){websocket.close(1008);return;}
     room.tail=room.tail.catch(()=>{}).then(async()=>{
      if(websocket.readyState!==1)return;
      try{const result=await processRoomSocketFrame(state,bytes.toString('utf8'),dispatch);send(peer,result.reply);if(result.denied)websocket.close(4003);else if(result.changed)queueNotify(room,result.changed,peer);}
      catch(error){if(error.code!=='ROOM_SOCKET_PROTOCOL')console.warn('Room socket request failed:',error.code||error.name);websocket.close(error.code==='ROOM_SOCKET_PROTOCOL'?1008:1011);}
     }).finally(()=>peer.queued--);
    });
    websocket.on('close',()=>{
     room.peers.delete(peer);total--;if(!room.peers.size)rooms.delete(state.path);
     room.tail=room.tail.catch(()=>{}).then(async()=>{try{await leaveRoomSocket(state,dispatch);await notify(room,'presence',peer);}catch{}});
    });
   });
  }catch{reject(503);}
 });
 const timer=setInterval(()=>{for(const room of rooms.values())for(const peer of room.peers)if(Date.now()-peer.state.lastSeen>ROOM_SOCKET_LIMITS.idleMs)peer.socket.close(1001);else if(!peer.state.joined&&Date.now()-peer.state.createdAt>10000)peer.socket.close(1008);},10000);timer.unref();
 server.once('close',()=>{clearInterval(timer);for(const room of rooms.values()){clearTimeout(room.notifyTimer);for(const peer of room.peers)peer.socket.close(1001);}sockets.close();});
 return{async notify(path,kind='content'){const page=/^(\/api\/content\/workspaces\/[A-Za-z0-9._:-]+\/pages\/[A-Za-z0-9._:-]+)(?:\/|$)/.exec(path),scope=page&&roomSocketScope(page[1]+'/room'),room=scope&&rooms.get(scope.path);if(room)await notify(room,kind);}};
}
