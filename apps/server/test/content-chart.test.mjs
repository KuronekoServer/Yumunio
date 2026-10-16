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

test('Node HTTP chart views persist exact config and aggregate fresh values while rejecting stale writes',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'chart-legacy-fixture-'.repeat(3),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret:'chart-http-fixture-not-a-real-secret-123456',registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const store=createSqliteContentStore(legacy.database),connect=()=>{identity.content=createAccountContentApi({store,origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});};connect();
  let cookie,accountId;
  const request=(path,{method='GET',body,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie,'X-Yumunio-Expected-Account':accountId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='chart-http@example.invalid',password='chart-http-fictional-password';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic formula owner',email,password}}),202);await identity.flushBackgroundTasks();
  const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account.html')));
  const signed=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}}),user=(await ok(signed)).user;cookie=signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');accountId=user.id;
  const workspace=await ok(await request('/api/auth/organization/create',{method:'POST',body:{name:'Chart HTTP fixture',slug:'chart-http-fixture'}})),base='/api/content/workspaces/'+workspace.id;

 const collection=await ok(await request(base+'/collections',{method:'POST',body:{expectedRevision:0,title:'Synthetic chart',parentId:null,properties:[{id:'status',name:'Status',type:'select',options:['New','Done']},{id:'amount',name:'Amount',type:'number'}]}}),201),path=base+'/collections/'+collection.collectionId;
 const row=(await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:1,title:'A',values:{status:'New',amount:3}}}),201)).record;
 await ok(await request(path+'/records',{method:'POST',body:{expectedRevision:2,title:'B',values:{status:'New',amount:5}}}),201);
 const view={name:'Saved average',type:'chart',filters:[],sorts:[],groupBy:'status',datePropertyId:null,endDatePropertyId:null,chart:{type:'donut',aggregation:'average',valuePropertyId:'amount'}},saved=await ok(await request(path+'/views',{method:'POST',body:{expectedRevision:3,view}}),201),chartPath=path+'/views/'+saved.viewId;
 let chart=await ok(await request(chartPath));assert.deepEqual(chart.chart,{status:'available',groups:[{value:'New',count:2,numericCount:2,result:4}]});assert.deepEqual(chart.view.chart,view.chart);
 await ok(await request(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:4,values:{amount:-15}}}));connect();chart=await ok(await request(chartPath));assert.deepEqual(chart.chart,{status:'unavailable',reason:'CHART_NEGATIVE_DONUT'});assert.equal(Object.hasOwn(chart,'groups'),false);
 const stale=await request(chartPath,{method:'PATCH',body:{expectedRevision:4,view}});assert.equal(stale.status,409);await stale.arrayBuffer();assert.equal((await store.read(workspace.id,user.id)).revision,5);
 const mismatch=await request(chartPath,{headers:{'X-Yumunio-Expected-Account':'other-account'}});assert.equal(mismatch.status,404);await mismatch.arrayBuffer();
 await ok(await request('/api/auth/sign-out',{method:'POST',body:{}}));assert.equal((await request(chartPath)).status,401);
});
