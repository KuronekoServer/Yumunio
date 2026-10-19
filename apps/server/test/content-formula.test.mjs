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

test('Node HTTP formula projections are computed, preview-only and revision guarded after ordinary local account login',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'formula-legacy-fixture-'.repeat(3),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret:'formula-http-fixture-not-a-real-secret-123456',registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const store=createSqliteContentStore(legacy.database),connect=()=>{identity.content=createAccountContentApi({store,origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});};connect();
  let cookie,accountId;
  const request=(path,{method='GET',body,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie,'X-Yumunio-Expected-Account':accountId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='formula-http@example.invalid',password='formula-http-fictional-password';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic formula owner',email,password}}),202);await identity.flushBackgroundTasks();
  const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account')));
  const signed=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}}),user=(await ok(signed)).user;cookie=signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');accountId=user.id;
  const workspace=await ok(await request('/api/auth/organization/create',{method:'POST',body:{name:'Formula HTTP fixture',slug:'formula-http-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  const formula=(id,expression,resultType='number')=>({id,name:id,type:'formula',formula:{version:1,expression,resultType}}),properties=[{id:'price',name:'Price',type:'number'},formula('total','field("price") * 2'),formula('label','concat("Result ", toText(field("total")))','text')];
  const created=await ok(await request(base+'/collections',{method:'POST',body:{expectedRevision:0,title:'HTTP computed records',parentId:null,properties}}),201),path=base+'/collections/'+created.collectionId;
  const row=(await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:1,title:'One',values:{price:3}}}),201)).record;assert.equal(row.values.total,6);assert.equal(row.values.label,'Result 6');
  const preview=await ok(await request(path+'/formulas/preview',{method:'POST',body:{expectedRevision:2,property:formula('candidate','field("total") / 0'),recordId:row.id}}));assert.deepEqual(preview,{revision:2,propertyId:'candidate',valid:true,result:{recordId:row.id,value:null,error:{code:'FORMULA_DIVISION_BY_ZERO'}}});
  const changed=await ok(await request(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:2,values:{price:5}}}));assert.equal(changed.revision,3);assert.equal(changed.record.values.label,'Result 10');
  const stale=await request(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:2,values:{price:999}}});assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'CONTENT_CONFLICT');
  const readonly=await request(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:3,values:{total:null}}});assert.equal(readonly.status,400);assert.equal((await readonly.json()).error.code,'COMPUTED_PROPERTY_READ_ONLY');
  const mismatch=await request(path+'/formulas/preview',{method:'POST',headers:{'X-Yumunio-Expected-Account':'another-account'},body:{expectedRevision:3,property:formula('candidate','1')}});assert.equal(mismatch.status,404);await mismatch.arrayBuffer();
  connect();const read=await ok(await request(path));assert.equal(read.revision,3);assert.equal(read.collection.records[0].values.total,10);assert.equal(read.collection.properties.length,3);
  const persisted=await store.read(workspace.id,user.id);assert.equal(persisted.payload.collections[0].collection.records[0].values.total,null);assert.equal(persisted.payload.collections[0].collection.records[0].values.label,null);assert.equal((await legacy.read()).snapshot,null);
  await ok(await request('/api/auth/sign-out',{method:'POST',body:{}}));assert.equal((await request(path)).status,401);
});