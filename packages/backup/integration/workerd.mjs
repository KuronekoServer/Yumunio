import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/worker-fixture.mjs';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const prefix='yumunio-recovery-workerd-',root=fileURLToPath(new URL('../../../',import.meta.url));
test('actual local workerd D1/R2 creates a durable encrypted recovery archive and resumes a fenced empty-target restore',async t=>{
  const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'worker.mjs');let worker;
  t.after(async()=>{await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await build({entryPoints:[join(root,'packages/backup/integration/fixture-worker.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const key=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');const start=()=>new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',d1Databases:{SOURCE:'source-fixture',TARGET:'target-fixture'},r2Buckets:{LIVE:'live-fixture',BACKUPS:'backup-fixture',RESTORED:'restored-fixture'},resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},bindings:{FIXTURE_KEY:key}}));worker=start();await worker.ready;
  const schema=(await Promise.all(['apps/worker/auth-schema.sql','apps/worker/snapshot-schema.sql','packages/backup/schema/backup.sqlite.sql','packages/identity/schema/webhooks.sqlite.sql'].map(path=>readFile(join(root,path),'utf8')))).join('\n').replace(/^\s*--.*$/gm,'');
  for(const binding of ['SOURCE','TARGET']){const db=await worker.getD1Database(binding);await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));}
  const call=async path=>{const response=await worker.dispatchFetch('http://fixture.invalid'+path);assert.equal(response.status,200,await response.clone().text());return response.json();};
  const original=await call('/seed');const captured=await call('/step');assert.equal(captured.phase,'upload-database',JSON.stringify(captured));await worker.dispose();worker=start();await worker.ready;
  let status;for(let step=0;step<30;step++){status=await call('/step');if(status?.status==='complete'||status?.status==='failed')break;}assert.equal(status.status,'complete',JSON.stringify(status));assert.equal((await call('/verify')).objectCount,1);assert.deepEqual(await call('/restore-start'),{state:'restoring'});assert.equal((await worker.dispatchFetch('http://fixture.invalid/restored')).status,503);
  await worker.dispose();worker=start();await worker.ready;assert.equal((await call('/restore')).status,'ready');const restored=await call('/restored');assert.deepEqual(restored.gate,{state:'ready'});assert.equal(restored.title,'Private 日本語 😀');assert.equal(restored.revision,3);assert.equal(restored.version,3);assert.equal(restored.size,original.size);assert.equal(restored.checksum,original.checksum);assert.equal(restored.profileChanged,true);assert.equal(restored.keyChanged,true);assert.deepEqual(restored.grant,{grantId:'grant',membershipId:'membership-generation'});assert.deepEqual(restored.webhook.approval,{revoked_at:'2026-10-15T00:00:00.000Z',version:2});assert.deepEqual(restored.webhook.subscription,{status:'paused',reason:'restore',version:3});assert.equal(restored.webhook.guards,0);assert.deepEqual(restored.webhook.source,{revokedAt:null,subscriptionStatus:'active',pending:2});assert.equal(restored.webhook.jobs.length,2);for(const job of restored.webhook.jobs){assert.deepEqual(job,{status:'cancelled',lease_id:null,lease_until:null,last_code:'RESTORE',version:2});}
});
