import test from 'node:test';
import assert from 'node:assert/strict';
import {CoalescedReads} from '../public/coalesced-reads.js';
const deferred=()=>{let resolve;return{promise:new Promise(yes=>resolve=yes),resolve:value=>resolve(value)};};

test('concurrent placements share a read, but cancellation and returned models remain independent',async()=>{
 const pool=new CoalescedReads(),response=deferred(),abort=new AbortController();let reads=0;
 const read=()=>{reads++;return response.promise;},left=pool.run('account:source:view',read,{signal:abort.signal}),right=pool.run('account:source:view',read);
 abort.abort();await assert.rejects(left,{name:'AbortError'});response.resolve({records:[{title:'original'}]});assert.equal((await right).records[0].title,'original');assert.equal(reads,1);
 const[one,two]=await Promise.all([pool.run('same',async()=>({items:[]})),pool.run('same',async()=>assert.fail('Duplicate read'))]);one.items.push('changed');assert.deepEqual(two.items,[]);
});
test('mutations and account changes fence in-flight reads; completed responses are never cached',async()=>{
 const pool=new CoalescedReads(),stale=deferred();let reads=0;
 const first=pool.run('owner:page',()=>{reads++;return stale.promise;});pool.clear();
 const second=await pool.run('owner:page',async()=>{reads++;return{revision:2};});stale.resolve({revision:1});assert.equal((await first).revision,1);assert.equal(second.revision,2);
 await pool.run('owner:page',async()=>{reads++;return{revision:3};});await pool.run('member:page',async()=>{reads++;return{revision:4};});assert.equal(reads,4);
});
test('failed reads are shared only while pending, and can be reauthorized later',async()=>{
 const pool=new CoalescedReads();let reads=0;
 const tasks=[pool.run('scope',async()=>{reads++;throw Error('denied');}),pool.run('scope',async()=>assert.fail('Duplicate read'))];
 for(const result of await Promise.allSettled(tasks))assert.equal(result.reason.message,'denied');assert.equal(reads,1);assert.equal(await pool.run('scope',async()=>true),true);
});
