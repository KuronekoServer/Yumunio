import {assertId} from '@yumunio/domain';
import {PRESENCE_LIMITS,validPresenceClientId} from '@yumunio/collaboration/presence';

export class RoomPresenceStoreError extends Error{constructor(code='ROOM_PRESENCE_UNAVAILABLE',status=503){super('Room presence is unavailable.');this.code=code;this.status=status;}}
const bad=()=>{throw new RoomPresenceStoreError();},conflict=()=>{throw new RoomPresenceStoreError('ROOM_PRESENCE_CHANGED',409);};
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(typeof value==='bigint'||typeof value==='string')value=Number(value);if(!Number.isSafeInteger(value)||value<min||value>max)bad();return value;};
const timestamp=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)bad();return value;};
const constraint=error=>['23505','ER_DUP_ENTRY','SQLITE_CONSTRAINT_UNIQUE','SQLITE_CONSTRAINT_PRIMARYKEY'].includes(error?.code)||/UNIQUE constraint failed/.test(error?.message??'');
function context(dialect){const params=[],bind=value=>{params.push(value);return dialect==='postgres'?'$'+params.length:'?';},column=(alias,name)=>alias+'.'+(dialect==='mysql'?'`'+name+'`':'"'+name+'"'),equal=(a,b)=>dialect==='mysql'?'BINARY '+a+' = BINARY '+b:a+' = '+b;return{params,bind,column,equal};}
function validateScope(scope){for(const key of ['workspaceId','pageId','epoch','accountId','membershipId','sessionId'])assertId(scope[key]);if(!['owner','admin','member','guest'].includes(scope.actorRole))bad();integer(scope.expectedRevision,1);timestamp(scope.now);}
function actor(s,scope,dialect){const b=s.bind,c=s.column,e=s.equal,expires=dialect==='sqlite'?Date.parse(scope.now):new Date(scope.now);return 'EXISTS (SELECT 1 FROM yumunio_memberships a JOIN yumunio_users u ON '+e(c('u','id'),c('a','userId'))+' JOIN yumunio_auth_sessions auth ON '+e(c('auth','userId'),c('u','id'))+' JOIN yumunio_account_content content ON '+e('content.workspace_id',c('a','organizationId'))+' WHERE '+e(c('a','organizationId'),b(scope.workspaceId))+' AND '+e(c('a','id'),b(scope.membershipId))+' AND '+e(c('a','userId'),b(scope.accountId))+' AND '+e(c('a','role'),b(scope.actorRole))+' AND '+c('u','emailVerified')+' = TRUE AND '+e(c('auth','id'),b(scope.sessionId))+' AND '+c('auth','expiresAt')+' > '+b(expires)+' AND content.revision = '+b(scope.expectedRevision)+' AND (SELECT COUNT(*) FROM yumunio_memberships duplicates WHERE '+e(c('duplicates','organizationId'),c('a','organizationId'))+' AND '+e(c('duplicates','userId'),c('a','userId'))+') = 1)';}
function scoped(s,scope,{epoch=true}={}){return s.equal('workspace_id',s.bind(scope.workspaceId))+' AND '+s.equal('page_id',s.bind(scope.pageId))+(epoch?' AND '+s.equal('epoch',s.bind(scope.epoch)):'');}
function row(raw){try{for(const key of ['workspace_id','page_id','epoch','account_id','membership_id','session_id'])assertId(raw[key]);if(!/^[a-f0-9]{32}$/.test(raw.id)||!validPresenceClientId(raw.client_id)||!['owner','admin','member','guest'].includes(raw.actor_role))bad();timestamp(raw.expires_at);return{id:raw.id,workspaceId:raw.workspace_id,pageId:raw.page_id,epoch:raw.epoch,accountId:raw.account_id,membershipId:raw.membership_id,sessionId:raw.session_id,actorRole:raw.actor_role,clientId:raw.client_id,sequence:integer(raw.sequence,1),documentVersion:integer(raw.document_version,1),cursor:JSON.parse(raw.cursor_json),expiresAt:raw.expires_at,slot:integer(raw.slot,0,63),accountSlot:integer(raw.account_slot,0,7)};}catch{bad();}}
/** TTL-only records. No body revision, history, backup payload or account name is written here. */
export class SqlRoomPresenceStore{
 constructor(client){if(!client||!['sqlite','mysql','postgres'].includes(client.dialect)||typeof client.query!=='function')bad();this.client=client;}
 async query(sql,params=[]){try{const result=await this.client.query(sql,params);if(!Array.isArray(result?.rows)||!Number.isSafeInteger(result.affectedRows)||result.affectedRows<0)bad();return result;}catch(error){if(constraint(error))conflict();bad();}}
 async checkSchema(){await this.query('SELECT id,workspace_id,page_id,epoch,account_id,membership_id,session_id,actor_role,client_id,sequence,document_version,cursor_json,expires_at,slot,account_slot FROM yumunio_room_presence WHERE 1 = 0');}
 async list(scope){validateScope(scope);const s=context(this.client.dialect),c=s.column,e=s.equal,b=s.bind;const expires=this.client.dialect==='sqlite'?Date.parse(scope.now):new Date(scope.now);
  const sql='SELECT p.* FROM yumunio_room_presence p JOIN yumunio_users pu ON '+e(c('pu','id'),'p.account_id')+' JOIN yumunio_memberships pm ON '+e(c('pm','id'),'p.membership_id')+' AND '+e(c('pm','organizationId'),'p.workspace_id')+' AND '+e(c('pm','userId'),'p.account_id')+' AND '+e(c('pm','role'),'p.actor_role')+' JOIN yumunio_auth_sessions ps ON '+e(c('ps','id'),'p.session_id')+' AND '+e(c('ps','userId'),'p.account_id')+' WHERE '+e('p.workspace_id',b(scope.workspaceId))+' AND '+e('p.page_id',b(scope.pageId))+' AND '+e('p.epoch',b(scope.epoch))+' AND p.expires_at > '+b(scope.now)+' AND '+c('pu','emailVerified')+' = TRUE AND '+c('ps','expiresAt')+' > '+b(expires)+' AND '+actor(s,scope,this.client.dialect)+' ORDER BY p.slot LIMIT 65';
  const result=await this.query(sql,s.params);if(result.rows.length>64)bad();return result.rows.map(row);
 }
 async publish(scope,input){validateScope(scope);if(!validPresenceClientId(input.clientId)||!/^[a-f0-9]{32}$/.test(input.id))bad();integer(input.sequence,1);integer(input.documentVersion,1);timestamp(input.expiresAt);if(Date.parse(input.expiresAt)-Date.parse(scope.now)!==PRESENCE_LIMITS.ttlMs)bad();
  let s=context(this.client.dialect);await this.query('DELETE FROM yumunio_room_presence WHERE expires_at <= '+s.bind(scope.now)+' OR ('+scoped(s,scope,{epoch:false})+' AND NOT ('+s.equal('epoch',s.bind(scope.epoch))+') AND '+actor(s,scope,this.client.dialect)+')',s.params);
  for(let attempt=0;attempt<4;attempt++){
   s=context(this.client.dialect);const existing=(await this.query('SELECT * FROM yumunio_room_presence WHERE '+scoped(s,scope,{epoch:false})+' ORDER BY slot LIMIT 65',s.params)).rows.map(row);if(existing.length>64)bad();
   const prior=existing.find(value=>value.id===input.id);if(prior){if(prior.accountId!==scope.accountId||prior.membershipId!==scope.membershipId||prior.sessionId!==scope.sessionId||prior.clientId!==input.clientId)bad();s=context(this.client.dialect);const result=await this.query('UPDATE yumunio_room_presence SET sequence='+s.bind(input.sequence)+',document_version='+s.bind(input.documentVersion)+',cursor_json='+s.bind(JSON.stringify(input.cursor))+',expires_at='+s.bind(input.expiresAt)+',actor_role='+s.bind(scope.actorRole)+' WHERE '+s.equal('id',s.bind(input.id))+' AND '+actor(s,scope,this.client.dialect),s.params);if(result.affectedRows!==1)conflict();return;}
   const own=existing.filter(value=>value.accountId===scope.accountId),free=(used,count)=>Array.from({length:count},(_,index)=>index).find(index=>!used.has(index)),slot=free(new Set(existing.map(value=>value.slot)),64),accountSlot=free(new Set(own.map(value=>value.accountSlot)),8);
   if(slot===undefined||accountSlot===undefined)throw new RoomPresenceStoreError('ROOM_PRESENCE_CAPACITY',429);
   const fields=['id','workspace_id','page_id','epoch','account_id','membership_id','session_id','actor_role','client_id','sequence','document_version','cursor_json','expires_at','slot','account_slot'],values=[input.id,scope.workspaceId,scope.pageId,scope.epoch,scope.accountId,scope.membershipId,scope.sessionId,scope.actorRole,input.clientId,input.sequence,input.documentVersion,JSON.stringify(input.cursor),input.expiresAt,slot,accountSlot];
   s=context(this.client.dialect);try{const result=await this.query('INSERT INTO yumunio_room_presence ('+fields.join(',')+') SELECT '+values.map(s.bind).join(',')+' WHERE '+actor(s,scope,this.client.dialect),s.params);if(result.affectedRows!==1)conflict();return;}catch(error){if(error?.code!=='ROOM_PRESENCE_CHANGED'||attempt===3)throw error;}
  }
 }
 async leave(scope,id){validateScope(scope);if(!/^[a-f0-9]{32}$/.test(id))bad();const s=context(this.client.dialect);await this.query('DELETE FROM yumunio_room_presence WHERE '+scoped(s,scope)+' AND '+s.equal('id',s.bind(id))+' AND '+s.equal('account_id',s.bind(scope.accountId))+' AND '+s.equal('session_id',s.bind(scope.sessionId)),s.params);}
}
export function createSqliteRoomPresenceStore(database){return new SqlRoomPresenceStore({dialect:'sqlite',async query(sql,params=[]){const statement=database.prepare(sql);return /^SELECT\b/.test(sql)?{rows:statement.all(...params),affectedRows:0}:{rows:[],affectedRows:Number(statement.run(...params).changes)};}});}
export function createD1RoomPresenceStore(database){return new SqlRoomPresenceStore({dialect:'sqlite',async query(sql,params=[]){const result=await database.prepare(sql).bind(...params).all();if(result?.success===false)bad();return{rows:result.results,affectedRows:Number(result.meta?.changes??0)};}});}
export const createPoolRoomPresenceStore=client=>new SqlRoomPresenceStore(client);

