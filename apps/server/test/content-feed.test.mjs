import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {getMigrations} from 'better-auth/db/migration';
import {createIdentity} from '@yumunio/identity';
import {createAccountContentApi} from '@yumunio/identity/content';
import {createSqliteContentStore} from '@yumunio/identity/content-store';
import {createAppServer} from '../server.mjs';
import {SqliteSnapshotStore} from '../snapshot-store.mjs';

test('Node HTTP Feed views preserve saved order across new services and reject stale writes',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'feed-legacy-fixture-'.repeat(3),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret:'feed-http-fixture-not-a-real-secret-123456',registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const store=createSqliteContentStore(legacy.database),connect=()=>{identity.content=createAccountContentApi({store,origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});};connect();
  let cookie,accountId;
  const request=(path,{method='GET',body,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie,'X-Yumunio-Expected-Account':accountId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='feed-http@example.invalid',password='feed-http-fictional-password';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic Feed owner',email,password}}),202);await identity.flushBackgroundTasks();
  const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account')));
  const signed=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}}),user=(await ok(signed)).user;cookie=signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');accountId=user.id;
  const workspace=await ok(await request('/api/auth/organization/create',{method:'POST',body:{name:'Chart HTTP fixture',slug:'feed-http-fixture'}})),base='/api/content/workspaces/'+workspace.id;

 const collection=await ok(await request(base+'/collections',{method:'POST',body:{expectedRevision:0,title:'Synthetic Feed',parentId:null,properties:[{id:'status',name:'Status',type:'select',options:['New','Done']},{id:'amount',name:'Amount',type:'number'}]}}),201),path=base+'/collections/'+collection.collectionId;
 const first=(await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:1,title:'First <b>literal</b>',values:{status:'New',amount:3}}}),201)).record;
 await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:2,title:'Second',values:{status:'New',amount:5}}}),201);
 await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:3,title:'Filtered',values:{status:'Done',amount:100}}}),201);
 const view={name:'Saved Feed',type:'feed',filters:[{propertyId:'status',operator:'eq',value:'New'}],sorts:[{propertyId:'amount',direction:'desc'}],groupBy:null,datePropertyId:null,endDatePropertyId:null},saved=await ok(await request(path+'/views',{method:'POST',body:{expectedRevision:4,view}}),201),feedPath=path+'/views/'+saved.viewId;
 let result=await ok(await request(feedPath));assert.deepEqual(result.collection.records.map(record=>record.title),['Second','First <b>literal</b>']);assert.equal(Object.hasOwn(result,'groups'),false);assert.equal(Object.hasOwn(result,'chart'),false);
 await ok(await request(path+'/records/'+first.id,{method:'PATCH',body:{expectedRevision:5,values:{amount:8}}}));connect();result=await ok(await request(feedPath));assert.deepEqual(result.collection.records.map(record=>record.title),['First <b>literal</b>','Second']);assert.deepEqual({...result.view,id:undefined},{...view,id:undefined});
 const stale=await request(feedPath,{method:'PATCH',body:{expectedRevision:5,view:{...view,name:'Retained draft'}}});assert.equal(stale.status,409);await stale.arrayBuffer();assert.equal((await store.read(workspace.id,user.id)).revision,6);
 const mismatch=await request(feedPath,{headers:{'X-Yumunio-Expected-Account':'other-account'}});assert.equal(mismatch.status,404);await mismatch.arrayBuffer();
 await ok(await request('/api/auth/sign-out',{method:'POST',body:{}}));const signedOut=await request(feedPath);assert.equal(signedOut.status,401);await signedOut.arrayBuffer();
});
