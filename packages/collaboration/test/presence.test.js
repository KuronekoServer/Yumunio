import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomDocument,Y,toBase64} from '../src/index.js';
import {HttpRoomClient} from '../src/client.js';
import {PRESENCE_LIMITS,validatePresenceCursor,validatePresenceSnapshot} from '../src/presence.js';
const draft={title:'Presence',blocks:[{id:'body',type:'paragraph',data:{text:'A\u{1f600}B'}},{id:'source',type:'code',data:{text:'Source',purpose:'import-source'}}]},cursor={blockId:'body',start:1,end:3,direction:'forward'};
const columnsDraft={title:'Column presence',blocks:[{id:'group',type:'columns',children:[{id:'left',type:'column',children:[{id:'body',type:'paragraph',data:{text:'A\u{1f600}B'}}]},{id:'right',type:'column',children:[{id:'right-body',type:'paragraph',data:{text:'Right'}}]}]}]};
function fixture(t,{draft:clientDraft=draft}={}){
 const doc=createRoomDocument(clientDraft),calls=[],selfId='a'.repeat(32),peerId='b'.repeat(32);let responseOverride=null,blockRequest=null;
 const snapshot=()=>{const serverTime=new Date().toISOString();return{pageId:'page',epoch:'epoch',sequence:1,documentVersion:1,selfId,ttlMs:PRESENCE_LIMITS.ttlMs,serverTime,participants:[{id:selfId,displayName:'Synthetic owner',self:true,cursor,expiresAt:new Date(Date.parse(serverTime)+30000).toISOString()},{id:peerId,displayName:'Synthetic viewer',self:false,cursor:null,expiresAt:new Date(Date.parse(serverTime)+30000).toISOString()}]};};
 const client=new HttpRoomClient({accountId:'owner',workspaceId:'workspace',pageId:'page',draft:clientDraft,request:async call=>{calls.push(structuredClone(call));if(call.path.endsWith('/open'))return{revision:2,pageId:'page',epoch:'epoch',sequence:1,documentVersion:1,editable:true,ticket:'synthetic.ticket',expiresAt:new Date(Date.now()+900000).toISOString(),update:toBase64(Y.encodeStateAsUpdate(doc)),stateVector:toBase64(Y.encodeStateVector(doc))};if(call.path.endsWith('/presence')){if(blockRequest)await blockRequest(call);if(responseOverride)throw responseOverride;if(call.method==='DELETE')return{left:true};return snapshot();}throw new Error('Unexpected synthetic request');}});t.after(()=>{client.destroy();doc.destroy();});return{client,calls,snapshot,setError:value=>{responseOverride=value;},block:callback=>{blockRequest=callback;}};
}
test('presence cursors are block-only UTF16 boundaries and never target readonly source blocks',()=>{
 assert.deepEqual(validatePresenceCursor(cursor,draft),cursor);assert.equal(validatePresenceCursor(null,draft),null);
 for(const value of [{...cursor,start:2},{...cursor,end:2},{...cursor,start:-1},{...cursor,end:9},{...cursor,blockId:'source'},{...cursor,blockId:'title'},{...cursor,extra:'private'},{...cursor,direction:'rtl'}])assert.throws(()=>validatePresenceCursor(value,draft));
 assert.equal(validatePresenceCursor({...cursor,start:3,end:3,direction:'backward'},draft).direction,'none');
});
test('presence wire snapshots reject unknown metadata, duplicate IDs and unsafe names while newer text hides offsets',t=>{
 const f=fixture(t),value=f.snapshot(),context={pageId:'page',epoch:'epoch',sequence:1,documentVersion:1,draft};assert.equal(validatePresenceSnapshot(value,context).participants.length,2);
 for(const change of [v=>{v.accountId='hidden';},v=>{v.participants.push(v.participants[0]);},v=>{v.participants[0].displayName='bad\nname';},v=>{v.participants[0].self=false;},v=>{v.participants[0].cursor.start=2;},v=>{v.participants[0].expiresAt=v.serverTime;}]){const bad=structuredClone(value);change(bad);assert.throws(()=>validatePresenceSnapshot(bad,context));}
 assert.equal(validatePresenceSnapshot({...value,sequence:2},context).participants[0].cursor,null);
});
test('presence polling and leaving never acknowledge text or mutate CRDT, and local TTL hides idle peers',async t=>{
 const f=fixture(t);await f.client.open({expectedRevision:1});const bytes=toBase64(Y.encodeStateAsUpdate(f.client.doc)),id=f.client.doc.clientID;
 const value=await f.client.publishPresence({cursor});assert.equal(value.participants.length,2);assert.deepEqual(f.calls.at(-1).body.cursor,cursor);assert.equal(f.calls.at(-1).headers['X-Yumunio-Presence-Client'],f.client.presenceClientId);assert.equal(f.client.pending,false);assert.equal(f.client.doc.clientID,id);assert.equal(toBase64(Y.encodeStateAsUpdate(f.client.doc)),bytes);
 assert.equal(f.client.presenceSnapshot({now:Date.now()+31000}).participants.length,0);await f.client.readPresence();assert.equal(f.client.presenceSnapshot().participants.length,2);assert.deepEqual(await f.client.leavePresence(),{left:true});assert.equal(f.client.presenceSnapshot(),null);assert.equal(f.client.pending,false);
});
test('pending input publishes no misleading offsets and in-progress sync defers presence without requests',async t=>{
 const f=fixture(t);await f.client.open({expectedRevision:1});f.client.setText('block:body','Pending text');const bytes=toBase64(Y.encodeStateAsUpdate(f.client.doc)),generation=f.client.generation;await f.client.publishPresence({cursor});assert.equal(f.calls.at(-1).body.cursor,null);assert.ok(f.client.presenceSnapshot().participants.every(item=>item.cursor===null));assert.equal(f.client.pending,true);assert.equal(f.client.generation,generation);assert.equal(toBase64(Y.encodeStateAsUpdate(f.client.doc)),bytes);f.client.busy=true;const count=f.calls.length;assert.deepEqual(await f.client.publishPresence({cursor}),{deferred:true});assert.equal(f.calls.length,count);f.client.busy=false;
});
test('revoked and late presence cannot retain peers or resurrect destroyed clients',async t=>{
 const f=fixture(t);await f.client.open({expectedRevision:1});await f.client.readPresence();f.setError({status:404,code:'CONTENT_NOT_FOUND'});await assert.rejects(f.client.readPresence());assert.equal(f.client.status,'stale');assert.equal(f.client.presenceSnapshot(),null);
 const g=fixture(t);await g.client.open({expectedRevision:1});let release,entered;const started=new Promise(resolve=>{entered=resolve;});g.block(()=>{entered();return new Promise(resolve=>{release=resolve;});});const pending=g.client.readPresence();await started;g.client.destroy();release();await assert.rejects(pending,error=>error.code==='ROOM_CLIENT_STOPPED');assert.equal(g.client.status,'closed');assert.equal(g.client.presenceSnapshot(),null);
});
test('leave clears immediately but waits for an in-flight publish before DELETE even when the client is destroyed',async t=>{
 const f=fixture(t);await f.client.open({expectedRevision:1});await f.client.readPresence();let release,entered;const started=new Promise(resolve=>{entered=resolve;});f.block(call=>call.method==='POST'?new Promise(resolve=>{release=resolve;entered();}):undefined);
 const publish=f.client.publishPresence({cursor});await started;const leaving=f.client.leavePresence();assert.equal(f.client.presenceSnapshot(),null);assert.equal(f.calls.at(-1).method,'POST');f.client.destroy();release();await assert.rejects(publish,error=>error.code==='ROOM_CLIENT_STOPPED');assert.deepEqual(await leaving,{left:true});assert.equal(f.calls.at(-1).method,'DELETE');assert.equal(f.client.status,'closed');assert.equal(f.client.presenceSnapshot(),null);
});
test('client text and presence traverse canonical columns but reject wrapper roots, nested columns and unknown ancestry',async t=>{
 assert.deepEqual(validatePresenceCursor(cursor,columnsDraft),cursor);assert.throws(()=>validatePresenceCursor({...cursor,blockId:'left'},columnsDraft));
 const f=fixture(t,{draft:columnsDraft});await f.client.open({expectedRevision:1});await f.client.publishPresence({cursor});assert.deepEqual(f.calls.at(-1).body.cursor,cursor);f.client.setText('block:body','A\u{1f600}B!');assert.equal(f.client.snapshot().blocks[0].children[0].children[0].data.text,'A\u{1f600}B!');assert.throws(()=>f.client.setText('block:left','Invalid wrapper'));
 const unknown={title:'Unknown ancestor',blocks:[{id:'future',type:'future-kind',data:{},children:structuredClone(columnsDraft.blocks)}]};assert.throws(()=>validatePresenceCursor(cursor,unknown));
 const nested=structuredClone(columnsDraft);nested.blocks[0].children[0].children.push({id:'nested-group',type:'columns',children:[{id:'nested-left',type:'column',children:[{id:'nested-left-body',type:'paragraph',data:{text:'Left'}}]},{id:'nested-right',type:'column',children:[{id:'nested-right-body',type:'paragraph',data:{text:'Right'}}]}]});assert.throws(()=>validatePresenceCursor(cursor,nested));assert.throws(()=>createRoomDocument(nested));
 const detached={title:'Detached wrapper',blocks:[{id:'detached',type:'column',children:[{id:'detached-body',type:'paragraph',data:{text:'Detached'}}]}]};assert.throws(()=>createRoomDocument(detached));
});
