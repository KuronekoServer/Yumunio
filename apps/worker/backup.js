import { createD1RecoveryStore } from '@yumunio/backup/d1';
import { readBackupConfig } from '@yumunio/backup/config';
import { createBackupOperations, backupBlobEnvironment } from '@yumunio/backup/operations';
import { createWorkerBlobStore } from './blob-store.js';
import { readBlobConfig } from '../../packages/adapters/src/blob.js';

export async function createWorkerBackupOperations(env){
  const config=readBackupConfig(env);
  if(!env.DB){if(config.enabled)throw new Error('Backup database required.');return null;}
  const targetConfig=config.enabled?readBlobConfig(backupBlobEnvironment(env),{runtime:'worker'}):null;
  const destinationLocation=targetConfig?.driver==='r2'?targetConfig.binding:targetConfig?.driver==='s3'?targetConfig.endpoint+'/'+targetConfig.bucket+'/'+targetConfig.prefix:null;
  return createBackupOperations({store:createD1RecoveryStore(env.DB),env,config,destinationLocation,
    sourceBlobs:config.enabled?await createWorkerBlobStore(env):null,
    destination:config.enabled?await createWorkerBlobStore({...env,...backupBlobEnvironment(env)}):null});
}
