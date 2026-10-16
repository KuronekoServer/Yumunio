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
import {exerciseBlockForest} from '../../../packages/identity/test/fixtures/block-forest-flow.js';
test('Node production HTTP moves whole selected forests and columns atomically, invalidates rooms and rechecks destination mention generations',async t=>{
 const prefix='yumunio-block-forest-http-',directory=await mkdtemp(join(tmpdir(),prefix)),database=join(directory,'accounts.sqlite');let service,db;
 const server=createAppServer({identity:{handle:(...args)=>service.handle(...args),content:(...args)=>service.content(...args)}});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db?.close();await service?.close();const absolute=await realpath(directory);assert.equal(dirname(absolute).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(absolute).startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 service=await createNodeIdentityService({YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_AUTH_SECRET:'Synthetic-block-forest-http-authentication-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled'},{storage:'sqlite',database},{verifySchema:false});await(await getMigrations(service.auth.options)).runMigrations();await service.migrateContentSchema();db=new DatabaseSync(database);
 const stamp=Date.now(),password='Synthetic-Block-Forest-HTTP-2026!',hash=await hashPassword(password),workspaceId='forest-workspace';
 for(const[id,role]of[['forest-owner','owner'],['forest-person','guest']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').run('credential-'+id,id,'credential',id,hash,stamp,stamp);}
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Forest HTTP','synthetic-forest-http',stamp);for(const[id,role]of[['forest-owner','owner'],['forest-person','guest']])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,role,stamp);
 const request=(path,{method='GET',body,account,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password}});assert.equal(response.status,200,await response.clone().text());const value=await response.json();return{id:value.user.id,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};};
 await exerciseBlockForest({request,owner:await login('forest-owner'),person:await login('forest-person'),workspaceId,async inspect(){const row=db.prepare('SELECT revision,payload_json FROM yumunio_account_content WHERE workspace_id=?').get(workspaceId);return{revision:row.revision,payload:JSON.parse(row.payload_json)};},async replacePerson(){db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-person-generation','forest-person');}});
});
