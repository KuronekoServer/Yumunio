import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpRoomClient} from '../src/client.js';
import {Y,createStructuredRoom,applyStructuredUpdate,structuredRoomDiff,toBase64,fromBase64,STRUCTURED_ROOM_FEATURES} from '../src/index.js';

function sharedPage(t){
 const seed={title:'複数の端末',blocks:[{id:'body',type:'paragraph',data:{text:'本文'}}]};
 const initial=createStructuredRoom(seed);let state=Y.encodeStateAsUpdate(initial),sequence=1,draft=structuredClone(seed),loseAck=false;
 initial.destroy();const calls=[];
 const response=extra=>{const sync=structuredRoomDiff(state,seed);return{protocol:2,pageId:'page',epoch:'canonical-room',sequence,revision:sequence,documentVersion:sequence,editable:true,update:toBase64(sync.update),stateVector:toBase64(sync.stateVector),...(seed.references?{referenceTargets:structuredClone(seed.references)}:{}),...extra};};
 const request=async call=>{
  calls.push(call);
  if(call.path.endsWith('/updates')){
   if(call.body.references)seed.references={...seed.references,...structuredClone(call.body.references)};
   const next=applyStructuredUpdate(state,fromBase64(call.body.update),seed);
   if(toBase64(next.state)!==toBase64(state)){state=next.state;draft=next.draft;sequence++;}
   if(loseAck){loseAck=false;throw Object.assign(Error('Acknowledgement lost after commit'),{status:0});}
   return response({acknowledged:true});
  }
  return response(call.path.endsWith('/open')?{seed,ticket:'synthetic.ticket',expiresAt:'2099-01-01T00:00:00.000Z',supportedFeatures:STRUCTURED_ROOM_FEATURES}:{});
 };
 const create=()=>{const client=new HttpRoomClient({accountId:'same-account',workspaceId:'workspace',pageId:'page',draft:seed,protocol:2,request});t.after(()=>client.destroy());return client;};
 return{create,calls,request,state:()=>response(),draft:()=>structuredClone(draft),sequence:()=>sequence,loseNextAck:()=>{loseAck=true;}};
}

test('same-account devices send a Yjs update directly and converge without repeating base content',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();
 await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 assert.notEqual(left.doc.clientID,right.doc.clientID);assert.notEqual(left.presenceClientId,right.presenceClientId);
 left.setText('block:body','左 本文');right.setText('block:body','本文 右');
 const before=f.calls.length;await Promise.all([left.sync({pushFirst:true}),right.sync({pushFirst:true})]);
 assert.ok(f.calls.slice(before).every(call=>call.method==='POST'&&call.path.endsWith('/updates')));
 await left.sync({pushFirst:true});await right.sync({pushFirst:true});
 assert.deepEqual(left.snapshot(),right.snapshot());assert.equal(f.draft().blocks[0].data.text,'左 本文 右');
});

test('a lost acknowledgement is reconciled with the same CRDT structs, not a repeated text insertion',async t=>{
 const f=sharedPage(t),client=f.create();await client.open({expectedRevision:1});
 client.setText('block:body','本文 追加');f.loseNextAck();
 await assert.rejects(client.sync({pushFirst:true}));assert.equal(client.pending,true);
 const committed=f.sequence(),sent=f.calls.at(-1);
 await client.sync({pushFirst:true});
 assert.equal(f.sequence(),committed);assert.equal(client.pending,false);assert.equal(f.draft().blocks[0].data.text,'本文 追加');
 await f.request(sent);assert.equal(f.sequence(),committed);assert.deepEqual(client.snapshot(),f.draft());
});

test('a deferred merged response and edits made while awaiting ACK keep their pending generation',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 right.setText('block:body','本文 右');await right.sync({pushFirst:true});
 left.setText('block:body','左 本文');
 const held=await left.sync({pushFirst:true,canApply:()=>false});assert.equal(held.deferred,true);assert.equal(left.pending,true);
 const original=left.request;let edited=false;left.request=async call=>{const result=await original(call);if(call.path.endsWith('/updates')&&!edited){edited=true;left.setText('title','変換後のタイトル');}return result;};
 await left.sync({pushFirst:true});assert.equal(left.pending,true);
 await left.sync({pushFirst:true});await right.sync({pushFirst:true});
 assert.equal(left.pending,false);assert.deepEqual(left.snapshot(),right.snapshot());assert.equal(f.draft().title,'変換後のタイトル');assert.equal(f.draft().blocks[0].data.text,'左 本文 右');
});

test('Undo and Redo belong to a device rather than the shared account',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 left.setText('block:body','左 本文');await left.sync({pushFirst:true});await right.sync();
 right.setText('block:body','左 本文 右');await right.sync({pushFirst:true});await left.sync();
 left.history('undo');await left.sync({pushFirst:true});await right.sync();assert.equal(f.draft().blocks[0].data.text,'本文 右');
 left.history('redo');await left.sync({pushFirst:true});await right.sync();assert.equal(f.draft().blocks[0].data.text,'左 本文 右');assert.deepEqual(left.snapshot(),right.snapshot());
});

