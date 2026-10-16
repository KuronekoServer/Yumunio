import { assertId } from '@yumunio/domain';
import { validatePreferences } from './preferences-model.js';
export class PreferencesStoreError extends Error {
  constructor(code='PREFERENCES_STORAGE_ERROR'){super('The preference storage operation could not be completed.');this.name='PreferencesStoreError';this.code=code;}
}
const fail=code=>{throw new PreferencesStoreError(code);};
const encoder=new TextEncoder();
function sqlContext(dialect){
  const params=[],bind=value=>{params.push(value);return dialect==='postgres'?'$'+params.length:'?';},mark=dialect==='mysql'?String.fromCharCode(96):'"';
  const column=(a,n)=>a+'.'+mark+n+mark,equal=(a,b)=>dialect==='mysql'?'BINARY '+a+' = BINARY '+b:a+' = '+b;
  return {params,bind,column,equal};
}
function revision(value){if(typeof value==='bigint')value=Number(value);if(typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value))value=Number(value);if(!Number.isSafeInteger(value)||value<1)fail();return value;}
function payload(value){try{return validatePreferences(value);}catch{fail();}}
function stored(value){try{if(typeof value!=='string'||encoder.encode(value).length>4096)fail();return payload(JSON.parse(value));}catch{fail();}}
export class SqlPreferencesStore {
  #client;
  constructor(client){if(!client||!['sqlite','mysql','postgres'].includes(client.dialect)||typeof client.query!=='function')fail();this.#client=client;}
  async #query(sql,params=[],duplicate=false){try{const r=await this.#client.query(sql,params);if(!r||!Array.isArray(r.rows)||!Number.isSafeInteger(r.affectedRows)||r.affectedRows<0)fail();return r;}catch(error){if(duplicate&&(error?.code==='ER_DUP_ENTRY'||error?.errno===1062))return {rows:[],affectedRows:0};fail();}}
  async checkSchema(){await this.#query('SELECT account_id,revision,preferences_json FROM yumunio_account_preferences WHERE 1 = 0');}
  async read(accountId){
    assertId(accountId);const s=sqlContext(this.#client.dialect);
    const {rows}=await this.#query('SELECT '+s.column('u','id')+' AS account_id,p.revision,p.preferences_json FROM yumunio_users u LEFT JOIN yumunio_account_preferences p ON '+s.equal('p.account_id',s.column('u','id'))+' WHERE '+s.equal(s.column('u','id'),s.bind(accountId))+' AND '+s.column('u','emailVerified')+' = TRUE',s.params);
    if(!rows.length)return null;if(rows.length!==1||rows[0].account_id!==accountId)fail();const row=rows[0];
    if(row.revision===null){if(row.preferences_json!==null)fail();return {revision:0,preferences:null};}
    return {revision:revision(row.revision),preferences:stored(row.preferences_json)};
  }
  async write(accountId,{expectedRevision,preferences}={}){
    assertId(accountId);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)fail('PREFERENCES_CONFLICT');
    const captured=payload(preferences),text=JSON.stringify(captured);if(encoder.encode(text).length>4096)fail();
    const s=sqlContext(this.#client.dialect);let sql;
    if(expectedRevision===0)sql='INSERT INTO yumunio_account_preferences (account_id,revision,preferences_json) SELECT '+s.bind(accountId)+',1,'+s.bind(text)+' WHERE ';
    else sql='UPDATE yumunio_account_preferences SET revision=revision+1,preferences_json='+s.bind(text)+' WHERE '+s.equal('account_id',s.bind(accountId))+' AND revision='+s.bind(expectedRevision)+' AND ';
    sql+='EXISTS (SELECT 1 FROM yumunio_users u WHERE '+s.equal(s.column('u','id'),s.bind(accountId))+' AND '+s.column('u','emailVerified')+' = TRUE)';
    if(expectedRevision===0&&this.#client.dialect!=='mysql')sql+=' ON CONFLICT (account_id) DO NOTHING';
    const result=await this.#query(sql,s.params,expectedRevision===0&&this.#client.dialect==='mysql');
    if(result.affectedRows===1)return {revision:expectedRevision+1,preferences:captured};
    if(result.affectedRows!==0)fail();
    if(!await this.read(accountId))fail('PREFERENCES_NOT_FOUND');fail('PREFERENCES_CONFLICT');
  }
}
export function createSqlitePreferencesStore(database){
  if(!database||typeof database.prepare!=='function')fail();
  return new SqlPreferencesStore({dialect:'sqlite',async query(sql,params=[]){const s=database.prepare(sql);return /^SELECT\b/.test(sql)?{rows:s.all(...params),affectedRows:0}:{rows:[],affectedRows:Number(s.run(...params).changes)};}});
}
export function createD1PreferencesStore(database){
  if(!database||typeof database.prepare!=='function')fail();
  return new SqlPreferencesStore({dialect:'sqlite',async query(sql,params=[]){const r=await database.prepare(sql).bind(...params).all();if(r?.success===false)fail();return {rows:r.results,affectedRows:r.meta?.changes};}});
}
