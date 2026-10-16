import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteRecoveryStore} from '../src/sqlite.js';
import {createD1RecoveryStore} from '../src/d1.js';
import {createRecoveryArchive,readRecoveryArchive,sealRecoveryManifest,openRecoveryManifest,writeRecoveryBody,manifestKey,sha256} from '../src/archive.js';
import {restoreRecoveryArchive} from '../src/restore.js';
import {requestBackup,runBackupStep} from '../src/jobs.js';
import {LEGACY_RECOVERY_TRANSFORMS,PRE_AI_RECOVERY_TRANSFORMS,PRE_WEBHOOK_RECOVERY_TRANSFORMS,PRE_RETIREMENT_RECOVERY_TRANSFORMS,RECOVERY_TRANSFORMS,validateDatabaseSnapshot,prepareRecoverySnapshot,TABLES,TABLE_BY_NAME} from '../src/model.js';
import {database,seed,memoryBlobs,d1,secret,stamp} from './fixtures.js';
const retiredName='yumunio_ai_requests';
const columns='request_id account_id workspace_id page_id membership_id actor_role expected_revision page_version source_digest projection_version profile_hash request_digest task status created_at deadline_at finished_at version result_ciphertext day_key day_slot active_slot metadata_slot'.split(' ');
const oldRow=['retired-request','account','workspace','page','membership-generation-a','owner',5,2,'a'.repeat(64),1,'b'.repeat(64),'c'.repeat(64),'summarize','succeeded',Date.parse(stamp),Date.parse(stamp)+60000,Date.parse(stamp),1,'retired-private-ciphertext','2026-10-15',1,null,1];
const withRetired=snapshot=>({...structuredClone(snapshot),tables:[...snapshot.tables,{name:retiredName,columns:[...columns],rows:[[...oldRow]]}]});
async function legacyArchive(snapshot,sourceBlobs){
 const destination=await memoryBlobs('retired-archive'),key=crypto.getRandomValues(new Uint8Array(32)),created=await createRecoveryArchive({snapshot,sourceBlobs,destination,key,authSecret:secret,createdAt:stamp});
 const opened=await readRecoveryArchive({source:destination,key,backupId:created.backupId,authSecret:secret}),legacy=withRetired(opened.snapshot);
 const body=await writeRecoveryBody(new TextEncoder().encode(JSON.stringify(legacy)),{key,header:opened.header,kind:'database',reference:'database',destination});
 destination.data.set(manifestKey(created.backupId),await sealRecoveryManifest({...opened.manifest,database:body,transforms:[...PRE_RETIREMENT_RECOVERY_TRANSFORMS]},{key,header:opened.header}));
 return{destination,key,created,legacy};
}
test('new captures exclude existing retired tables without reading or changing their rows',async t=>{
 const db=database(t);await seed(db,{blobs:false});assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(retiredName),undefined);
 // An obsolete source table is excluded even when its layout is not an accepted archive layout.
 db.exec('CREATE TABLE '+retiredName+'(private_retired_payload TEXT)');db.prepare('INSERT INTO '+retiredName+' VALUES(?)').run('private-retired-source-row');
 const snapshot=await createSqliteRecoveryStore(db).capture({now:stamp});assert.equal(TABLES.some(table=>table.name===retiredName),false);assert.equal(TABLE_BY_NAME.has(retiredName),false);assert.equal(snapshot.tables.some(table=>table.name===retiredName),false);assert.ok(snapshot.excludedTables.includes(retiredName));assert.doesNotMatch(JSON.stringify(snapshot),/private-retired-source-row/);
 const destination=await memoryBlobs(),key=crypto.getRandomValues(new Uint8Array(32)),result=await createRecoveryArchive({snapshot,destination,key,authSecret:secret,createdAt:stamp});const opened=await readRecoveryArchive({source:destination,key,backupId:result.backupId,authSecret:secret});assert.equal(opened.snapshot.tables.some(table=>table.name===retiredName),false);assert.equal(db.prepare('SELECT private_retired_payload FROM '+retiredName).get().private_retired_payload,'private-retired-source-row');
});
test('legacy encrypted archives restore notes, ACL and attachments without recreating retired data',async t=>{
 const db=database(t),seeded=await seed(db),snapshot=await createSqliteRecoveryStore(db).capture({now:stamp}),archive=await legacyArchive(snapshot,seeded.source),opened=await readRecoveryArchive({source:archive.destination,key:archive.key,backupId:archive.created.backupId,authSecret:secret});
 assert.ok(opened.snapshot.tables.some(table=>table.name===retiredName));const plan=prepareRecoverySnapshot(opened.snapshot,{objectMapping:new Map([...seeded.source.data.keys()].map(objectKey=>['fixture-source/'+objectKey,{profileId:'fixture-restored',objectKey}])) ,now:stamp});assert.equal(plan.tables.some(table=>table.name===retiredName),false);assert.ok(plan.excludedTables.includes(retiredName));
 const targetDb=database(t),targetBlobs=await memoryBlobs('fixture-restored'),result=await restoreRecoveryArchive({source:archive.destination,key:archive.key,backupId:archive.created.backupId,authSecret:secret,target:createSqliteRecoveryStore(targetDb),targetBlobs,restoreId:'retired-isolated',preparedAt:stamp});assert.equal(result.status,'ready');assert.equal(targetDb.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(retiredName),undefined);
 const payload=JSON.parse(targetDb.prepare('SELECT payload_json FROM yumunio_account_content').get().payload_json);assert.deepEqual(payload.grants,seeded.payload.grants);assert.deepEqual(payload.grantBindings,seeded.payload.grantBindings);assert.equal(payload.pages[0].document.blocks[0].data.text,seeded.payload.pages[0].document.blocks[0].data.text);assert.deepEqual(await targetBlobs.get(payload.attachments[0].objectKey),await seeded.source.get('objects/committed'));
 assert.equal(JSON.stringify(payload).includes(oldRow[18]),false);assert.equal(opened.snapshot.tables.find(table=>table.name===retiredName).rows[0][18],oldRow[18]);
});
test('historical manifest descriptions remain recognized while current backup output omits retired data',async t=>{
 const db=database(t);await seed(db,{blobs:false});const snapshot=withRetired(await createSqliteRecoveryStore(db).capture({now:stamp})),destination=await memoryBlobs(),key=crypto.getRandomValues(new Uint8Array(32)),result=await createRecoveryArchive({snapshot,destination,key,authSecret:secret,createdAt:stamp});const opened=await readRecoveryArchive({source:destination,key,backupId:result.backupId,authSecret:secret});assert.equal(opened.snapshot.tables.some(table=>table.name===retiredName),false);assert.ok(opened.snapshot.excludedTables.includes(retiredName));assert.ok(RECOVERY_TRANSFORMS.every(value=>!value.includes('AI')));
 for(const transforms of [LEGACY_RECOVERY_TRANSFORMS,PRE_AI_RECOVERY_TRANSFORMS,PRE_WEBHOOK_RECOVERY_TRANSFORMS,PRE_RETIREMENT_RECOVERY_TRANSFORMS]){const bytes=await sealRecoveryManifest({...opened.manifest,transforms:[...transforms]},{key,header:opened.header});assert.deepEqual((await openRecoveryManifest(bytes,{key,backupId:result.backupId})).manifest.transforms,transforms);}
});
test('retired archive compatibility refuses unknown columns, malformed cells and duplicate composite keys',async t=>{
 const db=database(t);await seed(db,{blobs:false});const valid=withRetired(await createSqliteRecoveryStore(db).capture({now:stamp}));validateDatabaseSnapshot(valid);
 for(const mutate of [entry=>entry.columns[0]='unknown',entry=>entry.rows[0][6]='5',entry=>entry.rows[0][14]='invalid-date',entry=>entry.rows.push([...entry.rows[0]])]){const bad=structuredClone(valid);mutate(bad.tables.at(-1));assert.throws(()=>validateDatabaseSnapshot(bad),{code:'INVALID_RECOVERY_DATA'});}
 const otherAccount=structuredClone(valid);otherAccount.tables.at(-1).rows.push(oldRow.map((value,index)=>index===1?'another-account':value));validateDatabaseSnapshot(otherAccount);
});
test('D1-shaped durable jobs omit retired rows and legacy restore retains the no-table target fence',async t=>{
 const db=database(t);await seed(db,{blobs:false});const source=createD1RecoveryStore(d1(db)),legacy=withRetired(await source.capture({now:stamp})),destination=await memoryBlobs(),key=crypto.getRandomValues(new Uint8Array(32));const job=await requestBackup({store:source,destination,key,requestKey:'retired-compatibility',id:'retired-d1-job',now:stamp});
 let result;for(let step=0;step<15;step++){result=await runBackupStep({store:{...source,async capture(){return structuredClone(legacy);}},destination,key,authSecret:secret,now:()=>stamp});if(result?.status==='complete'||result?.status==='failed')break;}assert.equal(result.status,'complete');const opened=await readRecoveryArchive({source:destination,key,backupId:job.id,authSecret:secret});assert.equal(opened.snapshot.tables.some(table=>table.name===retiredName),false);assert.ok(opened.snapshot.excludedTables.includes(retiredName));
 const oldArchive=await legacyArchive(await source.capture({now:stamp})),targetDb=database(t),target=createD1RecoveryStore(d1(targetDb));const restored=await restoreRecoveryArchive({source:oldArchive.destination,key:oldArchive.key,backupId:oldArchive.created.backupId,authSecret:secret,target,restoreId:'retired-d1-target',preparedAt:stamp});assert.equal(restored.status,'ready');assert.equal(targetDb.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,1);assert.equal(targetDb.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(retiredName),undefined);
 const occupied=database(t);occupied.exec('CREATE TABLE '+retiredName+'(opaque TEXT)');occupied.prepare('INSERT INTO '+retiredName+' VALUES(?)').run('unchanged');await assert.rejects(restoreRecoveryArchive({source:oldArchive.destination,key:oldArchive.key,backupId:oldArchive.created.backupId,authSecret:secret,target:createD1RecoveryStore(d1(occupied)),restoreId:'retired-occupied',preparedAt:stamp}),{code:'RECOVERY_TARGET_NOT_EMPTY'});assert.equal(occupied.prepare('SELECT opaque FROM '+retiredName).get().opaque,'unchanged');assert.equal(occupied.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('previous in-progress captures require a new reviewed backup before any old encrypted fragment is uploaded',async t=>{
 const db=database(t);await seed(db,{blobs:false});const store=createSqliteRecoveryStore(db),destination=await memoryBlobs(),key=crypto.getRandomValues(new Uint8Array(32));const job=await requestBackup({store,destination,key,requestKey:'old-in-progress',id:'old-capture',now:stamp});assert.equal((await runBackupStep({store,destination,key,authSecret:secret,now:()=>stamp})).phase,'upload-database');
 const state=JSON.parse(db.prepare('SELECT state_json FROM yumunio_backup_jobs WHERE id=?').get(job.id).state_json);delete state.capturePolicy;db.prepare('UPDATE yumunio_backup_jobs SET state_json=? WHERE id=?').run(JSON.stringify(state),job.id);
 const result=await runBackupStep({store,destination,key,authSecret:secret,now:()=>stamp});assert.equal(result.status,'failed');assert.equal(result.errorCode,'RECOVERY_BACKUP_RESTART_REQUIRED');assert.equal(destination.data.size,0);assert.ok(db.prepare('SELECT COUNT(*) AS n FROM yumunio_backup_fragments').get().n>0);
});
