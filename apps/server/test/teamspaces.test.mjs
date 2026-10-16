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
import {exerciseTeamspaces} from '../../../packages/identity/test/fixtures/teamspace-flow.js';
test('Node production HTTP preserves workspace ownership and teamspace ACL across review, comments, export, scoped integrations, restart and membership generations',async t=>{
 const prefix='yumunio-teamspace-http-',directory=await mkdtemp(join(tmpdir(),prefix)),database=join(directory,'accounts.sqlite');let service,db,externalAttempts=0;
 const server=createAppServer({identity:{handle:(...args)=>service.handle(...args),content:(...args)=>service.content(...args),apiTokens:(...args)=>service.apiTokens(...args),webhooks:(...args)=>service.webhooks(...args)}});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db?.close();await service?.close();const absolute=await realpath(directory);assert.equal(dirname(absolute).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(absolute).startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const env={YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_AUTH_SECRET:'Synthetic-teamspace-http-authentication-secret-2026!',YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled',YUMUNIO_API_TOKENS_ENABLED:'true',YUMUNIO_WEBHOOK_ENABLED:'true',YUMUNIO_WEBHOOK_ENDPOINT:'https://receiver.teamspace-fixture.invalid/events',YUMUNIO_WEBHOOK_SIGNING_KEY:Buffer.alloc(32,84).toString('base64')};
 const start=verifySchema=>createNodeIdentityService(env,{storage:'sqlite',database},{verifySchema,webhookFetch:()=>{externalAttempts++;throw new Error('Synthetic teamspace tests forbid external fetch.');}});
 service=await start(false);await(await getMigrations(service.auth.options)).runMigrations();await service.migrateContentSchema();db=new DatabaseSync(database);
 const stamp=Date.now(),password='Synthetic-Teamspace-Host-Fixture-2026!',hash=await hashPassword(password),workspaceId='teamspace-workspace';
 for(const[id,role]of[['team-owner','owner'],['team-member','member'],['team-peer','owner'],['team-outsider','guest']]){db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);db.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').run('credential-'+id,id,'credential',id,hash,stamp,stamp);}
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run(workspaceId,'Teamspace HTTP','synthetic-teamspace-http',stamp);for(const[id,role]of[['team-owner','owner'],['team-member','member'],['team-peer','owner'],['team-outsider','guest']])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('workspace-member-'+id,workspaceId,id,role,stamp);
 const request=(path,{method='GET',body,account,headers={}}={})=>fetch(origin+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const login=async id=>{const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password}});assert.equal(response.status,200,await response.clone().text());const value=await response.json();return{id:value.user.id,cookie:response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ')};};
 await exerciseTeamspaces({request,owner:await login('team-owner'),member:await login('team-member'),peer:await login('team-peer'),outsider:await login('team-outsider'),workspaceId,async inspect(){const row=db.prepare('SELECT revision,payload_json FROM yumunio_account_content WHERE workspace_id=?').get(workspaceId);return row?{revision:row.revision,payload:JSON.parse(row.payload_json)}:{revision:0,payload:null};},async countWorkspaces(){return db.prepare('SELECT COUNT(*) AS n FROM yumunio_workspaces').get().n;},async organizationMembers(id){return db.prepare('SELECT userId AS accountId,role FROM yumunio_memberships WHERE organizationId=? ORDER BY userId').all(id).map(row=>({...row}));},async restart(){await service.close();service=await start(true);},async replaceMembership(id){db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=? AND organizationId=?').run('replacement-'+id,id,workspaceId);}});
 assert.equal(externalAttempts,0);
});
