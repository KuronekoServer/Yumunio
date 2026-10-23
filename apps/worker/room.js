import {authorizeRoomSocket,processRoomSocketFrame,readRoomSocketPeer,leaveRoomSocket,ROOM_SOCKET_LIMITS,roomSocketRoute} from '../../packages/identity/src/room-socket.js';
import {contentChangesPath} from '../../packages/identity/src/content-changes.js';
import {WorkspaceEvents} from './content-socket.js';
import {PeerRequestQueue} from './peer-queue.js';
import {createContentCache} from './content-cache.js';

/** Account services, instance setup and backup checks are heavy (better-auth,
 * D1 adapters and mail). Keep them out of the Worker's startup graph; the first
 * room or setup request loads them once per isolate. */
let workerModules=null;
function loadWorkerModules(){
  return workerModules??=Promise.all([
    import('../../packages/identity/src/setup.js'),
    import('../../packages/identity/src/setup-store.js'),
    import('@yumunio/backup'),
    import('./identity.js')
  ]).then(([setup,setupStore,backup,identity])=>({
    createInstanceSetup:setup.createInstanceSetup,
    createD1SetupStore:setupStore.createD1SetupStore,
    createD1RecoveryStore:backup.createD1RecoveryStore,
    assertRecoveryReady:backup.assertRecoveryReady,
    createWorkerAccountServices:identity.createWorkerAccountServices
  })).catch(error=>{workerModules=null;throw error;});
}

let collaboration=null;
function loadCollaboration(){
  return collaboration??=import('@yumunio/collaboration').then(({Y,toBase64,fromBase64})=>({Y,toBase64,fromBase64})).catch(error=>{collaboration=null;throw error;});
}

/** One hibernating Durable Object per workspace/page. Yjs updates are applied
 * and acknowledged after a durable journal write; the coalesced workspace row
 * is checkpointed to D1 every 250ms (or immediately on conflicts/changes). */
