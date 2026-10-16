import {API_TOKEN_SCOPE_SETS} from './api-token-model.js';
const fail=()=>{throw Error('API token scopes require an explicit migration.');};
const table='yumunio_api_tokens',constraint='yumunio_api_token_scopes';
const scopeCheck='scopes_json IN ('+API_TOKEN_SCOPE_SETS.map(scopes=>"'"+JSON.stringify(scopes)+"'").join(',')+')';
const rebuild=["CREATE TABLE yumunio_api_tokens_scope_v2 (\n  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 32),\n  account_id TEXT NOT NULL,\n  workspace_id TEXT NOT NULL,\n  page_id TEXT NOT NULL,\n  membership_id TEXT NOT NULL,\n  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner','admin','member','guest')),\n  name TEXT NOT NULL CHECK (length(name) >= 1 AND length(name) <= 80),\n  scopes_json TEXT NOT NULL CONSTRAINT yumunio_api_token_scopes CHECK (scopes_json IN ('[\"page:read\"]','[\"page:read\",\"document:read\"]','[\"page:read\",\"document:read\",\"document:write\"]','[\"page:read\",\"mcp:connect\"]','[\"page:read\",\"document:read\",\"mcp:connect\"]','[\"page:read\",\"document:read\",\"document:write\",\"mcp:connect\"]')),\n  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),\n  expires_at TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  revoked_at TEXT,\n  version INTEGER NOT NULL CHECK (version >= 1 AND version <= 9007199254740991),\n  request_id TEXT NOT NULL,\n  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),\n  active_slot INTEGER CHECK (active_slot >= 1 AND active_slot <= 20),\n  metadata_slot INTEGER NOT NULL CHECK (metadata_slot >= 1 AND metadata_slot <= 50),\n  UNIQUE (account_id,request_id),\n  UNIQUE (account_id,active_slot),\n  UNIQUE (account_id,metadata_slot),\n  CHECK (expires_at > created_at),\n  CHECK (revoked_at IS NULL OR active_slot IS NULL)\n)","INSERT INTO yumunio_api_tokens_scope_v2 (id,account_id,workspace_id,page_id,membership_id,actor_role,name,scopes_json,token_hash,expires_at,created_at,revoked_at,version,request_id,request_digest,active_slot,metadata_slot) SELECT id,account_id,workspace_id,page_id,membership_id,actor_role,name,scopes_json,token_hash,expires_at,created_at,revoked_at,version,request_id,request_digest,active_slot,metadata_slot FROM yumunio_api_tokens","DROP TABLE yumunio_api_tokens","ALTER TABLE yumunio_api_tokens_scope_v2 RENAME TO yumunio_api_tokens"];

