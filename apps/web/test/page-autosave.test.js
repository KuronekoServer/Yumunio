import test from 'node:test';
import assert from 'node:assert/strict';
import {PageAutosave} from '../public/page-autosave.js';
const settle=async()=>{for(let round=0;round<16;round++)await Promise.resolve();};
class FakeClock{
 time=0;next=0;timers=new Map();
 now(){return this.time;}
 setTimeout(callback,delay){const id=++this.next;this.timers.set(id,{due:this.time+delay,callback});return id;}
 clearTimeout(id){this.timers.delete(id);}
 async advance(duration){const target=this.time+duration;let rounds=0;for(;;){await settle();const pending=[...this.timers].filter(([,timer])=>timer.due<=target).sort((left,right)=>left[1].due-right[1].due||left[0]-right[0]);if(!pending.length)break;if(++rounds>100)throw Error('Unexpected timer loop');const[id,timer]=pending[0];this.time=timer.due;this.timers.delete(id);timer.callback();}this.time=target;await settle();}
}
function fixture(handler){
 const clock=new FakeClock(),state={scopeKey:'account:workspace:page-A',generation:0,dirty:false,paused:false},calls=[],events=[];let active=0,maxActive=0;
 const controller=new PageAutosave({clock,getState:()=>({...state}),onState:value=>events.push(value),save:async operation=>{calls.push(operation);active++;maxActive=Math.max(maxActive,active);try{const result=handler?await handler(operation,state):{status:'saved'};if(result?.status==='saved'&&operation.isCurrent()&&state.generation===operation.generation)state.dirty=false;return result;}finally{active--;}}});
 return{controller,clock,state,calls,events,maxActive:()=>maxActive,edit(){state.generation++;state.dirty=true;controller.notify();}};
}
function deferred(){let resolve,reject;return{promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve:value=>resolve(value),reject:error=>reject(error)};}

test('construction has no read callback status callback or scheduled work before the caller initializes its UI',()=>{
 let reads=0,events=0;const clock=new FakeClock();new PageAutosave({clock,getState:()=>{reads++;throw Error();},save:async()=>({status:'saved'}),onState:()=>{events++;}});assert.equal(reads,0);assert.equal(events,0);assert.equal(clock.timers.size,0);
});

test('debounce coalesces real body generations and redundant refresh does not extend the edit deadline',async()=>{
 const f=fixture();f.edit();await f.clock.advance(600);f.controller.refresh();await f.clock.advance(299);assert.equal(f.calls.length,0);await f.clock.advance(1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].generation,1);assert.equal(f.controller.snapshot().phase,'idle');assert.equal(f.state.dirty,false);
 f.edit();await f.clock.advance(700);f.edit();await f.clock.advance(899);assert.equal(f.calls.length,1);await f.clock.advance(1);assert.equal(f.calls.length,2);assert.equal(f.calls[1].generation,3);
});

test('continuous input is saved by three seconds without waiting for a quiet debounce window',async()=>{
 const f=fixture();f.edit();for(let count=0;count<4;count++){await f.clock.advance(600);f.edit();}await f.clock.advance(599);assert.equal(f.calls.length,0);await f.clock.advance(1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].generation,5);assert.equal(f.clock.time,3000);
});

test('fresh pause checks prevent sends during IME room modal loading or permission gates and resume rereads current state',async()=>{
 for(const reason of ['IME','room','modal','loading','permission']){const f=fixture();f.edit();await f.clock.advance(400);f.state.paused=true;await f.clock.advance(6000);assert.equal(f.calls.length,0,reason);assert.equal(f.controller.snapshot().phase,'paused');assert.equal(f.clock.timers.size,0);f.state.generation++;f.state.paused=false;f.controller.refresh();await f.clock.advance(0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].generation,2);}
});

test('only one save is in flight and edits during its ACK wait keep their own next generation and maximum wait',async()=>{
 const held=deferred(),f=fixture(async()=>f.calls.length===1?held.promise:{status:'saved'});f.edit();await f.clock.advance(900);assert.equal(f.calls.length,1);const first=f.calls[0];await f.clock.advance(200);f.edit();await f.clock.advance(100);f.edit();assert.equal(first.isCurrent(),true);await f.clock.advance(5000);assert.equal(f.calls.length,1);assert.equal(f.controller.snapshot().pending,true);held.resolve({status:'saved'});await settle();assert.equal(f.state.dirty,true);await f.clock.advance(0);assert.equal(f.calls.length,2);assert.equal(f.calls[1].generation,3);assert.equal(f.maxActive(),1);assert.equal(f.state.dirty,false);
});

