import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SqlSnapshotStore } from '../src/sql-snapshot.js';
import { SnapshotError } from '../src/snapshot.js';

const stamp = '2026-10-15T03:00:00.000Z';
const fixture = name => ({ schemaVersion: 1, name, pages: [], ui: { recentPageIds: [], lastRoute: '#home' }, updatedAt: stamp });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof SnapshotError && error.code === code);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Real SQLite executes the common INSERT/UPDATE/WHERE SQL and primary-key CAS.
// Placeholder/error translation is a transport harness, not a remote-database compatibility test.
class SqlTransport {
  constructor(filename, dialect) {
    this.database = new DatabaseSync(filename, { timeout: 5000 });
    this.dialect = dialect;
    this.calls = [];
    this.ended = 0;
    this.database.exec('CREATE TABLE IF NOT EXISTS yumunio_prototype_snapshots (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }
  async query(sql, params) {
    this.calls.push({ sql, params: [...params] });
    const portableSql = sql.replace(/\$[1-3]/g, '?');
    try {
      const statement = this.database.prepare(portableSql);
      if (sql.startsWith('SELECT')) {
        statement.setReadBigInts(true);
        return { rows: statement.all(...params).map(row => ({ ...row, revision: String(row.revision) })), affectedRows: 0 };
      }
      return { rows: [], affectedRows: Number(statement.run(...params).changes) };
    } catch (error) {
      if (this.dialect === 'mysql' && error.errcode === 1555) {
        throw Object.assign(new Error('Duplicate fixture key'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      }
      throw error;
    }
  }
  async end() { this.ended++; this.database.close(); }
}

for (const dialect of ['mysql', 'postgres']) {
  test(`${dialect}: separate connections enforce initial and subsequent compare-and-swap`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'yumunio-sql-snapshot-'));
    const filename = join(directory, 'snapshot.sqlite');
    const a = new SqlTransport(filename, dialect);
    const b = new SqlTransport(filename, dialect);
    const first = new SqlSnapshotStore(a, { now: () => stamp });
    const second = new SqlSnapshotStore(b, { now: () => stamp });
    t.after(async () => {
      await Promise.all([first.close(), second.close()]);
      const target = await realpath(directory);
      assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.match(basename(target), /^yumunio-sql-snapshot-/);
      await rm(target, { recursive: true, force: true });
    });
    assert.deepEqual(await first.read(), { revision: 0, snapshot: null });
    const initial = await Promise.allSettled([first.write(0, fixture('alpha')), second.write(0, fixture('beta'))]);
    assert.equal(initial.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(initial.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
    assert.equal(initial.find(result => result.status === 'rejected').reason.details.actualRevision, 1);
    const initialWinner = initial.find(result => result.status === 'fulfilled').value;
    assert.deepEqual(await second.read(), initialWinner);
    const updates = await Promise.allSettled([first.write(1, fixture('gamma')), second.write(1, fixture('delta'))]);
    assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(updates.find(result => result.status === 'rejected').reason.details.actualRevision, 2);
    assert.deepEqual(await first.read(), updates.find(result => result.status === 'fulfilled').value);
    assert.equal(a.database.prepare('SELECT updated_at FROM yumunio_prototype_snapshots').get().updated_at, stamp);
    const stale = await Promise.allSettled([first.write(0, fixture('stale')), second.write(1, fixture('stale'))]);
    assert.ok(stale.every(result => result.status === 'rejected' && result.reason.code === 'VERSION_CONFLICT'));
    assert.equal((await first.read()).revision, 2);
  });

  test(`${dialect}: a nonzero revision never creates an absent row`, async () => {
    const transport = new SqlTransport(':memory:', dialect);
    const store = new SqlSnapshotStore(transport);
    try {
      await assert.rejects(store.write(7, fixture('absent')), error => error.code === 'VERSION_CONFLICT' && error.details.actualRevision === 0);
      assert.deepEqual(await store.read(), { revision: 0, snapshot: null });
      assert.ok(!transport.calls.some(call => call.sql.startsWith('INSERT')));
    } finally { await store.close(); }
  });
}

test('input is captured before transport waits, and success returns its own committed snapshot', async () => {
  const transport = new SqlTransport(':memory:', 'mysql');
  const admitted = deferred();
  const continueWrite = deferred();
  let otherStore;
  const store = new SqlSnapshotStore({
    dialect: 'mysql',
    async query(sql, params) {
      admitted.resolve();
      await continueWrite.promise;
      const result = await transport.query(sql, params);
      if (sql.startsWith('INSERT')) await otherStore.write(1, fixture('later writer'));
      return result;
    },
  });
  otherStore = new SqlSnapshotStore(transport);
  try {
    const input = fixture("quoted ' ; DROP TABLE example; -- \u65e5\u672c\u8a9e");
    const expected = structuredClone(input);
    const pending = store.write(0, input);
    await admitted.promise;
    input.name = 'mutated after admission';
    continueWrite.resolve();
    assert.deepEqual(await pending, { revision: 1, snapshot: expected });
    assert.equal((await otherStore.read()).revision, 2);
    assert.equal((await otherStore.read()).snapshot.name, 'later writer');
    assert.ok(!transport.calls[0].sql.includes('DROP TABLE'));
    assert.equal(JSON.parse(transport.calls[0].params[0]).name, expected.name);
  } finally { await store.close(); await otherStore.close(); }
});

test('invalid and oversized snapshots, revisions, and clocks never query the database', async () => {
  let queries = 0;
  const driver = { dialect: 'mysql', async query() { queries++; return { rows: [], affectedRows: 1 }; } };
  const store = new SqlSnapshotStore(driver);
  for (const revision of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await rejectsCode(store.write(revision, fixture('valid')), 'INVALID_REVISION');
  }
  await rejectsCode(store.write(0, { ...fixture('valid'), accessKey: 'unexpected secret' }), 'INVALID_SNAPSHOT');
  await rejectsCode(store.write(0, fixture('x'.repeat(900001))), 'PAYLOAD_TOO_LARGE');
  for (const now of [() => '2026-02-30T00:00:00.000Z', () => '2026-10-15T12:00:00+09:00', () => new Date()]) {
    await rejectsCode(new SqlSnapshotStore(driver, { now }).write(0, fixture('valid')), 'INVALID_INPUT');
  }
  assert.equal(queries, 0);
});

test('BIGINT revisions from drivers are exact safe integers and malformed stored data is rejected', async () => {
  let rows = [];
  const store = new SqlSnapshotStore({ dialect: 'postgres', async query() { return { rows, affectedRows: 0 }; } });
  for (const revision of [1, '1', 1n, String(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)]) {
    rows = [{ revision, payload_json: JSON.stringify(fixture('stored')) }];
    assert.equal((await store.read()).revision, Number(revision));
  }
  for (const revision of [0, '0', '01', '+1', '1.0', '9007199254740992', 9007199254740992, 9007199254740992n, -1n, null]) {
    rows = [{ revision, payload_json: JSON.stringify(fixture('stored')) }];
    await rejectsCode(store.read(), 'STORAGE_ERROR');
  }
  for (const payload of ['{', '{}', 'x'.repeat(900001), fixture('object instead of text')]) {
    rows = [{ revision: '1', payload_json: payload }];
    await rejectsCode(store.read(), 'STORAGE_ERROR');
  }
  rows = [{ revision: 1, payload_json: JSON.stringify(fixture('one')) }, { revision: 1, payload_json: JSON.stringify(fixture('two')) }];
  await rejectsCode(store.read(), 'STORAGE_ERROR');
});

test('transport failures are sanitized and uncertain writes are never retried', async () => {
  let calls = 0;
  const secret = 'postgres://user:private-password@private-host/database';
  const store = new SqlSnapshotStore({ dialect: 'postgres', async query() { calls++; throw new Error(secret); } });
  await assert.rejects(store.write(0, fixture('valid')), error => {
    assert.equal(error.code, 'STORAGE_ERROR');
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes('private'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
  await rejectsCode(store.read(), 'STORAGE_ERROR');
  assert.equal(calls, 2);
});

test('only MySQL duplicate-entry insertion failures are treated as a version conflict', async () => {
  for (const marker of [{ code: 'ER_DUP_ENTRY' }, { errno: 1062 }]) {
    let calls = 0;
    const store = new SqlSnapshotStore({ dialect: 'mysql', async query() {
      if (calls++ === 0) throw Object.assign(new Error('private error detail'), marker);
      return { rows: [{ revision: '4', payload_json: JSON.stringify(fixture('current')) }], affectedRows: 0 };
    } });
    await assert.rejects(store.write(0, fixture('attempt')), error => error.code === 'VERSION_CONFLICT' && error.details.actualRevision === 4);
    assert.equal(calls, 2);
  }
  const store = new SqlSnapshotStore({ dialect: 'mysql', async query() { throw Object.assign(new Error('bad field'), { errno: 1054 }); } });
  await rejectsCode(store.write(0, fixture('attempt')), 'STORAGE_ERROR');
});

test('malformed pool results cannot be mistaken for a successful save', async () => {
  for (const result of [null, {}, { rows: [], affectedRows: '1' }, { rows: [], affectedRows: 2 }, { rows: [], affectedRows: NaN }]) {
    const store = new SqlSnapshotStore({ dialect: 'mysql', async query() { return result; } });
    await rejectsCode(store.write(0, fixture('attempt')), 'STORAGE_ERROR');
  }
});

test('close drains active operations, rejects new operations, and ends the pool exactly once', async () => {
  const admitted = deferred();
  const release = deferred();
  let ended = 0;
  const store = new SqlSnapshotStore({ dialect: 'mysql', async query() {
    admitted.resolve(); await release.promise;
    assert.equal(ended, 0);
    return { rows: [], affectedRows: 1 };
  }, async end() { ended++; } });
  const pending = store.write(0, fixture('accepted'));
  await admitted.promise;
  const closing = store.close();
  assert.equal(store.close(), closing);
  await rejectsCode(store.read(), 'STORAGE_ERROR');
  await rejectsCode(store.write(0, fixture('too late')), 'STORAGE_ERROR');
  assert.equal(ended, 0);
  release.resolve();
  assert.equal((await pending).revision, 1);
  await closing;
  assert.equal(ended, 1);
  await store.close();
  assert.equal(ended, 1);
});

test('pool shutdown failures are sanitized and closing still remains idempotent', async () => {
  let ended = 0;
  const store = new SqlSnapshotStore({ dialect: 'postgres', async query() { return { rows: [] }; }, async end() { ended++; throw new Error('private host'); } });
  const closing = store.close();
  await rejectsCode(closing, 'STORAGE_ERROR');
  assert.equal(store.close(), closing);
  await rejectsCode(store.close(), 'STORAGE_ERROR');
  assert.equal(ended, 1);
});
