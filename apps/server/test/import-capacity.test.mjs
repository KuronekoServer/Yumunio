import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { createSqliteContentStore } from '@yumunio/identity/content-store';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';
import { largeImportBundle } from './fixtures/import-capacity.mjs';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
async function ok(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }


test('Node HTTP atomically imports more than 100 pages and 256000 bytes with native text rows while preserving private ACL, replay and old content',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'synthetic-large-import-legacy-'.repeat(2),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret:'synthetic-large-import-secret-2026-123456789',registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const contentStore=createSqliteContentStore(legacy.database);let writes=0;
  const connect=()=>{identity.content=createAccountContentApi({store:{read:(...args)=>contentStore.read(...args),write:(...args)=>{writes++;return contentStore.write(...args);}},origin,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});};connect();
  const request=(path,{method='GET',body,account}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function account(name){const email=name+'@example.invalid',password='Synthetic-large-import-password-2026!';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name,email,password}}),202);await identity.flushBackgroundTasks();const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account.html')));const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}}),result=await ok(response);return{id:result.user.id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
  const owner=await account('large-import-owner'),member=await account('large-import-member');
  const workspace=await ok(await request('/api/auth/organization/create',{method:'POST',account:owner,body:{name:'Large import fixture',slug:'large-import-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  legacy.database.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('large-import-member-generation',workspace.id,member.id,'member',Date.now());
  const original=await ok(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:0,title:'Existing note',blocks:[{id:'original',type:'paragraph',data:{text:'Keep original note unchanged'}}]}}),201);
  const body=largeImportBundle(1);assert.equal(body.pages.length,260);assert.ok(bytes(body)>256000);assert.ok(bytes(body)<768000);
  const invalid=structuredClone(body);invalid.pages[0].parentSourceId=invalid.pages[1].sourceId;invalid.pages[1].parentSourceId=invalid.pages[0].sourceId;
  assert.equal((await request(base+'/imports',{method:'POST',account:owner,body:invalid})).status,400);
  const overPages={expectedRevision:1,importId:'too-many-pages',pages:Array.from({length:501},(_,index)=>({sourceId:'page-'+index,parentSourceId:index? 'page-0':null,title:'Page',blocks:[]}))};
  assert.equal((await request(base+'/imports',{method:'POST',account:owner,body:overPages})).status,413);
  const overBytes={expectedRevision:1,importId:'too-many-bytes',pages:[{sourceId:'root',parentSourceId:null,title:'Root',blocks:[{id:'oversized',type:'paragraph',data:{text:'x'.repeat(768000)}}]}]};
  assert.equal((await request(base+'/imports',{method:'POST',account:owner,body:overBytes})).status,413);
  const ordinary={expectedRevision:1,title:'Ordinary page',blocks:[{id:'oversized',type:'paragraph',data:{text:'x'.repeat(256000)}}]};
  assert.equal((await request(base+'/pages',{method:'POST',account:owner,body:ordinary})).status,413);assert.equal(writes,1);
  const committed=await ok(await request(base+'/imports',{method:'POST',account:owner,body}),201);assert.equal(committed.revision,2);assert.equal(committed.pageCount,260);assert.equal(writes,2);
  connect();const replay=await ok(await request(base+'/imports',{method:'POST',account:owner,body}));assert.deepEqual(replay,{...committed,replayed:true});assert.equal(writes,2);
  const listing=await ok(await request(base+'/pages',{account:owner}));assert.equal(listing.pages.length,261);assert.equal(listing.revision,2);assert.equal(Object.hasOwn(listing,'imports'),false);
  const hidden=await ok(await request(base+'/pages',{account:member}));assert.deepEqual(hidden.pages,[]);
  assert.equal((await request(base+'/pages/'+committed.rootPageId,{account:member})).status,404);
  const table=listing.pages.find(page=>page.title==='Imported records'),view=await ok(await request(base+'/collections/'+table.collectionId,{account:owner}));
  assert.equal(view.collection.records.length,125);assert.ok(view.collection.properties.every(property=>property.type==='text'));
  const originalProperty=view.collection.properties.find(property=>property.name==='Original');
  assert.ok(view.collection.records.some(record=>record.values[originalProperty.id]==='007'));
  assert.ok(view.collection.records.some(record=>record.values[originalProperty.id]==='=SUM(A1)'));
  const container=await ok(await request(base+'/pages/'+table.id,{account:owner}));assert.doesNotMatch(JSON.stringify(container.document),/=SUM/);
  assert.deepEqual((await ok(await request(base+'/pages/'+original.page.id,{account:owner}))).document,original.document);
  assert.equal((await legacy.read()).snapshot,null);assert.equal((await contentStore.read(workspace.id,owner.id)).payload.imports.length,1);
});
