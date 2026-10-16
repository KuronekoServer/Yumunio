import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CONTENT_TEST_TABLES, assertEmptyIdentityTestDatabase, planIdentityContentTestDdl, createOwnedIdentityContentTables} from '../integration/identity-content-ddl.mjs';

const schemas = Object.fromEntries(await Promise.all(['mysql', 'postgres'].map(async dialect => [dialect,
  await readFile(new URL('../../../packages/identity/schema/content.' + dialect + '.sql', import.meta.url), 'utf8')])));

for (const dialect of ['mysql', 'postgres']) test(dialect + ' current content schema explicitly creates all three owned tables without adopting existing tables', async () => {
  const plan = planIdentityContentTestDdl(schemas[dialect], dialect), queries = [], created = ['yumunio_users'];
  assert.deepEqual(plan.map(item => item.table), CONTENT_TEST_TABLES);
  assert.ok(plan.every(item => item.statement.startsWith('CREATE TABLE ' + item.table + ' (') && !/IF NOT EXISTS/i.test(item.statement)));
  assert.match(plan[1].statement, /ordinal INTEGER NOT NULL CHECK \(ordinal >= 0 AND ordinal < 32\)/);
  assert.match(plan[2].statement, /CHECK \(ok = 1\)/);
  await createOwnedIdentityContentTables({async query(sql) { queries.push(sql); }}, schemas[dialect], dialect, created);
  assert.deepEqual(queries, plan.map(item => item.statement));
  assert.deepEqual(created, ['yumunio_users', ...CONTENT_TEST_TABLES]);
});

test('every preexisting table, including an unrelated or case-variant name, refuses fixture setup', () => {
  assert.doesNotThrow(() => assertEmptyIdentityTestDatabase({rows: []}));
  for (const result of [undefined, {}, {rows: null}, {rows: [{TABLE_NAME: 'yumunio_account_content'}]},
    {rows: [{tablename: 'yumunio_content_chunks'}]}, {rows: [{tablename: 'YUMUNIO_CONTENT_GUARDS'}]}, {rows: [{tablename: 'unrelated_private_table'}]}]) {
    assert.throws(() => assertEmptyIdentityTestDatabase(result), /no preexisting tables/);
  }
});

test('unknown, duplicated, missing or additional DDL fails before any SQL or ownership changes', async () => {
  const source = schemas.postgres;
  for (const changed of [source.replace('yumunio_content_guards', 'yumunio_users'),
    source.replace('yumunio_content_guards', 'yumunio_content_chunks'), source.split('CREATE TABLE IF NOT EXISTS yumunio_content_guards')[0],
    source + '\nDROP TABLE yumunio_users;', source.replace('CREATE TABLE IF NOT EXISTS yumunio_content_guards', 'ALTER TABLE yumunio_content_guards'),
    source.replace('yumunio_content_guards (', 'public.yumunio_content_guards ('),
    source.replace('yumunio_content_guards (', '"yumunio_content_guards" ('), source.replace('ok INTEGER', 'ok /* hidden */ INTEGER')]) {
    const queries = [], created = ['yumunio_users'];
    await assert.rejects(createOwnedIdentityContentTables({async query(sql) { queries.push(sql); }}, changed, 'postgres', created), /three allowlisted/);
    assert.deepEqual(queries, []); assert.deepEqual(created, ['yumunio_users']);
  }
});

test('unsupported dialect, foreign table suffixes and already owned content refuse execution', async () => {
  for (const dialect of ['sqlite', '', undefined]) assert.throws(() => planIdentityContentTestDdl(schemas.postgres, dialect));
  assert.throws(() => planIdentityContentTestDdl(schemas.mysql, 'postgres'));
  assert.throws(() => planIdentityContentTestDdl(schemas.postgres, 'mysql'));
  const created = ['yumunio_account_content']; let queries = 0;
  await assert.rejects(createOwnedIdentityContentTables({async query() { queries++; }}, schemas.postgres, 'postgres', created), /ownership/);
  assert.equal(queries, 0); assert.deepEqual(created, ['yumunio_account_content']);
});

test('concurrent or unknown CREATE failure records only earlier acknowledged tables for reverse cleanup', async () => {
  const created = ['yumunio_users'], attempted = [], failure = new Error('CREATE acknowledgement unavailable');
  await assert.rejects(createOwnedIdentityContentTables({async query(sql) {
    attempted.push(sql); if (attempted.length === 2) throw failure;
  }}, schemas.mysql, 'mysql', created), error => error === failure);
  assert.equal(attempted.length, 2);
  assert.deepEqual([...created].reverse(), ['yumunio_account_content', 'yumunio_users']);
  assert.equal(created.includes('yumunio_content_chunks'), false);
  assert.equal(created.includes('yumunio_content_guards'), false);
});
