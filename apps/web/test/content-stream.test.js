import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {connectContentStream} from '../public/content-stream.js';
function fixture(t,options={}){
 const view=Object.assign(new EventTarget(),{location:{origin:'https://live.example'},navigator:{onLine:true}}),peers=[],changes=[];let denied=0;
 class Socket extends EventTarget{
  constructor(url){super();this.url=url;this.readyState=0;this.sent=[];peers.push(this);}
  message(value){this.readyState=1;this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  send(value){this.sent.push(value);}
  close(code=1000){if(this.readyState===3)return;this.readyState=3;const event=Object.assign(new Event('close'),{code});this.dispatchEvent(event);}
 }
 const stream=connectContentStream({workspaceId:'workspace-a',accountId:'owner',view,Socket,onChange:value=>changes.push(value),onDenied:()=>denied++,random:()=>0,...options});t.after(()=>stream.destroy());return{view,peers,changes,stream,denied:()=>denied};
}
test('automatic connection is scoped, and only valid content-free notifications reach readers',t=>{
 const f=fixture(t);assert.equal(f.peers[0].url,'wss://live.example/api/content/workspaces/workspace-a/changes/ws');
 f.peers[0].message({type:'ready'});f.peers[0].message({type:'changed'});assert.equal(f.changes.length,2);assert.deepEqual(f.changes[1],{workspaceId:'workspace-a',accountId:'owner',remote:true});assert.deepEqual(f.peers[0].sent,[]);
 f.stream.destroy();f.peers[0].message({type:'changed'});assert.equal(f.changes.length,2);
});
test('a lost connection reconnects and invalidates on ready, including changes missed offline',async t=>{
 const f=fixture(t);f.peers[0].message({type:'ready'});f.peers[0].close(1012);await pause(250);assert.equal(f.peers.length,2);f.peers[1].message({type:'ready'});assert.equal(f.changes.length,2);
});
test('page suspension closes sockets and resuming reauthorizes with the same account scope',t=>{
 const f=fixture(t);f.peers[0].message({type:'ready'});f.view.dispatchEvent(new Event('pagehide'));assert.equal(f.peers[0].readyState,3);f.view.dispatchEvent(new Event('pageshow'));assert.equal(f.peers.length,2);assert.equal(f.peers[1].url,f.peers[0].url);
});
test('revoked access stops reconnecting and cannot silently adopt another account',async t=>{
 const f=fixture(t);f.peers[0].message({type:'ready'});f.peers[0].close(4003);f.view.dispatchEvent(new Event('focus'));await pause(250);assert.equal(f.denied(),1);assert.equal(f.peers.length,1);assert.equal(f.changes.length,1);
});
test('unrecognized payloads are rejected rather than forwarded to the editor',t=>{
 const f=fixture(t);f.peers[0].message({type:'changed',title:'private',workspaceId:'another'});assert.equal(f.changes.length,0);assert.equal(f.peers[0].readyState,3);
});
test('blocked WebSockets fall back to authorized head reads, and access loss stops both transports',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});let revision=1,reads=0,fail=false;
 const f=fixture(t,{Socket:null,readHead:async()=>{reads++;if(fail)throw Object.assign(Error('denied'),{status:404});return{workspaceId:'workspace-a',accountId:'owner',revision,principals:'snapshot'};}});
 const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 t.mock.timers.tick(2000);await settle();assert.equal(reads,1);assert.equal(f.changes.length,1);
 t.mock.timers.tick(2000);await settle();assert.equal(f.changes.length,1);
 revision=2;t.mock.timers.tick(2000);await settle();assert.equal(f.changes.length,2);
 fail=true;t.mock.timers.tick(2000);await settle();assert.equal(f.denied(),1);t.mock.timers.tick(10000);await settle();assert.equal(reads,4);
});
