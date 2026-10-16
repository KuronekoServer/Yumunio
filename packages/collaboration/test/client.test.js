import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpRoomClient } from '../src/client.js';
import { Y,createRoomDocument,encodeRoomState,applyRoomUpdate,loadRoomDocument,roomDiff,toBase64,fromBase64,ROOM_LIMITS } from '../src/index.js';
const base=()=>({title:'Shared',blocks:[{id:'a',type:'paragraph',data:{text:'Hello'}}]});
function fixture(){
  let draft=base(),epoch='epoch-one',sequence=1,revision=2;const doc=createRoomDocument(draft);let state=encodeRoomState(doc);doc.destroy();
  const calls=[];let fail=false,bad=false,respond=value=>value;
  const response=(extra={})=>{const diff=roomDiff(state,draft);return{pageId:'page',epoch,sequence,revision,documentVersion:sequence,editable:true,update:toBase64(diff.update),stateVector:toBase64(diff.stateVector),...extra};};
  const request=async call=>{
    calls.push(call);assert.equal(call.headers['X-Yumunio-Expected-Account'],'actor');
    if(fail)throw Object.assign(new Error('unavailable'),typeof fail==='object'?fail:{status:0});
    if(call.path.endsWith('/renew'))return respond({pageId:'page',epoch,sequence,revision,documentVersion:sequence,editable:true,ticket:'renewed-fixture.ticket',expiresAt:'2026-10-15T01:15:00.000Z'},call);
    if(call.path.endsWith('/updates')){
      if(call.body.epoch!==epoch)throw Object.assign(new Error(),{status:409,code:'ROOM_EPOCH_CHANGED'});
      const result=applyRoomUpdate(state,fromBase64(call.body.update),draft);state=result.state;draft=result.draft;sequence++;revision++;
    }
    return respond(response({...(call.path.endsWith('/open')?{ticket:'signed-fixture',expiresAt:'2026-10-15T01:00:00.000Z'}:{}),...(call.path.endsWith('/updates')?{acknowledged:!bad}:{})}),call);
  };
  const client=new HttpRoomClient({accountId:'actor',workspaceId:'workspace',pageId:'page',draft:base(),request});
  return{client,calls,response,setFail:value=>{fail=value;},setBad:value=>{bad=value;},setEpoch:value=>{epoch=value;},setResponse:value=>{respond=value;},draft:()=>draft,
    remoteInsert(key,index,text){const remote=loadRoomDocument(state,draft);try{remote.getText(key).insert(index,text);const result=applyRoomUpdate(state,Y.encodeStateAsUpdate(remote),draft);state=result.state;draft=result.draft;sequence++;revision++;}finally{remote.destroy();}}
  };
}
function capture(client){return{document:client.doc,clientId:client.doc.clientID,bytes:toBase64(Y.encodeStateAsUpdate(client.doc)),baseline:structuredClone(client.baseline),serverState:toBase64(client.serverState),serverVector:toBase64(client.serverVector),sequence:client.sequence,revision:client.revision,documentVersion:client.documentVersion,pending:client.pending};}
function assertPreserved(client,before){assert.equal(client.doc,before.document);assert.equal(client.doc.clientID,before.clientId);assert.equal(toBase64(Y.encodeStateAsUpdate(client.doc)),before.bytes);assert.deepEqual(client.baseline,before.baseline);assert.equal(toBase64(client.serverState),before.serverState);assert.equal(toBase64(client.serverVector),before.serverVector);assert.equal(client.sequence,before.sequence);assert.equal(client.revision,before.revision);assert.equal(client.documentVersion,before.documentVersion);assert.equal(client.pending,before.pending);}
function unsupportedResponse(value){const bad=new Y.Doc();try{bad.getText('unknown').insert(0,'must not enter live document');const update=Y.mergeUpdates([fromBase64(value.update),Y.encodeStateAsUpdate(bad)]);return{...value,update:toBase64(update)};}finally{bad.destroy();}}

