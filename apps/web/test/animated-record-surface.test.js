import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnimatedRecordSurface} from '../public/animated-record-surface.js';
import {createRecordPanelDom} from '../public/record-panel-dom.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(t){
 const f=settingsDomFixture(t),calls=[];let reduced=false,removed=0;
 const native=createRecordPanelDom(f.doc,{title:'Detail',closeLabel:'Close',fullPageLabel:'Full page',editorTitle:'Record',editorUrl:'/workspace-detail',fullUrl:'/workspace',loading:'Loading',onClose(){},onFullPage(){}});
 const animate=(element,frames,transition)=>{let finish;const promise=new Promise(resolve=>{finish=resolve;});const call={element,frames,transition,finish,stopped:false};calls.push(call);return{then:(...args)=>promise.then(...args),stop:()=>{call.stopped=true;}};};
 const surface=createAnimatedRecordSurface({surface:native,animate,getReducedMotion:()=>reduced,onDestroy:()=>removed++});
 return{...f,surface,calls,get removed(){return removed;},reduce(){reduced=true;surface.reduce();}};
}
test('feedback and animation preserve the editor; exit waits for animation completion',async t=>{
 const f=fixture(t),frame=f.surface.frame;frame.draft='Uncommitted text';f.background.scrollTop=420;
 f.surface.setStatus('Ready');assert.equal(f.surface.frame,frame);assert.equal(frame.draft,'Uncommitted text');assert.equal(f.surface.status.textContent,'Ready');
 assert.equal(f.calls[0].transition.duration,.2);let resolved=false;const closing=f.surface.close().then(()=>{resolved=true;});await flush();
 assert.equal(resolved,false);assert.equal(f.calls[0].stopped,true);assert.equal(f.surface.host.inert,true);assert.equal(frame.isConnected,true);
 f.calls.at(-1).finish();await closing;assert.equal(frame.isConnected,false);assert.equal(f.removed,1);assert.equal(f.background.scrollTop,420);
});
test('permission loss removes an exiting editor immediately and settles close only once',async t=>{
 const f=fixture(t),closing=f.surface.close(),exit=f.calls.at(-1);f.surface.destroy();await closing;assert.equal(f.surface.host.isConnected,false);assert.equal(f.removed,1);assert.equal(exit.stopped,true);
 exit.finish();await flush();f.surface.destroy();assert.equal(f.removed,1);
});
test('reduced motion changes stop movement without replacing the editor and finish an active exit',async t=>{
 const f=fixture(t),frame=f.surface.frame;f.reduce();assert.equal(f.surface.frame,frame);assert.equal(f.calls[0].stopped,true);assert.equal(f.calls.at(-1).transition.duration,0);assert.deepEqual(f.calls.at(-1).frames,{x:0});
 const closing=f.surface.close();f.reduce();await closing;assert.equal(f.removed,1);assert.equal(frame.isConnected,false);
});
