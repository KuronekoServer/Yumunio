import { createDatabaseClient } from '@yumunio/adapters/prototype-sql';
import { createSqliteRecoveryStore } from '@yumunio/backup/sqlite';
import { createPoolRecoveryStore } from '@yumunio/backup/pool';
import { assertRecoveryReady } from '@yumunio/backup/restore';

/** Read-only readiness check. It neither opens blob storage nor starts backup jobs. */
export async function createNodeRecoveryGuard({storage,databaseOptions},snapshotStore){
  if(storage==='browser-local')return null;
  let client;
  try{
    const store=storage==='sqlite'?createSqliteRecoveryStore(snapshotStore.database):createPoolRecoveryStore(client=await createDatabaseClient(databaseOptions));
    await assertRecoveryReady(store);
    return{store,close:()=>client?.end()};
  }catch(error){await client?.end();throw error;}
}
