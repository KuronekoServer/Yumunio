import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDatabaseOptions, createDatabaseClient } from '../src/database-snapshot.js';

test('SQL driver options preserve Unicode credentials and verify TLS by default', () => {
  const config = validateDatabaseOptions({ dialect: 'mysql', connectionString: 'mariadb://user:p%40ss@db.example.invalid:3307/yumunio' });
  assert.equal(config.password, 'p@ss');
  assert.equal(config.port, 3307);
  assert.equal(config.database, 'yumunio');
  assert.equal(config.sslMode, 'verify-full');
  assert.equal(validateDatabaseOptions({ dialect: 'postgres', connectionString: 'postgresql://user:pass@localhost/yumunio' }).port, 5432);
});

test('invalid SQL URLs and hidden TLS overrides fail before opening drivers', async () => {
  for (const connectionString of ['mysql://u:p@localhost/', 'mysql://u:p@localhost/db?ssl=false', 'mysql://u:p@localhost/db#x', 'mysql://u:p@localhost/a/b', 'mysql://u:p@localhost/a%00b', 'postgres://u:p@localhost/db', 'mysql://localhost/db', ' mysql://u:p@localhost/db']) {
    assert.throws(() => validateDatabaseOptions({ dialect: 'mysql', connectionString }), /Invalid database configuration/);
    await assert.rejects(createDatabaseClient({ dialect: 'mysql', connectionString }), /Invalid database configuration/);
  }
  const good = { dialect: 'mysql', connectionString: 'mysql://u:p@localhost/db' };
  assert.throws(() => validateDatabaseOptions({ ...good, sslMode: 'prefer' }));
  assert.throws(() => validateDatabaseOptions({ ...good, connectionString: 'mysql://u:p@127.0.0.1/db' }), /DNS hostname/);
  assert.equal(validateDatabaseOptions({ ...good, connectionString: 'mysql://u:p@127.0.0.1/db', sslMode: 'disable' }).host, '127.0.0.1');
  assert.throws(() => validateDatabaseOptions({ ...good, connectionLimit: 0 }));
  assert.throws(() => validateDatabaseOptions({ ...good, sslMode: 'disable', ca: '-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----' }));
});

test('Node SQL drivers can be loaded and their lazy pools closed without a database connection', async () => {
  for (const dialect of ['mysql', 'postgres']) {
    const client = await createDatabaseClient({
      dialect,
      connectionString: (dialect === 'mysql' ? 'mysql' : 'postgres') + '://fixture:fixture@127.0.0.1/yumunio_test_import',
      sslMode: 'disable'
    });
    assert.equal(client.dialect, dialect);
    assert.equal(typeof client.query, 'function');
    await client.end();
  }
});

test('TiDB connection settings use a MySQL URL and the normalized MySQL dialect', () => {
  const config = validateDatabaseOptions({ dialect: 'mysql', connectionString: 'mysql://fixture:fixture@tidb.example.invalid:4000/yumunio' });
  assert.equal(config.dialect, 'mysql');
  assert.equal(config.host, 'tidb.example.invalid');
  assert.equal(config.port, 4000);
  assert.equal(config.sslMode, 'verify-full');
  assert.throws(() => validateDatabaseOptions({ dialect: 'mysql', connectionString: 'tidb://fixture:fixture@tidb.example.invalid:4000/yumunio' }), /Invalid database configuration/);
  assert.throws(() => validateDatabaseOptions({ dialect: 'tidb', connectionString: 'mysql://fixture:fixture@tidb.example.invalid:4000/yumunio' }), /Invalid database configuration/);
});