test('client explicitly opens, keeps offline local edits and only clears pending after durable acknowledged response',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('block:a','Hello offline');const before=capture(f.client);f.setFail(true);
  await assert.rejects(f.client.sync());assertPreserved(f.client,before);assert.equal(f.client.snapshot().blocks[0].data.text,'Hello offline');
  f.setFail(false);await f.client.sync();assert.equal(f.client.pending,false);assert.equal(f.draft().blocks[0].data.text,'Hello offline');
  assert.equal(f.client.doc,before.document);assert.ok(f.calls.some(call=>call.method==='POST'&&call.path.endsWith('/updates')));
});
test('epoch changes stop the client and preserve pending text without silently replacing it',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Unsent');const before=capture(f.client);f.setEpoch('epoch-two');
  await assert.rejects(f.client.sync(),error=>error.code==='ROOM_EPOCH_CHANGED');assert.equal(f.client.status,'stale');assertPreserved(f.client,before);assert.equal(f.client.snapshot().title,'Unsent');
});
test('unknown acknowledgement preserves local input and pending state for a safe identical update retry',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Pending title');const before=capture(f.client);f.setBad(true);
  await assert.rejects(f.client.sync());assertPreserved(f.client,before);assert.equal(f.client.snapshot().title,'Pending title');f.setBad(false);await f.client.sync();assert.equal(f.client.pending,false);assert.equal(f.client.doc,before.document);
});
test('one long-lived client can edit and durably sync more than 64 rounds without growing client IDs or losing observers',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});const document=f.client.doc,clientId=document.clientID,title=document.getText('title');let changes=0,destroyed=false;
  title.observe(()=>{changes++;});document.on('destroy',()=>{destroyed=true;});
  const rounds=ROOM_LIMITS.clients+16;for(let round=0;round<rounds;round++){f.client.setText('title','Round '+round);await f.client.sync();assert.equal(f.client.pending,false);}
  assert.equal(f.client.doc,document);assert.equal(document.clientID,clientId);assert.equal(destroyed,false);assert.equal(changes,rounds);assert.ok(document.store.clients.size<=2);assert.equal(f.draft().title,'Round '+(rounds-1));
});
test('remote text merges with local pending edits and an edit made while awaiting durable ACK stays pending',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});const document=f.client.doc,clientId=document.clientID;let remoteChanges=0;document.getText('block:a').observe(event=>{if(event.transaction.origin==='remote')remoteChanges++;});
  f.client.setText('block:a','Hello local');f.remoteInsert('block:a',5,' remote');
  let release,received;const held=new Promise(resolve=>{release=resolve;}),posted=new Promise(resolve=>{received=resolve;});
  f.setResponse(async(value,call)=>{if(call.path.endsWith('/updates')){received();await held;}return value;});const syncing=f.client.sync();await posted;
  assert.match(f.client.snapshot().blocks[0].data.text,/local/);assert.match(f.client.snapshot().blocks[0].data.text,/remote/);f.client.setText('title','Typed during ACK');release();
  const first=await syncing;assert.equal(first.pending,true);assert.equal(first.draft.title,'Typed during ACK');assert.equal(f.client.doc,document);assert.equal(document.clientID,clientId);assert.equal(remoteChanges,1);
  f.setResponse(value=>value);await f.client.sync();assert.equal(f.client.pending,false);assert.equal(f.draft().title,'Typed during ACK');assert.deepEqual(f.draft(),f.client.snapshot());
});
test('malformed GET updates, mismatched vectors and metadata leave the live document and pending input untouched',async t=>{
  const invalid=[value=>({...value,update:'%%%'}),value=>({...value,update:toBase64(new Uint8Array([255]))}),value=>({...value,stateVector:toBase64(new Uint8Array([0]))}),unsupportedResponse,value=>({...value,documentVersion:0})];
  for(const rewrite of invalid){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Unsent input');const before=capture(f.client);f.remoteInsert('block:a',5,' remote');f.setResponse(rewrite);
    await assert.rejects(f.client.sync());assertPreserved(f.client,before);assert.equal(f.client.status,'ready');assert.equal(f.client.doc.isDestroyed,false);
  }
});
test('a malformed durable ACK is not partially applied and a later clean sync recovers',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Pending title');const before=capture(f.client);
  f.setResponse((value,call)=>call.path.endsWith('/updates')?unsupportedResponse(value):value);await assert.rejects(f.client.sync());assertPreserved(f.client,before);assert.equal(f.draft().title,'Pending title');
  f.setResponse(value=>value);await f.client.sync();assert.equal(f.client.pending,false);assert.equal(f.client.doc,before.document);assert.deepEqual(f.client.snapshot(),f.draft());
});
test('an unacknowledged response cannot merge additional remote text until a validated GET',async t=>{
  const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Pending title');const before=capture(f.client);
  f.setResponse((value,call)=>{if(call.path.endsWith('/updates')){f.remoteInsert('block:a',5,' only from rejected ACK');return{...f.response(),acknowledged:false};}return value;});
  await assert.rejects(f.client.sync());assertPreserved(f.client,before);assert.equal(f.client.snapshot().blocks[0].data.text,'Hello');
  f.setResponse(value=>value);await f.client.sync();assert.equal(f.client.pending,false);assert.equal(f.client.snapshot().blocks[0].data.text,'Hello only from rejected ACK');assert.equal(f.client.doc,before.document);
});
test('revoked authorization stops synchronization while retaining the same document and offline input',async t=>{
  for(const status of [401,404]){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Offline input');const before=capture(f.client);f.setFail({status});
    await assert.rejects(f.client.sync(),error=>error.status===status);assert.equal(f.client.status,'stale');assertPreserved(f.client,before);const count=f.calls.length;
    await assert.rejects(f.client.sync(),error=>error.code==='ROOM_CLIENT_STOPPED');assert.equal(f.calls.length,count);
  }
});

