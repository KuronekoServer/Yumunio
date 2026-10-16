import { readFile } from 'node:fs/promises';
import { readServerConfig } from '../config.mjs';
import { createNodeBackupService } from '../backup.mjs';

let service;
try {
  service = await createNodeBackupService(process.env, readServerConfig(process.env), { forRestore: true, verifySchema: false });
  if (!service) throw new Error('SQL storage is required.');
  const dialect = service.client?.dialect ?? 'sqlite';
  const sql = await readFile(new URL(import.meta.resolve('@yumunio/backup/schema/' + dialect)), 'utf8');
  if (service.client) {
    // These maintained migrations contain standalone DDL, without procedures or string semicolons.
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await service.client.query(statement);
  } else service.database.exec(sql);
  await service.store.checkSchema();
  console.log('Backup job and recovery-fence schemas are ready. Existing data was preserved; backups were not started.');
} catch {
  console.error('Backup initialization failed. Check SQL storage, configuration and schema permissions.');
  process.exitCode = 1;
} finally { try { await service?.close(); } catch { process.exitCode = 1; } }
