import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {validateContentPayload} from '@yumunio/identity/content';
import {sha256} from '../src/archive.js';
export const stamp='2026-10-15T00:00:00.000Z',secret='fixture-only-authentication-secret-not-real-12345678',password='Fixture-recovery-password-12345!';
export const schema=(await Promise.all(['../../../apps/worker/auth-schema.sql','../../../apps/worker/snapshot-schema.sql','../schema/backup.sqlite.sql'].map(path=>readFile(new URL(path,import.meta.url),'utf8')))).join('\n');
export function database(t,path=':memory:'){const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');db.exec(schema);if(t)t.after(()=>{try{db.close();}catch{}});return db;}
export function seedPresence(db){db.prepare('INSERT INTO yumunio_room_presence(id,workspace_id,page_id,epoch,account_id,membership_id,session_id,actor_role,client_id,sequence,document_version,cursor_json,expires_at,slot,account_slot)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('a'.repeat(32),'workspace','page','ephemeral-epoch','account','ephemeral-membership','ephemeral-session','owner','00000000-0000-4000-8000-000000000001',1,1,'null',stamp,0,0);}
export async function memoryBlobs(profileId='fixture-source'){const data=new Map();return{profileId,data,async put(key,bytes){if(data.has(key))throw Object.assign(new Error('private provider credentials'),{code:'BLOB_EXISTS'});data.set(key,bytes.slice());return{size:bytes.length,checksum:await sha256(bytes)};},async get(key){return data.get(key)?.slice()??null;},async delete(key){data.delete(key);}};}
export function d1(database){
  const prepare=sql=>{
    let params=[];
    const execute=()=>{const statement=database.prepare(sql);if(statement.columns().length)return{success:true,results:statement.all(...params),meta:{changes:0}};return{success:true,results:[],meta:{changes:Number(statement.run(...params).changes)}};};
    return{sql,bind(...values){params=values;return this;},async all(){return execute();},_execute:execute};
  };
  return{prepare,async batch(commands){database.exec('BEGIN IMMEDIATE');try{const result=commands.map(command=>command._execute());database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}}};
}
export async function seed(db,{blobs=true}={}){
  const milliseconds=Date.parse(stamp),source=await memoryBlobs();
  db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run('account','架空の利用者 😀','recovery@example.invalid',milliseconds,milliseconds);
  db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run('workspace','Private workspace','fixture-recovery',milliseconds);
  db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-generation-a','workspace','account','owner',milliseconds);
  db.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run('credential','account','credential','account',await hashPassword(password),milliseconds,milliseconds);
  db.prepare('INSERT INTO yumunio_auth_sessions(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)').run('session',milliseconds+100000,'private-old-session-token',milliseconds,milliseconds,'account');
  db.prepare('INSERT INTO yumunio_auth_verifications(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run('verification','private-challenge','private-old-reset-token',milliseconds+100000,milliseconds,milliseconds);
  db.prepare('INSERT INTO yumunio_auth_rate_limits(id,key,count,lastRequest) VALUES(?,?,?,?)').run('limit','auth-fixture',3,milliseconds);
  db.prepare('INSERT INTO yumunio_workspace_invitations(id,organizationId,email,role,status,expiresAt,createdAt,inviterId) VALUES(?,?,?,?,?,?,?,?)').run('sdk-invite','workspace','invite@example.invalid','member','pending',milliseconds+100000,milliseconds,'account');
  const page=(id,parentId=null,trashedAt=null)=>({page:{id,workspaceId:'workspace',title:id==='page'?"Private 日本語 😀 literal '; DROP TABLE yumunio_users; --":id,parentId,createdAt:stamp,updatedAt:stamp,trashedAt},document:{pageId:id,workspaceId:'workspace',version:2,updatedAt:stamp,blocks:[{id:'block-'+id,type:'paragraph',data:{text:'Private body '+id}}]},inheritPermissions:parentId!==null});
  const payload={schemaVersion:1,pages:[page('page'),page('trashed','page',stamp)],grants:[{id:'grant',workspaceId:'workspace',pageId:'page',accountId:'account',permission:'full',includeDescendants:true,status:'active'}],grantBindings:[{grantId:'grant',membershipId:'membership-generation-a'}]};
  if(blobs){const attachment=new TextEncoder().encode('Private attachment bytes 日本語 😀'),pending=new TextEncoder().encode('Uncommitted ready upload');await source.put('objects/committed',attachment);await source.put('objects/pending',pending);payload.attachments=[{id:'attachment',pageId:'page',name:'資料.txt',mediaType:'text/plain',size:attachment.length,checksum:await sha256(attachment),profileId:source.profileId,objectKey:'objects/committed'}];payload.pendingBlobs=[{id:'pending',importId:'import',sourceId:'source',accountId:'account',membershipId:'membership-generation-a',pageId:'page',name:'Pending.txt',mediaType:'text/plain',size:pending.length,checksum:await sha256(pending),profileId:source.profileId,objectKey:'objects/pending',status:'ready'}];}
  validateContentPayload(payload,'workspace');db.prepare('INSERT INTO yumunio_account_content VALUES(?,?,?)').run('workspace',5,JSON.stringify(payload));
  db.prepare('INSERT INTO yumunio_account_preferences VALUES(?,?,?)').run('account',2,JSON.stringify({schemaVersion:1,themeId:'midnight',customColors:{},fontId:'system',locale:'en'}));
  db.prepare('INSERT INTO yumunio_collaboration_invitations VALUES(?,?,?,?,?,?)').run('invite','workspace',1,JSON.stringify({id:'invite',revokedAt:null}),'membership-generation-a','pending');
  db.prepare('INSERT INTO yumunio_mail_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('mail','mail-key','encrypted-mail-not-plaintext','f'.repeat(64),'leased',1,stamp,'lease',stamp,stamp,stamp,stamp,'invite',1);
  const prototype={schemaVersion:1,name:'Separate prototype',pages:[],ui:{recentPageIds:[],lastRoute:'#home'},updatedAt:stamp};db.prepare('INSERT INTO yumunio_prototype_snapshots VALUES(?,?,?,?)').run(1,4,JSON.stringify(prototype),stamp);
  return{source,payload,prototype};
}
