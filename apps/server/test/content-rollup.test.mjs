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

test('Node HTTP rollups compute related records without authored values and preserve CAS and target deletion boundaries',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'formula-legacy-fixture-'.repeat(3),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret:'rollup-http-fixture-not-a-real-secret-123456',registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const store=createSqliteContentStore(legacy.database),connect=()=>{identity.content=createAccountContentApi({store,origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});};connect();
  let cookie,accountId;
  const request=(path,{method='GET',body,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie,'X-Yumunio-Expected-Account':accountId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='rollup-http@example.invalid',password='rollup-http-fictional-password';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic formula owner',email,password}}),202);await identity.flushBackgroundTasks();
  const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account')));
  const signed=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}}),user=(await ok(signed)).user;cookie=signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');accountId=user.id;
  const workspace=await ok(await request('/api/auth/organization/create',{method:'POST',body:{name:'Formula HTTP fixture',slug:'rollup-http-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  const target=await ok(await request(base+'/collections',{method:'POST',body:{expectedRevision:0,title:'Target',parentId:null,properties:[{id:'amount',name:'Amount',type:'number'},{id:'due',name:'Due',type:'date'}]}}),201),targetPath=base+'/collections/'+target.collectionId;
  const one=(await ok(await request(targetPath+'/records',{method:'POST',body:{expectedRevision:1,title:'One',values:{amount:2,due:'2026-10-15'}}}),201)).record,two=(await ok(await request(targetPath+'/records',{method:'POST',body:{expectedRevision:2,title:'Two',values:{amount:3,due:'2026-10-16'}}}),201)).record;
  const rollup=(id,targetPropertyId,operation='sum',resultType='number')=>({id,name:id,type:'rollup',rollup:{version:1,relationPropertyId:'related',targetCollectionId:target.collectionId,targetPropertyId,operation,resultType}}),properties=[{id:'related',name:'Related',type:'relation'},rollup('sum','amount'),rollup('latest','due','max','date')];
  const source=await ok(await request(base+'/collections',{method:'POST',body:{expectedRevision:3,title:'Source',parentId:null,properties}}),201),path=base+'/collections/'+source.collectionId,row=(await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:4,title:'Linked',values:{related:[one.pageId,two.pageId]}}}),201)).record;assert.equal(row.values.sum,5);assert.equal(row.values.latest,'2026-10-16');
  const preview=await ok(await request(path+'/rollups/preview',{method:'POST',body:{expectedRevision:5,property:rollup('count',null,'count'),recordId:row.id}}));assert.deepEqual(preview.result,{recordId:row.id,value:2});assert.equal((await store.read(workspace.id,user.id)).revision,5);
  const readonly=await request(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:5,values:{sum:99}}});assert.equal(readonly.status,400);assert.equal((await readonly.json()).error.code,'COMPUTED_PROPERTY_READ_ONLY');
  await ok(await request(targetPath+'/records/'+one.id,{method:'PATCH',body:{expectedRevision:5,values:{amount:7}}}));const stale=await request(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:5,values:{related:[]}}});assert.equal(stale.status,409);await stale.arrayBuffer();connect();let current=await ok(await request(path));assert.equal(current.collection.records[0].values.sum,10);
  await ok(await request(targetPath+'/records/'+two.id,{method:'DELETE',body:{expectedRevision:6}}));current=await ok(await request(path));assert.equal(current.collection.records[0].values.sum,null);assert.equal(current.collection.records[0].rollupErrors.sum.code,'ROLLUP_REDACTED_INPUT');
  await ok(await request(base+'/pages/'+two.pageId+'/restore',{method:'POST',body:{expectedRevision:7,parentId:target.pageId}}));current=await ok(await request(path));assert.equal(current.collection.records[0].values.sum,10);
  const persisted=await store.read(workspace.id,user.id);assert.equal(persisted.payload.collections[1].collection.records[0].values.sum,null);assert.equal((await legacy.read()).snapshot,null);await ok(await request('/api/auth/sign-out',{method:'POST',body:{}}));assert.equal((await request(path)).status,401);
});