const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** Automatic, account-scoped invalidation, independent of the body editor DOM.
 * Reconnect always refreshes: an event is a hint, never a permission or cache. */
export function connectContentStream({workspaceId,accountId,view=globalThis.window,Socket=globalThis.WebSocket,onChange,onDenied=()=>{},signal,random=Math.random,readHead}){
 if(!validId(workspaceId)||!validId(accountId))throw new TypeError('INVALID_CONTENT_SCOPE');
 let socket=null,retry=null,heartbeat=null,deadline=null,fallback=null,checking=false,lastHead='',attempt=0,dead=false,denied=false;
 const lifetime=new AbortController();
 const clear=()=>{clearTimeout(retry);clearInterval(heartbeat);clearTimeout(deadline);clearInterval(fallback);retry=heartbeat=deadline=fallback=null;};
 function disconnect(){clear();const peer=socket;socket=null;try{peer?.close();}catch{}}
 function changed(){if(!dead&&!denied)onChange({workspaceId,accountId,remote:true});}
 const headRead=readHead??(async()=>{const response=await fetch(new URL('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/changes',view.location.origin),{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-Yumunio-Expected-Account':accountId},signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)])});if(!response.ok)throw Object.assign(Error('CONTENT_HEAD_UNAVAILABLE'),{status:response.status});return response.json();});
 function startFallback(){if(fallback||dead||denied)return;fallback=setInterval(async()=>{
  if(checking||dead||denied||view.navigator?.onLine===false||view.document?.hidden)return;checking=true;
  try{const head=await headRead();if(dead||denied)return;if(head?.workspaceId!==workspaceId||head.accountId!==accountId||!Number.isSafeInteger(head.revision)||typeof head.principals!=='string')throw Error('INVALID_CONTENT_HEAD');const stamp=JSON.stringify([head.revision,head.principals]);if(stamp!==lastHead){lastHead=stamp;changed();}}
  catch(error){if(!dead&&[401,403,404].includes(error.status)){denied=true;disconnect();onDenied();}}finally{checking=false;}
 },2000);}
 function schedule(){if(dead||denied||retry||view.navigator?.onLine===false)return;retry=setTimeout(()=>{retry=null;connect();},Math.min(15000,250*2**Math.min(attempt++,6))*(.8+random()*.4));}
 function connect(){
  if(dead||denied||socket||view.navigator?.onLine===false)return;
  startFallback();if(typeof Socket!=='function')return;
  const url=new URL('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/changes/ws',view.location.origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  let peer;try{peer=new Socket(url.href);socket=peer;}catch{schedule();return;}
  deadline=setTimeout(()=>peer.close(),15000);
  peer.addEventListener('message',event=>{
   if(dead||peer!==socket||typeof event.data!=='string'||event.data.length>128)return;
   let message;try{message=JSON.parse(event.data);}catch{peer.close();return;}
   if(!message||Object.keys(message).length!==1||!['ready','changed','pong','denied'].includes(message.type)){peer.close();return;}
   if(message.type==='denied'){denied=true;disconnect();onDenied();return;}
   if(message.type==='ready'){
    clearTimeout(deadline);clearInterval(fallback);fallback=null;attempt=0;heartbeat=setInterval(()=>{if(peer!==socket||peer.readyState!==1)return;try{peer.send('{"type":"ping"}');clearTimeout(deadline);deadline=setTimeout(()=>peer.close(),15000);}catch{peer.close();}},25000);changed();
   }else{clearTimeout(deadline);if(message.type==='changed')changed();}
  });
  peer.addEventListener('close',event=>{if(peer!==socket)return;socket=null;clear();if(event.code===4003){denied=true;onDenied();}else{startFallback();schedule();}});
  peer.addEventListener('error',()=>{try{peer.close();}catch{}});
 }
 const listen=(target,type,fn)=>target?.addEventListener(type,fn,{signal:lifetime.signal});
 listen(view,'offline',disconnect);listen(view,'online',()=>{connect();changed();});
 listen(view,'pagehide',disconnect);listen(view,'pageshow',()=>{connect();changed();});
 listen(view,'focus',()=>{connect();changed();});
 listen(view.document,'visibilitychange',()=>{if(!view.document.hidden){connect();changed();}});
 function destroy(){dead=true;disconnect();lifetime.abort();signal?.removeEventListener('abort',destroy);}
 signal?.addEventListener('abort',destroy,{once:true});if(!signal?.aborted)connect();else destroy();
 return{destroy,get connected(){return socket?.readyState===1;}};
}
