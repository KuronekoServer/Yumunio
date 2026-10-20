import test from 'node:test';
import assert from 'node:assert/strict';
import {UI_MOTION,surfaceTransition,observeReducedMotion,captureBlockPositions,blockPlacementChanges} from '../public/ui-motion-policy.js';
import {requestMotionSurface,MOTION_SURFACE_EVENT} from '../public/motion-bridge.js';

test('all UI transitions are short tweens and reduced motion removes movement duration',()=>{
 assert.ok(UI_MOTION.menu>=.1&&UI_MOTION.menu<=.15);assert.ok(UI_MOTION.panel>=.18&&UI_MOTION.panel<=.22);
 for(const kind of ['menu','panel','sidebar','modal','placement']){const normal=surfaceTransition(kind),reduced=surfaceTransition(kind,true);assert.equal(normal.type,'tween');assert.ok(normal.duration>0&&normal.duration<=.22);assert.equal(reduced.duration,0);assert.deepEqual(normal.ease,[.2,0,.2,1]);}
});
test('OS reduced-motion changes are observed live and their listener is removed on unmount',()=>{
 const media=new EventTarget(),values=[];media.matches=false;const stop=observeReducedMotion({matchMedia:query=>{assert.equal(query,'(prefers-reduced-motion: reduce)');return media;}},value=>values.push(value));media.matches=true;media.dispatchEvent(new Event('change'));assert.deepEqual(values,[false,true]);stop();media.matches=false;media.dispatchEvent(new Event('change'));assert.deepEqual(values,[false,true]);
});
test('placement animates changed ancestors once without moving their nested editors twice',()=>{
 const parent={dataset:{blockId:'parent'},contains:element=>element===child,getBoundingClientRect:()=>({left:0,top:100,width:200,height:100})},child={dataset:{blockId:'child'},contains:()=>false,getBoundingClientRect:()=>({left:20,top:120,width:100,height:20})},rows=[parent,child],root={querySelectorAll:()=>rows};
 const before=captureBlockPositions(root);parent.getBoundingClientRect=()=>({left:0,top:180,width:200,height:100});child.getBoundingClientRect=()=>({left:20,top:200,width:100,height:20});
 const changed=blockPlacementChanges(root,before);assert.equal(changed.length,1);assert.equal(changed[0].element,parent);assert.equal(changed[0].y,-80);assert.equal(before.get('child').top,120);
});
test('a stable document produces no placement animation or DOM mutations',()=>{
 const row={dataset:{blockId:'row'},getBoundingClientRect:()=>({left:5,top:40,width:100,height:20})},root={querySelectorAll:()=>[row]};assert.deepEqual(blockPlacementChanges(root,captureBlockPositions(root)),[]);
});
test('React surface bridge has a native fallback and passes lifecycle callbacks without serialization',()=>{
 assert.equal(requestMotionSurface('record',{},{}),null);const window=new EventTarget(),model={onClose:()=>true},surface={close:()=>true};window.addEventListener(MOTION_SURFACE_EVENT,event=>{assert.equal(event.detail.model,model);event.detail.result=surface;});assert.equal(requestMotionSurface('record',model,window),surface);
});
