import test from 'node:test';
import assert from 'node:assert/strict';
import {SIDEBAR_SIZE,sidebarSizeRange,clampSidebarSize,readSidebarSize,writeSidebarSize,createSidebarResize} from '../public/sidebar-resize.js';

function fixture(){
 const win=new EventTarget(),doc=new EventTarget(),handle=new EventTarget(),frames=new Map();let serial=0,value=256,viewport=1440,captured=null,toggles=0,focuses=0;const commits=[],previews=[],activity=[];
 Object.assign(win,{requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:id=>frames.delete(id)});Object.assign(doc,{defaultView:win,hidden:false});
 Object.assign(handle,{ownerDocument:doc,focus(){focuses++;},setPointerCapture:id=>{captured=id;},hasPointerCapture:id=>captured===id,releasePointerCapture:()=>{captured=null;}});
 const controller=createSidebarResize({handle,read:()=>value,viewport:()=>viewport,preview:next=>{value=next;previews.push(next);},commit:next=>commits.push(next),toggle:()=>toggles++,onActive:active=>activity.push(active)});
 const send=(type,props={},target=handle)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:1,button:0,isPrimary:true,clientX:256,...props});target.dispatchEvent(event);return event;};
 return{controller,win,doc,handle,send,frames,commits,previews,activity,flush(){for(const[id,fn]of frames){frames.delete(id);fn();}},setViewport:next=>{viewport=next;},get value(){return value;},get toggles(){return toggles;},get focuses(){return focuses;},get captured(){return captured;}};
}

test('sidebar limits keep document space, handle bad saved values, and retain the preferred width after a narrow viewport',()=>{
 assert.deepEqual(sidebarSizeRange(1440),{min:200,max:480});assert.deepEqual(sidebarSizeRange(761),{min:200,max:401});
 assert.equal(clampSidebarSize(460,761),401);assert.equal(clampSidebarSize(460,1440),460);assert.equal(clampSidebarSize(NaN),256);assert.equal(clampSidebarSize(-100),200);assert.equal(clampSidebarSize(Infinity),256);
 let stored;const storage={getItem:()=>stored,setItem:(_,value)=>{stored=value;}};writeSidebarSize(storage,'account-workspace',460);assert.equal(readSidebarSize(storage,'account-workspace'),460);
 for(const invalid of ['null','invalid',JSON.stringify({version:2,width:300}),JSON.stringify({version:1,width:'300'}),' '.repeat(129)]){stored=invalid;assert.equal(readSidebarSize(storage,'key'),SIDEBAR_SIZE.default);}
 assert.equal(readSidebarSize({getItem(){throw new Error('storage blocked');}},'key'),256);assert.doesNotThrow(()=>writeSidebarSize({setItem(){throw new Error('storage full');}},'key',300));
});

test('drag previews are frame-coalesced, release saves the latest position once, and its following click cannot collapse',()=>{
 const f=fixture();f.send('pointerdown');f.send('pointermove',{clientX:280});f.send('pointermove',{clientX:320});assert.equal(f.frames.size,1);assert.equal(f.value,256);assert.equal(f.commits.length,0);
 f.flush();assert.equal(f.value,320);f.send('pointerup',{clientX:352});f.send('click');f.send('pointerup',{clientX:400});assert.deepEqual(f.commits,[352]);assert.equal(f.value,352);assert.equal(f.toggles,0);assert.equal(f.captured,null);assert.deepEqual(f.activity,[true,false]);
 f.send('pointerdown',{clientX:352});f.send('pointerup',{clientX:354});f.send('click');assert.equal(f.toggles,1);assert.equal(f.value,352);f.controller.destroy();
});

test('an out-and-back drag or movement against a limit never turns into a collapse click',()=>{
 for(const end of [256,200]){const f=fixture();f.send('pointerdown');f.send('pointermove',{clientX:100});f.flush();f.send('pointerup',{clientX:end});f.send('click');assert.equal(f.toggles,0);assert.equal(f.value,end);assert.equal(f.commits.length,end===256?0:1);f.controller.destroy();}
});

test('Escape, cancellation, lost capture, blur, resize, hiding and teardown restore width without saving',()=>{
 const cancel=[f=>f.send('keydown',{key:'Escape'}),f=>f.send('pointercancel'),f=>f.send('lostpointercapture'),f=>f.send('blur',{},f.win),f=>f.send('resize',{},f.win),f=>{f.doc.hidden=true;f.send('visibilitychange',{},f.doc);},f=>f.controller.destroy()];
 for(const stop of cancel){const f=fixture();f.send('pointerdown');f.send('pointermove',{clientX:340});f.flush();assert.equal(f.value,340);stop(f);assert.equal(f.value,256);assert.equal(f.commits.length,0);assert.equal(f.frames.size,0);assert.equal(f.captured,null);assert.equal(f.controller.active,false);if(stop!==cancel.at(-1)){f.send('pointerup');f.send('click');assert.equal(f.toggles,0);}f.controller.destroy();}
});

test('keyboard resizing, bounds and collapse work while composition, shortcuts and unrelated keys pass through',()=>{
 const f=fixture();for(const props of [{key:'ArrowRight',isComposing:true},{key:'ArrowRight',keyCode:229},{key:'ArrowRight',ctrlKey:true},{key:'Tab'}])assert.equal(f.send('keydown',props).defaultPrevented,false);
 f.send('keydown',{key:'ArrowRight'});assert.equal(f.value,264);f.send('keydown',{key:'ArrowLeft',shiftKey:true});assert.equal(f.value,232);f.send('keydown',{key:'Home'});assert.equal(f.value,200);f.setViewport(761);f.send('keydown',{key:'End'});assert.equal(f.value,401);f.send('keydown',{key:'Enter'});assert.equal(f.toggles,1);assert.deepEqual(f.commits,[264,232,200,401]);f.controller.destroy();
});

test('IME composition cancels a pending gesture and primary pointer isolation prevents duplicate writes',()=>{
 const f=fixture();for(const props of [{button:2},{isPrimary:false},{isComposing:true}])f.send('pointerdown',props);assert.equal(f.controller.active,false);
 f.send('pointerdown');f.send('pointermove',{clientX:350});f.send('pointerup',{pointerId:2,clientX:400});f.send('pointercancel',{pointerId:2});assert.equal(f.controller.active,true);
 f.send('compositionstart',{},f.doc);assert.equal(f.controller.active,false);assert.equal(f.value,256);f.send('pointerdown');assert.equal(f.controller.active,false);assert.equal(f.send('keydown',{key:'ArrowRight'}).defaultPrevented,false);
 f.send('compositionend',{},f.doc);f.send('pointerdown');f.send('pointerup',{clientX:300});f.send('click');assert.deepEqual(f.commits,[300]);assert.equal(f.toggles,0);f.controller.destroy();assert.equal(f.send('keydown',{key:'ArrowRight'}).defaultPrevented,false);
});
