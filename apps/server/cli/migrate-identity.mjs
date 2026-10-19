import { readServerConfig } from '../config.mjs';
import { readNodeInstanceEnvironment } from '../setup.mjs';
import { createNodeIdentityService } from '../identity.mjs';
import { getMigrations } from 'better-auth/db/migration';
let service;
try {
  const environment = await readNodeInstanceEnvironment(process.env);
  const config = readServerConfig(environment);
  service = await createNodeIdentityService(environment, config, { verifySchema: false });
  if (!service) throw new Error('Accounts are disabled.');
  const plan = await getMigrations(service.auth.options);
  await plan.runMigrations();
  await service.migrateContentSchema();
  console.log('Account, content, collaboration, outbox, preference, API token and webhook schemas are ready. Legacy workspace notes were not migrated.');
} catch {
  console.error('Account initialization failed. Check opt-in, database, TLS, mail configuration and schema permissions.');
  process.exitCode = 1;
} finally { try { await service?.close(); } catch { process.exitCode = 1; } }