test('ticket renewal keeps pending local text and long-lived CRDT metadata unchanged even when the server has newer content',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Held unsent input');const before=capture(f.client),generation=f.client.generation;f.remoteInsert('block:a',5,' remote not imported by renew');let events=0;f.client.doc.getText('block:a').observe(()=>{events++;});const receipt=await f.client.renew();assertPreserved(f.client,before);assert.equal(f.client.generation,generation);assert.equal(events,0);assert.equal(f.client.ticket,'renewed-fixture.ticket');assert.equal(f.client.expiresAt,'2026-10-15T01:15:00.000Z');assert.equal(receipt.needsSync,true);assert.equal(receipt.server.sequence,2);assert.equal(f.client.sequence,1);assert.equal(f.client.snapshot().blocks[0].data.text,'Hello');assert.deepEqual(f.calls.at(-1).body,{epoch:'epoch-one',ticket:'signed-fixture'});assert.deepEqual(Object.keys(f.calls.at(-1).body),['epoch','ticket']);await f.client.sync();assert.equal(f.client.pending,false);assert.match(f.client.snapshot().blocks[0].data.text,/remote not imported by renew/);assert.equal(f.draft().title,'Held unsent input');
});
test('input made during renewal remains pending and renewal never creates an acknowledgement',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});let release,received;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{received=resolve;});f.setResponse(async(value,call)=>{if(call.path.endsWith('/renew')){received();await held;}return value;});const document=f.client.doc,id=document.clientID,renewing=f.client.renew();await requested;assert.equal(f.client.busy,true);f.client.setText('title','Typed while renewing');const generation=f.client.generation;await assert.rejects(f.client.sync(),error=>error.code==='ROOM_CLIENT_STOPPED');await assert.rejects(f.client.renew(),error=>error.code==='ROOM_CLIENT_STOPPED');release();const receipt=await renewing;assert.equal(receipt.needsSync,false);assert.equal(f.client.doc,document);assert.equal(document.clientID,id);assert.equal(f.client.generation,generation);assert.equal(f.client.pending,true);assert.equal(f.client.snapshot().title,'Typed while renewing');assert.equal(f.client.busy,false);
});
test('malformed renewal metadata cannot replace tickets advance versions merge updates or clear pending input',async t=>{
 const invalid=[value=>({...value,pageId:'other'}),value=>({...value,sequence:0}),value=>({...value,revision:-1}),value=>({...value,documentVersion:0}),value=>({...value,expiresAt:'invalid'}),value=>({...value,expiresAt:'2026-10-15T00:59:59.000Z'}),value=>({...value,ticket:''}),value=>({...value,ticket:'unsafe\r\nvalue'}),value=>({...value,update:'AA=='}),value=>({...value,acknowledged:true})];for(const rewrite of invalid){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Held input');const before=capture(f.client),ticket=f.client.ticket,expiresAt=f.client.expiresAt;f.setResponse(rewrite);await assert.rejects(f.client.renew(),error=>error.code==='INVALID_ROOM_RESPONSE');assertPreserved(f.client,before);assert.equal(f.client.ticket,ticket);assert.equal(f.client.expiresAt,expiresAt);assert.equal(f.client.status,'ready');assert.equal(f.client.busy,false);}
});
test('renewal rejects epoch or capability changes without rebinding pending input into a new authority',async t=>{
 for(const rewrite of [value=>({...value,epoch:'new-epoch'}),value=>({...value,editable:false})]){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Retained on stop');const before=capture(f.client),ticket=f.client.ticket;f.setResponse(rewrite);await assert.rejects(f.client.renew(),error=>['ROOM_EPOCH_CHANGED','ROOM_NOT_EDITABLE'].includes(error.code));assert.equal(f.client.status,'stale');assertPreserved(f.client,before);assert.equal(f.client.ticket,ticket);}
});
test('renewal handles transient failures and revoked sessions without discarding the old ticket or pending document',async t=>{
 for(const status of [0,401,403,404,503]){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Retained after renewal failure');const before=capture(f.client),ticket=f.client.ticket;f.setFail({status});await assert.rejects(f.client.renew());assertPreserved(f.client,before);assert.equal(f.client.ticket,ticket);assert.equal(f.client.status,[401,403,404].includes(status)?'stale':'ready');assert.equal(f.client.busy,false);}
});
test('late renewal responses never resurrect stopped or destroyed clients or replace their old ticket',async t=>{
 for(const mode of ['stop','destroy']){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Pending when leaving');const before=capture(f.client),ticket=f.client.ticket,expiresAt=f.client.expiresAt;let release,received;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{received=resolve;});f.setResponse(async(value,call)=>{if(call.path.endsWith('/renew')){received();await held;}return value;});const renewing=f.client.renew();await requested;f.client[mode]();release();await assert.rejects(renewing,error=>error.code==='ROOM_CLIENT_STOPPED');assert.equal(f.client.status,mode==='stop'?'stale':'closed');assert.equal(f.client.ticket,ticket);assert.equal(f.client.expiresAt,expiresAt);assert.equal(f.client.pending,true);if(mode==='stop')assertPreserved(f.client,before);else assert.equal(f.client.doc,null);assert.equal(f.client.busy,false);}
});
test('renewal scheduling uses a local clock hint only and never sends a requested TTL or clock',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());assert.equal(f.client.ticketRenewalDue({now:0}),false);await f.client.open({expectedRevision:1});const expiry=Date.parse(f.client.expiresAt);assert.equal(f.client.ticketRenewalDue({now:expiry-60001}),false);assert.equal(f.client.ticketRenewalDue({now:expiry-60000}),true);assert.equal(f.client.ticketRenewalDue({now:expiry+999999}),true);assert.throws(()=>f.client.ticketRenewalDue({now:NaN}));assert.throws(()=>f.client.ticketRenewalDue({withinMs:-1}));await f.client.renew();assert.deepEqual(Object.keys(f.calls.at(-1).body),['epoch','ticket']);assert.equal(f.calls.at(-1).method,'POST');assert.equal(f.calls.at(-1).path.endsWith('/room/renew'),true);
});
test('readonly renewal stays readonly and cannot silently upgrade its ticket capability',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());f.setResponse(value=>({...value,editable:false}));await f.client.open({expectedRevision:1});const document=f.client.doc;assert.equal((await f.client.renew()).editable,false);assert.equal(f.client.doc,document);assert.equal(f.client.editable,false);assert.throws(()=>f.client.setText('title','Forbidden'),error=>error.code==='ROOM_NOT_EDITABLE');const ticket=f.client.ticket;f.setResponse(value=>({...value,editable:true}));await assert.rejects(f.client.renew(),error=>error.code==='ROOM_NOT_EDITABLE');assert.equal(f.client.ticket,ticket);assert.equal(f.client.status,'stale');
});
test('late renewal authorization failures leave a destroyed client closed',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});let release,received;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{received=resolve;});f.setResponse(async(value,call)=>{if(call.path.endsWith('/renew')){received();await held;throw Object.assign(new Error('revoked'),{status:404});}return value;});const renewing=f.client.renew();await requested;f.client.destroy();release();await assert.rejects(renewing,error=>error.status===404);assert.equal(f.client.status,'closed');assert.equal(f.client.doc,null);assert.equal(f.client.busy,false);
});
test('focused sync validates a detached readonly candidate before deferring without changing live state or sending an update',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Held input');const before=capture(f.client),generation=f.client.generation;f.remoteInsert('block:a',5,' remote');let callbacks=0,changes=0;f.client.doc.on('update',()=>{changes++;});
 const result=await f.client.sync({canApply:({phase,draft})=>{assert.equal(phase,'pull');assert.equal(draft.blocks[0].data.text,'Hello remote');assert.equal(draft.title,'Held input');assert.equal(Object.isFrozen(draft),true);assert.equal(Object.isFrozen(draft.blocks[0].data),true);assert.throws(()=>{draft.blocks[0].data.text='tampered';},TypeError);return false;},onApply:()=>{callbacks++;}});
 assert.equal(result.deferred,true);assert.equal(result.pending,true);assert.equal(callbacks,0);assert.equal(changes,0);assert.equal(f.client.generation,generation);assertPreserved(f.client,before);assert.equal(f.calls.filter(call=>call.path.endsWith('/updates')).length,0);assert.equal(f.client.busy,false);
 const later=await f.client.sync();assert.equal(later.deferred,undefined);assert.equal(later.pending,false);assert.equal(f.draft().title,'Held input');assert.equal(f.draft().blocks[0].data.text,'Hello remote');
});

