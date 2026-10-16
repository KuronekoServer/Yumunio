import { readServerConfig } from '../config.mjs';
import { createNodeIdentityService } from '../identity.mjs';
import { getMigrations } from 'better-auth/db/migration';
let service;
try {
  const config = readServerConfig(process.env);
  service = await createNodeIdentityService(process.env, config, { verifySchema: false });
  if (!service) throw new Error('Accounts are disabled.');
  const plan = await getMigrations(service.auth.options);
  await plan.runMigrations();
  await service.migrateContentSchema();
  console.log('Account, content, collaboration, outbox, preference, API token and webhook schemas are ready. Legacy workspace notes were not migrated.');
} catch {
  console.error('Account initialization failed. Check opt-in, database, TLS, mail configuration and schema permissions.');
  process.exitCode = 1;
} finally { try { await service?.close(); } catch { process.exitCode = 1; } }
