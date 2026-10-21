const unavailable=()=>Object.assign(new Error('Room connection interrupted.'),{code:'ROOM_SOCKET_CLOSED',status:0});
/** Multiplexes the existing Yjs protocol over a page-scoped WebSocket. Mutations
 * are never replayed by this transport; the Yjs client reconciles after reconnect. */
export class RoomSocketTransport{
 constructor({url,headers,onChange=()=>{},onState=null,onReady=()=>{},onDisconnect=()=>{},WebSocket:Socket=globalThis.WebSocket,timeoutMs=10000}){
  const address=new URL(url);if(!['ws:','wss:'].includes(address.protocol)||address.search||address.hash||typeof headers!=='function'||typeof Socket!=='function')throw new TypeError('INVALID_ROOM_SOCKET');
  Object.assign(this,{url,headers,onChange,onState,onReady,onDisconnect,Socket,timeoutMs});this.pending=new Map();this.socket=null;this.opening=null;this.ready=false;this.closed=false;this.nextId=0;this.attempt=0;this.retry=null;
 }
 connect(){
  if(this.closed)return Promise.reject(unavailable());if(this.ready)return Promise.resolve();if(this.opening)return this.opening;
  this.opening=new Promise((resolve,reject)=>{
   let settled=false;const settle=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
   const socket=new this.Socket(this.url);this.socket=socket;this.nextId=0;
   const timer=setTimeout(()=>{settle(unavailable());socket.close();},this.timeoutMs);
   socket.addEventListener('open',()=>{if(this.socket!==socket||this.closed)return;void this.rpc({suffix:'',method:'GET',headers:this.headers()},socket).then(value=>{if(this.socket!==socket||this.closed)return;this.ready=true;this.attempt=0;settle();if(typeof this.onState==='function')this.onState(value);this.onReady();},error=>{settle(error);if([401,403,404,409].includes(error.status))this.closed=true;socket.close();});});
   socket.addEventListener('message',event=>{
    if(this.socket!==socket||this.closed)return;
    let message;try{if(typeof event.data!=='string'||event.data.length>400000)throw Error();message=JSON.parse(event.data);}catch{socket.close(1002);return;}
    if(message?.type==='changed'&&['content','presence'].includes(message.kind)){this.onChange(message.kind);return;}
    if(message?.type==='state'&&typeof this.onState==='function'&&message.body&&typeof message.body==='object'){this.onState(message.body);return;}
    const pending=message?.type==='response'&&this.pending.get(message.id);if(!pending||!Number.isInteger(message.status)||message.status<200||message.status>599||!message.body||typeof message.body!=='object'){socket.close(1002);return;}
    this.pending.delete(message.id);clearTimeout(pending.timer);
    if(message.status>=400)pending.reject(Object.assign(new Error('Room request rejected.'),{code:message.body.error?.code??'ROOM_SOCKET_REJECTED',status:message.status}));else pending.resolve(message.body);
   });
   socket.addEventListener('error',()=>settle(unavailable()));
   socket.addEventListener('close',event=>{
    if(this.socket!==socket)return;this.ready=false;this.socket=null;this.opening=null;settle(unavailable());
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(unavailable());}this.pending.clear();
    if([1002,1008,4001,4003].includes(event.code))this.closed=true;
    this.onDisconnect({permanent:this.closed,code:event.code});
    if(!this.closed){clearTimeout(this.retry);this.retry=setTimeout(()=>{this.retry=null;void this.connect().catch(()=>{});},Math.min(10000,250*2**Math.min(this.attempt++,6)));}
   });
  });return this.opening;
 }
 rpc(call,socket=this.socket){
  if(this.closed||!socket||socket.readyState!==1||this.pending.size>=8)return Promise.reject(unavailable());
  const id=++this.nextId,message=JSON.stringify({type:'request',id,...call});
  if(new TextEncoder().encode(message).length>100000)return Promise.reject(Object.assign(new Error('Room message exceeds its limit.'),{code:'ROOM_TOO_LARGE',status:413}));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(unavailable());socket.close();},this.timeoutMs);this.pending.set(id,{resolve,reject,timer});try{socket.send(message);}catch{clearTimeout(timer);this.pending.delete(id);reject(unavailable());socket.close();}});
 }
 async request({path,method,headers,body}){
  const base=new URL(this.url).pathname.slice(0,-3);if(!path.startsWith(base)||!['','/updates','/renew','/presence'].includes(path.slice(base.length)))throw new TypeError('INVALID_ROOM_SOCKET_SCOPE');
  await this.connect();return this.rpc({suffix:path.slice(base.length),method,headers,...(body===undefined?{}:{body})});
 }
 close(){this.closed=true;this.ready=false;clearTimeout(this.retry);this.retry=null;this.socket?.close(1000);}
}
