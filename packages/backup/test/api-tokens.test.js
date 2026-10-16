import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSqliteRecoveryStore} from '../src/sqlite.js';
import {createRecoveryArchive,readRecoveryArchive,sealRecoveryManifest,openRecoveryManifest} from '../src/archive.js';
import {restoreRecoveryArchive} from '../src/restore.js';
import {LEGACY_RECOVERY_TRANSFORMS,RECOVERY_TRANSFORMS} from '../src/model.js';
import {database,seed,memoryBlobs,secret,stamp} from './fixtures.js';
test('encrypted recovery captures optional API token metadata and never reactivates bearer credentials after isolated restore',async t=>{
  const db=database(t),targetDb=database(t);await seed(db,{blobs:false});const ddl=await readFile(new URL('../../identity/schema/api-tokens.sqlite.sql',import.meta.url),'utf8');db.exec(ddl);targetDb.exec(ddl);
  const token={id:'a'.repeat(32),account_id:'account',workspace_id:'workspace',page_id:'page',membership_id:'membership-generation-a',actor_role:'owner',name:'Synthetic token',scopes_json:'["page:read"]',token_hash:'f'.repeat(64),expires_at:'2026-10-16T00:00:00.000Z',created_at:stamp,revoked_at:null,version:1,request_id:crypto.randomUUID(),request_digest:'e'.repeat(64),active_slot:1,metadata_slot:1};
  db.prepare('INSERT INTO yumunio_api_tokens('+Object.keys(token).join(',')+') VALUES('+Object.keys(token).map(()=>'?').join(',')+')').run(...Object.values(token));
  const store=createSqliteRecoveryStore(db),snapshot=await store.capture({now:stamp});assert.equal(snapshot.tables.find(table=>table.name==='yumunio_api_tokens').rows.length,1);assert.equal(snapshot.excludedTables.includes('yumunio_api_tokens'),false);
  const destination=await memoryBlobs('fixture-token-archive'),key=crypto.getRandomValues(new Uint8Array(32)),result=await createRecoveryArchive({snapshot,destination,key,authSecret:secret,createdAt:stamp});
  const restored=await restoreRecoveryArchive({source:destination,key,backupId:result.backupId,authSecret:secret,target:createSqliteRecoveryStore(targetDb),restoreId:'synthetic-token-restore',preparedAt:stamp});assert.equal(restored.status,'ready');assert.equal(targetDb.prepare('SELECT COUNT(*) AS n FROM yumunio_api_tokens').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_api_tokens').get().n,1);
  const archive=await readRecoveryArchive({source:destination,key,backupId:result.backupId,authSecret:secret});assert.deepEqual(archive.manifest.transforms,RECOVERY_TRANSFORMS);
  const legacy={...archive.manifest,transforms:[...LEGACY_RECOVERY_TRANSFORMS]},bytes=await sealRecoveryManifest(legacy,{key,header:archive.header});assert.deepEqual((await openRecoveryManifest(bytes,{key,backupId:result.backupId})).manifest.transforms,LEGACY_RECOVERY_TRANSFORMS);
  await assert.rejects(sealRecoveryManifest({...legacy,transforms:['Preserve all sessions and API tokens.']},{key,header:archive.header}),{code:'INVALID_RECOVERY_DATA'});
});
