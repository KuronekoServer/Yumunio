import { assertRecoveryReady } from './restore.js';
import { readBackupConfig, publicBackupConfig, scheduledBackupRequestKey } from './config.js';
import { requestBackup, runBackupStep, backupJobStatus } from './jobs.js';
import { RECOVERY_LIMITS, RECOVERY_TRANSFORMS, fail } from './model.js';
import {createBackupMaintenance} from './maintenance.js';

/** Destination credentials never fall back to the application's attachment credentials. */
export function backupBlobEnvironment(env={}){
  const result={YUMUNIO_BLOB_DRIVER:env.YUMUNIO_BACKUP_DRIVER??'disabled'};
  result.YUMUNIO_BLOB_LOCAL_DIR=env.YUMUNIO_BACKUP_LOCAL_DIR??'.data/backups';
  result.YUMUNIO_R2_BINDING=env.YUMUNIO_BACKUP_R2_BINDING??'BACKUPS';
  for(const field of ['ENDPOINT','REGION','BUCKET','PREFIX','FORCE_PATH_STYLE','ACCESS_KEY_ID','SECRET_ACCESS_KEY','SESSION_TOKEN']){
    const value=env['YUMUNIO_BACKUP_S3_'+field];if(value!==undefined)result['YUMUNIO_S3_'+field]=value;
  }
  return result;
}

/** Runtime-independent orchestration; leases and immutable ciphertext checkpoints live in SQL. */
export async function createBackupOperations({store,env={},config=readBackupConfig(env),sourceBlobs=null,destination=null,destinationLocation=null,authSecret,now=()=>new Date().toISOString()}={}){
  if(!store||typeof now!=='function')fail('INVALID_BACKUP_CONFIG');
  await assertRecoveryReady(store);
  if(config.enabled){if(!destination||typeof destination.profileId!=='string'||!destination.profileId||destination.profileId.length>128||destinationLocation!==null&&(typeof destinationLocation!=='string'||destinationLocation.length>4096||/[\u0000-\u001f\u007f]/.test(destinationLocation)))fail('INVALID_BACKUP_CONFIG');await store.checkSchema();}
  const authContext=config.enabled?(authSecret??env.YUMUNIO_AUTH_SECRET):undefined;
  const cleanup=await createBackupMaintenance({store,config,destination,sourceBlobs,authSecret:authContext,env,now});
  let active=null,closed=false;
  async function status(){
    await assertRecoveryReady(store);
    const maintenance=await cleanup.status();return{configuration:{...publicBackupConfig(config),automaticRetention:maintenance.approved},destination:config.enabled?{profileId:destination.profileId,driver:config.driver,location:destinationLocation??'Configured '+config.driver+' destination'}:null,scope:'database-and-private-files',limits:{...RECOVERY_LIMITS},
      exclusions:['environment-secrets','unknown-extension-tables'],restoreTransforms:[...RECOVERY_TRANSFORMS],
      jobs:config.enabled?(await store.jobs.list({limit:20})).map(backupJobStatus):[],cleanup:maintenance};
  }
  async function request({requestId,accountId='operator'}={}){
    if(!config.enabled||closed)fail('BACKUP_DISABLED');
    if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(requestId)||typeof accountId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountId))fail('INVALID_BACKUP_REQUEST');
    await assertRecoveryReady(store);
    return backupJobStatus(await requestBackup({store,destination,key:config.key,requestKey:'manual:'+accountId+':'+requestId,now:now()}));
  }
  async function tick({steps=1,schedule=true}={}){
    if(!Number.isSafeInteger(steps)||steps<1||steps>8)fail('INVALID_BACKUP_REQUEST');
    if(closed||!config.enabled)return null;if(active)return active;
    active=(async()=>{
      await assertRecoveryReady(store);
      const requestKey=schedule?scheduledBackupRequestKey(config,now()):null;
      if(requestKey)await requestBackup({store,destination,key:config.key,requestKey,now:now()});
      let last=null;for(let index=0;index<steps;index++){
        await assertRecoveryReady(store);
        const result=await runBackupStep({store,sourceBlobs,destination,key:config.key,authSecret:authContext,now});
        if(!result)break;last=result;
      }await cleanup.tick();return last;
    })();
    try{return await active;}finally{active=null;}
  }
  return Object.freeze({store,config,sourceBlobs,destination,authSecret:authContext,status,request,tick,cleanup,
    assertReady:()=>assertRecoveryReady(store),async close(){closed=true;try{await active;}finally{await cleanup.close();}}});
}
export {createBackupMaintenance} from './maintenance.js';
