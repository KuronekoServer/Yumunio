import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createDatabaseClient } from '@yumunio/adapters/prototype-sql';
import { createSqliteRecoveryStore } from '@yumunio/backup/sqlite';
import { createPoolRecoveryStore } from '@yumunio/backup/pool';
import { readBackupConfig } from '@yumunio/backup/config';
import { createBackupOperations, backupBlobEnvironment } from '@yumunio/backup/operations';
import { createNodeBlobStore } from './blob-store.mjs';
import { readBlobConfig } from '../../packages/adapters/src/blob.js';

/** Reuses the SQLite snapshot connection; network pools and their shutdown are owned here. */
export async function createNodeBackupService(env,serverConfig,{snapshotStore=null,recoveryStore=null,forRestore=false,verifySchema=true}={}){
  const config=readBackupConfig(env);if(serverConfig.storage==='browser-local'){if(config.enabled)throw new Error('Backups require SQL storage.');return null;}
  let database,client,owned=false,operations,timer;
  const closeResources=async()=>{clearInterval(timer);try{await operations?.close();}finally{if(client)await client.end();else if(owned)database?.close();}};
  try{
    let store=recoveryStore;
    if(!store){
      if(serverConfig.storage==='sqlite'){if(!snapshotStore?.database)await mkdir(dirname(resolve(serverConfig.database)),{recursive:true});database=snapshotStore?.database??new DatabaseSync(resolve(serverConfig.database),{timeout:5000});owned=!snapshotStore?.database;}
      else{client=await createDatabaseClient(serverConfig.databaseOptions);}
      store=client?createPoolRecoveryStore(client):createSqliteRecoveryStore(database);
    }
    if(!forRestore)await import('@yumunio/backup/restore').then(module=>module.assertRecoveryReady(store));
    if(verifySchema&&config.enabled)await store.checkSchema();
    const sourceBlobs=config.enabled?await createNodeBlobStore(env):null;
    const destination=config.enabled?await createNodeBlobStore(backupBlobEnvironment(env)):null;
    const targetConfig=config.enabled?readBlobConfig(backupBlobEnvironment(env)):null;
    const destinationLocation=targetConfig?.driver==='local'?targetConfig.directory:targetConfig?.driver==='s3'?targetConfig.endpoint+'/'+targetConfig.bucket+'/'+targetConfig.prefix:null;
    if(!forRestore)operations=await createBackupOperations({store,env,config,sourceBlobs,destination,destinationLocation});
    return{store,config,operations,sourceBlobs,destination,database,client,
      start(){if(!operations||timer||!config.enabled)return;const step=()=>void operations.tick({steps:2}).catch(()=>{});timer=setInterval(step,15000);timer.unref();step();},
      close:closeResources};
  }catch(error){await closeResources();throw error;}
}
