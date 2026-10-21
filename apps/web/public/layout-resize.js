/** Pointer capture and keyboard resizing only. Never owns or replaces editor content. */
export function createLayoutResize({handle,read,canStart,project,preview,commit,reset,onStart=()=>{},onActive=()=>{}}){
 const doc=handle.ownerDocument,win=doc.defaultView,life=new AbortController();let active=null,frame=null,destroyed=false;
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const valid=()=>!destroyed&&handle.isConnected&&canStart()&&(!active||same(read(),active.initial));
 const paint=value=>preview(value);
 const clearFrame=()=>{if(frame!==null){win.cancelAnimationFrame(frame);frame=null;}};
 function finish(cancel=false){
  if(!active)return;const previous=active;active=null;clearFrame();handle.classList.remove('is-resizing');
  try{if(!cancel&&valid()&&same(read(),previous.initial)&&!same(previous.next,previous.initial))commit(previous.next,previous.initial);}
  finally{if(handle.hasPointerCapture?.(previous.pointerId))handle.releasePointerCapture(previous.pointerId);paint(read());onActive(false);}
 }
 const listen=(target,type,fn,options={})=>target.addEventListener(type,fn,{...options,signal:life.signal});
 listen(handle,'pointerdown',event=>{
  if(event.button!==0||event.isPrimary===false||event.isComposing||active||!valid())return;
  const initial=structuredClone(read()),geometry=project({initial,phase:'start',x:event.clientX});if(!geometry)return;
  event.preventDefault();event.stopPropagation();onStart();handle.focus({preventScroll:true});active={initial,next:initial,geometry,pointerId:event.pointerId};
  handle.setPointerCapture(event.pointerId);handle.classList.add('is-resizing');onActive(true);
 });
 function move(event,immediate=false){
  if(!active||event.pointerId!==active.pointerId)return;if(!valid()){finish(true);return;}
  event.preventDefault();const next=project({initial:active.initial,geometry:active.geometry,phase:'move',x:event.clientX});if(!next)return;
  active.next=next;clearFrame();if(immediate)paint(next);else frame=win.requestAnimationFrame(()=>{frame=null;if(active)paint(active.next);});
 }
 listen(handle,'pointermove',event=>move(event));
 listen(handle,'pointerup',event=>{if(active?.pointerId!==event.pointerId)return;move(event,true);finish();});
 listen(handle,'pointercancel',()=>finish(true));listen(handle,'lostpointercapture',()=>finish(true));
 listen(handle,'keydown',event=>{
  if(event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'&&active){event.preventDefault();event.stopPropagation();finish(true);return;}
  if(active||!valid()||!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;
  const initial=structuredClone(read()),next=event.key==='Enter'?reset?.(initial):project({initial,phase:'key',key:event.key,shift:event.shiftKey});if(!next)return;
  event.preventDefault();event.stopPropagation();if(!same(next,initial)){onStart();commit(next,initial);paint(read());}
 });
 listen(handle,'dblclick',event=>{if(active||!valid()||!reset)return;event.preventDefault();const initial=structuredClone(read()),next=reset(initial);if(!same(initial,next)){onStart();commit(next,initial);paint(read());}});
 listen(win,'blur',()=>finish(true));listen(win,'resize',()=>finish(true));listen(doc,'visibilitychange',()=>{if(doc.hidden)finish(true);});
 paint(read());return{get active(){return!!active;},cancel:()=>finish(true),destroy(){finish(true);destroyed=true;clearFrame();life.abort();}};
}
