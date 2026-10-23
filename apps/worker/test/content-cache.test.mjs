import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentCache} from '../content-cache.js';
import {isValidatedPayload,markValidatedPayload} from '../../../packages/identity/src/content-cache-marker.js';

function fixture(){
  const state={revision:1,payload:{schemaVersion:1,pages:[]},fullReads:0,headReads:0,writes:0,failure:null};
  const base={
    async read(workspaceId,accountId,{headOnly=false}={}){
      if(headOnly){state.headReads++;return{revision:state.revision,principals:[{accountId}]};}
      state.fullReads++;return{revision:state.revision,payload:structuredClone(state.payload),principals:[{accountId}]};
    },
    async write(workspaceId,accountId,{payload}){
      if(state.failure){const error=state.failure;state.failure=null;throw error;}
      state.writes++;state.revision++;state.payload=structuredClone(payload);return{revision:state.revision};
    },
    async readHead(workspaceId,accountId){return this.read(workspaceId,accountId,{headOnly:true});}
  };
  return{state,store:createContentCache().wrap(base),cache:createContentCache()};
}

test('the room payload is validated once per revision and reused across accounts',async()=>{
  const{state,store}=fixture();
  const first=await store.read('workspace','owner');
  assert.equal(state.fullReads,1);assert.equal(state.headReads,1);
  // A raw D1 row is never trusted by the cache; readPayload validates it and
  // marks the validated clone (the same object the cache now holds).
  assert.equal(isValidatedPayload(first.payload),false);
  assert.equal(isValidatedPayload(structuredClone(first.payload)),false);
  assert.equal(Object.getOwnPropertySymbols(first.payload).length,0);
  markValidatedPayload(first.payload);
  const peer=await store.read('workspace','editor');
  assert.equal(state.fullReads,1);assert.equal(state.headReads,2);assert.notEqual(peer,first);assert.equal(peer.payload,first.payload);assert.deepEqual(peer.principals,[{accountId:'editor'}]);
  state.revision++;
  await store.read('workspace','owner');
  assert.equal(state.fullReads,2);assert.equal(state.headReads,3);
  const head=await store.readHead('workspace','owner');
  assert.deepEqual(head,{revision:state.revision,principals:[{accountId:'owner'}]});
});

test('a committed write seeds the next revision and a conflict forces a fresh read',async()=>{
  const{state,store}=fixture();
  await store.read('workspace','owner');
  const next={schemaVersion:1,pages:[{id:'next'}]};
  const written=await store.write('workspace','owner',{expectedRevision:1,payload:next});
  assert.equal(written.revision,2);assert.equal(isValidatedPayload(next),true);
  const cached=await store.read('workspace','editor');
  assert.equal(state.fullReads,1);assert.equal(cached.payload,next);assert.deepEqual(cached.principals,[{accountId:'editor'}]);
  state.failure=Object.assign(new Error('conflict'),{code:'CONTENT_CONFLICT'});
  await assert.rejects(store.write('workspace','owner',{expectedRevision:2,payload:{schemaVersion:1,pages:[]}}),{code:'CONTENT_CONFLICT'});
  await store.read('workspace','owner');
  assert.equal(state.fullReads,2);
});

test('deferred updates acknowledge the current revision and commit once on flush',async()=>{
  // A local fixture with a real base to exercise deferred mode.
  const local={revision:1,writes:0,payload:{schemaVersion:1,pages:[{page:{id:'p',title:'A'},document:{version:1,blocks:[]}}],rooms:[{pageId:'p',epoch:'e',sequence:1,documentVersion:1}]},fullReads:0,headReads:0,failure:null};
  const base={async read(workspaceId,accountId,{headOnly=false}={}){if(headOnly){local.headReads++;return{revision:local.revision,principals:[{accountId}]};}local.fullReads++;return{revision:local.revision,payload:structuredClone(local.payload),principals:[{accountId}]};},async write(workspaceId,accountId,{payload}){local.writes++;local.revision++;local.payload=structuredClone(payload);return{revision:local.revision};}};
  const cached=createContentCache();const wrapped=cached.wrap(base);cached.setDeferred(true);
  const read=await wrapped.read('w','a');
  const next=structuredClone(read.payload);next.pages[0].page.title='B';next.rooms[0].sequence=6;next.rooms[0].documentVersion=6;next.pages[0].document.version=6;
  const ack=await wrapped.write('w','a',{expectedRevision:read.revision,payload:next,actorMembershipId:'m',actorRole:'member',guardMemberships:[]});
  assert.equal(ack.revision,read.revision);assert.equal(local.writes,0);assert.equal(cached.dirty,true);
  const hit=await wrapped.read('w','b');
  assert.equal(local.fullReads,1);assert.equal(hit.revision,read.revision);assert.equal(hit.payload.pages[0].page.title,'B');
  const flushed=await cached.flush();
  assert.equal(local.writes,1);assert.equal(flushed.revision,read.revision+1);assert.equal(cached.dirty,false);
});