test('a deferred durable response keeps the last accepted basis and pending input then recovers from a fresh GET',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Saved by server but not yet accepted');f.remoteInsert('block:a',5,' remote');let afterPull,calls=[];
 const first=await f.client.sync({canApply:({phase})=>phase==='pull',onApply:event=>{calls.push(event.phase);afterPull=capture(f.client);}});
 assert.equal(first.deferred,true);assert.equal(first.pending,true);assert.deepEqual(calls,['pull']);assertPreserved(f.client,afterPull);assert.equal(f.draft().title,'Saved by server but not yet accepted');assert.ok(f.calls.some(call=>call.path.endsWith('/updates')));const oldRevision=f.client.revision;
 const second=await f.client.sync({onApply:event=>{calls.push(event.phase);}});assert.equal(second.pending,false);assert.ok(second.revision>oldRevision);assert.deepEqual(calls,['pull','pull','ack']);assert.deepEqual(f.client.snapshot(),f.draft());
});

test('same-turn apply hooks align a focused field before the next input can overwrite newly received remote text',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});let domText='Hello',typed=false,appliedPull=false,order=[];f.remoteInsert('block:a',5,' remote');f.client.setText('title','Trigger a pending update');
 f.setResponse((value,call)=>{if(call.path.endsWith('/updates')&&!typed){assert.equal(appliedPull,true);assert.equal(domText,'Hello remote');order.push('post');typed=true;domText+='!';f.client.setText('block:a',domText);}return value;});
 const first=await f.client.sync({canApply:({phase,draft})=>{order.push('check-'+phase);assert.equal(typeof draft.blocks[0].data.text,'string');return true;},onApply:({phase,draft})=>{order.push('apply-'+phase);domText=draft.blocks[0].data.text;if(phase==='pull')appliedPull=true;}});
 assert.equal(first.pending,true);assert.equal(first.draft.blocks[0].data.text,'Hello remote!');assert.deepEqual(order,['check-pull','apply-pull','post','check-ack','apply-ack']);await f.client.sync({onApply:({draft})=>{domText=draft.blocks[0].data.text;}});assert.equal(f.draft().blocks[0].data.text,'Hello remote!');assert.equal(domText,'Hello remote!');assert.equal(f.client.pending,false);
});