const DURABLE_SCHEMA='CREATE TABLE IF NOT EXISTS room_presence (id TEXT NOT NULL PRIMARY KEY, workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, epoch TEXT NOT NULL, account_id TEXT NOT NULL, membership_id TEXT NOT NULL, session_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK (actor_role IN (\'owner\',\'admin\',\'member\',\'guest\')), client_id TEXT NOT NULL, sequence INTEGER NOT NULL, document_version INTEGER NOT NULL, cursor_json TEXT NOT NULL, expires_at TEXT NOT NULL, slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 64), account_slot INTEGER NOT NULL CHECK (account_slot >= 0 AND account_slot < 8), UNIQUE (workspace_id,page_id,slot), UNIQUE (workspace_id,page_id,account_id,account_slot))';
/** Cloudflare: TTL rows live in the page's own Durable Object SQLite database
 * (one PageRoom per workspace/page), so a 10s heartbeat never writes to D1.
 * D1 is only read: once to authorize the requester before a write, and once
 * to re-validate every candidate row's live user, membership and session with
 * the same predicates as the SQL list query. A revoked session therefore never
 * becomes visible even though the TTL row itself is not stored in D1. */
export class DurableRoomPresenceStore{
 #sql;#database;#ready=false;
 constructor(sql,database){if(!sql||typeof sql.exec!=='function'||!database||typeof database.prepare!=='function')bad();this.#sql=sql;this.#database=database;}
 #local(query,...params){try{if(!this.#ready){this.#sql.exec(DURABLE_SCHEMA);this.#ready=true;}return this.#sql.exec(query,...params);}catch(error){if(constraint(error))conflict();bad();}}
 async #remote(query,params){let result;try{result=await this.#database.prepare(query).bind(...params).all();}catch{bad();}if(result?.success===false||!Array.isArray(result?.results))bad();return result.results;}
 async #authorized(scope){const s=context('sqlite');return (await this.#remote('SELECT 1 AS ok WHERE '+actor(s,scope,'sqlite'),s.params)).length===1;}
 #rows(scope,{epoch=true,live=true}={}){return this.#local('SELECT * FROM room_presence WHERE workspace_id = ? AND page_id = ?'+(epoch?' AND epoch = ?':'')+(live?' AND expires_at > ?':'')+' ORDER BY slot LIMIT 65',scope.workspaceId,scope.pageId,...(epoch?[scope.epoch]:[]),...(live?[scope.now]:[])).toArray().map(row);}
 async checkSchema(){this.#local('SELECT id FROM room_presence WHERE 1 = 0');}
 /** Removes expired rows; called from the room alarm and before each write. */
 purgeExpired(now=new Date().toISOString()){timestamp(now);return this.#local('DELETE FROM room_presence WHERE expires_at <= ?',now).rowsWritten??0;}
 async list(scope){validateScope(scope);const rows=this.#rows(scope);if(rows.length>64)bad();if(!rows.length)return[];
  const s=context('sqlite'),c=s.column,b=s.bind,item=index=>'json_extract(j.value,\'$['+index+']\')';
  const sql='SELECT '+item(0)+' AS id FROM json_each('+b(JSON.stringify(rows.map(value=>[value.id,value.accountId,value.membershipId,value.actorRole,value.sessionId])))+') j JOIN yumunio_users pu ON '+c('pu','id')+' = '+item(1)+' JOIN yumunio_memberships pm ON '+c('pm','id')+' = '+item(2)+' AND '+c('pm','organizationId')+' = '+b(scope.workspaceId)+' AND '+c('pm','userId')+' = '+c('pu','id')+' AND '+c('pm','role')+' = '+item(3)+' JOIN yumunio_auth_sessions ps ON '+c('ps','id')+' = '+item(4)+' AND '+c('ps','userId')+' = '+c('pu','id')+' WHERE '+c('pu','emailVerified')+' = TRUE AND '+c('ps','expiresAt')+' > '+b(Date.parse(scope.now))+' AND '+actor(s,scope,'sqlite');
  const allowed=new Set((await this.#remote(sql,s.params)).map(value=>value.id));return rows.filter(value=>allowed.has(value.id));
 }
 async publish(scope,input){validateScope(scope);if(!validPresenceClientId(input.clientId)||!/^[a-f0-9]{32}$/.test(input.id))bad();integer(input.sequence,1);integer(input.documentVersion,1);timestamp(input.expiresAt);if(Date.parse(input.expiresAt)-Date.parse(scope.now)!==PRESENCE_LIMITS.ttlMs)bad();
  this.purgeExpired(scope.now);
  if(!await this.#authorized(scope))conflict();
  // No await from here on: Durable Object SQL runs synchronously, so the
  // epoch sweep, slot allocation and write commit together under one gate.
  this.#local('DELETE FROM room_presence WHERE workspace_id = ? AND page_id = ? AND epoch <> ?',scope.workspaceId,scope.pageId,scope.epoch);
  const existing=this.#rows(scope,{epoch:false,live:false});if(existing.length>64)bad();
  const prior=existing.find(value=>value.id===input.id);
  if(prior){if(prior.accountId!==scope.accountId||prior.membershipId!==scope.membershipId||prior.sessionId!==scope.sessionId||prior.clientId!==input.clientId)bad();
   this.#local('UPDATE room_presence SET sequence = ?, document_version = ?, cursor_json = ?, expires_at = ?, actor_role = ? WHERE id = ?',input.sequence,input.documentVersion,JSON.stringify(input.cursor),input.expiresAt,scope.actorRole,input.id);return;}
  const own=existing.filter(value=>value.accountId===scope.accountId),free=(used,count)=>Array.from({length:count},(_,index)=>index).find(index=>!used.has(index)),slot=free(new Set(existing.map(value=>value.slot)),64),accountSlot=free(new Set(own.map(value=>value.accountSlot)),8);
  if(slot===undefined||accountSlot===undefined)throw new RoomPresenceStoreError('ROOM_PRESENCE_CAPACITY',429);
  this.#local('INSERT INTO room_presence (id,workspace_id,page_id,epoch,account_id,membership_id,session_id,actor_role,client_id,sequence,document_version,cursor_json,expires_at,slot,account_slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',input.id,scope.workspaceId,scope.pageId,scope.epoch,scope.accountId,scope.membershipId,scope.sessionId,scope.actorRole,input.clientId,input.sequence,input.documentVersion,JSON.stringify(input.cursor),input.expiresAt,slot,accountSlot);
 }
 async leave(scope,id){validateScope(scope);if(!/^[a-f0-9]{32}$/.test(id))bad();this.#local('DELETE FROM room_presence WHERE workspace_id = ? AND page_id = ? AND epoch = ? AND id = ? AND account_id = ? AND session_id = ?',scope.workspaceId,scope.pageId,scope.epoch,id,scope.accountId,scope.sessionId);}
}
export const createDurableRoomPresenceStore=({sql,database})=>new DurableRoomPresenceStore(sql,database);
