import worker from '../worker.js';
import {hashPassword} from 'better-auth/crypto';
let externalAttempts=0;
globalThis.fetch=()=>{externalAttempts++;throw Error('External requests are forbidden in the synthetic MCP fixture.');};
export default{async fetch(request,env,context){
 const path=new URL(request.url).pathname;if(path==='/__fixture/metrics')return Response.json({externalAttempts});if(path!=='/__fixture/seed')return worker.fetch(request,env,context);
 const password=await hashPassword('Synthetic-Worker-MCP-Fixture-2026!'),date=Date.now();await env.DB.batch([
  env.DB.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').bind('mcp-owner','Synthetic MCP owner','mcp-owner@example.invalid',date,date),
  env.DB.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').bind('credential-mcp-owner','mcp-owner','credential','mcp-owner',password,date,date),
  env.DB.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').bind('mcp-workspace','Synthetic MCP workspace','synthetic-mcp-workspace',date),
  env.DB.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').bind('mcp-membership','mcp-workspace','mcp-owner','owner',date)
 ]);return Response.json({seeded:true});
}};
