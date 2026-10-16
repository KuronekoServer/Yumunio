import worker from '../worker.js';
import {hashPassword} from 'better-auth/crypto';
globalThis.fetch=()=>{throw new Error('External requests are forbidden in the synthetic chart fixture.');};
export default{async fetch(request,env,context){
 if(new URL(request.url).pathname!=='/__fixture/seed')return worker.fetch(request,env,context);
 const password=await hashPassword('Synthetic-chart-password-2026!'),date=Date.now(),statements=[];
 for(const id of ['chart-owner','chart-member']){
  statements.push(env.DB.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').bind(id,id,id+'@example.invalid',date,date));
  statements.push(env.DB.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').bind('credential-'+id,id,'credential',id,password,date,date));
 }
 statements.push(env.DB.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').bind('chart-workspace','Synthetic chart workspace','synthetic-chart',date));
 for(const id of ['chart-owner','chart-member'])statements.push(env.DB.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').bind('membership-'+id,'chart-workspace',id,id==='chart-owner'?'owner':'member',date));
 await env.DB.batch(statements);return Response.json({seeded:true});
}};
