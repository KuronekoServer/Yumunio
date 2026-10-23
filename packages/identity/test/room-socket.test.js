import test from 'node:test';
import assert from 'node:assert/strict';
import {processRoomSocketFrame,roomSocketScope,readRoomSocketPeer} from '../src/room-socket.js';

test('socket frames cannot change their account, page, cookies, protocol or repeat a mutation id',async()=>{
 const state={...roomSocketScope('/api/content/workspaces/w/pages/p/room/ws'),origin:'https://socket.fixture.invalid',accountId:'owner',cookie:'private-fixture-cookie',lastId:0,lastSeen:Date.now(),rateAt:Date.now(),rate:0,joined:null};let calls=0;
 const dispatch=async request=>{calls++;assert.equal(request.url,'https://socket.fixture.invalid/api/content/workspaces/w/pages/p/room');assert.equal(request.headers.get('cookie'),'private-fixture-cookie');return Response.json({pageId:'p',epoch:'epoch'});};
 const frame={type:'request',id:1,method:'GET',suffix:'',headers:{'X-Yumunio-Expected-Account':'owner','X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Ticket':'fixture-ticket'}};
 for(const invalid of [{...frame,path:'/another-page'},{...frame,suffix:'/../q'},{...frame,headers:{...frame.headers,Cookie:'replace'}},{...frame,headers:{...frame.headers,'X-Yumunio-Expected-Account':'other'}},{...frame,headers:{...frame.headers,'X-Yumunio-Room-Protocol':'1'}}])await assert.rejects(processRoomSocketFrame(state,JSON.stringify(invalid),dispatch),{code:'ROOM_SOCKET_PROTOCOL'});
 assert.equal(calls,0);
 await processRoomSocketFrame(state,JSON.stringify(frame),dispatch);assert.equal(calls,1);
 await assert.rejects(processRoomSocketFrame(state,JSON.stringify(frame),dispatch),{code:'ROOM_SOCKET_PROTOCOL'});assert.equal(calls,1);
 await assert.rejects(processRoomSocketFrame(state,new Uint8Array([1,2]),dispatch),{code:'ROOM_SOCKET_PROTOCOL'});
 await assert.rejects(processRoomSocketFrame(state,' '.repeat(100001),dispatch),{code:'ROOM_SOCKET_PROTOCOL'});assert.equal(calls,1);
});
test('a peer push requests only the Yjs structs the client reported and never trusts a response vector',async()=>{
 const state={...roomSocketScope('/api/content/workspaces/w/pages/p/room/ws'),origin:'https://socket.fixture.invalid',accountId:'owner',cookie:'private-fixture-cookie',lastId:0,lastSeen:Date.now(),rateAt:Date.now(),rate:0,joined:null};
 const dispatch=async request=>Response.json({update:'AAA=',stateVector:'server-vector'});
 const base={'X-Yumunio-Expected-Account':'owner','X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Ticket':'fixture-ticket'};
 await processRoomSocketFrame(state,JSON.stringify({type:'request',id:1,method:'GET',suffix:'',headers:base}),dispatch);
 assert.equal(state.vector,null);
 await processRoomSocketFrame(state,JSON.stringify({type:'request',id:2,method:'POST',suffix:'/updates',headers:{...base,'X-Yumunio-State-Vector':'client-vector'},body:{epoch:'epoch',ticket:'fixture-ticket',update:'AAA='}}),dispatch);
 assert.equal(state.vector,'client-vector');
 const seen=[];
 await readRoomSocketPeer(state,async request=>{seen.push(request.headers.get('x-yumunio-state-vector'));return Response.json({update:'AAA=',stateVector:'server-vector'});});
 assert.deepEqual(seen,['client-vector']);
 await processRoomSocketFrame(state,JSON.stringify({type:'request',id:3,method:'POST',suffix:'/presence',headers:base,body:{epoch:'epoch',ticket:'fixture-ticket',clientId:'fixture'}}),dispatch);
 assert.equal(state.vector,'client-vector');
});