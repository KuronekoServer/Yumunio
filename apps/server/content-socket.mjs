import {WebSocketServer} from 'ws';
import {authorizeContentSocket,checkContentSocket,contentChangesPath,processContentSocketFrame,observeContentCommits} from '../../packages/identity/src/content-changes.js';

/** Sockets are process-local; a lightweight head check also observes writes made
 * by another Node replica sharing SQLite/Postgres/MySQL. No payload polling. */
export function attachContentSockets(server,{acquire,assertReady=async()=>{}}){
 const peers=new Set(),sockets=new WebSocketServer({noServer:true,clientTracking:false,perMessageDeflate:false,maxPayload:128});
 const use=async task=>{const runtime=await acquire();try{await assertReady();if(runtime.setupRequired||!runtime.identity?.content||!runtime.identity?.auth)throw Error('Content unavailable');return await task(runtime);}finally{runtime.release?.();}};
 const dispatch=request=>use(runtime=>runtime.identity.content(request));
 const send=(peer,value)=>{if(peer.socket.readyState===1){if(peer.socket.bufferedAmount>4096)peer.socket.close(1013);else peer.socket.send(JSON.stringify(value));}};
 async function check(peer,force=false){
  if(peer.checking){peer.again||=force;return;}
  peer.checking=true;
  try{
   const head=await checkContentSocket(peer.state,dispatch);
   if(!head){send(peer,{type:'denied'});peer.socket.close(4003);return;}
   const stamp=JSON.stringify(head);if(force||stamp!==peer.state.head){peer.state.head=stamp;send(peer,{type:'changed'});}
  }catch{peer.socket.close(1011);}finally{peer.checking=false;if(peer.again){peer.again=false;void check(peer,true);}}
 }
 const unsubscribe=observeContentCommits(workspaceId=>Promise.allSettled([...peers].filter(peer=>peer.state.workspaceId===workspaceId).map(peer=>check(peer,true))));
 server.on('upgrade',async(request,socket,head)=>{
  let url;try{url=new URL(request.url,'http://localhost');}catch{return;}
  if(!contentChangesPath(url.pathname))return;
  socket.on('error',()=>{});const timer=setTimeout(()=>socket.destroy(),10000);timer.unref();
  const reject=status=>{clearTimeout(timer);if(!socket.destroyed)socket.end('HTTP/1.1 '+status+' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
  try{
   const state=await use(runtime=>{const origin=runtime.publicOrigin||'http://127.0.0.1:'+server.address().port;if(request.headers.host!==new URL(origin).host)return new Response(null,{status:403});return authorizeContentSocket(new Request(new URL(request.url,origin),{headers:request.headers}),{origin,resolveSession:req=>runtime.identity.auth.api.getSession({headers:req.headers}),content:runtime.identity.content});});
   if(state instanceof Response)return reject(state.status);
   if(peers.size>=512||[...peers].filter(peer=>peer.state.workspaceId===state.workspaceId&&peer.state.accountId===state.accountId).length>=8)return reject(429);
   clearTimeout(timer);if(socket.destroyed)return;
   sockets.handleUpgrade(request,socket,head,websocket=>{
    const peer={socket:websocket,state,checking:false,again:false,receiving:false};peers.add(peer);send(peer,{type:'ready'});
    websocket.on('error',()=>{});websocket.on('close',()=>peers.delete(peer));
    websocket.on('message',async(bytes,binary)=>{
     if(binary||peer.receiving){websocket.close(1008);return;}peer.receiving=true;
     try{const reply=await processContentSocketFrame(state,bytes.toString(),dispatch);if(reply)send(peer,reply);else{send(peer,{type:'denied'});websocket.close(4003);}}catch(error){websocket.close(error.message==='CONTENT_SOCKET_RETRY'?1011:1008);}finally{peer.receiving=false;}
    });
   });
  }catch{reject(503);}
 });
 const timer=setInterval(()=>{for(const peer of peers)if(Date.now()-peer.state.lastSeen>90000)peer.socket.close(1001);else void check(peer);},1000);timer.unref();
 server.once('close',()=>{clearInterval(timer);unsubscribe();for(const peer of peers)peer.socket.close(1001);sockets.close();});
 return{close(){clearInterval(timer);unsubscribe();for(const peer of peers)peer.socket.close(1001);sockets.close();}};
}
