import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/worker-fixture.mjs';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-backup-runtime-',origin='https://backup.fixture.invalid',restoredOrigin='https://restored-backup.fixture.invalid';
const authSecret='synthetic-worker-backup-authentication-secret-2026',password='Synthetic-backup-password-2026!';

test('actual local workerd backup administration queues encrypted D1/R2 recovery and gates an isolated restore',{timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'fixture-worker.mjs'),key=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');let worker,enabled=false,schedule=false;
  t.after(async()=>{await worker?.dispose();const absolute=resolve(directory),parent=resolve(tmpdir()),rel=relative(parent,absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await build({entryPoints:[join(root,'apps/worker/integration/backup-fixture.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
  const start=()=>new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'backup-runtime-source',TARGET:'backup-runtime-target'},r2Buckets:{LIVE:'backup-runtime-live',BACKUPS:'backup-runtime-destination',RESTORED:'backup-runtime-restored'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{
    FIXTURE_KEY:key,YUMUNIO_PUBLIC_ORIGIN:origin,YUMUNIO_ACCESS_KEY:'synthetic-legacy-backup-fixture-'.repeat(2),YUMUNIO_ACCOUNTS_ENABLED:'true',YUMUNIO_AUTH_SECRET:authSecret,YUMUNIO_REGISTRATION_MODE:'closed',YUMUNIO_MAIL_DRIVER:'disabled',YUMUNIO_SERVER_ADMIN_IDS:'backup-admin',YUMUNIO_BLOB_DRIVER:'r2',YUMUNIO_R2_BINDING:'LIVE',
    ...(enabled?{YUMUNIO_BACKUP_DRIVER:'r2',YUMUNIO_BACKUP_R2_BINDING:'BACKUPS',YUMUNIO_BACKUP_ENCRYPTION_KEY:key,YUMUNIO_BACKUP_SCHEDULE:schedule?'0 0 * * *':''}:{YUMUNIO_BACKUP_ENCRYPTION_KEY:'ignored-invalid-disabled-fixture-key'})
  }}));
  worker=start();await worker.ready;
  async function migrate(binding,paths){const db=await worker.getD1Database(binding),schema=(await Promise.all(paths.map(path=>readFile(join(root,path),'utf8')))).join('\n').replace(/^\s*--.*$/gm,'');await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));}
  for(const binding of ['DB','TARGET'])await migrate(binding,['apps/worker/auth-schema.sql','apps/worker/snapshot-schema.sql']);
  const request=(path,{method='GET',body,account,headers={},restored=false}={})=>worker.dispatchFetch((restored?restoredOrigin:origin)+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:restored?restoredOrigin:origin}),...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json()).error.code,code);}
  async function login(id){const response=await request('/api/auth/sign-in/email',{method:'POST',body:{email:id+'@example.invalid',password}}),body=await ok(response);assert.equal(body.user.id,id);return{id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};}
  const seeded=await ok(await request('/__fixture/seed')),admin=await login('backup-admin'),owner=await login('backup-owner'),path='/api/admin/backups';
  const disabled=await ok(await request(path,{account:admin}));assert.equal(disabled.configuration.enabled,false);assert.equal(disabled.configuration.driver,'disabled');assert.equal(disabled.destination,null);assert.deepEqual(disabled.jobs,[]);
  await error(await request(path,{method:'POST',account:admin,body:{requestId:'disabled',confirmScope:'database-and-private-files',destinationProfileId:'disabled'}}),503,'BACKUP_DISABLED');
  const initial=await worker.getR2Bucket('BACKUPS');assert.equal((await initial.list()).objects.length,0);await worker.dispose();worker=undefined;
  enabled=true;worker=start();await worker.ready;for(const binding of ['DB','TARGET'])await migrate(binding,['packages/backup/schema/backup.sqlite.sql']);
  const state=await ok(await request(path,{account:admin}));assert.equal(state.configuration.enabled,true);assert.equal(state.configuration.driver,'r2');assert.equal(state.destination.location,'BACKUPS');assert.equal(state.configuration.automaticRetention,false);const destinationProfileId=state.destination.profileId;
  const serialized=JSON.stringify(state);for(const value of [key,authSecret,'payload_json','objectKey','SYNTHETIC-BACKUP-CONTENT'])assert.equal(serialized.includes(value),false,value);
  await error(await request(path),404,'ADMIN_NOT_FOUND');await error(await request(path,{account:owner}),404,'ADMIN_NOT_FOUND');await error(await request(path,{account:admin,headers:{'X-Yumunio-Expected-Account':'backup-owner'}}),404,'ADMIN_NOT_FOUND');
  const db=await worker.getD1Database('DB');await db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').bind(admin.id).run();await error(await request(path,{account:admin}),404,'ADMIN_NOT_FOUND');await db.prepare('UPDATE yumunio_users SET emailVerified=1 WHERE id=?').bind(admin.id).run();
  const consent={requestId:'manual-runtime-fixture',confirmScope:'database-and-private-files',destinationProfileId};
  await error(await request(path,{method:'POST',account:admin,headers:{Origin:'https://foreign.fixture.invalid'},body:consent}),404,'ADMIN_NOT_FOUND');
  for(const body of [{requestId:consent.requestId,destinationProfileId},{...consent,confirmScope:true},{...consent,extra:'not-allowed'}])await error(await request(path,{method:'POST',account:admin,body}),400,'BACKUP_CONSENT_REQUIRED');
  await error(await request(path,{method:'POST',account:admin,body:{...consent,destinationProfileId:'changed-destination'}}),409,'BACKUP_DESTINATION_CHANGED');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM yumunio_backup_jobs').first()).n,0);assert.equal((await ok(await request('/__fixture/objects'))).backupObjects,0);
  const queued=await ok(await request(path,{method:'POST',account:admin,body:consent}),202);assert.equal(queued.job.status,'queued');assert.equal(queued.job.result,undefined);await ok(await request('/__fixture/settle'));
  const replay=await ok(await request(path,{method:'POST',account:admin,body:consent}),202);assert.equal(replay.job.id,queued.job.id);await ok(await request('/__fixture/settle'));assert.equal((await ok(await request(path,{account:admin}))).jobs.length,1);
  await worker.dispose();worker=start();await worker.ready;
  let completed;for(let step=0;step<16;step++){await ok(await request('/__fixture/scheduled',{method:'POST',body:{}}));const status=await ok(await request(path,{account:admin}));completed=status.jobs.find(job=>job.id===queued.job.id);if(['complete','failed'].includes(completed.status))break;}
  assert.equal(completed.status,'complete',JSON.stringify(completed));assert.equal(completed.result.objectCount,1);assert.equal(completed.result.blobBytes,seeded.size);
  const archive=await ok(await request('/__fixture/archive',{method:'POST',body:{backupId:queued.job.id}}));assert.equal(archive.objectCount,1);assert.equal(archive.manifestChecksum,completed.result.manifestChecksum);assert.deepEqual(archive.envelopeKeys,['ciphertext','format','id','iv','salt','schemaVersion']);assert.equal(archive.excludedEnvironment,true);assert.equal(archive.includesAccounts,true);assert.equal(archive.includesAcl,true);assert.equal(archive.wrongKeyCode,'RECOVERY_AUTHENTICATION_FAILED');
  const objects=await ok(await request('/__fixture/objects'));assert.ok(objects.backupObjects>=4);assert.equal(objects.liveObjects,1);assert.equal(objects.privatePlaintext,false);assert.equal(objects.externalAttempts,0);
  await error(await request('/api/admin/backups/archive',{account:admin}),404,'ADMIN_NOT_FOUND');
  await worker.dispose();schedule=true;worker=start();await worker.ready;
  await ok(await request('/__fixture/scheduled',{method:'POST',body:{}}));let scheduled=await ok(await request(path,{account:admin}));assert.equal(scheduled.configuration.schedule,'0 0 * * *');assert.equal(scheduled.jobs.length,2);await ok(await request('/__fixture/scheduled',{method:'POST',body:{}}));scheduled=await ok(await request(path,{account:admin}));assert.equal(scheduled.jobs.length,2,'One daily schedule slot is idempotent.');
  const restoring=await ok(await request('/__fixture/restore-start',{method:'POST',body:{backupId:queued.job.id}}));assert.deepEqual(restoring,{state:'restoring'});
  assert.equal((await request('/health',{restored:true})).status,503);for(const route of ['/api/auth/config','/api/auth/get-session','/api/capabilities','/api/admin/backups','/api/instance'])await error(await request(route,{account:admin,restored:true}),503,'RECOVERY_IN_PROGRESS');
  assert.equal((await request('/health')).status,200,'Only the isolated restore target is fenced.');
  await worker.dispose();worker=start();await worker.ready;assert.equal((await request('/health',{restored:true})).status,503);
  const restored=await ok(await request('/__fixture/restore',{method:'POST',body:{backupId:queued.job.id}}));assert.equal(restored.status,'ready');const recovered=await ok(await request('/__fixture/restored'));assert.deepEqual(recovered.gate,{state:'ready'});assert.equal(recovered.revision,3);assert.equal(recovered.version,2);assert.equal(recovered.bodyRestored,true);assert.equal(recovered.sessions,0);assert.equal(recovered.size,seeded.size);assert.equal(recovered.checksum,seeded.checksum);assert.equal(recovered.profileChanged,true);assert.equal(recovered.keyChanged,true);assert.deepEqual(recovered.grant,{grantId:'backup-grant',membershipId:'membership-backup-admin'});
  assert.equal((await request('/health',{restored:true})).status,200);assert.equal(await ok(await request('/api/auth/get-session',{account:admin,restored:true})),null);assert.equal((await ok(await request('/__fixture/settle'))).externalAttempts,0);
});
