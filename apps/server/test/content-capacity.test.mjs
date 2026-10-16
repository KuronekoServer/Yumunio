import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {getMigrations} from 'better-auth/db/migration';
import {hashPassword} from 'better-auth/crypto';
import {createNodeIdentityService} from '../identity.mjs';
import {createAppServer} from '../server.mjs';
import {exerciseContentCapacity} from '../../../packages/identity/test/fixtures/content-capacity-flow.js';
test('Node production HTTP crosses the legacy aggregate limit while preserving content, collaboration CAS, scoped API and restart',async t=>{
 const prefix='yumunio-capacity-http-',directory=await mkdtemp(join(tmpdir(),prefix)),database=join(directory,'accounts.sqlite');let service,db;
 const server=createAppServer({identity:{handle:(...args)=>service.handle(...args),content:(...args)=>service.content(...args),collaboration:{handle:(...args)=>service.collaboration.handle(...args)},apiTokens:(...args)=>service.apiTokens(...args)}});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db?.close();await service?.close();const absolute=await realpath(directory);assert.equal(dirname(absolute).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(absolute).startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const env={YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_AUTH_SECRET:'Synthetic-capacity-http-authentication-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled',YUMUNIO_API_TOKENS_ENABLED:'true'},start=verifySchema=>createNodeIdentityService(env,{storage:'sqlite',database},{verifySchema});service=await start(false);await(await getMigrations(service.auth.options)).runMigrations();await service.migrateContentSchema();db=new DatabaseSync(database);
 const stamp=Date.now(),password='Synthetic-Capacity-Host-Fixture-2026!',hash=await hashPassword(password);for(const[id,role]of[['capacity-owner','owner'],['capacity-member','member']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').run('credential-'+id,id,'credential',id,hash,stamp,stamp);}
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run('capacity-workspace','Capacity HTTP','synthetic-capacity-http',stamp);for(const[id,role]of[['capacity-owner','owner'],['capacity-member','member']])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('capacity-membership-'+id.slice(9),'capacity-workspace',id,role,stamp);
 const request=(path,{method='GET',body,account,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password}});assert.equal(response.status,200,await response.clone().text());const value=await response.json();return{id:value.user.id,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};};
 await exerciseContentCapacity({request,owner:await login('capacity-owner'),member:await login('capacity-member'),async inspect(){const row=db.prepare('SELECT revision,payload_json AS head FROM yumunio_account_content WHERE workspace_id=?').get('capacity-workspace'),sizes=db.prepare('SELECT COUNT(*) AS chunkCount,MAX(length(CAST(payload_text AS BLOB))) AS largestRowBytes FROM yumunio_content_chunks WHERE workspace_id=?').get('capacity-workspace');return{...row,...sizes};},async restart(){await service.close();service=await start(true);}});
});
