import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { createSqliteContentStore } from '@yumunio/identity/content-store';
import { MAX_BODY_BYTES } from '@yumunio/prototype';
import { PageUploadFlow, PageUploadError } from '../../web/public/page-upload.js';
import { createLocalBlobStore } from '../blob-store.mjs';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';

test('normal page attachment client preserves page text and binds, downloads and removes real local bytes over Node HTTP', async t => {
  const directory=await mkdtemp(join(tmpdir(),'yumunio-page-attachments-'));
  const snapshotStore=new SqliteSnapshotStore(':memory:'),mail=[];let identity;
  const blobStore=await createLocalBlobStore({driver:'local',directory:join(directory,'blobs')});
  const contentStore=createSqliteContentStore(snapshotStore.database);
  const server=createAppServer({snapshotStore,accessKey:'page-attachments-http-fixture-'.repeat(3),identity:{
    handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();snapshotStore.close();
    const canonical=await realpath(directory);assert.equal(dirname(canonical).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
    assert.match(basename(canonical),/^yumunio-page-attachments-/);await rm(canonical,{recursive:true,force:true});
  });
  identity=createIdentity({database:snapshotStore.database,origin,workspaceContent:true,secret:'local-page-attachments-secret-'.repeat(3),registrationMode:'open',
    sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();
  snapshotStore.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  identity.content=createAccountContentApi({store:contentStore,origin,blobStore,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
  let cookie='',accountId='';
  const request=(path,method='GET',body)=>fetch(origin+path,{method,headers:{
    ...(cookie?{Cookie:cookie}:{}),...(method==='GET'?{}:{Origin:origin}),
    ...(body===undefined?{}:{'Content-Type':'application/json'}),...(accountId?{'X-Yumunio-Expected-Account':accountId}:{})
  },...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='page-attachments@example.invalid',password='page-attachments-local-password';
  await ok(await request('/api/auth/sign-up/email','POST',{name:'Attachments fixture',email,password}),202);
  await identity.flushBackgroundTasks();
  const token=new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');
  await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account.html')));
  const login=await request('/api/auth/sign-in/email','POST',{email,password});
  accountId=(await ok(login)).user.id;cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const workspace=await ok(await request('/api/auth/organization/create','POST',{name:'Page attachments fixture',slug:'page-attachments-fixture'}));
  const base='/api/content/workspaces/'+workspace.id;
  const initial=await ok(await request(base+'/pages','POST',{expectedRevision:0,title:'Plain page',blocks:[{id:'text',type:'paragraph',data:{text:'Keep the original text.'}}]}),201);
  const pageId=initial.page.id,path=base+'/pages/'+pageId,bytes=new Uint8Array(MAX_BODY_BYTES+128).fill(65);
  bytes.set(new TextEncoder().encode('Synthetic local attachment 日本語. <script>literal</script>'));
  const flow=new PageUploadFlow({accountId,workspaceId:workspace.id,pageId,createId:()=> 'node-http',request:async({path,method,headers,body})=>{
    const binary=body instanceof Uint8Array;
    const response=await fetch(origin+path,{method,headers:{Cookie:cookie,...(method==='GET'?{}:{Origin:origin}),
      ...(body===undefined?{}:{'Content-Type':binary?'application/octet-stream':'application/json'}),...headers},
      ...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})});
    const dto=await response.json();if(!response.ok)throw new PageUploadError(dto.error?.code,response.status);return dto;
  }});
  await flow.review();assert.equal(flow.snapshot().attachments.length,0);
  await flow.prepare({name:'架空.txt',mediaType:'text/plain',bytes});
  const committed=await flow.send();assert.equal(committed.replayed,false);assert.equal(committed.version,1);assert.equal(committed.revision,4);
  await flow.review();assert.equal(flow.snapshot().file,null);assert.equal(flow.snapshot().uploads.length,0);
  const attachment=flow.snapshot().attachments[0];assert.equal(attachment.name,'架空.txt');
  const page=await ok(await request(path));assert.equal(page.document.version,1);assert.deepEqual(page.document.blocks,initial.document.blocks);
  const stored=(await contentStore.read(workspace.id,accountId)).payload.attachments[0];assert.deepEqual(await blobStore.get(stored.objectKey),bytes);
  const download=await request(path+'/attachments/'+attachment.id);assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.match(download.headers.get('content-security-policy'),/sandbox/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  assert.deepEqual((await ok(await request(base+'/imports/'+flow.uploadId+'/assets'))).assets,[]);
  const removed=await flow.remove(attachment);assert.equal(removed.revision,6);await flow.review();
  assert.deepEqual(flow.snapshot().attachments,[]);assert.deepEqual(flow.snapshot().uploads,[]);assert.equal(await blobStore.get(stored.objectKey),null);
  assert.equal((await request(path+'/attachments/'+attachment.id)).status,404);
  assert.equal((await ok(await request(path))).document.version,1);assert.equal((await snapshotStore.read()).snapshot,null);
  await ok(await request('/api/auth/sign-out','POST',{}));assert.equal((await request(path+'/uploads')).status,401);
});
