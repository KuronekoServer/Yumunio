import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createD1ContentStore, createSqliteContentStore, SqlAccountContentStore } from '../src/content-store.js';

const identitySchema = await readFile(new URL('../../../apps/worker/auth-schema.sql', import.meta.url), 'utf8');
const contentSchema = await readFile(new URL('../schema/content.sqlite.sql', import.meta.url), 'utf8');
const fixturePayload = () => ({ schemaVersion: 1, pages: [{ title: '\u65e5\u672c\u8a9e \ud83d\udc08', text: "literal '; DROP TABLE yumunio_users; --" }], grants: [] });
const actor = (extra = {}) => ({ expectedRevision: 0, payload: fixturePayload(), actorMembershipId: 'member-a', actorRole: 'owner', guardMemberships: [], ...extra });
const hasCode = code => error => error?.code === code && !error.message.includes('DROP') && !Object.hasOwn(error, 'cause');

function database() {
  const db = new DatabaseSync(':memory:');
  initialize(db);
  return db;
}
function initialize(db) {
  db.exec(identitySchema);
  db.exec(contentSchema);
  db.exec('CREATE TABLE IF NOT EXISTS prototype_sentinel (value TEXT NOT NULL)');
  db.prepare('INSERT INTO prototype_sentinel VALUES (?)').run('legacy-private-content');
  const stamp = '2026-10-15T00:00:00.000Z';
  for (const [id, verified] of [['user-a', 1], ['user-b', 1], ['user-c', 0], ['user-z', 1]]) {
    db.prepare('INSERT INTO yumunio_users (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, id + '@studio.example', verified, stamp, stamp);
  }
  for (const id of ['workspace-a', 'workspace-b', 'workspace-empty']) {
    db.prepare('INSERT INTO yumunio_workspaces (id, name, slug, createdAt) VALUES (?, ?, ?, ?)').run(id, id, id, stamp);
  }
  for (const [id, workspaceId, accountId, role] of [
    ['member-a', 'workspace-a', 'user-a', 'owner'], ['member-b', 'workspace-a', 'user-b', 'member'],
    ['member-c', 'workspace-a', 'user-c', 'guest'], ['member-z', 'workspace-b', 'user-z', 'owner'],
  ]) db.prepare('INSERT INTO yumunio_memberships (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, workspaceId, accountId, role, stamp);
}
const principal = (id, accountId, role, emailVerified = true) => ({ id, accountId, displayName: accountId, email: accountId + '@studio.example', emailVerified, role });

test('SQLite reads one verified workspace membership snapshot and never migrates legacy data', async t => {
  const db = database(); t.after(() => db.close());
  const store = createSqliteContentStore(db);
  await store.checkSchema();
  assert.deepEqual(await store.read('workspace-a', 'user-a'), { revision: 0, payload: null, principals: [
    principal('member-a', 'user-a', 'owner'), principal('member-b', 'user-b', 'member'), principal('member-c', 'user-c', 'guest', false),
  ] });
  for (const [workspaceId, accountId] of [['workspace-a', 'user-z'], ['workspace-b', 'user-a'], ['workspace-a', 'user-c'], ['workspace-empty', 'user-a'], ['missing', 'user-a']]) {
    assert.equal(await store.read(workspaceId, accountId), null);
  }
  assert.deepEqual(await store.write('workspace-a', 'user-a', actor()), { revision: 1 });
  const saved = await store.read('workspace-a', 'user-b');
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.payload, fixturePayload());
  saved.payload.pages[0].title = 'caller mutation';
  assert.deepEqual((await store.read('workspace-a', 'user-a')).payload, fixturePayload());
  assert.deepEqual(await store.write('workspace-b', 'user-z', actor({ actorMembershipId: 'member-z', payload: { other: true } })), { revision: 1 });
  assert.deepEqual((await store.read('workspace-b', 'user-z')).payload, { other: true });
  assert.deepEqual((await store.read('workspace-a', 'user-a')).payload, fixturePayload());
  assert.equal(db.prepare('SELECT value FROM prototype_sentinel').get().value, 'legacy-private-content');
});

test('factories do not create schema, capture private clients or close caller databases', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = createSqliteContentStore(db);
  assert.deepEqual(Object.keys(store), []);
  await assert.rejects(store.checkSchema(), hasCode('CONTENT_STORAGE_ERROR'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'yumunio_account_content'").get().n, 0);
  assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
});

test('SQLite CAS persists across two connections and reopening, with one winner at each revision', async t => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'yumunio-content-store-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith('yumunio-content-store-'));
    await rm(target, { recursive: true, force: true });
  });
  const path = join(directory, 'content.sqlite');
  const firstDb = new DatabaseSync(path); initialize(firstDb);
  const secondDb = new DatabaseSync(path);
  let firstClosed = false; let secondClosed = false;
  t.after(() => { if (!firstClosed) firstDb.close(); if (!secondClosed) secondDb.close(); });
  const first = createSqliteContentStore(firstDb); const second = createSqliteContentStore(secondDb);
  for (const expectedRevision of [0, 1]) {
    const results = await Promise.allSettled([
      first.write('workspace-a', 'user-a', actor({ expectedRevision, payload: { winner: 'first', expectedRevision } })),
      second.write('workspace-a', 'user-a', actor({ expectedRevision, payload: { winner: 'second', expectedRevision } })),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'CONTENT_CONFLICT').length, 1);
    assert.equal((await first.read('workspace-a', 'user-a')).revision, expectedRevision + 1);
  }
  await assert.rejects(first.write('workspace-a', 'user-a', actor({ expectedRevision: 1 })), hasCode('CONTENT_CONFLICT'));
  await assert.rejects(first.write('workspace-b', 'user-z', actor({ actorMembershipId: 'member-z', expectedRevision: 4 })), hasCode('CONTENT_CONFLICT'));
  const expected = await first.read('workspace-a', 'user-a');
  firstDb.close(); firstClosed = true; secondDb.close(); secondClosed = true;
  const reopened = new DatabaseSync(path);
  try { assert.deepEqual(await createSqliteContentStore(reopened).read('workspace-a', 'user-a'), expected); }
  finally { reopened.close(); }
});

