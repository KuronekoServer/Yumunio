import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteRecoveryStore } from '../src/sqlite.js';
import { createBackupOperations, backupBlobEnvironment } from '../src/operations.js';
import { createBackupOperationsApi } from '../src/operations-api.js';
import { verifyRecoveryArchive, base64 } from '../src/archive.js';
import { database, seed, memoryBlobs, secret, stamp } from './fixtures.js';

const origin='https://backup-ui.example.invalid';
const env=()=>({YUMUNIO_BACKUP_DRIVER:'local',YUMUNIO_BACKUP_ENCRYPTION_KEY:base64(crypto.getRandomValues(new Uint8Array(32))),YUMUNIO_AUTH_SECRET:secret});
test('backup destination configuration is separate and disabled by default without reading active attachment credentials',()=>{
  const mapped=backupBlobEnvironment({YUMUNIO_S3_ACCESS_KEY_ID:'active-only',YUMUNIO_S3_SECRET_ACCESS_KEY:'active-only',YUMUNIO_S3_BUCKET:'active-only'});
  assert.equal(mapped.YUMUNIO_BLOB_DRIVER,'disabled');assert.equal(mapped.YUMUNIO_S3_ACCESS_KEY_ID,undefined);assert.equal(mapped.YUMUNIO_S3_SECRET_ACCESS_KEY,undefined);
  const explicit=backupBlobEnvironment({YUMUNIO_BACKUP_DRIVER:'s3',YUMUNIO_BACKUP_S3_BUCKET:'fixture-backup',YUMUNIO_BACKUP_S3_PREFIX:'encrypted/',YUMUNIO_BACKUP_S3_SECRET_ACCESS_KEY:'synthetic-separate'});
  assert.equal(explicit.YUMUNIO_S3_BUCKET,'fixture-backup');assert.equal(explicit.YUMUNIO_S3_PREFIX,'encrypted/');assert.equal(explicit.YUMUNIO_S3_SECRET_ACCESS_KEY,'synthetic-separate');
});
test('local-only orchestration deduplicates explicit requests, completes synthetic encrypted archive and exposes no credentials',async t=>{
  const db=database(t),{source}=await seed(db),destination=await memoryBlobs('fixture-destination'),settings=env();
  const operations=await createBackupOperations({store:createSqliteRecoveryStore(db),env:settings,sourceBlobs:source,destination,now:()=>stamp});t.after(()=>operations.close());
  const first=await operations.request({requestId:'explicit-fixture',accountId:'account'}),again=await operations.request({requestId:'explicit-fixture',accountId:'account'});
  assert.equal(first.id,again.id);assert.equal(destination.data.size,0,'Queuing never sends bytes.');
  let result;for(let step=0;step<30;step++){result=await operations.tick({steps:2,schedule:false});if(result?.status==='complete')break;}
  assert.equal(result.status,'complete');assert.equal((await verifyRecoveryArchive({source:destination,key:operations.config.key,backupId:first.id,authSecret:secret})).objectCount,2);
  const dto=await operations.status();assert.equal(dto.jobs.length,1);assert.equal(dto.configuration.automaticRetention,false);
  const serialized=JSON.stringify(dto);for(const value of [settings.YUMUNIO_BACKUP_ENCRYPTION_KEY,secret,'private-old-session-token','Private body page','objectKey','payload_json','leaseId','state_json'])assert.equal(serialized.includes(value),false,value);
});
test('server-admin job API requires current verified session, expected account, origin and explicit full-instance consent before queueing',async t=>{
  const db=database(t),{source}=await seed(db),destination=await memoryBlobs('fixture-admin-destination');
  const operations=await createBackupOperations({store:createSqliteRecoveryStore(db),env:env(),sourceBlobs:source,destination,now:()=>stamp});t.after(()=>operations.close());
  let user={id:'admin',emailVerified:true};const api=createBackupOperationsApi({operations,origin,adminIds:['admin'],resolveSession:async()=>({user})});
  const request=(method='GET',input,headers={},path='/api/admin/backups')=>api(new Request(origin+path,{method,headers:{'X-Yumunio-Expected-Account':'admin',...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})}));
  assert.equal((await request()).status,200);
  for(const current of [null,{id:'owner',emailVerified:true},{id:'admin',emailVerified:false}]){user=current;assert.equal((await request()).status,404);}user={id:'admin',emailVerified:true};
  assert.equal((await request('GET',undefined,{'X-Yumunio-Expected-Account':'different'})).status,404);
  assert.equal((await request('POST',{requestId:'fixture',confirmScope:'database-and-private-files'},{Origin:'https://foreign.example.invalid'})).status,404);
  for(const input of [{requestId:'fixture'},{requestId:'fixture',confirmScope:true},{requestId:'fixture',confirmScope:'database-and-private-files',extra:'ignored'}])assert.equal((await request('POST',input)).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_backup_jobs').get().n,0);assert.equal(destination.data.size,0);
  assert.equal((await request('POST',{requestId:'fixture',confirmScope:'database-and-private-files',destinationProfileId:'different'})).status,409);
  const response=await request('POST',{requestId:'fixture',confirmScope:'database-and-private-files',destinationProfileId:destination.profileId});assert.equal(response.status,202);assert.equal((await response.json()).job.status,'queued');
  assert.equal(destination.data.size,0,'Admin acknowledgement is queueing only.');
  assert.equal((await request('GET',undefined,{},'/api/admin/backups?secret=anything')).status,404);
});
test('disabled backup operations cannot queue or run and still check the recovery fence',async t=>{
  const db=database(t),operations=await createBackupOperations({store:createSqliteRecoveryStore(db)});t.after(()=>operations.close());
  await assert.rejects(operations.request({requestId:'fixture'}),{code:'BACKUP_DISABLED'});assert.equal(await operations.tick(),null);
  assert.equal((await operations.status()).configuration.enabled,false);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_backup_jobs').get().n,0);
  const api=createBackupOperationsApi({operations,origin,adminIds:['admin'],resolveSession:async()=>({user:{id:'admin',emailVerified:true}})});
  assert.equal((await api(new Request(origin+'/api/admin/backups',{method:'POST',headers:{Origin:origin,'X-Yumunio-Expected-Account':'admin'}}))).status,503);
});
