import assert from 'node:assert/strict';
import {HttpRoomClient,RoomSocketTransport} from '@yumunio/collaboration/client';
const deadline=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('WebSocket event deadline exceeded.')),10000);})]);}finally{clearTimeout(timer);}};

/** Uses actual sockets and the production Yjs client. No polling drives delivery. */
export async function exerciseRealtimeRoom({origin,request,owner,member,workspaceId,Socket,denyUpgrade}){
 const base='/api/content/workspaces/'+workspaceId,ok=async response=>{assert.ok(response.ok,'HTTP '+response.status);return response.json();};
 const initial=await ok(await request(base+'/pages',{account:owner}));
 const page=await ok(await request(base+'/pages',{account:owner,method:'POST',body:{expectedRevision:initial.revision,title:'Realtime Yjs',blocks:[{id:'shared',type:'paragraph',data:{text:'shared'}}]}})),path=base+'/pages/'+page.page.id;
 let revision=(await ok(await request(path+'/grants',{account:owner,method:'POST',body:{expectedRevision:page.revision,accountId:member.id,permission:'editor'}}))).revision;
 const peers=[];
 const create=account=>{
  const peer={notices:[],waiters:[],ready:0};
  peer.client=new HttpRoomClient({accountId:account.id,workspaceId,pageId:page.page.id,draft:{title:page.page.title,blocks:page.document.blocks},protocol:2,request:async call=>{
   if(peer.wire)return peer.wire.request(call);
   const response=await request(call.path,{account,method:call.method,headers:call.headers,body:call.body}),value=await response.json();if(!response.ok)throw Object.assign(Error('Room rejected.'),{code:value.error?.code,status:response.status});return value;
  }});
  peer.wait=kind=>{const at=peer.notices.length;return deadline(new Promise(resolve=>peer.waiters.push({kind,at,resolve})));};
  peer.notice=kind=>{peer.notices.push(kind);for(const waiter of peer.waiters.splice(0)){if(waiter.kind===kind&&peer.notices.length>waiter.at)waiter.resolve();else peer.waiters.push(waiter);}};
  peers.push(peer);return peer;
 };
 const left=create(owner),right=create(member);let stage='open';
 try{
  await left.client.open({expectedRevision:revision});await right.client.open({expectedRevision:left.client.revision});
  for(const[peer,account]of[[left,owner],[right,member]]){
   const url=new URL(path+'/room/ws',origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';
   peer.wire=new RoomSocketTransport({url:url.href,WebSocket:Socket(account),headers:()=>peer.client.requestHeaders({'X-Yumunio-Room-Ticket':peer.client.ticket}),onChange:peer.notice,onReady:()=>{peer.ready++;peer.notice('ready');},onDisconnect:details=>{if(details.permanent)peer.client.stop();}});
   await peer.wire.connect();
  }
  stage='push';const pushed=right.wait('content');left.client.setText('block:shared','A shared');await left.client.sync();await pushed;
  await right.client.sync();assert.equal(right.client.snapshot().blocks[0].data.text,'A shared');
  stage='concurrent';left.client.setText('block:shared','Left A shared');right.client.setText('block:shared','A shared Right');
  await Promise.all([left.client.sync(),right.client.sync()]);await left.client.sync();await right.client.sync();
  assert.deepEqual(left.client.snapshot(),right.client.snapshot());assert.equal(left.client.snapshot().blocks[0].data.text,'Left A shared Right');
  stage='presence';const presence=right.wait('presence');await left.client.publishPresence({cursor:{blockId:'shared',start:0,end:1,direction:'forward'}});await presence;
  await right.client.publishPresence({cursor:{blockId:'shared',start:2,end:2,direction:'none'}});
  const roster=await left.client.readPresence();assert.equal(roster.participants.length,2);assert.equal(roster.participants.filter(row=>row.cursor!==null).length,2);
  const saved=await ok(await request(path,{account:owner}));assert.deepEqual(saved.document.blocks,left.client.snapshot().blocks);
  stage='same-account-push';
  const secondDevice=create(owner),pushedWhileBusy=new Map(),deviceCalls=[];
  await secondDevice.client.open({expectedRevision:saved.revision});
  const receive=(peer,value)=>{const result=peer.client.receive(value);if(result.deferred)pushedWhileBusy.set(peer,value);peer.notice('state');};
  secondDevice.wire=new RoomSocketTransport({url:new URL(path+'/room/ws',origin).href.replace(/^http/,'ws'),WebSocket:Socket(owner),headers:()=>secondDevice.client.requestHeaders({'X-Yumunio-Room-Ticket':secondDevice.client.ticket,'X-Yumunio-Room-Push':'1'}),onState:value=>receive(secondDevice,value),onChange:secondDevice.notice});
  await secondDevice.wire.connect();
  left.wire.onState=value=>receive(left,value);
  const joined=await left.wire.rpc({suffix:'',method:'GET',headers:left.client.requestHeaders({'X-Yumunio-Room-Ticket':left.client.ticket,'X-Yumunio-Room-Push':'1'})});receive(left,joined);
  for(const peer of [left,secondDevice])peer.client.request=call=>{deviceCalls.push(call);return peer.wire.request(call);};
  assert.notEqual(left.client.doc.clientID,secondDevice.client.doc.clientID);assert.notEqual(left.client.presenceClientId,secondDevice.client.presenceClientId);
  const leftPush=left.wait('state'),devicePush=secondDevice.wait('state'),text=left.client.snapshot().blocks[0].data.text;
  left.client.setText('block:shared','端末A '+text);secondDevice.client.setText('block:shared',text+' 端末B');
  await Promise.all([left.client.sync({pushFirst:true}),secondDevice.client.sync({pushFirst:true})]);await Promise.all([leftPush,devicePush]);
  for(const[peer,value]of pushedWhileBusy){assert.notEqual(peer.client.receive(value).deferred,true);}pushedWhileBusy.clear();
  assert.deepEqual(left.client.snapshot(),secondDevice.client.snapshot());assert.equal(left.client.snapshot().blocks[0].data.text,'端末A '+text+' 端末B');
  assert.ok(deviceCalls.length>=2&&deviceCalls.every(call=>call.method==='POST'&&call.path.endsWith('/updates')),'push delivery must not pull after each notification');
  await secondDevice.client.publishPresence({cursor:null});const devices=await left.client.readPresence();assert.equal(devices.participants.length,3);
  stage='reconnect';left.client.setText('block:shared','Retained '+left.client.snapshot().blocks[0].data.text);
  const reconnect=left.wait('ready');left.wire.socket.close(1012);await reconnect;assert.equal(left.client.pending,true);assert.equal(left.ready,2);
  await left.client.sync();await right.client.sync();assert.deepEqual(left.client.snapshot(),right.client.snapshot());assert.equal(left.client.pending,false);
  if(denyUpgrade){await denyUpgrade(path+'/room/ws',owner,'https://foreign.fixture.invalid',403);await denyUpgrade(path+'/room/ws',null,origin,401);}
  stage='downgrade';right.client.setText('block:shared','Must remain unsent after downgrade');const held=right.client.snapshot();
  const current=await ok(await request(path,{account:owner}));await ok(await request(path+'/grants',{account:owner,method:'POST',body:{expectedRevision:current.revision,accountId:member.id,permission:'viewer',includeDescendants:false}}));
  await assert.rejects(right.client.sync(),error=>['ROOM_NOT_EDITABLE','ROOM_EPOCH_CHANGED','ROOM_CLIENT_STOPPED','ROOM_SOCKET_CLOSED'].includes(error.code)||[401,403,404].includes(error.status));assert.equal(right.client.pending,true);assert.deepEqual(right.client.snapshot(),held);
  const unchanged=await ok(await request(path,{account:owner}));assert.notEqual(unchanged.document.blocks[0].data.text,'Must remain unsent after downgrade');
  await left.client.leavePresence().catch(()=>{});
 }catch(error){error.fixtureStage=stage;console.log('Synthetic realtime failure:',stage,error.code||error.message);throw error;}finally{for(const peer of peers){peer.wire?.close();peer.client.destroy();}}
}
