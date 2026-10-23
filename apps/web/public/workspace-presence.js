import {captureInlineSelection} from './inline-editor.js';
import {participantRoster,remoteCursorLayer} from './room-presence-ui.js';
export function createWorkspacePresence({app,getRoom,getCurrent,isComposing,isModalOpen,translate:t,onAuthorizationFailure,signal}){
 const lifetime=new AbortController(),listen=(target,type,handler,options={})=>target.addEventListener(type,handler,{...options,signal:lifetime.signal});
 signal?.addEventListener('abort',()=>lifetime.abort(),{once:true});
 let frame=0,painted='';
 function refresh(){
  const host=app.querySelector('[data-room-presence]'),active=getRoom();
  if(!host||!active||active.phase!=='ready'||document.hidden){app.querySelector('.room-cursor-layer')?.remove();host?.replaceChildren();painted='';return;}
  const participants=active.client?.presenceSnapshot()?.participants||[];
  const stamp=JSON.stringify([participants.map(item=>[item.id,item.displayName,item.self,item.cursor?.blockId??null,item.cursor?.start??null,item.cursor?.end??null,item.expiresAt])]);
  // Typing changes only the local caret; rebuilding the roster for every key
  // would repaint the whole presence UI without changing what is shown.
  if(stamp===painted&&app.querySelector('.room-cursor-layer')?.isConnected)return;
  app.querySelector('.room-cursor-layer')?.remove();
  painted=stamp;
  host.replaceChildren(participantRoster(document,participants,{label:t('roomPresence.label'),you:t('roomPresence.you'),waiting:active.presenceError?t(active.presenceError):t('roomPresence.waiting')}));
  if(!isModalOpen())app.append(remoteCursorLayer(document,app,participants,{pageId:getCurrent()?.page.id}));
 }
 function paint(){if(frame)return;frame=requestAnimationFrame(()=>{frame=0;painted='';refresh();});}
 function cursor(){
  const input=document.activeElement;
  if(isComposing()||isModalOpen()||!input?.classList.contains('inline-editor')||input.dataset.pageId!==getCurrent()?.page.id)return null;
  const selection=captureInlineSelection(input);if(!selection)return null;
  const range=document.getSelection(),bound=range?.rangeCount?range.getRangeAt(0):null;
  return{blockId:input.dataset.blockId,...selection,direction:bound&&!range.isCollapsed&&range.anchorNode===bound.endContainer&&range.anchorOffset===bound.endOffset?'backward':'forward'};
 }
 async function publish(active,{force=false,readOnly=false}={}){
  if(getRoom()!==active||active.phase!=='ready'||!active.client||active.presenceBusy||active.client.busy||document.hidden)return;
  const selection=active.client.pending?null:cursor(),key=JSON.stringify(selection),now=Date.now();
  const reading=readOnly||!force&&active.lastPresenceKey===key&&now-(active.lastPresenceAt||0)<9000;
  active.presenceBusy=true;
  try{const response=reading?await active.client.readPresence():await active.client.publishPresence({cursor:selection});if(getRoom()!==active)return;if(!response?.deferred){if(!reading){active.lastPresenceAt=Date.now();active.lastPresenceKey=key;}active.presenceError=null;}}
  catch(error){if(getRoom()!==active)return;if(active.client.status==='stale'||[401,403,404].includes(error.status)||error.code==='ROOM_EPOCH_CHANGED'){onAuthorizationFailure(active);return;}active.presenceError=error.code==='ROOM_PRESENCE_UNAVAILABLE'?'roomPresence.schema':'roomPresence.unavailable';}
  finally{active.presenceBusy=false;if(getRoom()===active)refresh();}
 }
 function changed(){const active=getRoom();if(!active||active.phase!=='ready')return;clearTimeout(active.presenceTimer);active.presenceTimer=setTimeout(()=>void publish(active),1500);if(frame)return;frame=requestAnimationFrame(()=>{frame=0;refresh();});}
 function leave(active){if(!active)return;clearTimeout(active.presenceTimer);void active.client?.leavePresence().catch(()=>{});app.querySelector('.room-cursor-layer')?.remove();app.querySelector('[data-room-presence]')?.replaceChildren();}
 listen(document,'selectionchange',changed);listen(window,'resize',paint);listen(app,'scroll',paint,{capture:true});
 listen(document,'visibilitychange',()=>{const active=getRoom();if(!active)return;if(document.hidden){leave(active);refresh();}else void publish(active,{force:true});});
 return{refresh,paint,publish,changed,leave,destroy(){lifetime.abort();cancelAnimationFrame(frame);}};
}
