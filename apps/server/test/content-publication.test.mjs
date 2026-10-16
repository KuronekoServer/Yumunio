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

test('Node HTTP exposes only the reviewed publication snapshot without cookies and immediately fences edits, stopping and publisher revocation',async t=>{
  const legacy=new SqliteSnapshotStore(':memory:'),mail=[],secret='publication-http-fixture-not-a-real-secret-123456';let identity;
  const server=createAppServer({snapshotStore:legacy,accessKey:'publication-legacy-fixture-'.repeat(3),identity:{handle:(...args)=>identity.handle(...args),content:(...args)=>identity.content(...args)}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await identity?.flushBackgroundTasks();legacy.close();});
  identity=createIdentity({database:legacy.database,origin,workspaceContent:true,secret,registrationMode:'open',sendMail:async message=>{mail.push(message);return{status:'accepted'};}});
  await(await getMigrations(identity.auth.options)).runMigrations();legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql',import.meta.url),'utf8'));
  const store=createSqliteContentStore(legacy.database);identity.content=createAccountContentApi({store,origin,roomSecret:secret,publicationSecret:secret,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
  const request=(path,{method='GET',body,account,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.user.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='publication-owner@example.invalid',password='publication-http-fictional-password';await ok(await request('/api/auth/sign-up/email',{method:'POST',body:{name:'Synthetic publisher',email,password}}),202);await identity.flushBackgroundTasks();const token=new URL(mail[0].text.split('\n').at(-1)).searchParams.get('verify');await ok(await request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account.html')));const signed=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}}),result=await ok(signed),owner={user:result.user,cookie:signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
  const workspace=await ok(await request('/api/auth/organization/create',{method:'POST',account:owner,body:{name:'HTTP publication fixture',slug:'http-publication-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  const created=await ok(await request(base+'/pages',{method:'POST',account:owner,body:{expectedRevision:0,title:'Public snapshot',blocks:[{id:'text',type:'paragraph',data:{text:'Literal <script>safe text</script>'}},{id:'source',type:'code',data:{text:'Private original source',purpose:'import-source'}}]}}),201),path=base+'/pages/'+created.page.id+'/publication';
  const publish=async revision=>{const preview=await ok(await request(path+'/review',{method:'POST',account:owner,body:{expectedRevision:revision}}));return ok(await request(path,{method:'POST',account:owner,body:{expectedRevision:revision,reviewDigest:preview.reviewDigest,confirmPublicExposure:true}}));};
  const first=await publish(1),publicToken=new URL(first.publicPath,origin).searchParams.get('publication'),publicPath='/api/public/pages/'+publicToken;
  const anonymous=await request(publicPath);assert.equal(anonymous.status,200);assert.match(anonymous.headers.get('cache-control'),/(?:^|,\s*)no-store(?:,|$)/);assert.match(anonymous.headers.get('x-robots-tag'),/noindex/);assert.equal(anonymous.headers.has('set-cookie'),false);const publicPage=await anonymous.json();assert.deepEqual(publicPage.blocks,[{type:'paragraph',text:'Literal <script>safe text</script>'}]);assert.doesNotMatch(JSON.stringify(publicPage),/Private|source|publisher|workspace|membership|@example/);
  await ok(await request(base+'/pages/'+created.page.id,{method:'PATCH',account:owner,body:{expectedRevision:2,expectedVersion:1,title:'New snapshot source'}}));assert.equal((await request(publicPath)).status,404);const stale=await ok(await request(path,{account:owner}));assert.equal(stale.needsRepublish,true);assert.equal(stale.publicPath,null);
  const second=await publish(3),nextToken=new URL(second.publicPath,origin).searchParams.get('publication'),nextPath='/api/public/pages/'+nextToken;assert.notEqual(publicToken,nextToken);assert.equal((await request(publicPath)).status,404);assert.equal((await request(nextPath)).status,200);
  await ok(await request(path,{method:'DELETE',account:owner,body:{expectedRevision:4}}));assert.equal((await request(nextPath)).status,404);const third=await publish(5),finalPath='/api/public/pages/'+new URL(third.publicPath,origin).searchParams.get('publication');
  await ok(await request('/api/auth/sign-out',{method:'POST',account:owner,body:{}}));assert.equal((await request(finalPath)).status,200);legacy.database.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run(owner.user.id);assert.equal((await request(finalPath)).status,404);assert.equal((await legacy.read()).snapshot,null);
});