export class PageRoom{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.tail=Promise.resolve();this.states=new Map();this.queued=new Map();this.peerQueue=new PeerRequestQueue();this.contentCache=createContentCache();this.contentCache.setDeferred(true);this.journal=null;this.journalLoaded=false;this.flushTimer=null;this.replaying=false;this.needsReplay=false;this.events=new WorkspaceEvents(ctx,()=>this.services());}
 async services(){
  const {createInstanceSetup,createD1SetupStore,createD1RecoveryStore,assertRecoveryReady,createWorkerAccountServices}=await loadWorkerModules();
  const configured=!!(this.env.YUMUNIO_INSTANCE_SECRET||this.env.YUMUNIO_SETUP_TOKEN);
  const settings=configured?(this.setup??=createInstanceSetup({env:this.env,store:createD1SetupStore(this.env.DB),runtime:'worker'}).catch(error=>{this.setup=null;throw error;})).then(setup=>setup.load()):Promise.resolve({env:this.env,revision:0});
  // Independent live reads share a round trip; neither result is reused for
  // another frame, and a failed recovery check still prevents all dispatch.
  const[state]=await Promise.all([settings,assertRecoveryReady(createD1RecoveryStore(this.env.DB))]);
  if(configured&&!state.data)throw Error('Setup required.');const{env,revision}=state;
  // Reuse construction and schema readiness, never sessions or authorization.
  // Settings and recovery are reread above; content/session APIs still query
  // current membership, ACL, tickets and durable revision on every operation.
  const configuration=JSON.stringify(state.data??null);
  if(this.serviceCache?.revision!==revision||this.serviceCache.configuration!==configuration){const entry={revision,configuration,promise:null};entry.promise=createWorkerAccountServices(env,undefined,this.ctx,{contentStore:base=>this.contentCache.wrap(base)}).catch(error=>{if(this.serviceCache===entry)this.serviceCache=null;throw error;});this.serviceCache=entry;}
  const services=await this.serviceCache.promise;if(!services)throw Error('Accounts required.');return{services,origin:env.YUMUNIO_PUBLIC_ORIGIN};
 }
 async dispatch(request){return(await this.services()).services.content(request);}
 enqueue(task){const result=this.tail.catch(()=>{}).then(task);this.tail=result.catch(()=>{});return result;}
 enqueuePeer(socket,task){return this.peerQueue.run(socket,task);}
 async state(socket){const id=socket.deserializeAttachment()?.id;if(!id)return null;let state=this.states.get(id);if(!state){state=await this.ctx.storage.get('socket:'+id);if(state)this.states.set(id,state);}return state?{id,state}:null;}
 send(socket,message){const text=JSON.stringify(message);if(new TextEncoder().encode(text).length>ROOM_SOCKET_LIMITS.responseBytes){socket.close(1013);return;}try{socket.send(text);}catch{socket.close(1011);}}
 async notify(kind,source,runtime){
  runtime??=await this.services();
  for(const socket of this.ctx.getWebSockets())if(socket!==source){const peer=await this.state(socket);if(!peer?.state.joined)continue;try{const body=await readRoomSocketPeer(peer.state,request=>runtime.services.content(request));if(body)this.send(socket,kind==='content'&&peer.state.push?{type:'state',body}:{type:'changed',kind});else socket.close(4003);}catch{socket.close(1011);}}
 }
 journalHeaders(source){
  const allowed=new Set(['cookie','x-yumunio-expected-account','x-yumunio-room-ticket','x-yumunio-room-protocol','x-yumunio-room-features','x-yumunio-room-extensions','x-yumunio-room-content','x-yumunio-room-layout','x-yumunio-room-settings','x-yumunio-room-references']);
  const entries=typeof source?.entries==='function'?[...source.entries()]:Object.entries(source??{}),result={};
  for(const[key,value]of entries){const name=String(key).toLowerCase();if(allowed.has(name)&&typeof value==='string')result[name]=value;}
  return result;
 }
 async restoreJournal(){
  if(this.journalLoaded)return;
  this.journalLoaded=true;
  const stored=await this.ctx.storage.get('room-journal');
  if(stored?.update){this.journal=stored;this.needsReplay=true;}
 }
 async persistJournal(){
  if(this.journal?.update)await this.ctx.storage.put('room-journal',this.journal);
  else await this.ctx.storage.delete('room-journal');
 }
 /** Commit the previous journal before adding an update that would not fit. */
 async prepareJournalFor(update){
  if(!this.journal?.update||typeof update!=='string')return;
  if((this.journal.size??0)+update.length>100000)await this.flushJournalLocked();
 }
 /** Persist the merged Yjs update before the caller acknowledges it. */
 async recordUpdate(path,body,headers,context={}){
  const {Y,toBase64,fromBase64}=await loadCollaboration();
  const next=fromBase64(body.update);
  const previous=this.journal?.update?fromBase64(this.journal.update):null;
  const merged=previous?Y.mergeUpdates([previous,next]):next;
  const references={...(this.journal?.references??{}),...(body.references??{})};
  const encoded=toBase64(merged),size=encoded.length+JSON.stringify({references,headers:this.journalHeaders(headers)}).length;
  if(size>120000)throw Object.assign(new Error('Room journal too large.'),{code:'ROOM_TOO_LARGE',status:413});
  this.journal={path,pageId:path.split('/pages/')[1]?.split('/')[0]??'',epoch:body.epoch,ticket:body.ticket,headers:this.journalHeaders(headers),cookie:context.cookie??this.journal?.cookie??null,origin:context.origin??this.journal?.origin??null,update:encoded,references,size};
  await this.persistJournal();
  this.scheduleFlush();
 }
 scheduleFlush(){
  if(this.flushTimer)return;
  this.flushTimer=setTimeout(()=>{this.flushTimer=null;void this.enqueue(()=>this.flushJournalLocked()).catch(()=>{if(this.journal?.update)this.scheduleFlush();});},250);
  void this.ctx.storage.getAlarm().then(alarm=>{if(!alarm||alarm>Date.now()+250)return this.ctx.storage.setAlarm(Date.now()+250);}).catch(()=>{});
 }
 async flushJournalLocked(){
  if(!this.journal?.update)return;
  clearTimeout(this.flushTimer);this.flushTimer=null;
  try{
    const result=await this.contentCache.flush();
    if(result){this.journal=null;this.needsReplay=false;await this.persistJournal();return;}
  }catch(error){
    if(error?.code==='CONTENT_CONFLICT'||error?.status===409){await this.replayJournal();return;}
    if([401,403,404].includes(error?.status)||error?.code==='CONTENT_NOT_FOUND')await this.failJournal(error);
    throw error;
  }
  await this.replayJournal();
 }
 /** Another writer advanced D1 while updates were buffered. Reapply the merged
  * Yjs update through the normal room API against the fresh durable state. */
 async replayJournal(){
  const journal=this.journal;
  if(!journal?.update||this.replaying)return;
  this.replaying=true;
  const before=this.contentCache.snapshot();
  try{
    const {origin}=await this.services();
    this.contentCache.invalidate();
    this.contentCache.setDeferred(false);
    const response=await this.dispatch(new Request(origin+journal.path+'/updates',{method:'POST',headers:{...journal.headers,...(journal.cookie?{cookie:journal.cookie}:{}),...(journal.origin?{origin:journal.origin}:{}),'content-type':'application/json'},body:JSON.stringify({epoch:journal.epoch,ticket:journal.ticket,update:journal.update,...(Object.keys(journal.references??{}).length?{references:journal.references}:{})})}));
    if(!response.ok){const value=await response.json().catch(()=>({}));throw Object.assign(new Error(value?.error?.code??'ROOM_REPLAY_FAILED'),{code:value?.error?.code,status:response.status});}
    // The replay builds a new room from the fresh durable row. Restore the
    // monotonic sequence/document version the client already observed.
    await this.contentCache.bump(journal.pageId,before);
    this.journal=null;this.needsReplay=false;await this.persistJournal();
  }catch(error){
    await this.failJournal(error);
    throw error;
  }finally{
    this.replaying=false;
    this.contentCache.setDeferred(true);
  }
 }
 async failJournal(error){
  this.journal=null;this.needsReplay=false;
  try{await this.ctx.storage.delete('room-journal');}catch{}
  for(const socket of this.ctx.getWebSockets()){if(socket.deserializeAttachment()?.kind==='workspace')continue;try{socket.close(error?.status===403||error?.code==='ROOM_EPOCH_CHANGED'?4003:1011);}catch{}}
 }
 async fetch(request){
  if(request.url==='https://events.internal/changed'||contentChangesPath(new URL(request.url).pathname))return this.enqueue(()=>this.events.fetch(request));
  return this.enqueue(async()=>{
   try{
    // Only the Worker binding calls this URL; it is not a public route.
    if(request.url==='https://room.internal/changed'&&request.method==='POST'){
      await this.restoreJournal();
      if(this.journal?.update){try{await this.flushJournalLocked();}catch(error){await this.failJournal(error);}}
      else this.contentCache.invalidate();
      await this.notify('content');
      return new Response(null,{status:204});
    }
    const url=new URL(request.url);if(!roomSocketRoute(url.pathname)||url.search)return new Response(null,{status:404});
    if(!url.pathname.endsWith('/ws')){
     await this.restoreJournal();
     if(this.needsReplay){try{await this.replayJournal();}catch(error){return Response.json({error:{code:error?.code??'ROOM_UNAVAILABLE'}},{status:503});}}
     const isOpen=url.pathname.endsWith('/open')&&request.method==='POST',isUpdate=url.pathname.endsWith('/updates')&&request.method==='POST';
     const body=isOpen||isUpdate?await request.clone().json().catch(()=>null):null;
     const reset=isOpen&&body?.reset===true;
     if(isUpdate&&body)await this.prepareJournalFor(body.update);
     if(isOpen)this.contentCache.setDeferred(false);
     if(reset){await this.flushJournalLocked();this.journal=null;await this.persistJournal();}
     const retry=request.clone();
     let response;
     try{response=await this.dispatch(request);}
     catch(error){
       if(error?.code==='CONTENT_CACHE_STALE'){await this.flushJournalLocked();response=await this.dispatch(retry);}
       else{if(isOpen)this.contentCache.setDeferred(true);throw error;}
     }
     if(isOpen)this.contentCache.setDeferred(true);
     // A failed request may have mutated the cached payload before it threw.
     if(!response.ok)this.contentCache.invalidate();
     if(response.ok&&isUpdate&&body){
       try{await this.recordUpdate(url.pathname.slice(0,-'/updates'.length),body,request.headers,{cookie:request.headers.get('cookie')??undefined,origin:request.headers.get('origin')??undefined});}
       catch(error){await this.failJournal(error);return Response.json({error:{code:'ROOM_JOURNAL_UNAVAILABLE'}},{status:503});}
     }
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
  // Preserve each connection's frame order, then serialize only authoritative
  // dispatch. Concurrent editors avoid avoidable CAS retries; fan-out never
  // holds the dispatch queue. External writers still use the durable CAS.
  try{const notice=await this.enqueuePeer(socket,async()=>{
   const peer=await this.state(socket);if(!peer){socket.close(1008);return;}
   try{
    const runtime=await this.services();
    return await this.enqueue(async()=>{
     await this.restoreJournal();
     if(this.needsReplay){try{await this.replayJournal();}catch(error){socket.close(1011);return;}}
     let raw=null;try{raw=JSON.parse(message);}catch{}
     const isOpen=raw?.type==='request'&&raw.suffix===''&&raw.method==='POST';
     const isUpdate=raw?.type==='request'&&raw.suffix==='/updates'&&raw.method==='POST'&&raw.body;
     const reset=isOpen&&raw.body?.reset===true;
     if(isUpdate)await this.prepareJournalFor(raw.body.update);
     if(isOpen)this.contentCache.setDeferred(false);
     if(reset){await this.flushJournalLocked();this.journal=null;await this.persistJournal();}
     const original=peer.state;
     let result,retried=false;
     for(;;){
      try{result=await processRoomSocketFrame(peer.state,message,request=>runtime.services.content(request));break;}
      catch(error){
       if(error?.code==='CONTENT_CACHE_STALE'&&!retried){
        retried=true;
        await this.flushJournalLocked();
        const restored=structuredClone(original);
        this.states.set(peer.id,restored);peer.state=restored;
        continue;
       }
       if(isOpen)this.contentCache.setDeferred(true);
       throw error;
      }
     }
     if(isOpen)this.contentCache.setDeferred(true);
     // A rejected frame can leave the cached payload partially advanced.
     if(result.denied||result.reply?.status>=400)this.contentCache.invalidate();
     if(!result.denied&&result.reply?.status<400&&isUpdate){
      try{await this.recordUpdate(peer.state.path,raw.body,raw.headers??{},{cookie:peer.state.cookie,origin:peer.state.origin});}
      catch(error){await this.failJournal(error);socket.close(1011);return;}
     }
     await this.ctx.storage.put('socket:'+peer.id,peer.state);this.send(socket,result.reply);
     if(result.denied)socket.close(4003);else if(result.changed)return{kind:result.changed,runtime};
    });
   }
   catch(error){socket.close(error.code==='ROOM_SOCKET_PROTOCOL'?1008:1011);}
  });if(notice)await this.notify(notice.kind,socket,notice.runtime);}finally{const remaining=(this.queued.get(socket)??1)-1;if(remaining)this.queued.set(socket,remaining);else this.queued.delete(socket);}
 }
 async webSocketClose(socket,code=1000,reason=''){
  if(socket.deserializeAttachment()?.kind==='workspace'){try{socket.close(code,reason);}catch{}return;}
  try{socket.close(code,reason);}catch{}
  await this.enqueuePeer(socket,async()=>{const peer=await this.state(socket);if(!peer)return;this.states.delete(peer.id);await this.ctx.storage.delete('socket:'+peer.id);try{await leaveRoomSocket(peer.state,request=>this.dispatch(request));await this.notify('presence',socket);}catch{}});
  if(!this.ctx.getWebSockets().some(peer=>peer.deserializeAttachment()?.id))await this.enqueue(()=>this.flushJournalLocked()).catch(()=>{});
 }
 async webSocketError(socket){try{socket.close(1011);}catch{}await this.webSocketClose(socket);}
 async alarm(){
  if(this.ctx.getWebSockets().some(socket=>socket.deserializeAttachment()?.kind==='workspace'))return this.enqueue(()=>this.events.alarm());
  await this.enqueue(async()=>{
   await this.restoreJournal();
   if(this.journal?.update){try{await this.flushJournalLocked();}catch(error){await this.failJournal(error);}}
   const sockets=this.ctx.getWebSockets();for(const socket of sockets){const peer=await this.state(socket);if(!peer||!peer.state.joined&&Date.now()-peer.state.createdAt>10000)socket.close(1008);else if(Date.now()-peer.state.lastSeen>ROOM_SOCKET_LIMITS.idleMs)socket.close(1001);}if(sockets.length||this.journal?.update)await this.ctx.storage.setAlarm(Date.now()+30000);
  });
 }
}
