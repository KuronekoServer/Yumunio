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

test('Node HTTP forms authenticate an assigned create-only respondent, persist typed responses exactly once and stop old receipts after closing',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'forms-legacy-fixture-'.repeat(3),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret:'forms-http-fixture-not-a-real-secret-123456',registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const store=createSqliteContentStore(legacy.database);identity.content=createAccountContentApi({store,origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
  const request=(path,{method='GET',body,account,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.user.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  async function account(name){const email=name+'@example.invalid',password='forms-http-fictional-password';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic '+name,email,password}}),202);await identity.flushBackgroundTasks();const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account')));const signed=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}});const result=await ok(signed);return{user:result.user,cookie:signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
  const owner=await account('forms-owner'),respondent=await account('forms-respondent'),workspace=await ok(await request('/api/auth/organization/create',{method:'POST',account:owner,body:{name:'HTTP forms fixture',slug:'http-forms-fixture'}}));
  legacy.database.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('fixture-'+respondent.user.id,workspace.id,respondent.user.id,'guest',Date.now());
  const base='/api/content/workspaces/'+workspace.id,collection=await ok(await request(base+'/collections',{method:'POST',account:owner,body:{expectedRevision:0,title:'Private form responses',parentId:null,properties:[{id:'rating',name:'Rating',type:'number',required:true}]}}),201);
  const path=base+'/collections/'+collection.collectionId+'/forms',created=await ok(await request(path,{method:'POST',account:owner,body:{expectedRevision:1,definition:{title:'Feedback',description:'Assigned account',fields:[{id:'rating',propertyId:'rating',label:'Your rating',description:'',required:true,condition:null}]}}}),201),manage=path+'/'+created.formId,respond=base+'/forms/'+created.formId;
  await ok(await request(manage+'/acceptance',{method:'POST',account:owner,body:{expectedRevision:2,accepting:true,confirmManagerAccess:true,respondentAccountIds:[respondent.user.id]}}));
  const form=await ok(await request(respond,{account:respondent}));assert.equal(form.fields[0].type,'number');assert.equal(Object.hasOwn(form,'revision'),false);assert.equal(Object.hasOwn(form.fields[0],'propertyId'),false);
  assert.equal((await request(respond,{account:respondent,headers:{'X-Yumunio-Expected-Account':owner.user.id}})).status,404);
  const body={requestId:'http-receipt',version:1,answers:{rating:0}},simultaneous=await Promise.all([request(respond+'/responses',{method:'POST',account:respondent,body}),request(respond+'/responses',{method:'POST',account:respondent,body})]);assert.deepEqual(simultaneous.map(response=>response.status).sort(),[200,201]);for(const response of simultaneous)assert.deepEqual(await response.json(),{requestId:'http-receipt',accepted:true});
  identity.content=createAccountContentApi({store:createSqliteContentStore(legacy.database),origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});assert.deepEqual(await ok(await request(respond+'/responses',{method:'POST',account:respondent,body})),{requestId:'http-receipt',accepted:true});
  const ownerView=await ok(await request(base+'/collections/'+collection.collectionId,{account:owner}));assert.equal(ownerView.revision,4);assert.equal(ownerView.collection.records.length,1);assert.equal(ownerView.collection.records[0].values.rating,0);const rowId=ownerView.collection.records[0].pageId;
  for(const path of [base+'/collections/'+collection.collectionId,base+'/pages/'+rowId])assert.equal((await request(path,{account:respondent})).status,404);assert.deepEqual((await ok(await request(base+'/pages',{account:respondent}))).pages,[]);
  await ok(await request(manage+'/acceptance',{method:'POST',account:owner,body:{expectedRevision:4,accepting:false}}));assert.equal((await request(respond+'/responses',{method:'POST',account:respondent,body})).status,404);assert.equal((await store.read(workspace.id,owner.user.id)).payload.formReceipts.length,1);assert.equal((await legacy.read()).snapshot,null);
});