test('input committed while a GET is in flight remains unchanged when composition defers the received candidate',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.remoteInsert('block:a',5,' remote');let release,received;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{received=resolve;});f.setResponse(async(value,call)=>{if(call.method==='GET'){received();await held;}return value;});let seen;
 const syncing=f.client.sync({canApply:({draft})=>{seen=draft;return false;}});await requested;f.client.setText('title','Typed during network wait');const before=capture(f.client),generation=f.client.generation;release();const result=await syncing;
 assert.equal(result.deferred,true);assert.equal(seen.title,'Typed during network wait');assertPreserved(f.client,before);assert.equal(f.client.generation,generation);assert.equal(f.client.snapshot().blocks[0].data.text,'Hello');
});

test('malformed responses fail before canApply and never use composition deferral to bypass complete validation',async t=>{
 for(const malformed of [unsupportedResponse,value=>({...value,stateVector:toBase64(new Uint8Array([0]))}),value=>({...value,revision:0})]){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Held');f.remoteInsert('block:a',5,' remote');const before=capture(f.client);let called=0;f.setResponse(malformed);await assert.rejects(f.client.sync({canApply:()=>{called++;return false;},onApply:()=>{called++;}}));assert.equal(called,0);assertPreserved(f.client,before);}
});

test('synchronous hook failures stop editing while keeping the long-lived document and avoiding additional writes',async t=>{
 for(const mode of ['check-throw','check-promise','check-nonboolean','apply-throw','apply-promise']){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Held input');f.remoteInsert('block:a',5,' remote');const document=f.client.doc,before=capture(f.client),options=mode.startsWith('check')?{canApply:()=>{if(mode==='check-throw')throw Error('private callback detail');return mode==='check-promise'?Promise.resolve(true):undefined;}}:{onApply:()=>{if(mode==='apply-throw')throw Error('private callback detail');return Promise.resolve();}};await assert.rejects(f.client.sync(options),error=>error.code==='ROOM_APPLY_FAILED'&&!error.message.includes('private'));assert.equal(f.client.status,'stale');assert.equal(f.client.doc,document);assert.equal(f.client.pending,true);assert.equal(f.calls.filter(call=>call.path.endsWith('/updates')).length,0);assert.throws(()=>f.client.setText('title','Not allowed'),error=>error.code==='ROOM_NOT_EDITABLE');if(mode.startsWith('check'))assertPreserved(f.client,before);}
});

test('a hook which stops or changes input during preflight cannot commit an outdated candidate',async t=>{
 for(const mode of ['stop','input']){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.remoteInsert('block:a',5,' remote');const before=capture(f.client);await assert.rejects(f.client.sync({canApply:()=>{if(mode==='stop')f.client.stop();else f.client.setText('title','Changed during preflight');return true;}}),error=>['ROOM_CLIENT_STOPPED','ROOM_APPLY_FAILED'].includes(error.code));assert.equal(f.client.status,'stale');assert.equal(f.client.doc,before.document);assert.equal(f.client.snapshot().blocks[0].data.text,'Hello');assert.equal(f.calls.filter(call=>call.path.endsWith('/updates')).length,0);}
});

test('late GET ACK and open responses never revive stopped or destroyed clients or invoke apply hooks',async t=>{
 for(const phase of ['open','pull','ack'])for(const mode of ['stop','destroy']){const f=fixture();t.after(()=>f.client.destroy());if(phase!=='open'){await f.client.open({expectedRevision:1});f.client.setText('title','Kept while leaving');}const before=f.client.doc?capture(f.client):null;let release,received,applies=0;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{received=resolve;});f.setResponse(async(value,call)=>{if(phase==='open'&&call.path.endsWith('/open')||phase==='pull'&&call.method==='GET'||phase==='ack'&&call.path.endsWith('/updates')){received();await held;}return value;});const pending=phase==='open'?f.client.open({expectedRevision:1}):f.client.sync({onApply:()=>{applies++;}});await requested;f.client[mode]();release();await assert.rejects(pending,error=>error.code==='ROOM_CLIENT_STOPPED');assert.equal(f.client.status,mode==='stop'?'stale':'closed');assert.equal(applies,phase==='ack'?1:0);if(before&&mode==='stop')assertPreserved(f.client,before);if(mode==='destroy')assert.equal(f.client.doc,null);assert.equal(f.client.busy,false);}
});

test('relative selections retain forward backward and collapsed carets across remote edits without changing document identity',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});const document=f.client.doc,forward=f.client.captureRelativeSelection({key:'block:a',start:1,end:4,direction:'forward'}),backward=f.client.captureRelativeSelection({key:'block:a',start:1,end:4,direction:'backward'}),caret=f.client.captureRelativeSelection({key:'block:a',start:2,end:2});assert.ok(forward);assert.equal(Object.isFrozen(forward),true);assert.deepEqual(Object.keys(forward),[]);f.remoteInsert('block:a',0,'remote ');await f.client.sync();assert.equal(f.client.doc,document);assert.deepEqual(f.client.resolveRelativeSelection(forward),{key:'block:a',start:8,end:11,direction:'forward'});assert.deepEqual(f.client.resolveRelativeSelection(backward),{key:'block:a',start:8,end:11,direction:'backward'});assert.deepEqual(f.client.resolveRelativeSelection(caret),{key:'block:a',start:9,end:9,direction:'none'});
});

