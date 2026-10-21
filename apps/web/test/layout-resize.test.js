import test from 'node:test';
import assert from 'node:assert/strict';
import {createLayoutResize} from '../public/layout-resize.js';
function fixture(){
 const win=new EventTarget(),doc=new EventTarget(),handle=new EventTarget(),frames=new Map(),classes=new Set();let serial=0,value=50,allowed=true,captured=null,starts=0;const previews=[],commits=[],activity=[];
 Object.assign(win,{requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:id=>frames.delete(id)});Object.assign(doc,{defaultView:win,hidden:false});Object.assign(handle,{ownerDocument:doc,isConnected:true,classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)},focus(){},setPointerCapture:id=>captured=id,hasPointerCapture:id=>captured===id,releasePointerCapture:()=>captured=null});
 const controller=createLayoutResize({handle,read:()=>value,canStart:()=>allowed,onStart:()=>starts++,onActive:active=>activity.push(active),project:({initial,phase,x,geometry,key,shift})=>phase==='start'?{x}:phase==='move'?Math.max(15,Math.min(100,initial+x-geometry.x)):key==='Home'?15:key==='End'?100:initial+(key==='ArrowLeft'?-1:1)*(shift?5:1),preview:v=>previews.push(v),commit:(next,initial)=>{commits.push([next,initial]);value=next;},reset:()=>100});
 const send=(type,properties={},target=handle)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{button:0,isPrimary:true,pointerId:1,clientX:100,...properties});target.dispatchEvent(event);return event;};
 return{controller,send,handle,doc,win,previews,commits,activity,classes,frames,flush(){for(const [key,fn]of frames){frames.delete(key);fn();}},get value(){return value;},get starts(){return starts;},setValue:v=>value=v,disable:()=>allowed=false};
}
test('pointer movement only previews, release commits the last coordinates once, and capture is cleaned up',()=>{
 const f=fixture();f.send('pointerdown');f.send('pointermove',{clientX:120});f.flush();assert.equal(f.value,50);assert.equal(f.previews.at(-1),70);assert.equal(f.commits.length,0);f.send('pointerup',{clientX:130});f.send('pointerup',{clientX:140});assert.deepEqual(f.commits,[[80,50]]);assert.deepEqual(f.activity,[true,false]);assert.equal(f.starts,1);assert.equal(f.controller.active,false);assert.equal(f.classes.size,0);f.controller.destroy();
});
test('Escape, pointer cancellation, lost capture, blur and page teardown never save a preview',()=>{
 for(const cancel of [f=>f.send('keydown',{key:'Escape'}),f=>f.send('pointercancel'),f=>f.send('lostpointercapture'),f=>f.send('blur',{},f.win),f=>f.controller.destroy()]){const f=fixture();f.send('pointerdown');f.send('pointermove',{clientX:125});f.flush();cancel(f);assert.equal(f.value,50);assert.equal(f.previews.at(-1),50);assert.equal(f.commits.length,0);assert.equal(f.controller.active,false);assert.equal(f.frames.size,0);f.controller.destroy();}
});
test('readonly changes and a remote layout update fence a captured gesture',()=>{
 for(const change of [f=>f.disable(),f=>f.setValue(65)]){const f=fixture();f.send('pointerdown');f.send('pointermove',{clientX:120});change(f);f.send('pointerup',{clientX:140});assert.equal(f.commits.length,0);assert.equal(f.previews.at(-1),f.value);assert.equal(f.controller.active,false);f.controller.destroy();}
});
test('keyboard steps, Home, End and reset are immediate while composition and unrelated keys are untouched',()=>{
 const f=fixture();f.send('keydown',{key:'ArrowRight',isComposing:true});f.send('keydown',{key:'ArrowRight',keyCode:229});f.send('keydown',{key:'Tab'});assert.equal(f.commits.length,0);assert.equal(f.send('keydown',{key:'ArrowRight'}).defaultPrevented,true);assert.equal(f.value,51);f.send('keydown',{key:'ArrowLeft',shiftKey:true});assert.equal(f.value,46);f.send('keydown',{key:'Home'});assert.equal(f.value,15);f.send('keydown',{key:'End'});assert.equal(f.value,100);f.send('keydown',{key:'Enter'});assert.equal(f.commits.length,4);f.send('keydown',{key:'ArrowLeft'});f.send('dblclick');assert.equal(f.value,100);f.controller.destroy();assert.equal(f.send('keydown',{key:'ArrowLeft'}).defaultPrevented,false);
});
