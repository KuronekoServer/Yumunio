import {assertId} from '@yumunio/domain';
export class AdminStoreError extends Error {constructor(code='ADMIN_STORAGE_ERROR'){super('The administration operation could not be completed.');this.name='AdminStoreError';this.code=code;}}
const fail=(code='ADMIN_STORAGE_ERROR')=>{throw new AdminStoreError(code);};
const statuses=['queued','leased','accepted','dead','cancelled'];
function context(dialect){
  const params=[],bind=value=>{params.push(value);return dialect==='postgres'?'$'+params.length:'?';},mark=dialect==='mysql'?String.fromCharCode(96):'"';
  const column=(a,n)=>a+'.'+mark+n+mark,equal=(a,b)=>dialect==='mysql'?'BINARY '+a+' = BINARY '+b:a+' = '+b;
  return {params,bind,column,equal};
}
const number=value=>{if(typeof value==='bigint')value=Number(value);if(typeof value==='string'&&/^\d{1,16}$/.test(value))value=Number(value);if(!Number.isSafeInteger(value)||value<0)fail();return value;};
function date(value){
  if(value===null||value===undefined)fail();
  if(value instanceof Date)value=value.toISOString();
  else if(typeof value==='string'&&/^\d{10,16}$/.test(value))value=Number(value);
  else if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value))value=value.replace(' ','T')+'Z';
  try{const result=new Date(value).toISOString();if(result.length!==24)fail();return result;}catch{fail();}
}
function label(value,max){if(typeof value!=='string')fail();return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'')).slice(0,max).join('');}
function mailJob(row){
  if(!row||!statuses.includes(row.status))fail();
  return {id:assertId(row.id),status:row.status,attempts:number(row.attempts),createdAt:date(row.created_at),updatedAt:date(row.updated_at),expiresAt:date(row.expires_at),
    nextAttemptAt:row.status==='queued'?date(row.available_at):null,canRetry:row.status==='dead'};
}
export class SqlAdminStore {
  #client;#ids;
  constructor(client,{adminIds=[]}={}){
    if(!client||!['sqlite','mysql','postgres'].includes(client.dialect)||typeof client.query!=='function'||!Array.isArray(adminIds)||adminIds.length>100)fail();
    this.#client=client;this.#ids=new Set(adminIds.map(id=>assertId(id)));
  }
  #guard(s,accountId,email){
    assertId(accountId);if(!this.#ids.has(accountId))fail('ADMIN_NOT_FOUND');
    return 'EXISTS (SELECT 1 FROM yumunio_users au WHERE '+s.equal(s.column('au','id'),s.bind(accountId))+' AND '+s.column('au','emailVerified')+' = TRUE'+
      (email!==undefined?' AND '+s.equal(s.column('au','email'),s.bind(email)):'')+')';
  }
  async #query(sql,params=[],duplicate=false){
    try{const r=await this.#client.query(sql,params);if(!r||!Array.isArray(r.rows)||!Number.isSafeInteger(r.affectedRows)||r.affectedRows<0)fail();return r;}
    catch(error){if(duplicate&&(error?.code==='ER_DUP_ENTRY'||error?.errno===1062))return {rows:[],affectedRows:0};fail();}
  }
  async authorize(accountId){
    const s=context(this.#client.dialect),guard=this.#guard(s,accountId),c=s.column;
    const {rows}=await this.#query('SELECT '+c('u','id')+' AS id,'+c('u','name')+' AS name,'+c('u','email')+' AS email FROM yumunio_users u WHERE '+s.equal(c('u','id'),s.bind(accountId))+' AND '+guard,s.params);
    if(rows.length!==1)fail('ADMIN_NOT_FOUND');
    return {id:assertId(rows[0].id),name:label(rows[0].name,120),email:label(rows[0].email,254)};
  }
  async users(accountId){
    const s=context(this.#client.dialect),guard=this.#guard(s,accountId),c=s.column;
    const {rows}=await this.#query('SELECT '+['id','name','email','emailVerified','createdAt'].map(n=>c('u',n)+' AS '+(n==='emailVerified'?'verified':n==='createdAt'?'created_at':n)).join(',')+
      ' FROM yumunio_users u WHERE '+guard+' ORDER BY '+c('u','createdAt')+','+c('u','id')+' LIMIT 101',s.params);
    if(!rows.length)fail('ADMIN_NOT_FOUND');
    return {users:rows.slice(0,100).map(row=>({id:assertId(row.id),name:label(row.name,120),email:label(row.email,254),emailVerified:row.verified===true||row.verified===1,
      createdAt:date(row.created_at),serverAdmin:this.#ids.has(row.id),currentUser:row.id===accountId})),hasMore:rows.length>100};
  }
  async sessions(accountId,targetId,currentSessionId){
    assertId(targetId);const s=context(this.#client.dialect),c=s.column,target=s.bind(targetId),guard=this.#guard(s,accountId);
    const {rows}=await this.#query('SELECT '+c('u','id')+' AS target_id,'+c('ss','id')+' AS id,'+c('ss','createdAt')+' AS created_at,'+c('ss','expiresAt')+' AS expires_at FROM yumunio_users u LEFT JOIN yumunio_auth_sessions ss ON '+
      s.equal(c('ss','userId'),c('u','id'))+' WHERE '+s.equal(c('u','id'),target)+' AND '+guard+' ORDER BY '+c('ss','createdAt')+' DESC,'+c('ss','id')+' LIMIT 101',s.params);
    if(!rows.length)fail('ADMIN_NOT_FOUND');
    const sessions=rows.filter(row=>row.id!==null);
    return {userId:targetId,sessions:sessions.slice(0,100).map(row=>({id:assertId(row.id),createdAt:date(row.created_at),expiresAt:date(row.expires_at),current:targetId===accountId&&row.id===currentSessionId})),hasMore:sessions.length>100};
  }
  async revokeSession(accountId,targetId,sessionId){
    assertId(targetId);assertId(sessionId);const s=context(this.#client.dialect),q=n=>(this.#client.dialect==='mysql'?String.fromCharCode(96):'"')+n+(this.#client.dialect==='mysql'?String.fromCharCode(96):'"');
    const r=await this.#query('DELETE FROM yumunio_auth_sessions WHERE '+s.equal(q('id'),s.bind(sessionId))+' AND '+s.equal(q('userId'),s.bind(targetId))+' AND '+this.#guard(s,accountId),s.params);
    if(r.affectedRows!==1)fail('ADMIN_NOT_FOUND');return {revoked:true};
  }
  async jobs(accountId,prefix){
    const s=context(this.#client.dialect),guard=this.#guard(s,accountId);
    const counts=await this.#query('SELECT status,COUNT(*) AS n FROM yumunio_mail_jobs WHERE '+guard+' GROUP BY status',s.params);
    const aggregate=Object.fromEntries(statuses.map(status=>[status,0]));
    for(const row of counts.rows){if(!statuses.includes(row.status))fail();aggregate[row.status]=number(row.n);}
    const t=context(this.#client.dialect);
    const {rows}=await this.#query('SELECT id,status,attempts,created_at,updated_at,expires_at,available_at FROM yumunio_mail_jobs WHERE dedupe_key LIKE '+t.bind(prefix+'%')+' AND '+this.#guard(t,accountId)+' ORDER BY created_at DESC,id LIMIT 20',t.params);
    // This also rejects a removed administrator when the job tables are empty.
    await this.authorize(accountId);
    return {counts:aggregate,tests:rows.map(mailJob)};
  }
  async enqueueTest(accountId,email,prefix,job){
    const s=context(this.#client.dialect),keys=['id','dedupe_key','payload_ciphertext','payload_digest','status','attempts','available_at','lease_id','lease_until','created_at','updated_at','expires_at','invitation_id','invitation_generation'];
    const values=[job.id,job.dedupeKey,job.ciphertext,job.digest,'queued',0,job.now,null,null,job.now,job.now,job.expiresAt,null,null];
    if(!job.dedupeKey.startsWith(prefix))fail();
    let sql='INSERT INTO yumunio_mail_jobs ('+keys.join(',')+') SELECT '+values.map(s.bind).join(',')+' WHERE '+this.#guard(s,accountId,email);
    if(this.#client.dialect!=='mysql')sql+=' ON CONFLICT (dedupe_key) DO NOTHING';
    const r=await this.#query(sql,s.params,this.#client.dialect==='mysql');
    const t=context(this.#client.dialect),{rows}=await this.#query('SELECT id,status,payload_digest FROM yumunio_mail_jobs WHERE '+t.equal('dedupe_key',t.bind(job.dedupeKey))+' AND '+this.#guard(t,accountId,email),t.params);
    if(rows.length!==1)fail('ADMIN_NOT_FOUND');
    if(rows[0].payload_digest!==job.digest)fail('ADMIN_CONFLICT');
    return {jobId:assertId(rows[0].id),status:rows[0].status,replayed:r.affectedRows===0};
  }
  async retryTest(accountId,email,prefix,id,job){
    assertId(id);const s=context(this.#client.dialect);
    const r=await this.#query("UPDATE yumunio_mail_jobs SET status='queued',attempts=0,payload_ciphertext="+s.bind(job.ciphertext)+',payload_digest='+s.bind(job.digest)+
      ',available_at='+s.bind(job.now)+',updated_at='+s.bind(job.now)+',expires_at='+s.bind(job.expiresAt)+',lease_id=NULL,lease_until=NULL WHERE '+s.equal('id',s.bind(id))+
      " AND status='dead' AND dedupe_key LIKE "+s.bind(prefix+'%')+' AND '+this.#guard(s,accountId,email),s.params);
    if(r.affectedRows!==1)fail('ADMIN_CONFLICT');return {jobId:id,status:'queued'};
  }
}
export function createSqliteAdminStore(database,options){
  if(!database||typeof database.prepare!=='function')fail();
  return new SqlAdminStore({dialect:'sqlite',async query(sql,params=[]){const s=database.prepare(sql);return /^SELECT\b/.test(sql)?{rows:s.all(...params),affectedRows:0}:{rows:[],affectedRows:Number(s.run(...params).changes)};}},options);
}
export function createD1AdminStore(database,options){
  if(!database||typeof database.prepare!=='function')fail();
  return new SqlAdminStore({dialect:'sqlite',async query(sql,params=[]){const r=await database.prepare(sql).bind(...params).all();if(r?.success===false)fail();return {rows:r.results,affectedRows:r.meta?.changes};}},options);
}
