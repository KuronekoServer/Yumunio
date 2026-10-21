export const SIDEBAR_SIZE=Object.freeze({default:256,min:200,max:480,mainMin:360,step:8,dragThreshold:4});
export function sidebarSizeRange(viewport){
 const available=Number.isFinite(viewport)&&viewport>0?viewport:1024;
 return{min:SIDEBAR_SIZE.min,max:Math.max(SIDEBAR_SIZE.min,Math.min(SIDEBAR_SIZE.max,Math.floor(available-SIDEBAR_SIZE.mainMin)))};
}
export function clampSidebarSize(width,viewport){
 const {min,max}=sidebarSizeRange(viewport);
 return Math.round(Math.max(min,Math.min(max,Number.isFinite(width)?width:SIDEBAR_SIZE.default)));
}
export function readSidebarSize(storage,key){
 try{const text=storage.getItem(key);if(!text||text.length>128)return SIDEBAR_SIZE.default;const value=JSON.parse(text);return value?.version===1&&Number.isFinite(value.width)?clampSidebarSize(value.width):SIDEBAR_SIZE.default;}catch{return SIDEBAR_SIZE.default;}
}
export function writeSidebarSize(storage,key,width){
 try{storage.setItem(key,JSON.stringify({version:1,width:clampSidebarSize(width)}));}catch{}
}

/** React owns the shell. Pointer capture never moves, replaces or serializes editor nodes. */
export function createSidebarResize({handle,read,viewport,preview,commit,toggle,onActive=()=>{}}){
 const doc=handle.ownerDocument,win=doc.defaultView,life=new AbortController();let active=null,frame=null,blockedClick=false,composing=false;
 const listen=(target,type,fn)=>target.addEventListener(type,fn,{signal:life.signal});
 const clearFrame=()=>{if(frame!==null){win.cancelAnimationFrame(frame);frame=null;}};
 function finish(cancel=false){
  if(!active)return;const previous=active;active=null;clearFrame();blockedClick=cancel||previous.moved;
  try{preview(cancel?previous.initial:previous.next);if(!cancel&&previous.moved&&previous.next!==previous.initial)commit(previous.next);}
  finally{if(handle.hasPointerCapture?.(previous.pointerId))handle.releasePointerCapture(previous.pointerId);onActive(false);}
 }
 function move(event,immediate=false){
  if(!active||event.pointerId!==active.pointerId)return;
  event.preventDefault();const delta=event.clientX-active.x;active.moved||=Math.abs(delta)>=SIDEBAR_SIZE.dragThreshold;
  active.next=active.moved?clampSidebarSize(active.initial+delta,viewport()):active.initial;
  clearFrame();if(immediate)preview(active.next);else frame=win.requestAnimationFrame(()=>{frame=null;if(active)preview(active.next);});
 }
 listen(handle,'pointerdown',event=>{
  if(event.button!==0||event.isPrimary===false||event.isComposing||composing||active)return;
  event.preventDefault();event.stopPropagation();blockedClick=false;active={initial:read(),next:read(),x:event.clientX,pointerId:event.pointerId,moved:false};
  handle.focus({preventScroll:true});onActive(true);
  try{handle.setPointerCapture(event.pointerId);}catch{finish(true);}
 });
 listen(handle,'pointermove',event=>move(event));
 listen(handle,'pointerup',event=>{if(active?.pointerId!==event.pointerId)return;move(event,true);finish();});
 listen(handle,'pointercancel',event=>{if(active?.pointerId===event.pointerId)finish(true);});
 listen(handle,'lostpointercapture',event=>{if(active?.pointerId===event.pointerId)finish(true);});
 listen(handle,'click',event=>{event.preventDefault();event.stopPropagation();if(!blockedClick&&!composing)toggle();});
 listen(handle,'keydown',event=>{
  if(event.isComposing||event.keyCode===229||composing)return;
  if(event.key==='Escape'&&active){event.preventDefault();event.stopPropagation();finish(true);return;}
  if(active||event.altKey||event.ctrlKey||event.metaKey||!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();if(event.key==='Enter'){toggle();return;}
  const range=sidebarSizeRange(viewport()),next=clampSidebarSize(event.key==='Home'?range.min:event.key==='End'?range.max:read()+(event.key==='ArrowLeft'?-1:1)*SIDEBAR_SIZE.step*(event.shiftKey?4:1),viewport());
  if(next!==read()){preview(next);commit(next);}
 });
 listen(doc,'compositionstart',()=>{composing=true;finish(true);});listen(doc,'compositionend',()=>{composing=false;});
 listen(win,'blur',()=>finish(true));listen(win,'resize',()=>finish(true));listen(doc,'visibilitychange',()=>{if(doc.hidden)finish(true);});
 return{cancel:()=>finish(true),destroy(){finish(true);clearFrame();life.abort();},get active(){return!!active;}};
}
