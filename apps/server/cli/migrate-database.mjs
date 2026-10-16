import { readFile } from 'node:fs/promises';
import { readServerConfig } from '../config.mjs';
import { createDatabaseClient } from '@yumunio/adapters/prototype-sql';

let client;
try {
  const config = readServerConfig(process.env);
  if (!config.databaseOptions) throw new Error('Select mariadb, mysql, or postgres in YUMUNIO_STORAGE.');
  const schema = config.databaseOptions.dialect === 'postgres' ? 'prototype.postgres.sql' : 'prototype.mysql.sql';
  const sql = await readFile(new URL('../../../packages/adapters/' + schema, import.meta.url), 'utf8');
  client = await createDatabaseClient(config.databaseOptions);
  await client.query(sql);
  console.log('Prototype snapshot schema is ready (' + config.storage + '). Existing rows were preserved.');
} catch {
  console.error('Database initialization failed. Check the storage selection, URL, TLS, credentials, and CREATE TABLE permission.');
  process.exitCode = 1;
} finally {
  try { await client?.end(); } catch { process.exitCode = 1; }
}
