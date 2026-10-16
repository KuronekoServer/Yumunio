import worker from '../worker.js';
import {hashPassword} from 'better-auth/crypto';
let externalAttempts=0;
globalThis.fetch=()=>{externalAttempts++;throw new Error('Synthetic board fixture forbids external requests.');};
export default{async fetch(request,env,context){
 const path=new URL(request.url).pathname;if(path==='/__fixture/metrics')return Response.json({externalAttempts});if(path!=='/__fixture/seed')return worker.fetch(request,env,context);
 const password=await hashPassword('Synthetic-Board-Host-Fixture-2026!'),stamp=Date.now(),statements=[];
 for(const[id,role]of[['board-owner','owner'],['board-member','member']])statements.push(env.DB.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').bind(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp),env.DB.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').bind('credential-'+id,id,'credential',id,password,stamp,stamp));
 statements.push(env.DB.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').bind('board-workspace','Synthetic ordered board','synthetic-board-runtime',stamp));for(const[id,role]of[['board-owner','owner'],['board-member','member']])statements.push(env.DB.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').bind('workspace-member-'+id,'board-workspace',id,role,stamp));await env.DB.batch(statements);return Response.json({seeded:true});
}};
