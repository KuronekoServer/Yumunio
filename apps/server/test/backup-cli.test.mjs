import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runBackupCommand } from '../cli/backup.mjs';
import { database, seed, secret } from '../../../packages/backup/test/fixtures.js';
import { createNodeBlobStore } from '../blob-store.mjs';
import { base64, manifestKey } from '@yumunio/backup/archive';
const execute = promisify(execFile);

async function directory(t) {
  const parent = resolve('.build/test-fixtures'); await mkdir(parent, { recursive: true });
  const path = await mkdtemp(join(parent, 'backup-cli-'));
  t.after(async () => { if (dirname(path) !== parent || !basename(path).startsWith('backup-cli-')) throw new Error('Invalid test cleanup.'); await rm(path, { recursive: true, force: true }); });
  return path;
}
const settings = path => ({ YUMUNIO_STORAGE: 'sqlite', YUMUNIO_DATABASE: join(path, 'source.sqlite'), YUMUNIO_BACKUP_DRIVER: 'local', YUMUNIO_BACKUP_LOCAL_DIR: join(path, 'archives'), YUMUNIO_BACKUP_ENCRYPTION_KEY: base64(crypto.getRandomValues(new Uint8Array(32))), YUMUNIO_AUTH_SECRET: secret, YUMUNIO_BLOB_DRIVER: 'local', YUMUNIO_BLOB_LOCAL_DIR: join(path, 'source-files') });

test('operator CLI requires scope and reviewed destination, verifies encrypted archive and restores only to a separate empty target', async t => {
  const path = await directory(t), env = settings(path), db = database(null, env.YUMUNIO_DATABASE), { source, payload } = await seed(db), files = await createNodeBlobStore(env);
  for (const [key, bytes] of source.data) await files.put(key, bytes);
  for (const item of [...payload.attachments, ...payload.pendingBlobs]) item.profileId = files.profileId;
  db.prepare('UPDATE yumunio_account_content SET payload_json=?').run(JSON.stringify(payload)); db.close();
  const status = await runBackupCommand(['status'], env); assert.equal(status.configuration.enabled, true); assert.equal(status.jobs.length, 0);
  await assert.rejects(runBackupCommand(['create'], env), /BACKUP_CONSENT_REQUIRED/);
  await assert.rejects(runBackupCommand(['create', '--confirm-scope', 'database-and-private-files', '--destination-profile', 'changed'], env), /BACKUP_DESTINATION_CHANGED/);
  const args = ['create', '--confirm-scope', 'database-and-private-files', '--destination-profile', status.destinationProfileId, '--request-id', 'synthetic-cli-request'];
  const queued = await runBackupCommand([...args, '--steps', '1'], env); assert.equal(queued.finished, false);
  const completed = await runBackupCommand(args, env); assert.equal(completed.job.id, queued.job.id); assert.equal(completed.job.status, 'complete'); assert.equal(completed.job.result.objectCount, 2);
  const backupId = completed.job.id;
  const checked = await runBackupCommand(['verify', '--backup-id', backupId], env); assert.equal(checked.verified, true); assert.equal(checked.restoreTested, false);
  await assert.rejects(runBackupCommand(['restore', '--backup-id', backupId, '--restore-id', 'synthetic-restore'], env), /EMPTY_TARGET_CONFIRMATION_REQUIRED/);
  await assert.rejects(runBackupCommand(['restore', '--backup-id', backupId, '--restore-id', 'synthetic-restore', '--confirm-empty-target'], env), { code: 'RECOVERY_TARGET_NOT_EMPTY' });
  const target = { ...env, YUMUNIO_DATABASE: join(path, 'target.sqlite'), YUMUNIO_BLOB_LOCAL_DIR: join(path, 'restored-files') };
  database(null, target.YUMUNIO_DATABASE).close();
  const restored = await runBackupCommand(['restore', '--backup-id', backupId, '--restore-id', 'synthetic-restore', '--confirm-empty-target'], target); assert.equal(restored.status, 'ready'); assert.equal(restored.objectCount, 1); assert.equal(restored.discardedPendingObjects, 1);
  const replay = await runBackupCommand(['restore', '--backup-id', backupId, '--restore-id', 'synthetic-restore', '--confirm-empty-target'], target); assert.equal(replay.rowCount, restored.rowCount);
  const result = new DatabaseSync(target.YUMUNIO_DATABASE);
  try {
    assert.equal(result.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n, 1); assert.equal(result.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions').get().n, 0);
    const content = JSON.parse(result.prepare('SELECT payload_json FROM yumunio_account_content').get().payload_json), destination = await createNodeBlobStore(target);
    assert.equal(content.attachments[0].profileId, destination.profileId); assert.deepEqual(await destination.get(content.attachments[0].objectKey), source.data.get('objects/committed'));
  } finally { result.close(); }
  const archive = await createNodeBlobStore({ YUMUNIO_BLOB_DRIVER: 'local', YUMUNIO_BLOB_LOCAL_DIR: env.YUMUNIO_BACKUP_LOCAL_DIR });
  const manifest = new TextDecoder().decode(await archive.get(manifestKey(backupId))); assert.equal(manifest.includes('Private body'), false); assert.equal(manifest.includes(secret), false);
});

test('backup schema migration is explicit, idempotent and never queues an archive', async t => {
  const path = await directory(t), env = { ...process.env, ...settings(path), YUMUNIO_BACKUP_DRIVER: 'disabled' };
  for (let count = 0; count < 2; count++) await execute(process.execPath, ['apps/server/cli/migrate-backup.mjs'], { cwd: resolve('.'), env, windowsHide: true });
  const result = await runBackupCommand(['status'], env); assert.equal(result.configuration.enabled, false); assert.deepEqual(result.jobs, []);
  await assert.rejects(runBackupCommand(['create', '--confirm-scope', 'database-and-private-files', '--destination-profile', 'unused'], env), /BACKUP_DISABLED/);
  await assert.rejects(runBackupCommand(['verify', '--backup-id', '../bad'], env), /INVALID_BACKUP_ARGUMENTS/);
});
