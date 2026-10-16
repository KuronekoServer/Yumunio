import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerConfig } from '../config.mjs';

test('server defaults are local and do not require a Cloudflare account', () => {
  const config = readServerConfig();
  assert.deepEqual(config, { host: '127.0.0.1', port: 8788, storage: 'browser-local', accessKey: '', publicOrigin: 'http://127.0.0.1:8788', allowAnonymous: true, database: '.data/yumunio.sqlite', databaseOptions: null });
  assert.equal(readServerConfig({ YUMUNIO_STORAGE: 'sqlite' }).allowAnonymous, true);
});

test('invalid deployment config fails before opening a database or listener', () => {
  for (const port of ['0', '-1', '65536', '1e3', ' 8788', '8788.5']) assert.throws(() => readServerConfig({ YUMUNIO_PORT: port }), /PORT/);
  assert.throws(() => readServerConfig({ YUMUNIO_STORAGE: 'd1' }), /STORAGE/);
  assert.throws(() => readServerConfig({ YUMUNIO_PUBLIC_ORIGIN: 'https://example.invalid/' }), /public origin/);
  assert.throws(() => readServerConfig({ YUMUNIO_ACCESS_KEY: 'short' }), /ACCESS_KEY/);
  assert.throws(() => readServerConfig({ YUMUNIO_DATABASE: 'bad\0path' }), /DATABASE/);
});

test('a public proxy or external bind cannot inherit anonymous SQLite access', () => {
  for (const extra of [{ YUMUNIO_HOST: '0.0.0.0' }, { YUMUNIO_PUBLIC_ORIGIN: 'https://workspace.example' }]) {
    assert.throws(() => readServerConfig({ YUMUNIO_STORAGE: 'sqlite', ...extra }), /ACCESS_KEY/);
    const config = readServerConfig({ YUMUNIO_STORAGE: 'sqlite', YUMUNIO_ACCESS_KEY: 'fixture-'.repeat(8), ...extra });
    assert.equal(config.allowAnonymous, false);
  }
});

test('MariaDB/TiDB/MySQL and PostgreSQL require explicit credentials and shared TLS configuration', () => {
  for (const storage of ['mariadb', 'tidb', 'mysql', 'postgres']) {
    const env = { YUMUNIO_STORAGE: storage, YUMUNIO_ACCESS_KEY: 'fixture-'.repeat(8), YUMUNIO_DATABASE_URL: (storage === 'postgres' ? 'postgres' : 'mysql') + '://user:pass@localhost/yumunio' };
    const config = readServerConfig(env);
    assert.equal(config.storage, storage);
    assert.equal(config.allowAnonymous, false);
    assert.equal(config.databaseOptions.sslMode, 'verify-full');
    assert.equal(config.databaseOptions.dialect, storage === 'postgres' ? 'postgres' : 'mysql');
    assert.throws(() => readServerConfig({ ...env, YUMUNIO_ACCESS_KEY: '' }), /ACCESS_KEY/);
    assert.throws(() => readServerConfig({ ...env, YUMUNIO_DATABASE_URL: '' }), /database configuration/);
    assert.throws(() => readServerConfig({ ...env, YUMUNIO_DATABASE_TLS: 'prefer' }), /database configuration/);
  }
});

test('TiDB preserves its storage label while selecting the shared MySQL driver and URL', () => {
  const env = { YUMUNIO_STORAGE: 'tidb', YUMUNIO_ACCESS_KEY: 'fixture-'.repeat(8), YUMUNIO_DATABASE_URL: 'mysql://fixture:fixture@tidb.example.invalid:4000/yumunio' };
  const config = readServerConfig(env);
  assert.equal(config.storage, 'tidb');
  assert.equal(config.databaseOptions.dialect, 'mysql');
  assert.equal(config.databaseOptions.connectionString, env.YUMUNIO_DATABASE_URL);
  assert.equal(config.allowAnonymous, false);
  assert.throws(() => readServerConfig({ ...env, YUMUNIO_DATABASE_URL: 'tidb://fixture:fixture@tidb.example.invalid:4000/yumunio' }), /database configuration/);
});