test('pushed state merges pending local changes without a read, and defers safely during composition',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 left.setText('block:body','左 本文');await left.sync({pushFirst:true});
 right.setText('block:body','本文 右');const count=f.calls.length,pushed=f.state();
 assert.equal(right.receive(pushed,{canApply:()=>false}).deferred,true);assert.equal(f.calls.length,count);
 const identity=right.doc;right.receive(pushed,{canApply:()=>true});assert.equal(right.doc,identity);assert.equal(right.pending,true);assert.equal(right.snapshot().blocks[0].data.text,'左 本文 右');
 await right.sync({pushFirst:true});const latest=f.state();left.receive(latest);left.receive(pushed);left.receive(latest);
 assert.deepEqual(left.snapshot(),right.snapshot());assert.equal(f.draft().blocks[0].data.text,'左 本文 右');
});

test('automatic collaboration retains column creation, resizing and unwrapping',async t=>{
 const f=sharedPage(t),client=f.create();await client.open({expectedRevision:1});
 const body=client.snapshot().blocks[0];
 const column=(id,children=[])=>({id,type:'column',children});
 client.pasteTree([{id:'columns',type:'columns',children:[column('left',[body]),column('right',[{id:'second',type:'paragraph',data:{text:'右側'}}])]}]);
 await client.sync({pushFirst:true});assert.equal(f.draft().blocks[0].type,'columns');
 const blocks=client.snapshot().blocks;blocks[0].children.push(column('third',[{id:'third-text',type:'paragraph',data:{text:'三列目'}}]));
 client.pasteTree(blocks);await client.sync({pushFirst:true});assert.equal(f.draft().blocks[0].children.length,3);
 client.pasteTree(client.snapshot().blocks[0].children.flatMap(c=>c.children));await client.sync({pushFirst:true});
 assert.deepEqual(f.draft().blocks.map(b=>b.id),['body','second','third-text']);
});

test('database view settings and block presentation merge with peer text and remain selectively undoable',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 const view={name:'Tasks',type:'table',filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null};
 left.pasteTree([...left.snapshot().blocks,{id:'database',type:'database',data:{format:'collection-view-v1',collectionId:'source',view,visiblePropertyIds:null}}]);await left.sync({pushFirst:true});await right.sync();
 const board={...view,type:'board',groupBy:'status'};left.operation({kind:'database-view',blockId:'database',view:board,visiblePropertyIds:['status']});right.setText('block:body','本文 続き');await Promise.all([left.sync({pushFirst:true}),right.sync({pushFirst:true})]);await left.sync();await right.sync();
 assert.deepEqual(left.snapshot(),right.snapshot());assert.equal(f.draft().blocks[1].data.collectionId,'source');assert.equal(f.draft().blocks[1].data.view.type,'board');
 left.history('undo');await left.sync({pushFirst:true});assert.equal(f.draft().blocks[1].data.view.type,'table');assert.equal(f.draft().blocks[0].data.text,'本文 続き');
 left.operation({kind:'block-presentation',blockId:'body',presentation:{background:'purple'}});await left.sync({pushFirst:true});await right.sync();assert.equal(right.snapshot().blocks[0].data.background,'purple');
 assert.throws(()=>left.operation({kind:'database-view',blockId:'body',view,visiblePropertyIds:null}));assert.throws(()=>left.operation({kind:'block-presentation',blockId:'body',presentation:{text:'overwrite'}}));
});

test('new references use opaque CRDT metadata, survive duplicate delivery and retain peer text after selective undo',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 left.setReferences({blockId:'body',text:'本文',links:[{start:0,end:2,label:'本文',pageId:'private-target'}]});
 const records=[...left.doc.getMap('references').values()].join('');assert.equal(records.includes('private-target'),false);assert.equal(left.snapshot().blocks[0].data.links[0].pageId,'private-target');
 f.loseNextAck();await assert.rejects(left.sync({pushFirst:true}));await left.sync({pushFirst:true});await right.sync();assert.equal(right.snapshot().blocks[0].data.links[0].pageId,'private-target');
 right.setText('block:body','本文 追記');await right.sync({pushFirst:true});await left.sync();left.history('undo');await left.sync({pushFirst:true});await right.sync();assert.equal(f.draft().blocks[0].data.text,'本文 追記');assert.equal(f.draft().blocks[0].data.links,undefined);
 left.history('redo');await left.sync({pushFirst:true});await right.sync();assert.deepEqual(left.snapshot(),right.snapshot());assert.equal(f.draft().blocks[0].data.links[0].pageId,'private-target');
});

test('copying a forest preserves page and person references while shared node records contain no target IDs',async t=>{
 const f=sharedPage(t),left=f.create(),right=f.create();await left.open({expectedRevision:1});await right.open({expectedRevision:1});
 left.pasteTree([...left.snapshot().blocks,{id:'copied',type:'paragraph',data:{text:'Page Person',links:[{start:0,end:4,label:'Page',pageId:'referenced-page'}],mentions:[{kind:'person',start:5,end:11,accountId:'referenced-person'}]}}]);
 const raw=left.doc.getMap('nodes').get('copied');assert.equal(raw.includes('referenced-page'),false);assert.equal(raw.includes('referenced-person'),false);
 await left.sync({pushFirst:true});await right.sync();assert.deepEqual(left.snapshot(),right.snapshot());assert.equal(right.snapshot().blocks[1].data.mentions[0].accountId,'referenced-person');
});