test('relative selections reject unknown roots invalid UTF16 endpoints forged markers and other client or stopped scopes',async t=>{
 const f=fixture(),other=fixture();t.after(()=>f.client.destroy());t.after(()=>other.client.destroy());assert.equal(f.client.captureRelativeSelection({key:'title',start:0}),null);await f.client.open({expectedRevision:1});await other.client.open({expectedRevision:1});f.client.setText('title','A\ud83d\ude00B');for(const selection of [{key:'unknown',start:0},{key:'block:missing',start:0},{key:'title',start:-1},{key:'title',start:3,end:2},{key:'title',start:2,end:3},{key:'title',start:0,end:9},{key:'title',start:0,direction:'invalid'}])assert.equal(f.client.captureRelativeSelection(selection),null);const marker=f.client.captureRelativeSelection({key:'title',start:1,end:3,direction:'backward'});assert.deepEqual(f.client.resolveRelativeSelection(marker),{key:'title',start:1,end:3,direction:'backward'});assert.equal(other.client.resolveRelativeSelection(marker),null);assert.equal(f.client.resolveRelativeSelection({}),null);assert.equal(f.client.resolveRelativeSelection(JSON.parse(JSON.stringify(marker))),null);assert.equal(f.client.doc.share.has('block:missing'),false);f.client.stop();assert.equal(f.client.resolveRelativeSelection(marker),null);other.client.destroy();assert.equal(other.client.resolveRelativeSelection(marker),null);
});

