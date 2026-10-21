const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function target(href){
 try{
  const url=new URL(href),workspaceId=url.searchParams.get('workspace');
  if(!['http:','https:'].includes(url.protocol)||!['/workspace','/workspace-detail'].includes(url.pathname)||!validId(workspaceId))return null;
  const pageId=url.searchParams.get('page'),viewId=url.searchParams.get('view'),query=new URLSearchParams();
  if(validId(pageId)){query.set('page',pageId);if(validId(viewId))query.set('view',viewId);}
  return{scope:url.origin+url.pathname+url.search,paths:['/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/bootstrap'+(query.size?'?'+query:'')]};
 }catch{return null;}
}

/** One navigation's in-flight reads, started alongside React hydration. Nothing
 * is persisted or reused for a later page, account or completed navigation. */
export function createInitialWorkspaceReads(href,{fetcher=globalThis.fetch,timeoutMs=10000}={}){
 const destination=target(href);if(!destination)return null;
 const entries=new Map(),controllers=new Set();let disposed=false;
 for(const path of destination.paths){
  const controller=new AbortController(),promise=Promise.resolve().then(()=>fetcher(path,{method:'GET',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)])}));
  controllers.add(controller);
  promise.catch(()=>{});entries.set(path,{controller,promise});
 }
 const timer=setTimeout(destroy,timeoutMs);
 function destroy(){if(disposed)return;disposed=true;clearTimeout(timer);for(const controller of controllers)controller.abort();controllers.clear();entries.clear();}
 return{
  startedAt:globalThis.performance?.now?.()??0,
  matches:value=>!disposed&&target(value)?.scope===destination.scope,
  take(path,{signal}={}){
   if(disposed)return null;const entry=entries.get(path);if(!entry)return null;entries.delete(path);if(!entries.size)clearTimeout(timer);
   const abort=()=>entry.controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
   return entry.promise.finally(()=>signal?.removeEventListener('abort',abort));
  },destroy
 };
}

const bridgeKey=Symbol.for('yumunio.initial-workspace-reads.v1'),fallbackBridge={prepared:null,claimedScope:null};
// The tiny startup bundle and the editor are independent module graphs. Share
// only this document's one-shot handoff; never use browser persistent storage.
function bridge(){const view=globalThis.window;if(!view)return fallbackBridge;if(!view[bridgeKey])Object.defineProperty(view,bridgeKey,{value:{prepared:null,claimedScope:null}});return view[bridgeKey];}
export function startInitialWorkspaceReads(href){
 const state=bridge();if(state.claimedScope===target(href)?.scope)return null;
 if(state.prepared?.matches(href))return state.prepared;
 state.prepared?.destroy();state.prepared=createInitialWorkspaceReads(href);return state.prepared;
}
export function claimInitialWorkspaceReads(href,signal){
 const state=bridge(),wasPrepared=state.prepared?.matches(href)===true,reads=wasPrepared?state.prepared:createInitialWorkspaceReads(href);
 if(reads)reads.wasPrepared=wasPrepared;
 if(state.prepared!==reads)state.prepared?.destroy();state.prepared=null;state.claimedScope=target(href)?.scope??null;
 signal?.addEventListener('abort',()=>reads?.destroy(),{once:true});if(signal?.aborted)reads?.destroy();return reads;
}
