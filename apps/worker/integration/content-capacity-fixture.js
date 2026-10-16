import worker from '../worker.js';
import {hashPassword} from 'better-auth/crypto';
import {createD1ContentStore} from '@yumunio/identity/content-store';
import {CONTENT_STORAGE_LIMITS} from '@yumunio/identity/content-codec';
import {validateContentPayload} from '@yumunio/identity/content';
let externalAttempts=0;
globalThis.fetch=()=>{externalAttempts++;throw new Error('Synthetic capacity fixture forbids external requests.');};
export default{async fetch(request,env,context){
 const path=new URL(request.url).pathname;if(path==='/__fixture/metrics')return Response.json({externalAttempts});
 if(path==='/__fixture/max'){
  const stamp=new Date().toISOString(),payload={schemaVersion:1,pages:[{page:{id:'max-page',workspaceId:'capacity-max',parentId:null,title:'Maximum fixture',createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:'max-page',workspaceId:'capacity-max',version:1,updatedAt:stamp,blocks:[{id:'max-body',type:'paragraph',data:{text:''}}]},inheritPermissions:false}],grants:[],grantBindings:[]},size=new TextEncoder().encode(JSON.stringify(payload)).length;payload.pages[0].document.blocks[0].data.text='x'.repeat(CONTENT_STORAGE_LIMITS.logicalBytes-size);validateContentPayload(payload,'capacity-max');const store=createD1ContentStore(env.DB);await store.write('capacity-max','capacity-owner',{expectedRevision:0,payload,actorMembershipId:'capacity-membership-max',actorRole:'owner'});const saved=await store.read('capacity-max','capacity-owner'),bytes=new TextEncoder().encode(JSON.stringify(saved.payload)).length,count=(await env.DB.prepare('SELECT COUNT(*) AS n FROM yumunio_content_chunks WHERE workspace_id=?').bind('capacity-max').first()).n;return Response.json({bytes,chunks:count,textLength:saved.payload.pages[0].document.blocks[0].data.text.length});
 }
 if(path!=='/__fixture/seed')return worker.fetch(request,env,context);
 const password=await hashPassword('Synthetic-Capacity-Host-Fixture-2026!'),stamp=Date.now(),statements=[];for(const[id,role]of[['capacity-owner','owner'],['capacity-member','member']])statements.push(env.DB.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').bind(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp),env.DB.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt)VALUES(?,?,?,?,?,?,?)').bind('credential-'+id,id,'credential',id,password,stamp,stamp));
 for(const id of ['capacity-workspace','capacity-max'])statements.push(env.DB.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').bind(id,'Synthetic '+id,id,stamp));for(const[id,role]of[['capacity-owner','owner'],['capacity-member','member']])statements.push(env.DB.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').bind('capacity-membership-'+id.slice(9),'capacity-workspace',id,role,stamp));statements.push(env.DB.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').bind('capacity-membership-max','capacity-max','capacity-owner','owner',stamp));await env.DB.batch(statements);return Response.json({seeded:true});
}};