test('flush shares the same single flight and waits before sending at most one latest dirty generation',async()=>{
 const held=deferred(),f=fixture(async()=>f.calls.length===1?held.promise:{status:'saved'});f.edit();await f.clock.advance(200);const first=f.controller.flush();await settle();assert.equal(f.calls.length,1);f.edit();const second=f.controller.flush();await settle();assert.equal(f.calls.length,1);held.resolve({status:'saved'});await first;await second;assert.equal(f.calls.length,2);assert.equal(f.calls[1].generation,2);assert.equal(f.maxActive(),1);assert.equal(f.state.dirty,false);await f.clock.advance(5000);assert.equal(f.calls.length,2);
});

test('uncertain conflict rejected and malformed outcomes freeze automatic and manual retries until explicit fresh reset',async()=>{
 for(const result of [{status:'unknown'},{status:'conflict'},{status:'rejected'},undefined,{status:'unexpected'}]){let first=true;const f=fixture(async()=>{if(first){first=false;return result;}return{status:'saved'};});f.edit();await f.clock.advance(900);assert.equal(f.calls.length,1);const reason=['conflict','rejected'].includes(result?.status)?result.status:'unknown';assert.equal(f.controller.snapshot().phase,'blocked');assert.equal(f.controller.snapshot().reason,reason);f.edit();f.controller.refresh();await f.controller.flush();await f.clock.advance(10000);assert.equal(f.calls.length,1);assert.equal(f.state.dirty,true);assert.equal(f.clock.timers.size,0);f.controller.reset();await f.clock.advance(900);assert.equal(f.calls.length,2);assert.equal(f.state.dirty,false);}
});

test('network 5xx and invalid ACK errors remain unknown while authorization validation and CAS failures stop safely',async()=>{
 for(const status of [0,500,503,409,400,401,403,404,413,422]){const f=fixture(async()=>{throw Object.assign(Error('private body or credential must never enter controller metadata'),{status});});f.edit();await f.clock.advance(900);assert.equal(f.controller.snapshot().reason,status===409?'conflict':[400,401,403,404,413,422].includes(status)?'rejected':'unknown');f.edit();await f.clock.advance(10000);assert.equal(f.calls.length,1);assert.equal(JSON.stringify(f.events).includes('private body'),false);}
});

test('a claimed save whose same body generation remains dirty is treated as an unknown ACK rather than resubmitted',async()=>{
 const clock=new FakeClock(),state={scopeKey:'actor:page',generation:1,dirty:true,paused:false};let calls=0;const controller=new PageAutosave({clock,getState:()=>state,save:async()=>{calls++;return{status:'saved'};}});controller.notify();await clock.advance(900);assert.equal(controller.snapshot().reason,'unknown');await clock.advance(10000);assert.equal(calls,1);assert.equal(state.dirty,true);
});

test('scope switches cancel old debounce work and a late old ACK cannot revive or clear the new page draft',async()=>{
 const held=deferred(),f=fixture(async()=>f.calls.length===1?held.promise:{status:'saved'});f.edit();await f.clock.advance(500);f.state.scopeKey='account:workspace:page-B';f.state.generation=0;f.state.dirty=false;f.controller.reset();await f.clock.advance(1000);assert.equal(f.calls.length,0);f.state.scopeKey='account:workspace:page-A';f.controller.reset();f.edit();await f.clock.advance(900);const old=f.calls[0];f.state.scopeKey='other-account:other-workspace:page-B';f.state.generation=0;f.state.dirty=false;f.controller.reset();f.edit();await f.clock.advance(4000);assert.equal(f.calls.length,1);assert.equal(old.isCurrent(),false);const afterSwitch=f.events.length;held.resolve({status:'saved'});await settle();assert.equal(f.state.dirty,true);await f.clock.advance(0);assert.equal(f.calls.length,2);assert.equal(f.calls[1].scopeKey,'other-account:other-workspace:page-B');assert.equal(f.maxActive(),1);assert.ok(f.events.slice(afterSwitch).every(event=>event.scopeKey==='other-account:other-workspace:page-B'));assert.equal(f.state.dirty,false);
});

