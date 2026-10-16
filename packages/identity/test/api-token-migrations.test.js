import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {API_TOKEN_SCOPE_SETS} from '../src/api-token-model.js';
import {createSqliteApiTokenStore,migrateApiTokenScopeSchema,migrateD1ApiTokenScopeSchema} from '../src/api-token-store.js';
import {assertApiTokenScopeSchema} from '../src/api-token-migrations.js';
const current=await readFile(new URL('../schema/api-tokens.sqlite.sql',import.meta.url),'utf8'),legacy=current.replace(/CONSTRAINT yumunio_api_token_scopes CHECK \(scopes_json IN \([^)]*\)\)/,"CHECK (scopes_json IN ('[\"page:read\"]','[\"page:read\",\"document:read\"]'))");
const fixed=error=>/explicit migration/.test(error.message)&&!/password|SELECT|DROP TABLE/.test(error.message);
const scopesCheck=sets=>'CHECK (scopes_json IN ('+sets.map(scopes=>"'"+JSON.stringify(scopes)+"'").join(',')+'))';
function fixture(t,{definition=legacy,failAt=null}={}){
 const db=new DatabaseSync(':memory:');db.exec(definition);t.after(()=>db.close());
 const insert=(id='a',scopes=['page:read'],revoked=false)=>db.prepare('INSERT INTO yumunio_api_tokens(id,account_id,workspace_id,page_id,membership_id,actor_role,name,scopes_json,token_hash,expires_at,created_at,revoked_at,version,request_id,request_digest,active_slot,metadata_slot)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id.repeat(32),'actor','workspace','page','membership','member','Legacy synthetic',JSON.stringify(scopes),'b'.repeat(64),'2026-10-22T00:00:00.000Z','2026-10-15T00:00:00.000Z',revoked?'2026-10-16T00:00:00.000Z':null,revoked?2:1,id.repeat(36),'c'.repeat(64),revoked?null:1,id.charCodeAt(0)-96);
 const prepare=(sql,params=[])=>({sql,params,bind(...params){return prepare(sql,params);},async all(){const statement=db.prepare(sql),select=/^\s*SELECT\b/i.test(sql);return{success:true,results:select?statement.all(...params):[],meta:{changes:select?0:Number(statement.run(...params).changes)}};}});
 const d1={prepare,async batch(commands){db.exec('BEGIN IMMEDIATE');try{const result=[];for(let index=0;index<commands.length;index++){if(index===failAt)throw Error('Synthetic migration interruption with private password');result.push(await commands[index].all());}db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 return{db,d1,insert,rows:()=>db.prepare('SELECT * FROM yumunio_api_tokens ORDER BY id').all()};
}

test('explicit SQLite scope upgrade preserves all legacy token hashes, consent, revocation and quota slots exactly and is repeat-safe',async t=>{
 const f=fixture(t);f.insert();f.insert('d',['page:read','document:read'],true);const before=f.rows(),store=createSqliteApiTokenStore(f.db);await assert.rejects(store.checkSchema(),fixed);
 assert.deepEqual(await migrateApiTokenScopeSchema({dialect:'sqlite',database:f.db}),{changed:true});assert.deepEqual(f.rows(),before);await store.checkSchema();assert.deepEqual(await migrateApiTokenScopeSchema({dialect:'sqlite',database:f.db}),{changed:false});
 f.insert('e',API_TOKEN_SCOPE_SETS.at(-1),true);assert.equal(f.rows()[2].scopes_json,JSON.stringify(API_TOKEN_SCOPE_SETS.at(-1)));
});

test('D1 scope copy/swap is one rollback-capable batch, preserves rows and can resume after interruption',async t=>{
 const failed=fixture(t,{failAt:2});failed.insert();const original=failed.rows();await assert.rejects(migrateD1ApiTokenScopeSchema(failed.d1),fixed);assert.deepEqual(failed.rows(),original);assert.equal(failed.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='yumunio_api_tokens_scope_v2'").get().n,0);
 const f=fixture(t);f.insert();const before=f.rows();assert.deepEqual(await migrateD1ApiTokenScopeSchema(f.d1),{changed:true});assert.deepEqual(f.rows(),before);assert.deepEqual(await migrateD1ApiTokenScopeSchema(f.d1),{changed:false});
});

test('unknown or locally extended legacy schemas are refused without silently deleting operator triggers or indexes',async t=>{
 for(const change of ['index','trigger','unknown']){const f=fixture(t,{definition:change==='unknown'?legacy.replace(/CHECK \(scopes_json IN \([^)]*\)\)/,'CHECK (length(scopes_json)>0)'):legacy});f.insert();if(change==='index')f.db.exec('CREATE INDEX custom_scope_index ON yumunio_api_tokens(page_id)');if(change==='trigger')f.db.exec('CREATE TRIGGER custom_scope_trigger AFTER UPDATE ON yumunio_api_tokens BEGIN SELECT 1; END');const before=f.rows();await assert.rejects(migrateApiTokenScopeSchema({dialect:'sqlite',database:f.db}),fixed);assert.deepEqual(f.rows(),before);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='yumunio_api_tokens_scope_v2'").get().n,0);}
});

for(const dialect of ['mysql','postgres'])test(dialect+' explicit migration discovers the old constraint name and preserves transaction/connection ownership',async()=>{
 let state='legacy',released=0;const calls=[],metadata=()=>[{name:state==='legacy'?'old_unnamed_scope_check':'yumunio_api_token_scopes',definition:dialect==='postgres'?'CHECK ((scopes_json = ANY (ARRAY['+(state==='legacy'?API_TOKEN_SCOPE_SETS.slice(0,2):API_TOKEN_SCOPE_SETS).map(scopes=>"'"+JSON.stringify(scopes)+"'::text").join(',')+'])))':scopesCheck(state==='legacy'?API_TOKEN_SCOPE_SETS.slice(0,2):API_TOKEN_SCOPE_SETS)}];
 const run=async sql=>{calls.push(sql);if(sql.startsWith('ALTER TABLE')){assert.match(sql,/DROP CONSTRAINT [`"]old_unnamed_scope_check[`"], ADD CONSTRAINT/);state='current';}return sql.startsWith('SELECT')?metadata():[];};
 const connection={async execute(sql){return[await run(sql)];},async query(sql){return{rows:await run(sql)};},release(){released++;}},database={getConnection:async()=>connection,connect:async()=>connection};
 assert.deepEqual(await migrateApiTokenScopeSchema({dialect,database}),{changed:true});assert.equal(released,1);assert.equal(calls.filter(sql=>sql.startsWith('ALTER')).length,1);if(dialect==='postgres'){assert.equal(calls[0],'BEGIN');assert.match(calls[1],/^LOCK TABLE/);assert.equal(calls.at(-1),'COMMIT');}else assert.equal(calls.includes('BEGIN'),false);
 assert.deepEqual(await migrateApiTokenScopeSchema({dialect,database}),{changed:false});assert.equal(released,2);
});

test('schema metadata failures are sanitized and do not disclose driver diagnostics',async()=>{await assert.rejects(assertApiTokenScopeSchema({dialect:'postgres',query:async()=>{throw Error('SELECT private password');}}),fixed);});