function normalized(value){return String(value).toLowerCase().replace(/\bcheck\b/g,'').replace(/::(?:text|character varying)/g,'').replace(/_[a-z0-9]+(?=')/g,'').replace(/[\s\x60"()]/g,'');}
function kind(definition){const value=normalized(definition);for(const[state,sets]of [['current',API_TOKEN_SCOPE_SETS],['legacy',API_TOKEN_SCOPE_SETS.slice(0,2)]]){const names=sets.map(scopes=>normalized("'"+JSON.stringify(scopes)+"'")).join(',');if(value==='scopes_jsonin'+names||value==='scopes_json=anyarray['+names+']')return state;}return'unknown';}
async function inspect(dialect,query){
 let constraints;
 if(dialect==='sqlite'){const result=await query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='yumunio_api_tokens'"),sql=result.rows?.[0]?.sql;if(typeof sql!=='string')fail();constraints=[...sql.matchAll(/\bCHECK\s*\(([^)]*)\)/gi)].map(match=>({name:null,definition:match[1]}));}
 else if(dialect==='postgres')constraints=(await query("SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='yumunio_api_tokens'::regclass AND contype='c'")).rows;
 else if(dialect==='mysql')constraints=(await query("SELECT tc.CONSTRAINT_NAME AS name,cc.CHECK_CLAUSE AS definition FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='yumunio_api_tokens' AND tc.CONSTRAINT_TYPE='CHECK'")).rows;
 else fail();
 if(!Array.isArray(constraints))fail();const found=[...new Map(constraints.filter(row=>typeof row.definition==='string'&&/\bscopes_json\b/i.test(row.definition)).map(row=>[String(row.name)+'\0'+row.definition,row])).values()];if(found.length!==1)fail();
 const row=found[0],state=kind(row.definition);if(state==='unknown'||dialect!=='sqlite'&&(typeof row.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(row.name)))fail();return{...row,state};
}
/** Metadata-only startup check. Schema upgrades are always a separate explicit command. */
export async function assertApiTokenScopeSchema({dialect,query}){try{if((await inspect(dialect,query)).state!=='current')fail();}catch{fail();}}
function sqliteQuery(database){return async(sql,params=[])=>{if(typeof database.batch==='function'){const result=await database.prepare(sql).bind(...params).all();if(result?.success===false)fail();return{rows:result.results??[]};}return{rows:database.prepare(sql).all(...params)};};}
async function noExtras(query){const rows=(await query("SELECT type,name FROM sqlite_schema WHERE tbl_name='yumunio_api_tokens' AND type IN ('trigger','index') AND sql IS NOT NULL")).rows;if(!Array.isArray(rows)||rows.length)fail();}
/** All D1 copy/swap statements share one rollback-capable batch. No SDK tables are altered. */
export async function migrateD1ApiTokenScopeSchema(database){try{const query=sqliteQuery(database);if((await inspect('sqlite',query)).state==='current')return{changed:false};await noExtras(query);await database.batch(rebuild.map(sql=>database.prepare(sql)));await assertApiTokenScopeSchema({dialect:'sqlite',query});return{changed:true};}catch{fail();}}
/** Explicit CLI-only migration; canonical legacy credentials and quotas are copied exactly. */
export async function migrateApiTokenScopeSchema({dialect,database,query}={}){
 let connection,transaction=false;
 try{
  if(dialect==='sqlite'){
   if(typeof database?.batch==='function')return await migrateD1ApiTokenScopeSchema(database);
   const read=sqliteQuery(database);database.exec('BEGIN IMMEDIATE');transaction=true;if((await inspect('sqlite',read)).state==='current'){database.exec('COMMIT');transaction=false;return{changed:false};}await noExtras(read);
   for(const sql of rebuild)database.exec(sql);await assertApiTokenScopeSchema({dialect:'sqlite',query:read});database.exec('COMMIT');transaction=false;return{changed:true};
  }
  if(!['mysql','postgres'].includes(dialect)||!database)fail();connection=dialect==='mysql'?await database.getConnection():await database.connect();
  const run=async(sql,params=[])=>{if(dialect==='mysql'){const[result]=await connection.execute(sql,params);return{rows:Array.isArray(result)?result:[]};}return{rows:(await connection.query(sql,params)).rows??[]};};
  if(dialect==='postgres'){await connection.query('BEGIN');transaction=true;await connection.query('LOCK TABLE yumunio_api_tokens IN ACCESS EXCLUSIVE MODE');}
  const prior=await inspect(dialect,run);if(prior.state==='current'){if(transaction){await connection.query('COMMIT');transaction=false;}return{changed:false};}
  const quote=dialect==='mysql'?'\x60':'"';await run('ALTER TABLE '+table+' DROP CONSTRAINT '+quote+prior.name+quote+', ADD CONSTRAINT '+quote+constraint+quote+' CHECK ('+scopeCheck+')');
  await assertApiTokenScopeSchema({dialect,query:run});if(transaction){await connection.query('COMMIT');transaction=false;}return{changed:true};
 }catch{if(transaction)try{if(dialect==='sqlite')database.exec('ROLLBACK');else await connection.query('ROLLBACK');}catch{}fail();}
 finally{connection?.release();}
}
