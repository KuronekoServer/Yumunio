import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackupOperations} from '../src/operations.js';
import {createSqliteRecoveryStore} from '../src/sqlite.js';
import {createD1RecoveryStore} from '../src/d1.js';
import {restoreRecoveryArchive} from '../src/restore.js';
import {base64,manifestKey,verifyRecoveryArchive} from '../src/archive.js';
import {archiveGateKey} from '../src/maintenance-gate.js';
import {database,seed,memoryBlobs,secret,d1} from './fixtures.js';
import {mkdtemp,realpath,rename,rm,symlink,unlink,readFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalBlobStore} from '../../../apps/server/blob-store.mjs';
import {sha256} from '../../adapters/src/blob.js';

const first='2026-01-01T00:00:00.000Z',second='2026-01-02T00:00:00.000Z',later='2026-03-01T00:00:00.000Z';
async function archives(t,{kind='sqlite'}={}){
 const db=database(t),{source}=await seed(db),destination=await memoryBlobs('review-backups'),env={YUMUNIO_BACKUP_DRIVER:'local',YUMUNIO_BACKUP_ENCRYPTION_KEY:base64(crypto.getRandomValues(new Uint8Array(32))),YUMUNIO_AUTH_SECRET:secret,YUMUNIO_SERVER_ADMIN_IDS:'account',YUMUNIO_BACKUP_CLEANUP_ENABLED:'true',YUMUNIO_BACKUP_RETENTION_DAYS:'30'};let clock=first;
 const store=kind==='sqlite'?createSqliteRecoveryStore(db):createD1RecoveryStore(d1(db)),operations=await createBackupOperations({store,env,destination,sourceBlobs:source,now:()=>clock});t.after(()=>operations.close());
 async function complete(requestId){const requested=await operations.request({requestId,accountId:'account'});for(let n=0;n<80;n++){await operations.tick({steps:1,schedule:false});const current=await store.jobs.get(requested.id);if(current.status==='complete')return current;assert.notEqual(current.status,'failed',current.errorCode);}assert.fail('Synthetic backup did not finish');}
 const old=await complete('review-old');clock=second;const keeper=await complete('review-keeper');clock=later;const preview=await operations.cleanup.preview();await operations.cleanup.approve({accountId:'account',expectedVersion:preview.approvalVersion,destinationProfileId:destination.profileId,policyDigest:preview.policyDigest,planDigest:preview.planDigest,confirmScope:'expired-app-backup-artifacts',confirmQuiescent:true});return{db,store,source,destination,env,operations,old,keeper};
}

for(const kind of ['sqlite','d1'])for(const failure of ['begin','blob-put','sql-batch'])test(kind+' interrupted restore '+failure+' keeps its source archive protected while isolated target is restoring',async t=>{
 const f=await archives(t,{kind}),targetDb=database(t),actual=kind==='sqlite'?createSqliteRecoveryStore(targetDb):createD1RecoveryStore(d1(targetDb)),blobs=await memoryBlobs('review-isolated-target');let injected=false;
 const target={...actual,async beginRestore(...args){const result=await actual.beginRestore(...args);if(failure==='begin'){injected=true;throw new Error('Synthetic lost beginRestore ACK');}return result;},async applyRestoreBatch(...args){const result=await actual.applyRestoreBatch(...args);if(failure==='sql-batch'){injected=true;throw new Error('Synthetic lost SQL batch ACK');}return result;}};
 const targetBlobs={...blobs,async put(...args){const result=await blobs.put(...args);if(failure==='blob-put'){injected=true;throw Object.assign(new Error('Synthetic lost PUT ACK'),{code:'BLOB_UNAVAILABLE'});}return result;}};
 await assert.rejects(restoreRecoveryArchive({source:f.destination,key:f.operations.config.key,backupId:f.old.id,authSecret:secret,target,targetBlobs,restoreId:'review-interrupted-'+failure,preparedAt:later}));assert.equal(injected,true);const state=await actual.getRecoveryState();assert.equal(state.status,'restoring');if(failure==='sql-batch')assert.ok(state.cursor>0);
 assert.ok(await f.destination.get(archiveGateKey(f.old.id)),'source gate survives an uncertain or failed restore after begin');const cleanup=await f.operations.cleanup.tick();assert.equal(cleanup.status,'blocked');assert.equal(cleanup.errorCode,'BACKUP_ARCHIVE_BUSY');assert.ok(await f.destination.get(manifestKey(f.old.id)),'incomplete restore still has its required original manifest');assert.equal((await verifyRecoveryArchive({source:f.destination,key:f.operations.config.key,backupId:f.keeper.id,authSecret:secret})).backupId,f.keeper.id);
 await assert.rejects(restoreRecoveryArchive({source:f.destination,key:f.operations.config.key,backupId:f.old.id,authSecret:secret,target:actual,targetBlobs:blobs,restoreId:'review-interrupted-'+failure,preparedAt:later}),{code:'BACKUP_ARCHIVE_BUSY'});assert.equal((await actual.getRecoveryState()).status,'restoring','no automatic takeover or replay of the protected restore');
});

test('a changed retention policy invalidates durable approval after a restart without deleting any expired archive',async t=>{
 const f=await archives(t),before=new Map([...f.destination.data].map(([key,value])=>[key,value.slice()])),changed=await createBackupOperations({store:f.store,env:{...f.env,YUMUNIO_BACKUP_RETENTION_DAYS:'31'},destination:f.destination,sourceBlobs:f.source,now:()=>later});t.after(()=>changed.close());assert.equal((await changed.cleanup.status()).approved,false);assert.equal(await changed.cleanup.tick(),null);assert.deepEqual(f.destination.data,before);assert.ok(await f.destination.get(manifestKey(f.old.id)));
});

test('local cleanup cannot follow a backup root replaced with a junction after initialization',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'yumunio-maintenance-review-')),root=join(directory,'backups'),original=join(directory,'original-backups'),outside=join(directory,'outside'),key='recovery/synthetic/data/chunk',bytes=new Uint8Array([1,2,3]);let linked=false,moved=false;
 t.after(async()=>{if(linked)await unlink(root);if(moved)await rename(original,root);const absolute=await realpath(directory);assert.equal(dirname(absolute).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.match(basename(absolute),/^yumunio-maintenance-review-/);await rm(absolute,{recursive:true,force:true});});
 const store=await createLocalBlobStore({driver:'local',directory:root}),outsideStore=await createLocalBlobStore({driver:'local',directory:outside});await store.put(key,bytes);await outsideStore.put(key,bytes);await rename(root,original);moved=true;
 try{await symlink(outside,root,process.platform==='win32'?'junction':'dir');linked=true;}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('The OS does not allow the fixture symlink');return;}throw error;}
 for(const operation of [()=>store.get(key),()=>store.put('recovery/synthetic/data/new',bytes),()=>store.delete(key)])await assert.rejects(operation(),error=>error.code==='BLOB_UNAVAILABLE');assert.deepEqual(await outsideStore.get(key),bytes);
 const filename=await sha256(new TextEncoder().encode(key));assert.deepEqual(new Uint8Array(await readFile(join(original,filename))),bytes);
});