test('stop is terminal and does not assume an in-flight write was cancelled or allow a late response to rearm saving',async()=>{
 const held=deferred(),f=fixture(async()=>held.promise);f.edit();await f.clock.advance(900);const operation=f.calls[0];f.controller.stop();assert.equal(operation.isCurrent(),false);f.edit();f.controller.reset();f.controller.refresh();assert.equal(f.controller.snapshot().phase,'stopped');held.resolve({status:'saved'});await settle();assert.equal(f.state.dirty,true);await f.clock.advance(10000);assert.equal(f.calls.length,1);assert.equal(f.clock.timers.size,0);assert.equal(f.controller.snapshot().phase,'stopped');
});

test('a fresh same-page reset fences an earlier ACK and requires another explicit read if that write later completes',async()=>{
 const held=deferred(),f=fixture(async()=>held.promise);f.edit();await f.clock.advance(900);const operation=f.calls[0];f.state.generation=0;f.state.dirty=false;f.controller.reset();assert.equal(operation.isCurrent(),false);held.resolve({status:'saved'});await settle();assert.equal(f.controller.snapshot().reason,'unknown');f.edit();await f.clock.advance(5000);assert.equal(f.calls.length,1);
});

test('a definitively unsent paused adapter waits for an explicit state refresh instead of spinning or freezing as unknown',async()=>{
 let first=true;const f=fixture(async()=>{if(first){first=false;return{status:'paused'};}return{status:'saved'};});f.edit();await f.clock.advance(900);assert.equal(f.controller.snapshot().phase,'paused');await f.clock.advance(10000);assert.equal(f.calls.length,1);assert.equal(f.clock.timers.size,0);f.controller.refresh();await f.clock.advance(0);assert.equal(f.calls.length,2);assert.equal(f.controller.snapshot().phase,'idle');
});

test('invalid live state and generation rollback fail closed without sending until an explicit valid reset',async()=>{
 const f=fixture();f.edit();f.state.generation=-1;await f.clock.advance(900);assert.equal(f.calls.length,0);assert.equal(f.controller.snapshot().reason,'rejected');f.state.generation=1;f.controller.refresh();await f.clock.advance(900);assert.equal(f.calls.length,1);f.edit();f.state.generation=0;f.controller.notify();await f.clock.advance(5000);assert.equal(f.calls.length,1);assert.equal(f.controller.snapshot().reason,'rejected');f.controller.reset();await f.clock.advance(900);assert.equal(f.calls.length,2);
});

test('timing options are bounded and status observers cannot turn a successful save into a duplicate retry',async()=>{
 for(const debounceMs of [0,699,1001,NaN])assert.throws(()=>new PageAutosave({getState:()=>({}),save:async()=>{},debounceMs}),/INVALID_PAGE_AUTOSAVE/);assert.throws(()=>new PageAutosave({getState:()=>({}),save:async()=>{},maxWaitMs:3001}),/INVALID_PAGE_AUTOSAVE/);const clock=new FakeClock(),state={scopeKey:'actor:page',generation:1,dirty:true,paused:false};let calls=0;const controller=new PageAutosave({clock,getState:()=>state,onState:()=>{throw Error('UI observer failure');},save:async()=>{calls++;state.dirty=false;return{status:'saved'};}});controller.notify();await clock.advance(900);await clock.advance(10000);assert.equal(calls,1);assert.equal(controller.snapshot().phase,'idle');
});

test('a synchronous status update which changes scope or pauses cannot dispatch the earlier save candidate',async()=>{
 for(const change of ['pause','scope','stop']){const clock=new FakeClock(),state={scopeKey:'account:page-A',generation:1,dirty:true,paused:false};let calls=0,controller;controller=new PageAutosave({clock,getState:()=>state,save:async()=>{calls++;state.dirty=false;return{status:'saved'};},onState:event=>{if(event.phase==='saving'){if(change==='pause')state.paused=true;else if(change==='scope'){state.scopeKey='other-account:page-B';state.generation=0;state.dirty=false;}else controller.stop();}}});controller.notify();await clock.advance(900);assert.equal(calls,0);assert.equal(clock.timers.size,0);assert.equal(controller.snapshot().phase,change==='stop'?'stopped':change==='scope'?'idle':'paused');}
});
