// Process-local fanout; Node also checks the database head for other processes.
const listeners=new Set();
export function observeContentCommits(listener){listeners.add(listener);return()=>listeners.delete(listener);}
export function publishContentCommit(workspaceId){for(const listener of listeners)try{void Promise.resolve(listener(workspaceId)).catch(()=>{});}catch{}}

export const contentChangesPath=path=>/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/changes(?:\/ws)?$/.exec(path);
export async function readContentHead(store,workspaceId,accountId){
 const saved=await(typeof store.readHead==='function'?store.readHead(workspaceId,accountId):store.read(workspaceId,accountId));
 if(!saved)return null;
 const actor=saved.principals.find(row=>row.accountId===accountId);
 if(!actor?.emailVerified||!['owner','admin','member','guest'].includes(actor.role))return null;
 const bytes=new TextEncoder().encode(JSON.stringify(saved.principals));
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return{workspaceId,accountId,revision:saved.revision,principals:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
}

/** No page IDs, titles or content are sent on this invalidation channel. Reads
 * after a notification still enforce the current page and source database ACL. */
export async function authorizeContentSocket(request,{origin,resolveSession,content}){
 const url=new URL(request.url),match=contentChangesPath(url.pathname),cookie=request.headers.get('cookie')??'';
 const fail=status=>new Response(null,{status});
 if(!match||!url.pathname.endsWith('/ws')||url.origin!==origin||url.search||request.method!=='GET'||request.headers.get('origin')!==origin||request.headers.get('upgrade')?.toLowerCase()!=='websocket')return fail(403);
 if(!cookie||cookie.length>8192)return fail(401);
 const session=await resolveSession(request),accountId=session?.user?.id;
 if(!accountId||!session.user.emailVerified)return fail(401);
 const state={kind:'workspace',path:url.pathname.slice(0,-3),workspaceId:match[1],origin,cookie,accountId,lastSeen:Date.now()};
 const head=await checkContentSocket(state,content);if(!head)return fail(404);
 return{...state,head:JSON.stringify(head)};
}
export async function checkContentSocket(state,dispatch){
 const response=await dispatch(new Request(state.origin+state.path,{headers:{Cookie:state.cookie,'X-Yumunio-Expected-Account':state.accountId}}));
 if(response.ok)return response.json();
 if([401,403,404].includes(response.status))return null;
 throw new Error('CONTENT_SOCKET_RETRY');
}
export async function processContentSocketFrame(state,raw,dispatch){
 if(raw!=='{"type":"ping"}')throw new Error('CONTENT_SOCKET_PROTOCOL');
 const now=Date.now();if(now-state.lastSeen<1000)throw new Error('CONTENT_SOCKET_PROTOCOL');state.lastSeen=now;
 const head=await checkContentSocket(state,dispatch);
 if(!head)return null;
 const stamp=JSON.stringify(head),changed=stamp!==state.head;state.head=stamp;
 return{type:changed?'changed':'pong'};
}
