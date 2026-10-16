import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineDomFixture} from './fixtures/inline-dom.js';
import {createInlineEditor} from '../public/inline-editor.js';
import {createWorkspacePresence} from '../public/workspace-presence.js';

// Controller tests use explicit deferred responses and manually controlled clocks.
// They do not establish real network timing, browser layout, or OS IME behavior.
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const snapshot=name=>({participants:[{id:'ephemeral-'+name,displayName:name,self:false,cursor:null}]});
function fixture(t,{composing=false,onAuthorizationFailure}={}){
 const dom=inlineDomFixture(t),doc=dom.document,create=doc.createElement.bind(doc),listeners=new Map(),timers=new Map(),frames=new Map();let nextId=0,clock=10000;
 doc.hidden=false;
 const visit=root=>[root,...(root.childNodes||[]).flatMap(visit)];
 const match=(element,selector)=>element.nodeType!==1?false:selector==='[data-room-presence]'?element.getAttribute?.('data-room-presence')!==null:
  selector==='.inline-editor[data-block-id]'?element.className?.split(' ').includes('inline-editor')&&!!element.dataset?.blockId:
  selector.startsWith('.')?element.className?.split(' ').includes(selector.slice(1)):false;
 doc.createElement=tag=>{
  const element=create(tag);element.dataset={};element.style={setProperty(key,value){this[key]=value;}};
  element.classList={contains:name=>element.className?.split(' ').includes(name)===true};
  element.remove=()=>{if(element.parentElement){const parent=element.parentElement;parent.childNodes=parent.childNodes.filter(node=>node!==element);element.parentElement=null;}};
  element.querySelectorAll=selector=>visit(element).slice(1).filter(item=>match(item,selector));
  element.querySelector=selector=>element.querySelectorAll(selector)[0]||null;
  return element;
 };
 const descriptors=new Map(['window','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const window={innerWidth:1024,innerHeight:768,addEventListener(name,callback){listeners.set('window:'+name,callback);}};
 doc.defaultView=window;doc.addEventListener=(name,callback)=>listeners.set('document:'+name,callback);
 Object.defineProperties(globalThis,{
  window:{value:window,configurable:true},
  requestAnimationFrame:{value:callback=>{const id=++nextId;frames.set(id,callback);return id;},configurable:true},
  cancelAnimationFrame:{value:id=>frames.delete(id),configurable:true},
  setTimeout:{value:callback=>{const id=++nextId;timers.set(id,callback);return id;},configurable:true},
  clearTimeout:{value:id=>timers.delete(id),configurable:true}
 });
 t.after(()=>{for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
 t.mock.method(Date,'now',()=>clock);
 const app=doc.createElement('main'),host=doc.createElement('div'),scroll=doc.createElement('section');host.setAttribute('data-room-presence','');scroll.className='workspace-scroll';scroll.getBoundingClientRect=()=>({left:0,right:1024,top:48,bottom:768});
 const input=createInlineEditor({text:'Composition draft',label:'Body'});input.dataset={blockId:'body',pageId:'page'};scroll.append(input);app.append(host,scroll);
 if(composing){dom.select(input,3);input.dispatch('compositionstart');}
 const calls={publish:[],read:0,leave:0,authorization:0};let room;
 const makeRoom=(name='Initial',overrides={})=>{
  let value=snapshot(name);const client={busy:false,pending:false,status:'ready',presenceSnapshot:()=>value,
   publishPresence:async body=>{calls.publish.push(body);return value;},readPresence:async()=>{calls.read++;return value;},leavePresence:async()=>{calls.leave++;return{left:true};},...overrides};
  return{phase:'ready',client,setParticipants(name){value=snapshot(name);}};
 };
 room=makeRoom();let presence;
 presence=createWorkspacePresence({app,getRoom:()=>room,getCurrent:()=>({page:{id:'page'}}),isComposing:()=>input.getInlineState().composing,isModalOpen:()=>false,translate:key=>key,
  onAuthorizationFailure:active=>{calls.authorization++;if(onAuthorizationFailure)onAuthorizationFailure({active,presence,host,input});}});
 return{...dom,app,host,input,presence,calls,makeRoom,timers,frames,listeners,get room(){return room;},set room(value){room=value;},get clock(){return clock;},set clock(value){clock=value;}};
}

test('leave immediately clears the roster and fixed cursor layer while its request is pending and preserves the editor DOM',async t=>{
 const f=fixture(t),leaving=deferred();f.room.client.leavePresence=()=>{f.calls.leave++;return leaving.promise;};f.presence.refresh();
 assert.match(f.host.textContent,/Initial/);assert.ok(f.app.querySelector('.room-cursor-layer'));
 const state=f.input.getInlineState(),nodes=[...f.input.childNodes];
 assert.equal(f.presence.leave(f.room),undefined);assert.equal(f.calls.leave,1);assert.equal(f.host.childNodes.length,0);assert.equal(f.app.querySelector('.room-cursor-layer'),null);
 assert.deepEqual(f.input.getInlineState(),state);assert.deepEqual(f.input.childNodes,nodes);assert.equal(f.input.textContent,'Composition draft');
 leaving.resolve({left:true});await leaving.promise;
});

test('a delayed previous-room response cannot replace the current room roster or stop its authorization',async t=>{
 const f=fixture(t),response=deferred(),old=f.room;old.client.publishPresence=()=>response.promise;
 const pending=f.presence.publish(old,{force:true});assert.equal(old.presenceBusy,true);
 const current=f.makeRoom('Current');f.room=current;f.presence.refresh();assert.match(f.host.textContent,/Current/);
 response.resolve(snapshot('Old reply'));await pending;
 assert.match(f.host.textContent,/Current/);assert.doesNotMatch(f.host.textContent,/Old reply|Initial/);assert.equal(f.calls.authorization,0);assert.equal(f.room,current);assert.equal(old.presenceBusy,false);
 const rejected=deferred(),older=f.makeRoom('Older',{publishPresence:()=>rejected.promise});f.room=older;const failed=f.presence.publish(older,{force:true});f.room=current;
 rejected.reject(Object.assign(Error('Expired old request'),{status:401}));await failed;assert.equal(f.calls.authorization,0);assert.match(f.host.textContent,/Current/);
});

test('an authorization failure during composition clears presence immediately without waiting for leave or rerendering the draft',async t=>{
 const leaving=deferred();let clearedDuringStop=false;
 const f=fixture(t,{composing:true,onAuthorizationFailure:({active,presence,host,input})=>{
  const before=input.getInlineState();presence.leave(active);clearedDuringStop=host.childNodes.length===0;active.phase='stopped';active.client.status='stale';assert.deepEqual(input.getInlineState(),before);
 }});
 f.room.client.leavePresence=()=>{f.calls.leave++;return leaving.promise;};
 f.room.client.publishPresence=async body=>{f.calls.publish.push(body);throw Object.assign(Error('Revoked'),{status:401});};
 f.presence.refresh();assert.match(f.host.textContent,/Initial/);const state=f.input.getInlineState(),nodes=[...f.input.childNodes];
 await f.presence.publish(f.room,{force:true});
 assert.equal(f.calls.authorization,1);assert.equal(f.calls.leave,1);assert.equal(clearedDuringStop,true);assert.equal(f.calls.publish[0].cursor,null);
 assert.equal(f.host.childNodes.length,0);assert.equal(f.app.querySelector('.room-cursor-layer'),null);assert.equal(f.input.getInlineState().composing,true);assert.deepEqual(f.input.getInlineState(),state);assert.deepEqual(f.input.childNodes,nodes);
 leaving.resolve({left:true});await leaving.promise;
});

test('an unchanged local cursor reads peer presence at three seconds and renews its own heartbeat only at nine seconds',async t=>{
 const f=fixture(t);await f.presence.publish(f.room,{force:true});assert.equal(f.calls.publish.length,1);assert.equal(f.room.lastPresenceAt,10000);
 f.room.setParticipants('New peer');f.clock=13000;await f.presence.publish(f.room);
 assert.equal(f.calls.read,1);assert.equal(f.calls.publish.length,1);assert.match(f.host.textContent,/New peer/);assert.equal(f.room.lastPresenceAt,10000);
 f.clock=18999;await f.presence.publish(f.room);assert.equal(f.calls.read,2);assert.equal(f.calls.publish.length,1);
 f.clock=19000;await f.presence.publish(f.room);assert.equal(f.calls.publish.length,2);assert.equal(f.room.lastPresenceAt,19000);assert.equal(f.calls.read,2);
 assert.equal(f.timers.size,0);assert.equal(f.input.textContent,'Composition draft');
});
