import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {WebSocket} from 'ws';
import {getMigrations} from 'better-auth/db/migration';
import {hashPassword} from 'better-auth/crypto';
import {createNodeIdentityService} from '../identity.mjs';
import {createAppServer} from '../server.mjs';
import {exerciseRealtimeRoom} from '../../../packages/identity/test/fixtures/realtime-room-flow.js';

test('Node WebSockets deliver durable Yjs changes and cursors to another account, reconnect and enforce current permissions',{timeout:60000},async t=>{
 const prefix='yumunio-realtime-node-',directory=await mkdtemp(join(tmpdir(),prefix)),database=join(directory,'accounts.sqlite');let service,db;
 const server=createAppServer({runtimeProvider:async()=>({identity:service,publicOrigin:origin})});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db?.close();await service?.close();const absolute=await realpath(directory);assert.equal(dirname(absolute).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(absolute).startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 service=await createNodeIdentityService({YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_AUTH_SECRET:'Synthetic-realtime-websocket-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'},{storage:'sqlite',database},{verifySchema:false});
 await(await getMigrations(service.auth.options)).runMigrations();await service.migrateContentSchema();db=new DatabaseSync(database);
 const stamp=Date.now(),password='Synthetic-Realtime-Room-Fixture-2026!',hash=await hashPassword(password),workspaceId='realtime-workspace';
 for(const[id,role]of[['realtime-owner','owner'],['realtime-member','member']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').run('credential-'+id,id,'credential',id,hash,stamp,stamp);}
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Realtime WebSockets','synthetic-realtime',stamp);for(const[id,role]of[['realtime-owner','owner'],['realtime-member','member']])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('member-'+id,workspaceId,id,role,stamp);
 const request=(path,{method='GET',body,account,headers={}}={})=>fetch(origin+path,{method,headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password}});assert.equal(response.status,200);return{id:(await response.json()).user.id,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};};
 await exerciseRealtimeRoom({origin,request,owner:await login('realtime-owner'),member:await login('realtime-member'),workspaceId,
  Socket:account=>class extends WebSocket{constructor(url){super(url,{headers:{Origin:origin,Cookie:account.cookie}});}},
  denyUpgrade:async(path,account,suppliedOrigin,status)=>{await new Promise((resolve,reject)=>{const socket=new WebSocket(origin.replace('http:','ws:')+path,{headers:{Origin:suppliedOrigin,...(account?{Cookie:account.cookie}:{})}});socket.on('error',()=>{});socket.on('open',()=>{socket.close();reject(Error('Unexpected WebSocket upgrade.'));});socket.on('unexpected-response',(_request,response)=>{response.resume();socket.terminate();try{assert.equal(response.statusCode,status);resolve();}catch(error){reject(error);}});});}
 });
});
