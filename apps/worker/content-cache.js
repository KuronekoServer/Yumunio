import {markValidatedPayload} from '../../packages/identity/src/content-cache-marker.js';

const stale=()=>Object.assign(new Error('Content cache needs a refresh.'),{code:'CONTENT_CACHE_STALE'});

/** One Durable Object's view of a workspace payload.
 *
 * Every page-room request is routed to the page's Durable Object, so this cache
 * is only shared by the serialized room frames of that page. A cheap head read
 * still runs for every request: it preserves immediate membership/ACL
 * revocation and detects external writes by revision.
 *
 * In deferred mode a room update is applied to the cached payload and
 * acknowledged without rewriting the whole workspace row. The Durable Object
 * persists a small Yjs journal before acknowledging and calls `flush()` to
 * commit the coalesced payload. A head revision mismatch raises
 * CONTENT_CACHE_STALE so the caller can flush/replay before serving a read. */
export function createContentCache(){
  const state={workspaceId:null,revision:null,saved:null,base:null,deferred:false,dirty:false,lastWrite:null};
  const invalidate=()=>{state.workspaceId=null;state.revision=null;state.saved=null;state.dirty=false;state.lastWrite=null;};
  function wrap(base){
    if(!base||typeof base.read!=='function'||typeof base.write!=='function')throw new TypeError('INVALID_CONTENT_STORE');
    state.base=base;
    return new Proxy(base,{
      get(target,key,receiver){
        if(key==='read')return async (workspaceId,accountId,options={})=>{
          // The head query is account-scoped: a non-member or a downgraded
          // account never reaches the shared payload. Only the payload (which
          // contains no per-account projection) is reused across accounts.
          const head=await target.read(workspaceId,accountId,{headOnly:true});
          if(!head||options.headOnly)return head;
          if(state.dirty&&state.workspaceId===workspaceId&&state.revision!==head.revision)throw stale();
          if(state.workspaceId===workspaceId&&state.revision===head.revision&&state.saved)
            return {revision:head.revision,principals:head.principals,payload:state.saved.payload};
          const saved=await target.read(workspaceId,accountId);
          if(saved){state.workspaceId=workspaceId;state.revision=saved.revision;state.saved=saved;state.dirty=false;}
          else if(state.workspaceId===workspaceId)invalidate();
          return saved;
        };
        if(key==='write')return async (workspaceId,accountId,options)=>{
          if(state.deferred){
            if(state.workspaceId!==workspaceId||state.revision!==options.expectedRevision)throw Object.assign(new Error('Content changed.'),{code:'CONTENT_CONFLICT',status:409});
            markValidatedPayload(options.payload);
            state.saved={revision:state.revision,payload:options.payload};
            state.dirty=true;
            state.lastWrite={workspaceId,accountId,actorMembershipId:options.actorMembershipId,actorRole:options.actorRole,guardMemberships:options.guardMemberships};
            return {revision:state.revision};
          }
          try{
            const result=await target.write(workspaceId,accountId,options);
            if(options?.payload){
              markValidatedPayload(options.payload);
              state.workspaceId=workspaceId;state.revision=result.revision;state.saved={revision:result.revision,payload:options.payload};state.dirty=false;
              state.lastWrite={workspaceId,accountId,actorMembershipId:options.actorMembershipId,actorRole:options.actorRole,guardMemberships:options.guardMemberships};
            }
            return result;
          }catch(error){if(state.workspaceId===workspaceId)invalidate();throw error;}
        };
        const value=Reflect.get(target,key,receiver);
        return typeof value==='function'?value.bind(target):value;
      }
    });
  }
  /** Commits the coalesced payload once. Throws CONTENT_CONFLICT when another
   * writer advanced the durable revision; the caller then replays its journal. */
  async function flush(){
    if(!state.dirty||!state.saved||!state.lastWrite)return null;
    const {workspaceId,accountId,actorMembershipId,actorRole,guardMemberships}=state.lastWrite;
    const result=await state.base.write(workspaceId,accountId,{expectedRevision:state.revision,payload:state.saved.payload,actorMembershipId,actorRole,guardMemberships});
    state.revision=result.revision;state.saved={revision:result.revision,payload:state.saved.payload};state.dirty=false;
    return result;
  }
  /** The buffered payload is needed to restore monotonic room counters after a
   * conflict replay re-applies updates through the normal content API. */
  function snapshot(){
    return state.saved&&state.lastWrite?{payload:state.saved.payload,revision:state.revision,lastWrite:state.lastWrite}:null;
  }
  async function bump(pageId,before){
    if(!before?.payload)return null;
    const meta=state.lastWrite??before.lastWrite;
    if(!meta)return null;
    const roomBefore=(before.payload.rooms??[]).find(room=>room.pageId===pageId);
    if(!roomBefore)return null;
    for(let attempt=0;attempt<3;attempt++){
      const fresh=await state.base.read(meta.workspaceId,meta.accountId);
      if(!fresh)throw Object.assign(new Error('Content unavailable.'),{code:'CONTENT_NOT_FOUND',status:404});
      const next=structuredClone(fresh.payload);
      const room=(next.rooms??[]).find(row=>row.pageId===pageId),page=next.pages.find(row=>row.page.id===pageId);
      if(!room||!page||room.epoch!==roomBefore.epoch)throw Object.assign(new Error('Room changed.'),{code:'ROOM_EPOCH_CHANGED',status:409});
      room.sequence=Math.max(room.sequence,roomBefore.sequence);
      room.documentVersion=Math.max(room.documentVersion,roomBefore.documentVersion);
      page.document.version=room.documentVersion;
      try{
        const result=await state.base.write(meta.workspaceId,meta.accountId,{expectedRevision:fresh.revision,payload:next,actorMembershipId:meta.actorMembershipId,actorRole:meta.actorRole,guardMemberships:meta.guardMemberships});
        markValidatedPayload(next);
        state.revision=result.revision;state.saved={revision:result.revision,payload:next};state.dirty=false;state.lastWrite=meta;
        return result;
      }catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;}
    }
    throw Object.assign(new Error('Room counters could not be restored.'),{code:'CONTENT_CONFLICT',status:409});
  }
  return{wrap,invalidate,flush,snapshot,bump,setDeferred:value=>{state.deferred=!!value;},get revision(){return state.revision;},get dirty(){return state.dirty;}};
}

