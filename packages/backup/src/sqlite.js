import {createSqlRecoveryStore,sanitizedSqlError} from './sql.js';
export function createSqliteRecoveryStore(database){
  if(!database||typeof database.prepare!=='function'||typeof database.exec!=='function')throw new Error('Invalid recovery SQLite database.');
  const execute=({sql,params=[]})=>{const statement=database.prepare(sql);if(statement.columns().length)return{rows:statement.all(...params),affectedRows:0};const result=statement.run(...params);return{rows:[],affectedRows:Number(result.changes)};};
  const driver={dialect:'sqlite',async query(sql,params=[]){try{return execute({sql,params});}catch(error){throw sanitizedSqlError(error);}},async batch(statements){let begun=false;try{database.exec('BEGIN IMMEDIATE');begun=true;const result=statements.map(execute);database.exec('COMMIT');return result;}catch(error){if(begun)try{database.exec('ROLLBACK');}catch{}throw sanitizedSqlError(error);}}};
  return createSqlRecoveryStore(driver);
}