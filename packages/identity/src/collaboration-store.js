import {principalSnapshotGuardSql} from './content-principal-guard.js';
import {encodeContentPayload,readContentPayload,contentChunkCommands} from './content-codec.js';
import { assertId, assertJsonSerializable, assertPlainObject } from '@yumunio/domain';
export class CollaborationStoreError extends Error {
  constructor(code='COLLABORATION_STORAGE_ERROR'){super('The collaboration operation could not be completed.');this.name='CollaborationStoreError';this.code=code;}
}
const bad=()=>{throw new CollaborationStoreError();};
const conflict=()=>{throw new CollaborationStoreError('COLLABORATION_CONFLICT');};
const roles=['owner','admin','member','guest'],encoder=new TextEncoder();
function integer(value,min=0){if(typeof value==='bigint')value=Number(value);if(typeof value==='string'&&/^\d{1,16}$/.test(value))value=Number(value);if(!Number.isSafeInteger(value)||value<min)bad();return value;}
function capture(value,max=900000){try{assertJsonSerializable(value);const text=JSON.stringify(value);if(encoder.encode(text).length>max)bad();return text;}catch{bad();}}
function parse(value){try{if(typeof value!=='string'||encoder.encode(value).length>900000)bad();return JSON.parse(value);}catch{bad();}}
function sqlContext(dialect){
  const params=[],bind=value=>{params.push(value);return dialect==='postgres'?'$'+params.length:'?';};
  const quote=name=>{const mark=dialect==='mysql'?String.fromCharCode(96):'"';return mark+name+mark;};
  const column=(alias,name)=>alias+'.'+quote(name),equal=(a,b)=>dialect==='mysql'?'BINARY '+a+' = BINARY '+b:a+' = '+b;
  return {params,bind,quote,column,equal};
}
const stmt=(s,sql,changes)=>({sql,params:s.params,...(changes===undefined?{}:{changes})});
function principalGuard(s,workspaceId,p){
  if(!p||!roles.includes(p.role))bad();assertId(p.id);assertId(p.accountId);
  const {column:c,equal:e,bind:b}=s;
  return 'EXISTS (SELECT 1 FROM yumunio_memberships gm JOIN yumunio_users gu ON '+e(c('gu','id'),c('gm','userId'))+
    ' WHERE '+e(c('gm','organizationId'),b(workspaceId))+' AND '+e(c('gm','id'),b(p.id))+' AND '+e(c('gm','userId'),b(p.accountId))+
    ' AND '+e(c('gm','role'),b(p.role))+' AND '+c('gu','emailVerified')+' = '+(p.emailVerified?'TRUE':'FALSE')+' AND '+e(c('gu','email'),b(p.email))+
    ' AND (SELECT COUNT(*) FROM yumunio_memberships gc WHERE '+e(c('gc','organizationId'),c('gm','organizationId'))+' AND '+e(c('gc','userId'),c('gm','userId'))+') = 1)';
}
function invitationRow(row){return row?{invitation:parse(row.invitation_json),generation:integer(row.generation,1),issuerMembershipId:assertId(row.issuer_membership_id),status:row.status}:null;}
export class SqlCollaborationStore {
  #client;
  #chunkReady;
  constructor(client){if(!client||!['sqlite','mysql','postgres'].includes(client.dialect)||typeof client.query!=='function'||typeof client.batch!=='function')bad();this.#client=client;}
  async #query(sql,params=[]){try{return normalized(await this.#client.query(sql,params));}catch{bad();}}
  async #batch(commands){try{return await this.#client.batch(commands);}catch(error){if(error?.code==='COLLABORATION_CONFLICT')throw error;bad();}}
  async checkSchema(){for(const table of ['yumunio_collaboration_invitations','yumunio_mail_jobs','yumunio_transaction_guards'])await this.#query('SELECT * FROM '+table+' WHERE 1 = 0');this.#chunkReady=undefined;await this.#chunkSchema();}
  async #chunkSchema(){if(this.#chunkReady===undefined){try{await this.#query('SELECT workspace_id,revision,ordinal,payload_text FROM yumunio_content_chunks WHERE 1 = 0');await this.#query('SELECT id,ok FROM yumunio_content_guards WHERE 1 = 0');this.#chunkReady=true;}catch{this.#chunkReady=false;}}return this.#chunkReady;}
  async account(accountId){
    assertId(accountId);const s=sqlContext(this.#client.dialect),c=s.column;
    const {rows}=await this.#query('SELECT '+c('u','id')+' AS id,'+c('u','email')+' AS email,'+c('u','emailVerified')+' AS verified FROM yumunio_users u WHERE '+s.equal(c('u','id'),s.bind(accountId)),s.params);
    if(rows.length!==1)return null;const row=rows[0];return {id:assertId(row.id),email:row.email,emailVerified:row.verified===true||row.verified===1,status:'active',serverRole:'user'};
  }
  async invitation(id){
    assertId(id);const s=sqlContext(this.#client.dialect);
    const {rows}=await this.#query('SELECT invitation_json,generation,issuer_membership_id,status FROM yumunio_collaboration_invitations WHERE '+s.equal('id',s.bind(id)),s.params);return invitationRow(rows[0]);
  }
  async load(workspaceId){
    assertId(workspaceId);let s=sqlContext(this.#client.dialect),c=s.column,e=s.equal;
    const workspace=await this.#query('SELECT '+c('w','id')+' AS id,'+c('w','name')+' AS workspace_name,c.revision,c.payload_json FROM yumunio_workspaces w LEFT JOIN yumunio_account_content c ON '+e('c.workspace_id',c('w','id'))+' WHERE '+e(c('w','id'),s.bind(workspaceId)),s.params);
    if(workspace.rows.length!==1)return null;
    s=sqlContext(this.#client.dialect);c=s.column;e=s.equal;
    const members=await this.#query('SELECT '+c('m','id')+' AS id,'+c('m','userId')+' AS account_id,'+c('m','role')+' AS role,'+c('u','email')+' AS email,'+c('u','emailVerified')+' AS verified FROM yumunio_memberships m JOIN yumunio_users u ON '+e(c('u','id'),c('m','userId'))+' WHERE '+e(c('m','organizationId'),s.bind(workspaceId))+' LIMIT 1001',s.params);
    if(members.rows.length>1000)bad();const ids=new Set();
    const principals=members.rows.map(row=>{if(ids.has(row.account_id)||!roles.includes(row.role)||typeof row.email!=='string'||row.email.length>254)bad();ids.add(row.account_id);return {id:assertId(row.id),accountId:assertId(row.account_id),role:row.role,email:row.email,emailVerified:row.verified===true||row.verified===1};});
    s=sqlContext(this.#client.dialect);
    const invitations=await this.#query('SELECT invitation_json,generation,issuer_membership_id,status FROM yumunio_collaboration_invitations WHERE '+s.equal('workspace_id',s.bind(workspaceId))+' LIMIT 2001',s.params);
    if(invitations.rows.length>2000)bad();const row=workspace.rows[0];
    const currentRevision=row.revision===null?0:integer(row.revision,1);let payload;try{payload=row.payload_json===null?null:await readContentPayload((...args)=>this.#query(...args),this.#client.dialect,workspaceId,currentRevision,row.payload_json);}catch{bad();}
    return {workspaceName:typeof row.workspace_name==='string'?row.workspace_name:'',revision:currentRevision,payload,principals,invitations:invitations.rows.map(invitationRow)};
  }
  /** Content CAS, live identity guards and every mutation run in one real transaction. */
  async commit(input){
    assertPlainObject(input);
    const {workspaceId,expectedRevision,payload,guards=[],accountGuard=null,membershipChange=null,invitationChange=null,jobs=[],cancelInvitationId=null,lastOwner=false,principalSnapshot=null}=input;
    assertId(workspaceId);if(typeof expectedRevision!=='number'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)conflict();
    let encoded;try{encoded=encodeContentPayload(payload,expectedRevision+1);}catch{bad();}const text=encoded.head,transport=await this.#chunkSchema(),commands=[];if(encoded.chunks.length&&!transport)bad();
    if(this.#client.dialect!=='sqlite'){const t=sqlContext(this.#client.dialect);commands.push(stmt(t,'SELECT '+t.column('w','id')+' FROM yumunio_workspaces w WHERE '+t.equal(t.column('w','id'),t.bind(workspaceId))+' FOR UPDATE'));}
    const s=sqlContext(this.#client.dialect);let sql;
    if(expectedRevision===0)sql='INSERT INTO yumunio_account_content (workspace_id,revision,payload_json) SELECT '+s.bind(workspaceId)+',1,'+s.bind(text)+' WHERE NOT EXISTS (SELECT 1 FROM yumunio_account_content c WHERE '+s.equal('c.workspace_id',s.bind(workspaceId))+') AND ';
    else sql='UPDATE yumunio_account_content SET revision=revision+1,payload_json='+s.bind(text)+' WHERE '+s.equal('workspace_id',s.bind(workspaceId))+' AND revision='+s.bind(expectedRevision)+' AND ';
    sql+='EXISTS (SELECT 1 FROM yumunio_workspaces w WHERE '+s.equal(s.column('w','id'),s.bind(workspaceId))+')';
    if(!transport&&expectedRevision>0)sql+=' AND payload_json NOT LIKE \'{"$yumunioContent":1,%\'';
    if(!Array.isArray(guards)||guards.length>4)bad();
    for(const p of guards)sql+=' AND '+principalGuard(s,workspaceId,p);
    if(accountGuard)sql+=' AND EXISTS (SELECT 1 FROM yumunio_users ru WHERE '+s.equal(s.column('ru','id'),s.bind(assertId(accountGuard.id)))+' AND '+s.equal(s.column('ru','email'),s.bind(accountGuard.email))+' AND '+s.column('ru','emailVerified')+' = TRUE)';
    if(membershipChange?.kind==='insert')sql+=' AND NOT EXISTS (SELECT 1 FROM yumunio_memberships nm WHERE '+s.equal(s.column('nm','organizationId'),s.bind(workspaceId))+' AND '+s.equal(s.column('nm','userId'),s.bind(membershipChange.accountId))+')';
    if(invitationChange?.expectedGeneration)sql+=' AND EXISTS (SELECT 1 FROM yumunio_collaboration_invitations ci WHERE '+s.equal('ci.id',s.bind(invitationChange.value.invitation.id))+' AND ci.generation='+s.bind(invitationChange.expectedGeneration)+" AND ci.status='pending')";
    if(lastOwner)sql+=' AND (SELECT COUNT(*) FROM yumunio_memberships ow JOIN yumunio_users ou ON '+s.equal(s.column('ou','id'),s.column('ow','userId'))+' WHERE '+s.equal(s.column('ow','organizationId'),s.bind(workspaceId))+' AND '+s.equal(s.column('ow','role'),s.bind('owner'))+' AND '+s.column('ou','emailVerified')+' = TRUE) > 1';
    if(principalSnapshot!==null){try{sql+=' AND '+principalSnapshotGuardSql(s,this.#client.dialect,workspaceId,principalSnapshot);}catch{bad();}}
    commands.push(stmt(s,sql,1));
    if(transport)commands.push(...contentChunkCommands(this.#client.dialect,{workspaceId,revision:expectedRevision+1,chunks:encoded.chunks}));
    if(membershipChange){
      const m=membershipChange,t=sqlContext(this.#client.dialect),q=t.quote,e=t.equal,b=t.bind;let sql;
      if(m.kind==='insert'){
        const createdAt=this.#client.dialect==='mysql'?m.createdAt.replace('T',' ').slice(0,-1):m.createdAt;
        sql='INSERT INTO yumunio_memberships ('+['id','organizationId','userId','role','createdAt'].map(q).join(',')+') VALUES ('+[m.id,workspaceId,m.accountId,m.role,createdAt].map(b).join(',')+')';
      }
      else {
        const roleBind=m.kind==='update'?b(m.role):null;
        const where=e(q('id'),b(m.id))+' AND '+e(q('organizationId'),b(workspaceId))+' AND '+e(q('userId'),b(m.accountId))+' AND '+e(q('role'),b(m.previousRole));
        if(m.kind==='update')sql='UPDATE yumunio_memberships SET '+q('role')+'='+roleBind+' WHERE '+where;
        else if(m.kind==='delete')sql='DELETE FROM yumunio_memberships WHERE '+where;else bad();
      }
      commands.push(stmt(t,sql,1));
    }
    if(invitationChange){
      const {value,expectedGeneration}=invitationChange,t=sqlContext(this.#client.dialect),b=t.bind,json=capture(value.invitation,10000);
      const sql=expectedGeneration?'UPDATE yumunio_collaboration_invitations SET generation='+b(value.generation)+',invitation_json='+b(json)+',issuer_membership_id='+b(value.issuerMembershipId)+',status='+b(value.status)+' WHERE '+t.equal('id',b(value.invitation.id))+' AND generation='+b(expectedGeneration)+" AND status='pending'":
        'INSERT INTO yumunio_collaboration_invitations (id,workspace_id,generation,invitation_json,issuer_membership_id,status) VALUES ('+[value.invitation.id,workspaceId,value.generation,json,value.issuerMembershipId,value.status].map(b).join(',')+')';
      commands.push(stmt(t,sql,1));
    }
    if(cancelInvitationId){const t=sqlContext(this.#client.dialect);commands.push(stmt(t,"UPDATE yumunio_mail_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE invitation_id="+t.bind(cancelInvitationId)+" AND status IN ('queued','leased')"));}
    for(const job of jobs)commands.push(this.#jobInsert(job));
    await this.#batch(commands);return {revision:expectedRevision+1};
  }
  #jobInsert(job){
    const s=sqlContext(this.#client.dialect),keys=['id','dedupe_key','payload_ciphertext','payload_digest','status','attempts','available_at','lease_id','lease_until','created_at','updated_at','expires_at','invitation_id','invitation_generation'];
    return stmt(s,'INSERT INTO yumunio_mail_jobs ('+keys.join(',')+') VALUES ('+[job.id,job.dedupeKey,job.ciphertext,job.digest,'queued',0,job.now,null,null,job.now,job.now,job.expiresAt,job.invitationId??null,job.invitationGeneration??null].map(s.bind).join(',')+')',1);
  }
  async enqueue(job){
    const command=this.#jobInsert(job);
    // A single insert joins an enclosing SDK SQLite transaction; never opens a nested one.
    command.sql+=this.#client.dialect==='mysql'?' ON DUPLICATE KEY UPDATE dedupe_key=dedupe_key':' ON CONFLICT (dedupe_key) DO NOTHING';
    await this.#query(command.sql,command.params);
    const s=sqlContext(this.#client.dialect),{rows}=await this.#query('SELECT id,payload_digest FROM yumunio_mail_jobs WHERE '+s.equal('dedupe_key',s.bind(job.dedupeKey)),s.params);
    if(rows.length===1&&rows[0].payload_digest===job.digest)return {id:rows[0].id};bad();
  }
  async due(now,limit=10){
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)bad();const s=sqlContext(this.#client.dialect);
    const {rows}=await this.#query("SELECT id FROM yumunio_mail_jobs WHERE ((status='queued' AND available_at <= "+s.bind(now)+") OR (status='leased' AND lease_until <= "+s.bind(now)+')) ORDER BY available_at,id LIMIT '+limit,s.params);return rows.map(row=>assertId(row.id));
  }
  async claim(id,leaseId,now,leaseUntil){
    const s=sqlContext(this.#client.dialect),r=await this.#query("UPDATE yumunio_mail_jobs SET status='leased',lease_id="+s.bind(leaseId)+',lease_until='+s.bind(leaseUntil)+',attempts=attempts+1,updated_at='+s.bind(now)+' WHERE '+s.equal('id',s.bind(id))+" AND ((status='queued' AND available_at <= "+s.bind(now)+") OR (status='leased' AND lease_until <= "+s.bind(now)+'))',s.params);
    return r.affectedRows===1?this.leased(id,leaseId):null;
  }
  async leased(id,leaseId){const s=sqlContext(this.#client.dialect),{rows}=await this.#query('SELECT * FROM yumunio_mail_jobs WHERE '+s.equal('id',s.bind(id))+' AND '+s.equal('lease_id',s.bind(leaseId))+" AND status='leased'",s.params);return rows.length===1?structuredClone(rows[0]):null;}
  async settle(id,leaseId,{status,now,availableAt}){
    if(!['queued','accepted','dead','cancelled'].includes(status))bad();const s=sqlContext(this.#client.dialect);
    const r=await this.#query('UPDATE yumunio_mail_jobs SET status='+s.bind(status)+',available_at='+s.bind(availableAt??now)+',updated_at='+s.bind(now)+',lease_id=NULL,lease_until=NULL WHERE '+s.equal('id',s.bind(id))+' AND '+s.equal('lease_id',s.bind(leaseId))+" AND status='leased'",s.params);return r.affectedRows===1;
  }
}
function normalized(r){if(!r||!Array.isArray(r.rows)||!Number.isSafeInteger(r.affectedRows)||r.affectedRows<0)bad();return r;}
function checkChanges(command,result){if(command.changes!==undefined&&result.affectedRows!==command.changes)conflict();}
function databaseConflict(error){return error?.code==='COLLABORATION_CONFLICT'||['23505','ER_DUP_ENTRY','SQLITE_CONSTRAINT_UNIQUE','SQLITE_CONSTRAINT_CHECK'].includes(error?.code)||/yumunio_transaction_guard|UNIQUE constraint failed/.test(error?.message??'');}
export function createSqliteCollaborationStore(database){
  if(!database||typeof database.prepare!=='function')bad();
  const execute=command=>{const statement=database.prepare(command.sql);if(/^\s*SELECT\b/i.test(command.sql))return {rows:statement.all(...(command.params??[])),affectedRows:0};return {rows:[],affectedRows:Number(statement.run(...(command.params??[])).changes)};};
  return new SqlCollaborationStore({dialect:'sqlite',async query(sql,params=[]){return execute({sql,params});},async batch(commands){
    database.exec('BEGIN IMMEDIATE');try{const results=commands.map(command=>{const r=execute(command);checkChanges(command,r);return r;});database.exec('COMMIT');return results;}
    catch(error){try{database.exec('ROLLBACK');}catch{}if(databaseConflict(error))conflict();throw error;}
  }});
}
export function createD1CollaborationStore(database){
  if(!database||typeof database.prepare!=='function'||typeof database.batch!=='function')bad();
  const prepared=c=>database.prepare(c.sql).bind(...(c.params??[]));
  return new SqlCollaborationStore({dialect:'sqlite',async query(sql,params=[]){const r=await prepared({sql,params}).all();if(r?.success===false)bad();return normalized({rows:r.results,affectedRows:r.meta?.changes});},async batch(commands){
    const statements=[];
    for(const command of commands){statements.push(prepared(command));if(command.changes!==undefined){const id=crypto.randomUUID();statements.push(database.prepare('INSERT INTO yumunio_transaction_guards (id,ok) VALUES (?,CASE WHEN changes() = ? THEN 1 ELSE 0 END)').bind(id,command.changes));statements.push(database.prepare('DELETE FROM yumunio_transaction_guards WHERE id = ?').bind(id));}}
    try{const r=await database.batch(statements);if(r.some(row=>row.success===false))bad();return r;}catch(error){if(databaseConflict(error))conflict();throw error;}
  }});
}
/** Caller-owned mysql2/pg pools; one connection is held through each complete transaction. */
export function createPoolCollaborationStore(client){
  if(!client||!['mysql','postgres'].includes(client.dialect)||!client.database||typeof client.query!=='function')bad();const {dialect,database}=client;
  return new SqlCollaborationStore({dialect,query:client.query.bind(client),async batch(commands){
    const connection=dialect==='mysql'?await database.getConnection():await database.connect();
    const query=async(sql,params=[])=>{if(dialect==='mysql'){const [r]=await connection.execute(sql,params);return Array.isArray(r)?{rows:r,affectedRows:0}:{rows:[],affectedRows:r.affectedRows};}const r=await connection.query(sql,params);return {rows:r.rows,affectedRows:r.rowCount??0};};
    try{await connection.query('BEGIN');const results=[];for(const c of commands){const r=normalized(await query(c.sql,c.params));checkChanges(c,r);results.push(r);}await connection.query('COMMIT');return results;}
    catch(error){try{await connection.query('ROLLBACK');}catch{}if(databaseConflict(error))conflict();throw error;}finally{connection.release();}
  }});
}
