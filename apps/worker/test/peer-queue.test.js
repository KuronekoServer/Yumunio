import test from 'node:test';
import assert from 'node:assert/strict';
import {PeerRequestQueue} from '../peer-queue.js';

test('another editor proceeds while one connection waits, but a single connection retains frame order',async()=>{
 const queue=new PeerRequestQueue(),left={},right={},events=[];let release,started;
 const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const first=queue.run(left,async()=>{events.push('left started');started();await gate;events.push('left finished');return 1;});
 await ready;const second=queue.run(left,()=>{events.push('left next frame');return 2;});
 await queue.run(right,()=>events.push('other editor finished'));
 assert.deepEqual(events,['left started','other editor finished']);release();assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.deepEqual(events,['left started','other editor finished','left finished','left next frame']);
});
test('a failed frame rejects its own caller without poisoning subsequent frames',async()=>{
 const queue=new PeerRequestQueue(),peer={},failure=Error('synthetic failed frame');
 const first=queue.run(peer,()=>{throw failure;}),second=queue.run(peer,()=>42);
 await assert.rejects(first,error=>error===failure);assert.equal(await second,42);assert.equal(await queue.run(peer,()=>43),43);
});