test('relative markers survive deferred responses and renewals without importing remote content',async t=>{
 const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});const marker=f.client.captureRelativeSelection({key:'block:a',start:3});f.remoteInsert('block:a',0,'remote ');await f.client.sync({canApply:()=>false});assert.deepEqual(f.client.resolveRelativeSelection(marker),{key:'block:a',start:3,end:3,direction:'none'});await f.client.renew();assert.deepEqual(f.client.resolveRelativeSelection(marker),{key:'block:a',start:3,end:3,direction:'none'});await f.client.sync();assert.deepEqual(f.client.resolveRelativeSelection(marker),{key:'block:a',start:10,end:10,direction:'none'});
});

test('a synchronous document observer cannot revive a stopped or destroyed client or leave failed DOM binding editable',async t=>{
 for(const mode of ['stop','destroy','throw']){const f=fixture();t.after(()=>f.client.destroy());await f.client.open({expectedRevision:1});f.client.setText('title','Retained input');const before=capture(f.client);f.remoteInsert('block:a',5,' remote');let applied=0;f.client.doc.getText('block:a').observe(()=>{if(mode==='throw')throw Error('private observer detail');f.client[mode]();});await assert.rejects(f.client.sync({onApply:()=>{applied++;}}),error=>['ROOM_CLIENT_STOPPED','ROOM_APPLY_FAILED'].includes(error.code)&&!error.message.includes('private'));assert.equal(f.client.status,mode==='destroy'?'closed':'stale');assert.equal(applied,0);assert.equal(f.client.pending,true);assert.equal(f.client.revision,before.revision);assert.equal(f.calls.filter(call=>call.path.endsWith('/updates')).length,0);if(mode==='destroy')assert.equal(f.client.doc,null);else assert.equal(f.client.doc,before.document);}
});
