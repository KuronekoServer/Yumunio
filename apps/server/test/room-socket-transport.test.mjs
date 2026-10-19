import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {RoomSocketTransport} from '../../../packages/collaboration/src/socket-client.js';

test('a lost WebSocket acknowledgement reconnects without replaying the committed mutation and never crosses page scope',{timeout:10000},async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let writes=0,connections=0,readyResolve;
 const readyAgain=new Promise(resolve=>readyResolve=resolve);
 server.on('connection',socket=>{connections++;socket.on('message',raw=>{const message=JSON.parse(String(raw));if(message.suffix==='/updates'){writes++;socket.close(1012);return;}socket.send(JSON.stringify({type:'response',id:message.id,status:200,body:{writes}}));});});
 const path='/api/content/workspaces/workspace/pages/page/room',wire=new RoomSocketTransport({url:'ws://127.0.0.1:'+server.address().port+path+'/ws',WebSocket,headers:()=>({'X-Yumunio-Expected-Account':'fixture'}),onReady:()=>{if(connections===2)readyResolve();}});
 t.after(async()=>{wire.close();for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));});
 await wire.connect();
 await assert.rejects(wire.request({path:'/api/content/workspaces/other/pages/page/room',method:'GET',headers:{}}),{message:'INVALID_ROOM_SOCKET_SCOPE'});
 await assert.rejects(wire.request({path:path+'/updates',method:'POST',headers:{},body:{update:'already committed'}}),{code:'ROOM_SOCKET_CLOSED'});
 await readyAgain;assert.equal(writes,1);
 const state=await wire.request({path,method:'GET',headers:{}});assert.equal(state.writes,1);assert.equal(writes,1);
});