test('a changed durable revision while updates are buffered raises a stale signal',async()=>{
  let revision=1;const payload={schemaVersion:1,pages:[],rooms:[]};
  const base={async read(workspaceId,accountId,{headOnly=false}={}){if(headOnly)return{revision,principals:[]};return{revision,payload:structuredClone(payload),principals:[]};},async write(){throw new Error('unused');}};
  const cache=createContentCache();const store=cache.wrap(base);cache.setDeferred(true);
  const read=await store.read('w','a');
  await store.write('w','a',{expectedRevision:read.revision,payload:{...payload},actorMembershipId:'m',actorRole:'member',guardMemberships:[]});
  revision++;
  await assert.rejects(store.read('w','a'),{code:'CONTENT_CACHE_STALE'});
});

test('a conflict replay restores the sequence the client already observed',async()=>{
  let revision=1,payload={schemaVersion:1,pages:[{page:{id:'p',title:'A'},document:{version:1}}],rooms:[{pageId:'p',epoch:'e',sequence:1,documentVersion:1}]};
  const base={async read(workspaceId,accountId,{headOnly=false}={}){if(headOnly)return{revision,principals:[]};return{revision,payload:structuredClone(payload),principals:[]};},async write(workspaceId,accountId,{payload:next}){revision++;payload=structuredClone(next);return{revision};}};
  const cache=createContentCache();const store=cache.wrap(base);cache.setDeferred(true);
  const read=await store.read('w','a');
  const buffered=structuredClone(read.payload);buffered.pages[0].page.title='B';buffered.rooms[0].sequence=6;buffered.rooms[0].documentVersion=6;buffered.pages[0].document.version=6;
  await store.write('w','a',{expectedRevision:read.revision,payload:buffered,actorMembershipId:'m',actorRole:'member',guardMemberships:[]});
  const before=cache.snapshot();
  // Another writer advanced D1 and the replayed update produced sequence 2.
  payload={schemaVersion:1,pages:[{page:{id:'p',title:'B'},document:{version:2}},{page:{id:'other',title:'Kept'},document:{version:1}}],rooms:[{pageId:'p',epoch:'e',sequence:2,documentVersion:2}]};
  revision=3;
  cache.invalidate();
  await cache.bump('p',before);
  assert.equal(payload.rooms[0].sequence,6);assert.equal(payload.rooms[0].documentVersion,6);assert.equal(payload.pages[0].document.version,6);
  assert.equal(payload.pages[1].page.title,'Kept');assert.equal(revision,4);
});

test('a missing workspace is never cached and invalidation drops the payload',async()=>{
  const cache=createContentCache();
  let revision=1,payload={schemaVersion:1,pages:[]},fullReads=0;
  const base={async read(workspaceId,accountId,{headOnly=false}={}){if(headOnly)return{revision,principals:[]};fullReads++;return{revision,payload:structuredClone(payload),principals:[]};},async write(){throw new Error('unused');}};
  const store=cache.wrap(base);
  await store.read('workspace','owner');
  cache.invalidate();
  await store.read('workspace','owner');
  assert.equal(fullReads,2);
  const empty=createContentCache().wrap({async read(){return null;},async write(){throw new Error('unused');}});
  assert.equal(await empty.read('missing','owner'),null);
});