test('live actor membership ID, role, verification and workspace are guarded on the write statement', async t => {
  const db = database(); t.after(() => db.close());
  const store = createSqliteContentStore(db);
  await store.read('workspace-a', 'user-a');
  db.prepare('UPDATE yumunio_memberships SET role = ? WHERE id = ?').run('guest', 'member-a');
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_CONFLICT'));
  db.prepare('UPDATE yumunio_memberships SET role = ? WHERE id = ?').run('owner', 'member-a');
  db.prepare('UPDATE yumunio_users SET emailVerified = 0 WHERE id = ?').run('user-a');
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_NOT_FOUND'));
  db.prepare('UPDATE yumunio_users SET emailVerified = 1 WHERE id = ?').run('user-a');
  db.prepare('DELETE FROM yumunio_memberships WHERE id = ?').run('member-a');
  db.prepare('INSERT INTO yumunio_memberships (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('member-rejoined', 'workspace-a', 'user-a', 'owner', '2026-10-15');
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_CONFLICT'));
  assert.deepEqual(await store.write('workspace-a', 'user-a', actor({ actorMembershipId: 'member-rejoined' })), { revision: 1 });
  db.prepare('DELETE FROM yumunio_workspaces WHERE id = ?').run('workspace-a');
  assert.equal(await store.read('workspace-a', 'user-a'), null);
  await assert.rejects(store.write('workspace-a', 'user-a', actor({ expectedRevision: 1, actorMembershipId: 'member-rejoined' })), hasCode('CONTENT_NOT_FOUND'));
});

test('ambiguous memberships and unknown or differently cased roles fail closed', async t => {
  const db = database(); t.after(() => db.close());
  const store = createSqliteContentStore(db);
  db.prepare('INSERT INTO yumunio_memberships (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('duplicate', 'workspace-a', 'user-a', 'owner', '2026-10-15');
  assert.equal(await store.read('workspace-a', 'user-a'), null);
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_NOT_FOUND'));
  db.prepare('DELETE FROM yumunio_memberships WHERE id = ?').run('duplicate');
  for (const bad of ['owner,admin', 'OWNER', 'custom']) {
    db.prepare('UPDATE yumunio_memberships SET role = ? WHERE id = ?').run(bad, 'member-a');
    assert.equal(await store.read('workspace-a', 'user-a'), null);
  }
  db.prepare('UPDATE yumunio_memberships SET role = ? WHERE id = ?').run('owner', 'member-a');
  db.prepare('INSERT INTO yumunio_memberships (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('duplicate-target', 'workspace-a', 'user-b', 'member', '2026-10-15');
  assert.equal((await store.read('workspace-a', 'user-a')).principals.some(row => row.accountId === 'user-b'), false);
});

test('target guards bind verified members to this workspace, membership generation and role', async t => {
  const db = database(); t.after(() => db.close());
  const store = createSqliteContentStore(db);
  for (const guard of [
    { id: 'member-z', accountId: 'user-z', role: 'owner' },
    { id: 'member-b', accountId: 'user-z', role: 'member' },
    { id: 'member-b', accountId: 'user-b', role: 'admin' },
    { id: 'member-c', accountId: 'user-c', role: 'guest' },
  ]) await assert.rejects(store.write('workspace-a', 'user-a', actor({ guardMemberships: [guard] })), hasCode('CONTENT_CONFLICT'));
  const guard = { id: 'member-b', accountId: 'user-b', role: 'member' };
  await store.write('workspace-a', 'user-a', actor({ guardMemberships: [guard] }));
  db.prepare('DELETE FROM yumunio_memberships WHERE id = ?').run('member-b');
  db.prepare('INSERT INTO yumunio_memberships (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('new-target-generation', 'workspace-a', 'user-b', 'member', '2026-10-15');
  await assert.rejects(store.write('workspace-a', 'user-a', actor({ expectedRevision: 1, guardMemberships: [guard] })), hasCode('CONTENT_CONFLICT'));
  assert.equal((await store.read('workspace-a', 'user-a')).revision, 1);
});

test('non-JSON, oversized UTF-8 and corrupt stored payloads fail without mutation or sensitive errors', async t => {
  const db = database(); t.after(() => db.close());
  const store = createSqliteContentStore(db);
  const cyclic = {}; cyclic.self = cyclic;
  let getterCalled = false;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalled = true; return 'sensitive'; } });
  for (const payload of [null, [], { absent: undefined }, { number: NaN }, { toJSON() { return {}; } }, cyclic, getter, { text: '\u754c'.repeat(2666667) }]) {
    await assert.rejects(store.write('workspace-a', 'user-a', actor({ payload })), hasCode('CONTENT_STORAGE_ERROR'));
  }
  assert.equal(getterCalled, false);
  assert.equal((await store.read('workspace-a', 'user-a')).revision, 0);
  await store.write('workspace-a', 'user-a', actor());
  db.prepare('UPDATE yumunio_account_content SET payload_json = ?').run('sensitive malformed JSON');
  await assert.rejects(store.read('workspace-a', 'user-a'), hasCode('CONTENT_STORAGE_ERROR'));
  assert.equal(await store.read('workspace-a', 'user-z'), null);
});

function d1Binding(db) {
  return { prepare(sql) { return { bind(...params) { return { async all() {
    const statement = db.prepare(sql);
    if (/^SELECT\b/.test(sql)) return { success: true, results: statement.all(...params), meta: { changes: 0 } };
    return { success: true, results: [], meta: { changes: Number(statement.run(...params).changes) } };
  } }; } }; } };
}
test('D1 prepared binding executes the same SQLite authorization/CAS contract without batch or implicit DDL', async t => {
  const db = database(); t.after(() => db.close());
  const store = createD1ContentStore(d1Binding(db));
  await store.checkSchema();
  assert.equal((await store.read('workspace-a', 'user-a')).revision, 0);
  assert.deepEqual(await store.write('workspace-a', 'user-a', actor()), { revision: 1 });
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_CONFLICT'));
  db.prepare('DELETE FROM yumunio_memberships WHERE id = ?').run('member-a');
  await assert.rejects(store.write('workspace-a', 'user-a', actor({ expectedRevision: 1 })), hasCode('CONTENT_NOT_FOUND'));
  assert.equal(await store.read('workspace-a', 'user-a'), null);
});

for (const dialect of ['mysql', 'postgres']) test(dialect + ' generated bindings and conditional SQL run through a SQLite-shaped contract bridge (not a target DB runtime)', async t => {
  const db = database(); t.after(() => db.close());
  const calls = [];
  const bridge = { dialect, async query(sql, params = []) {
    calls.push({ sql, params });
    let values = params;
    let translated = sql;
    if (dialect === 'mysql') translated = sql.replace(/\bBINARY /g, '');
    else {
      values = [];
      translated = sql.replace(/\$(\d+)/g, (_, number) => { values.push(params[Number(number) - 1]); return '?'; });
    }
    try {
      const statement = db.prepare(translated);
      if (/^SELECT\b/.test(sql)) return { rows: statement.all(...values), affectedRows: 0 };
      return { rows: [], affectedRows: Number(statement.run(...values).changes) };
    } catch (error) {
      if (dialect === 'mysql' && error.message.includes('UNIQUE constraint failed')) throw Object.assign(new Error('fixture duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      throw error;
    }
  } };
  const store = new SqlAccountContentStore(bridge);
  await store.checkSchema();
  assert.equal((await store.read('workspace-a', 'user-a')).revision, 0);
  const guards = [{ id: 'member-b', accountId: 'user-b', role: 'member' }];
  await store.write('workspace-a', 'user-a', actor({ guardMemberships: guards }));
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_CONFLICT'));
  await store.write('workspace-a', 'user-a', actor({ expectedRevision: 1 }));
  assert.deepEqual((await store.read('workspace-a', 'user-a')).payload, fixturePayload());
  assert.deepEqual((await store.readPublication('workspace-a')).payload, fixturePayload());
  assert.ok(calls.every(call => !call.sql.includes('DROP TABLE') && !call.sql.includes('user-a') && !call.sql.includes('workspace-a')));
  assert.ok(calls.some(call => call.params.includes(JSON.stringify(fixturePayload()))));
  if (dialect === 'postgres') {
    assert.ok(calls.some(call => call.sql.includes('"emailVerified"') && call.sql.includes('"organizationId"') && call.sql.includes('"userId"')));
    for (const call of calls) assert.equal((call.sql.match(/\$\d+/g) || []).length, call.params.length);
  } else {
    assert.ok(calls.some(call => call.sql.includes('BINARY a.`userId` = BINARY ?') && call.sql.includes('BINARY g.`role` = BINARY ?')));
    for (const call of calls) assert.equal((call.sql.match(/\?/g) || []).length, call.params.length);
  }
});

test('unknown database errors remain generic and writes are never automatically retried', async () => {
  let queries = 0;
  const store = new SqlAccountContentStore({ dialect: 'postgres', async query() { queries++; throw new Error('private SQL password and content'); } });
  await assert.rejects(store.write('workspace-a', 'user-a', actor()), hasCode('CONTENT_STORAGE_ERROR'));
  assert.equal(queries, 1);
  const d1 = createD1ContentStore({ prepare() { return { bind() { return { async all() { return { success: false, error: 'private query' }; } }; } }; } });
  await assert.rejects(d1.checkSchema(), hasCode('CONTENT_STORAGE_ERROR'));
});

test('internal publication read captures one workspace aggregate and live principals without granting account read or writing',async t=>{
  const db=database();t.after(()=>db.close());const store=createSqliteContentStore(db);
  assert.equal(await store.readPublication('workspace-a'),null);await store.write('workspace-a','user-a',actor());
  const internal=await store.readPublication('workspace-a');assert.equal(internal.revision,1);assert.deepEqual(internal.payload,fixturePayload());assert.deepEqual(internal.principals,[principal('member-a','user-a','owner'),principal('member-b','user-b','member'),principal('member-c','user-c','guest',false)]);
  assert.equal(await store.read('workspace-a','user-c'),null);assert.equal(await store.read('workspace-a','user-z'),null);assert.equal(await store.readPublication('workspace-b'),null);assert.equal(await store.readPublication('missing'),null);
  internal.payload.pages[0].title='detached mutation';internal.principals[0].emailVerified=false;assert.deepEqual((await store.readPublication('workspace-a')).payload,fixturePayload());assert.equal(db.prepare('SELECT revision FROM yumunio_account_content').get().revision,1);
  db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('user-a');assert.equal((await store.readPublication('workspace-a')).principals[0].emailVerified,false);assert.equal(await store.read('workspace-a','user-a'),null);assert.equal(db.prepare('SELECT value FROM prototype_sentinel').get().value,'legacy-private-content');
});

test('publication lookup uses one bound statement, includes the aggregate once, and rejects malformed or oversized database results',async t=>{
  const db=database();t.after(()=>db.close());const base=createSqliteContentStore(db);await base.write('workspace-a','user-a',actor());let calls=0,result;
  const store=new SqlAccountContentStore({dialect:'sqlite',async query(sql,params){calls++;assert.equal(params.every(value=>value==='workspace-a'),true);assert.doesNotMatch(sql,/workspace-a/);result=db.prepare(sql).all(...params);return{rows:result,affectedRows:0};}});
  await store.readPublication('workspace-a');assert.equal(calls,1);assert.equal(result.length,4);assert.equal(result.filter(row=>row.payload_json!==null).length,1);
  for(const rows of [[...result,{...result[0]}],result.map(row=>row.row_kind===1?{...row,email:'invalid email'}:row),[result[0],...Array.from({length:1001},()=>result[1])]]){const broken=new SqlAccountContentStore({dialect:'sqlite',async query(){return{rows,affectedRows:0};}});await assert.rejects(broken.readPublication('workspace-a'),hasCode('CONTENT_STORAGE_ERROR'));}
  await assert.rejects(store.readPublication("workspace-a' OR 1=1"),hasCode('CONTENT_STORAGE_ERROR'));assert.equal(calls,1);
});
