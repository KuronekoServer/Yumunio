import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runBackupCommand} from '../cli/backup.mjs';
import {createNodeBackupService} from '../backup.mjs';
import {createBackupOperations} from '@yumunio/backup/operations';
import {base64,manifestKey} from '@yumunio/backup/archive';
import {database,seed,secret} from '../../../packages/backup/test/fixtures.js';

async function fixture(t){
 const parent=resolve('.build/test-fixtures');await mkdir(parent,{recursive:true});const path=await mkdtemp(join(parent,'backup-cleanup-cli-'));
 t.after(async()=>{assert.equal(dirname(path),parent);assert.ok(basename(path).startsWith('backup-cleanup-cli-'));await rm(path,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const env={YUMUNIO_STORAGE:'sqlite',YUMUNIO_DATABASE:join(path,'source.sqlite'),YUMUNIO_BACKUP_DRIVER:'local',YUMUNIO_BACKUP_LOCAL_DIR:join(path,'archives'),YUMUNIO_BACKUP_ENCRYPTION_KEY:base64(crypto.getRandomValues(new Uint8Array(32))),YUMUNIO_AUTH_SECRET:secret,YUMUNIO_BACKUP_CLEANUP_ENABLED:'true'},db=database(null,env.YUMUNIO_DATABASE);await seed(db,{blobs:false});db.close();
 const service=await createNodeBackupService(env,{storage:'sqlite',database:env.YUMUNIO_DATABASE});let clock='2026-01-01T00:00:00.000Z';const operations=await createBackupOperations({store:service.store,config:service.config,env,destination:service.destination,sourceBlobs:service.sourceBlobs,now:()=>clock});
 const complete=async requestId=>{const requested=await operations.request({requestId});for(let count=0;count<80;count++){await operations.tick({steps:1,schedule:false});const current=await service.store.jobs.get(requested.id);if(current.status==='complete')return current.id;assert.notEqual(current.status,'failed',current.errorCode);}assert.fail('fixture backup not complete');};
 let old,keeper;try{old=await complete('expired');clock='2026-01-02T00:00:00.000Z';keeper=await complete('keeper');await service.destination.put('recovery/foreign/data/untracked',new Uint8Array([1]));}finally{await operations.close();await service.close();}
 const status=await runBackupCommand(['status'],env),profile=status.destinationProfileId;
 const approve=preview=>runBackupCommand(['cleanup-approve','--destination-profile',profile,'--policy-digest',preview.policyDigest,'--plan-digest',preview.planDigest,'--expected-version',String(preview.approvalVersion),'--confirm-scope','expired-app-backup-artifacts','--confirm-quiescent'],env);
 return{env,old,keeper,profile,approve};
}

test('operator cleanup CLI binds preview and explicit consent, preserves the keeper and foreign objects, and persists revocation',async t=>{
 const f=await fixture(t);await assert.rejects(runBackupCommand(['cleanup-approve','--destination-profile',f.profile,'--expected-version','0'],f.env),/BACKUP_CLEANUP_CONSENT_REQUIRED/);
 await assert.rejects(runBackupCommand(['cleanup-preview','--destination-profile','different'],f.env),/BACKUP_CLEANUP_CONFLICT/);
 const preview=await runBackupCommand(['cleanup-preview','--destination-profile',f.profile],f.env);assert.deepEqual(preview.candidates.map(item=>item.backupId),[f.old]);assert.equal(preview.keeper.backupId,f.keeper);
 assert.equal((await f.approve(preview)).cleanup.approved,true);const result=await runBackupCommand(['cleanup-work','--steps','80'],f.env);assert.equal(result.finished,true);assert.equal(result.cleanup.status,'complete');
 assert.equal((await runBackupCommand(['verify','--backup-id',f.keeper],f.env)).verified,true);await assert.rejects(runBackupCommand(['verify','--backup-id',f.old],f.env),{code:'BACKUP_ARCHIVE_REMOVED'});
 const service=await createNodeBackupService(f.env,{storage:'sqlite',database:f.env.YUMUNIO_DATABASE},{forRestore:true});try{assert.equal(await service.destination.get(manifestKey(f.old)),null);assert.deepEqual(await service.destination.get('recovery/foreign/data/untracked'),new Uint8Array([1]));}finally{await service.close();}
 const status=await runBackupCommand(['status'],f.env);assert.equal(status.configuration.automaticRetention,true);const revoked=await runBackupCommand(['cleanup-revoke','--destination-profile',f.profile,'--expected-version',String(status.cleanup.approvalVersion),'--confirm-stop'],f.env);assert.equal(revoked.cleanup.approved,false);assert.equal((await runBackupCommand(['status'],f.env)).configuration.automaticRetention,false);
});

test('operator cleanup CLI never reports an idle blocked deletion as successfully finished',async t=>{
 const f=await fixture(t),preview=await runBackupCommand(['cleanup-preview','--destination-profile',f.profile],f.env);await f.approve(preview);
 const db=new DatabaseSync(f.env.YUMUNIO_DATABASE);try{db.prepare('UPDATE yumunio_backup_jobs SET updated_at=? WHERE id=?').run('2026-01-03T00:00:00.000Z',f.old);}finally{db.close();}
 const first=await runBackupCommand(['cleanup-work','--steps','8'],f.env);assert.equal(first.finished,false);assert.equal(first.cleanup.status,'blocked');assert.equal(first.cleanup.errorCode,'BACKUP_CLEANUP_CONFLICT');
 const repeated=await runBackupCommand(['cleanup-work','--steps','8'],f.env);assert.equal(repeated.finished,false);assert.equal(repeated.cleanup.id,first.cleanup.id);assert.equal((await runBackupCommand(['verify','--backup-id',f.old],f.env)).verified,true);
});
