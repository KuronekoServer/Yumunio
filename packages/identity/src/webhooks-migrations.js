import {WEBHOOK_EVENT_TYPES,WEBHOOK_DEFAULT_EVENT_TYPES,WEBHOOK_JOB_FIELDS} from './webhooks-model.js';
const fail=()=>{throw new Error('Webhook event schema requires an explicit migration.');};
const table='yumunio_webhook_jobs',constraint='yumunio_webhook_event_type',uniqueConstraint='yumunio_webhook_job_scope';
const eventCheck='event_type IN ('+WEBHOOK_EVENT_TYPES.map(type=>"'"+type+"'").join(',')+')';
const oldUnique='subscription_id,subscription_version,page_version,event_type',newUnique='subscription_id,subscription_version,page_id,page_version,event_type';
const fields=Object.values(WEBHOOK_JOB_FIELDS).join(',');
export const WEBHOOK_LIFECYCLE_REBUILD=Object.freeze([
 `CREATE TABLE yumunio_webhook_jobs_event_v3 (
 event_id TEXT NOT NULL PRIMARY KEY,
 subscription_id TEXT NOT NULL,
 subscription_version INTEGER NOT NULL CHECK(subscription_version>=1),
 profile_hash TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 page_version INTEGER NOT NULL CHECK(page_version>=1 AND page_version<9007199254740991),
 event_type TEXT NOT NULL CONSTRAINT yumunio_webhook_event_type CHECK(${eventCheck}),
 occurred_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(length(payload_json)<=1024),
 payload_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','leased','delivered','failed','cancelled','quarantined')),
 attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=4),
 next_attempt_at TEXT NOT NULL,
 lease_id TEXT,
 lease_until TEXT,
 last_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1 AND version<9007199254740991),
 CONSTRAINT yumunio_webhook_job_scope UNIQUE(${newUnique}),
 CHECK((status='leased' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'leased' AND lease_id IS NULL AND lease_until IS NULL))
)`,
 'INSERT INTO yumunio_webhook_jobs_event_v3 ('+fields+') SELECT '+fields+' FROM yumunio_webhook_jobs',
 'DROP TABLE yumunio_webhook_jobs',
 'ALTER TABLE yumunio_webhook_jobs_event_v3 RENAME TO yumunio_webhook_jobs',
 'CREATE INDEX yumunio_webhook_due ON yumunio_webhook_jobs(status,next_attempt_at,event_id)',
 'CREATE INDEX yumunio_webhook_scope_jobs ON yumunio_webhook_jobs(subscription_id,status)'
]);
function normalized(value){return String(value).toLowerCase().replace(/\bcheck\b/g,'').replace(/::(?:text|character varying)/g,'').replace(/_[a-z0-9]+(?=')/g,'').replace(/[\s\x60"()]/g,'');}
function kind(definition){
 const value=normalized(definition);if(value==="event_type='page.updated'")return'legacy';
 for(const [state,types]of [['details',WEBHOOK_EVENT_TYPES.slice(0,3)],['current',WEBHOOK_EVENT_TYPES]]){const names=types.map(name=>"'"+name+"'").join(',');if(value==='event_typein'+names||value==='event_type=anyarray['+names+']')return state;}
 return'unknown';
}
const validName=name=>typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(name);
async function inspect(dialect,query,{unique=false}={}){
 let constraints,ddl;
 if(dialect==='sqlite'){
  ddl=(await query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='yumunio_webhook_jobs'")).rows?.[0]?.sql;if(typeof ddl!=='string')fail();
  constraints=[...ddl.matchAll(/\bCHECK\s*\(([^)]*)\)/gi)].map(match=>({name:null,definition:match[1]}));
 }else if(dialect==='postgres')constraints=(await query("SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='yumunio_webhook_jobs'::regclass AND contype='c'")).rows;
 else if(dialect==='mysql')constraints=(await query("SELECT tc.CONSTRAINT_NAME AS name,cc.CHECK_CLAUSE AS definition FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='yumunio_webhook_jobs' AND tc.CONSTRAINT_TYPE='CHECK'")).rows;
 else fail();
 if(!Array.isArray(constraints))fail();const found=[...new Map(constraints.filter(row=>typeof row.definition==='string'&&/\bevent_type\b/i.test(row.definition)).map(row=>[String(row.name)+'\0'+row.definition,row])).values()];if(found.length!==1)fail();
 const row=found[0],state=kind(row.definition);if(state==='unknown'||dialect!=='sqlite'&&!validName(row.name))fail();
 if(!unique)return{...row,state};
 let uniques;
 if(dialect==='sqlite')uniques=[...ddl.matchAll(/\bUNIQUE\s*\(([^)]*)\)/gi)].map(match=>({name:null,columns_list:match[1]}));
 else if(dialect==='postgres')uniques=(await query("SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='yumunio_webhook_jobs'::regclass AND contype='u'")).rows?.map(row=>({...row,columns_list:/^UNIQUE\s*\(([^)]*)\)/i.exec(row.definition)?.[1]}));
 else uniques=(await query("SELECT INDEX_NAME AS name,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns_list FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='yumunio_webhook_jobs' AND NON_UNIQUE=0 AND INDEX_NAME<>'PRIMARY' GROUP BY INDEX_NAME")).rows;
 if(!Array.isArray(uniques)||uniques.length!==1)fail();const key=uniques[0],columns=String(key.columns_list).replace(/[\s"\x60]/g,'').toLowerCase();if(![oldUnique,newUnique].includes(columns)||dialect!=='sqlite'&&!validName(key.name))fail();
 return{...row,state,uniqueName:key.name,uniqueCurrent:columns===newUnique};
}
/** Read-only boot check: original profiles still accept their original schema. */
export async function assertWebhookEventSchema({dialect,query,eventTypes=WEBHOOK_DEFAULT_EVENT_TYPES,includeDescendants=false}){
 if(!includeDescendants&&eventTypes.every(type=>type==='page.updated'))return;
 const lifecycle=includeDescendants||eventTypes.some(type=>WEBHOOK_EVENT_TYPES.indexOf(type)>=3),schema=await inspect(dialect,query,{unique:lifecycle});
 if(lifecycle?schema.state!=='current'||!schema.uniqueCurrent:schema.state==='legacy')fail();
}
function sqliteQuery(database){return async(sql,params=[])=>{if(typeof database.batch==='function'){const result=await database.prepare(sql).bind(...params).all();if(result?.success===false)fail();return{rows:result.results??[]};}return{rows:database.prepare(sql).all(...params)};};}
async function assertManagedSqlite(query){const extras=(await query("SELECT type,name FROM sqlite_schema WHERE tbl_name='yumunio_webhook_jobs' AND type IN ('trigger','index') AND sql IS NOT NULL")).rows;if(extras.some(row=>row.type==='trigger'||!['yumunio_webhook_due','yumunio_webhook_scope_jobs'].includes(row.name)))fail();}
/** Explicit D1 copy/swap migration; a failed statement rolls back the whole batch. */
export async function migrateD1WebhookEventSchema(database){
 try{const query=sqliteQuery(database),before=await inspect('sqlite',query,{unique:true});if(before.state==='current'&&before.uniqueCurrent)return{changed:false};await assertManagedSqlite(query);await database.batch(WEBHOOK_LIFECYCLE_REBUILD.map(sql=>database.prepare(sql)));const after=await inspect('sqlite',query,{unique:true});if(after.state!=='current'||!after.uniqueCurrent)fail();return{changed:true};}catch{fail();}
}
/** Explicit migration only, after stopping old writers/runners; never run from boot/request handlers. */
export async function migrateWebhookEventSchema({dialect,database}={}){
 let connection,transaction=false;
 try{
  if(dialect==='sqlite'){
   if(typeof database?.batch==='function')return await migrateD1WebhookEventSchema(database);
   const query=sqliteQuery(database);database.exec('BEGIN IMMEDIATE');transaction=true;const before=await inspect('sqlite',query,{unique:true});
   if(before.state==='current'&&before.uniqueCurrent){database.exec('COMMIT');transaction=false;return{changed:false};}
   await assertManagedSqlite(query);for(const sql of WEBHOOK_LIFECYCLE_REBUILD)database.exec(sql);const after=await inspect('sqlite',query,{unique:true});if(after.state!=='current'||!after.uniqueCurrent)fail();database.exec('COMMIT');transaction=false;return{changed:true};
  }
  if(!['mysql','postgres'].includes(dialect)||!database)fail();connection=dialect==='mysql'?await database.getConnection():await database.connect();
  const run=async(sql,params=[])=>{if(dialect==='mysql'){const[result]=await connection.execute(sql,params);return{rows:Array.isArray(result)?result:[]};}const result=await connection.query(sql,params);return{rows:result.rows??[]};};
  if(dialect==='postgres'){await connection.query('BEGIN');transaction=true;await connection.query('LOCK TABLE yumunio_webhook_jobs IN ACCESS EXCLUSIVE MODE');}
  const before=await inspect(dialect,run,{unique:true});if(before.state==='current'&&before.uniqueCurrent){if(transaction){await connection.query('COMMIT');transaction=false;}return{changed:false};}
  const quote=dialect==='mysql'?'\x60':'"',changes=['DROP CONSTRAINT '+quote+before.name+quote,'ADD CONSTRAINT '+quote+constraint+quote+' CHECK ('+eventCheck+')'];
  if(!before.uniqueCurrent)changes.push((dialect==='mysql'?'DROP INDEX ':'DROP CONSTRAINT ')+quote+before.uniqueName+quote,'ADD CONSTRAINT '+quote+uniqueConstraint+quote+' UNIQUE ('+newUnique+')');
  await run('ALTER TABLE '+table+' '+changes.join(', '));const after=await inspect(dialect,run,{unique:true});if(after.state!=='current'||!after.uniqueCurrent)fail();if(transaction){await connection.query('COMMIT');transaction=false;}return{changed:true};
 }catch{if(transaction){try{if(dialect==='sqlite')database.exec('ROLLBACK');else await connection.query('ROLLBACK');}catch{}}fail();}
 finally{connection?.release();}
}
