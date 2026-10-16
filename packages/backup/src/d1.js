import {createSqlRecoveryStore,sanitizedSqlError} from './sql.js';
import {RecoveryError} from './model.js';
export function createD1RecoveryStore(database){
  if(!database||typeof database.prepare!=='function'||typeof database.batch!=='function')throw new Error('Invalid recovery D1 binding.');
  const prepared=({sql,params=[]})=>database.prepare(sql).bind(...params);
  const result=value=>{if(value?.success===false||!Array.isArray(value?.results))throw new RecoveryError('RECOVERY_STORAGE_ERROR');return{rows:value.results,affectedRows:Number(value.meta?.changes??0)};};
  return createSqlRecoveryStore({dialect:'d1',async query(sql,params=[]){try{return result(await prepared({sql,params}).all());}catch(error){throw sanitizedSqlError(error);}},async batch(statements){try{return(await database.batch(statements.map(prepared))).map(result);}catch(error){throw sanitizedSqlError(error);}}});
}