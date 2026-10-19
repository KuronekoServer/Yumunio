import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { createDatabaseClient } from '@yumunio/adapters/prototype-sql';
import { createSetupStore, createSqliteSetupStore } from '../../packages/identity/src/setup-store.js';
import { createInstanceSetup } from '../../packages/identity/src/setup.js';
import { readServerConfig } from './config.mjs';
import { createNodeIdentityService } from './identity.mjs';

async function setupEnvironment(environment, { createSecret = true } = {}) {
  if (!environment.YUMUNIO_SETUP_TOKEN && !environment.YUMUNIO_INSTANCE_SECRET && environment.YUMUNIO_WEB_SETUP !== 'true') return null;
  const initial = { ...environment, YUMUNIO_STORAGE: environment.YUMUNIO_STORAGE || 'sqlite' };
  if (!initial.YUMUNIO_SETUP_TOKEN && !initial.YUMUNIO_INSTANCE_SECRET) {
    const directory = resolve(initial.YUMUNIO_STATE_DIR || (initial.YUMUNIO_DATABASE ? dirname(initial.YUMUNIO_DATABASE) : '.data'));
    const path = resolve(directory, 'instance-secret');
    if (createSecret) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeFile(path, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!(await lstat(path)).isFile()) throw new Error('Invalid instance state file.');
    initial.YUMUNIO_INSTANCE_SECRET = await readFile(path, 'utf8');
  }
  return initial;
}

/** Resolve persisted web settings for operator commands without migrations or background jobs. */
export async function readNodeInstanceEnvironment(environment) {
  const initial = await setupEnvironment(environment, { createSecret: false });
  if (!initial) return environment;
  const origin = initial.YUMUNIO_PUBLIC_ORIGIN || 'http://127.0.0.1:' + (initial.YUMUNIO_PORT || '8788');
  const keys = await createInstanceSetup({ env: initial, origin }), config = readServerConfig(keys.baseEnvironment);
  let database, client;
  try {
    if (config.storage === 'sqlite') database = new DatabaseSync(resolve(config.database), { readOnly: true });
    else { client = await createDatabaseClient(config.databaseOptions); database = client.database; }
    const store = client ? createSetupStore(client) : createSqliteSetupStore(database);
    const setup = await createInstanceSetup({ env: initial, origin, store });
    return (await setup.load()).env;
  } finally { if (client) await client.end(); else database?.close(); }
}

/** Opt-in install mode. Legacy deployments retain their explicit migration flow. */
export async function createNodeSetup(environment) {
  const initial = await setupEnvironment(environment);
  if (!initial) return null;
  let database, client, current, pending;
  const retired = new Set();
  let setup;
  // Derive bootstrap keys before validating the persistent public server profile.
  const keys = await createInstanceSetup({ env: initial, origin: initial.YUMUNIO_PUBLIC_ORIGIN || 'http://127.0.0.1:' + (initial.YUMUNIO_PORT || '8788') });
  const config = readServerConfig(keys.baseEnvironment);
  if (config.storage === 'browser-local') throw new Error('Web setup requires a persistent SQL database.');
  try {
    if (config.storage === 'sqlite') {
      const file = resolve(config.database); await mkdir(dirname(file), { recursive: true });
      database = new DatabaseSync(file, { timeout: 5000 });
    } else { client = await createDatabaseClient(config.databaseOptions); database = client.database; }
    const store = client ? createSetupStore(client) : createSqliteSetupStore(database);
    await store.ensureSchema();
    const stored = await store.read();
    if (!stored) {
      // Only create schemas for an unclaimed, empty installation. Do not convert
      // an existing account deployment into a fresh bootstrap installation.
      const names = client ? (await client.query(client.dialect === 'mysql' ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()' : "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'")).rows.map(row => row.name) : database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
      for (const table of ['yumunio_users', 'yumunio_workspaces', 'yumunio_prototype_snapshots']) {
        if (names.includes(table)) {
          const total = client ? (await client.query('SELECT COUNT(*) AS total FROM ' + table)).rows[0].total : database.prepare('SELECT COUNT(*) AS total FROM ' + table).get().total;
          if (Number(total) !== 0) throw new Error('Web setup requires a new, empty instance.');
        }
      }
      const snapshot = await readFile(new URL(client ? '../../packages/adapters/prototype.' + client.dialect + '.sql' : '../worker/snapshot-schema.sql', import.meta.url), 'utf8');
      if (client) await client.query(snapshot); else database.exec(snapshot);
      const migration = await createNodeIdentityService({ ...keys.baseEnvironment, YUMUNIO_ACCOUNTS_ENABLED: 'true', YUMUNIO_MAIL_DRIVER: 'disabled', YUMUNIO_REGISTRATION_MODE: 'closed', YUMUNIO_WEBHOOK_ENABLED: 'false', YUMUNIO_API_TOKENS_ENABLED: 'false', YUMUNIO_MCP_ENABLED: 'false' }, config, { verifySchema: false });
      try {
        const plan = await getMigrations(migration.auth.options);
        if (plan.unsafeChanges.length || plan.schemaProblems.length) throw new Error('Schema needs operator review.');
        await plan.runMigrations(); await migration.migrateContentSchema();
      } finally { await migration.close(); }
    }
    const closeState = state => { if (state && state !== current && state.references === 0) { retired.delete(state); state.closing ??= Promise.resolve(state.identity?.close()); return state.closing; } };
    const refresh = async () => {
      const state = await setup.load();
      if (current?.revision === state.revision) return current;
      if (!pending) pending = (async () => {
        const identity = state.data ? await createNodeIdentityService(state.env, config) : null;
        const previous = current;
        current = { ...state, identity, references: 0 };
        if (previous) { retired.add(previous); await closeState(previous); }
        return current;
      })().finally(() => { pending = null; });
      return pending;
    };
    setup = await createInstanceSetup({ env: initial, store, origin: config.publicOrigin,
      assertReady: async () => {},
      resolveSession: async request => (await refresh()).identity?.auth.api.getSession({ headers: request.headers }) });
    await refresh(); // Reject a wrong encryption key or changed public origin before listening.
    return {
      config, setup,
      async acquire() {
        const state = await refresh(); state.references++;
        let released = false;
        return { identity: state.identity, instanceEnvironment: state.env, accessKey: state.env.YUMUNIO_ACCESS_KEY, publicOrigin: config.publicOrigin, setupRequired: !state.data, setup,
          release() { if (!released) { released = true; state.references--; void Promise.resolve(closeState(state)).catch(() => {}); } } };
      },
      async close() { if (current) { retired.add(current); current = null; } await Promise.all([...retired].map(state => state.identity?.close())); if (client) await client.end(); else database.close(); }
    };
  } catch (error) { if (client) await client.end(); else database?.close(); throw error; }
}
