import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTestDatabaseUrl } from '../../../packages/tooling/test/run-databases.mjs';
import { createDemoWorkspace } from '../../web/public/store.js';
import { createAppServer } from '../server.mjs';

const table = 'yumunio_prototype_snapshots';
const databaseSettings = [
  ['mysql', 'YUMUNIO_TEST_MYSQL_URL'],
  ['postgres', 'YUMUNIO_TEST_POSTGRES_URL'],
];

test('database integration opt-in rejects remote hosts and ordinary database names before connecting', () => {
  assert.equal(validateTestDatabaseUrl('mysql://fixture:password@127.0.0.1:3306/yumunio_test_fixture', 'mysql').database, 'yumunio_test_fixture');
  assert.equal(validateTestDatabaseUrl('postgres://fixture:password@[::1]:5432/yumunio_test_fixture', 'postgres').database, 'yumunio_test_fixture');
  for (const url of [
    'mysql://fixture:password@db.example.invalid/yumunio_test_fixture',
    'mysql://fixture:password@127.0.0.1/yumunio',
    'mysql://fixture:password@127.0.0.1/yumunio_test_fixture?host=db.example.invalid',
    'mysql://fixture:password@127.0.0.1/yumunio_test_fixture%2Fother',
    'postgres://fixture:password@127.0.0.1/yumunio_test_fixture',
  ]) assert.throws(() => validateTestDatabaseUrl(url, 'mysql'));
});

for (const [dialect, environmentKey] of databaseSettings) {
  const configuredUrl = process.env[environmentKey];
  test(`${dialect} service persists validated snapshots and serializes competing CAS writes`, {
    skip: configuredUrl ? false : `${environmentKey} not explicitly configured`, timeout: 90000,
  }, async t => {
    const { connectionString } = validateTestDatabaseUrl(configuredUrl, dialect);
    const { createDatabaseClient, createDatabaseSnapshotStore } = await import('@yumunio/adapters/prototype-sql');
    const options = { dialect, connectionString, sslMode: 'disable', ca: '', connectionLimit: 5 };
    const client = await createDatabaseClient(options);
    const stores = new Set();
    let created = false;
    t.after(async () => {
      const closed = await Promise.allSettled([...stores].map(store => store.close()));
      try {
        if (created) await client.query(`DROP TABLE ${table}`, []);
      } finally {
        await client.end();
      }
      const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Database fixture pools did not close.');
    });
    const existing = dialect === 'mysql'
      ? await client.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])
      : await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename = $1', [table]);
    assert.equal(existing.rows.length, 0, 'Refusing to mutate a database containing the prototype table.');
    const ddl = await readFile(new URL(`../../../packages/adapters/prototype.${dialect}.sql`, import.meta.url), 'utf8');
    assert.match(ddl, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?yumunio_prototype_snapshots/i);
    await client.query(ddl.replace(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i, 'CREATE TABLE'), []);
    created = true;
    const openStore = async () => {
      const store = await createDatabaseSnapshotStore(options);
      stores.add(store);
      return store;
    };
    const [first, second] = await Promise.all([openStore(), openStore()]);
    assert.deepEqual(await first.read(), { revision: 0, snapshot: null });
    const a = createDemoWorkspace(); a.name = 'Competing writer A';
    const b = createDemoWorkspace(); b.name = 'Competing writer B';
    await assert.rejects(first.write(9, a), error => error.code === 'VERSION_CONFLICT' && error.details.actualRevision === 0);
    assert.deepEqual(await second.read(), { revision: 0, snapshot: null });
    const raced = await Promise.allSettled([first.write(0, a), second.write(0, b)]);
    const accepted = raced.filter(result => result.status === 'fulfilled');
    const rejected = raced.filter(result => result.status === 'rejected');
    assert.equal(accepted.length, 1, 'Exactly one independent pool may create revision 1.');
    assert.equal(rejected.length, 1);
    assert.equal(accepted[0].value.revision, 1);
    assert.equal(rejected[0].reason.code, 'VERSION_CONFLICT');
    assert.equal(rejected[0].reason.details.actualRevision, 1);
    assert.deepEqual(await second.read(), accepted[0].value);
    await assert.rejects(first.write(0, a), error => error.code === 'VERSION_CONFLICT' && error.details.actualRevision === 1);
    const literal = createDemoWorkspace();
    literal.name = '日本語・é・🙂 SQL literal fixture';
    const document = literal.pages.find(page => page.kind === 'document');
    document.blocks.push({ id: 'db-bound-literal', type: 'paragraph', text: "'); DROP TABLE yumunio_prototype_snapshots; -- \\ $1 ? 日本語 🙂", checked: false });
    const saved = await first.write(1, literal);
    assert.deepEqual(saved, { revision: 2, snapshot: literal });
    assert.deepEqual(await second.read(), saved);
    await assert.rejects(second.write(2, { ...literal, schemaVersion: 99 }), error => error.code === 'INVALID_SNAPSHOT');
    assert.deepEqual(await first.read(), saved);
    const nextA = structuredClone(literal); nextA.name = 'Concurrent update A';
    const nextB = structuredClone(literal); nextB.name = 'Concurrent update B';
    const updates = await Promise.allSettled([first.write(2, nextA), second.write(2, nextB)]);
    const updateAccepted = updates.filter(result => result.status === 'fulfilled');
    const updateRejected = updates.filter(result => result.status === 'rejected');
    assert.equal(updateAccepted.length, 1, 'Exactly one independent pool may update revision 2.');
    assert.equal(updateRejected.length, 1);
    assert.equal(updateAccepted[0].value.revision, 3);
    assert.equal(updateRejected[0].reason.code, 'VERSION_CONFLICT');
    assert.equal(updateRejected[0].reason.details.actualRevision, 3);
    const current = updateAccepted[0].value;
    assert.deepEqual(await second.read(), current);
    await first.close(); stores.delete(first);
    await second.close(); stores.delete(second);
    const reopened = await openStore();
    assert.deepEqual(await reopened.read(), current);
    await verifyHttpSnapshot(reopened, dialect === 'mysql' ? 'mariadb' : 'postgres', current);
    const rows = await client.query(`SELECT revision FROM ${table} WHERE id = 1`, []);
    assert.equal(rows.rows.length, 1);
    assert.equal(Number(rows.rows[0].revision), 3);
  });
}

async function verifyHttpSnapshot(snapshotStore, storage, current) {
  const accessKey = 'database-http-fixture-' + 'B'.repeat(40);
  const server = createAppServer({ snapshotStore, storage, accessKey });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(origin + path, { signal: AbortSignal.timeout(10000), ...options });
  try {
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', runtime: 'node', prototype: true, storage });
    const capabilities = await request('/api/capabilities');
    assert.equal(capabilities.status, 200);
    const capability = await capabilities.json();
    assert.equal(capability.storage, storage);
    assert.equal(capability.workspaceSync, true);
    const unauthenticated = await request('/api/workspace/snapshot');
    assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
    const session = await request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ accessKey }),
    });
    assert.equal(session.status, 200);
    await session.arrayBuffer();
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const stored = await request('/api/workspace/snapshot', { headers: { Cookie: cookie } });
    assert.equal(stored.status, 200);
    assert.deepEqual(await stored.json(), current);
  } finally {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
}
