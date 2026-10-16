import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { createNodeIdentityService,applyAccountCustomDdl } from '../identity.mjs';

test('disabled identity does not open a database or read mail credentials', async () => {
  const env = { get YUMUNIO_MAIL_DRIVER() { throw new Error('must not read'); } };
  const config = { get storage() { throw new Error('must not open'); } };
  assert.equal(await createNodeIdentityService(env, config), null);
});

test('Node account startup requires an explicit schema migration and preserves the existing prototype database', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'yumunio-identity-'));
  const filename = join(folder, 'accounts.sqlite');
  const seed = new DatabaseSync(filename);
  seed.exec("CREATE TABLE prototype_sentinel(value TEXT); INSERT INTO prototype_sentinel VALUES ('preserved')");
  seed.close();
  let service;
  t.after(async () => {
    await service?.close();
    const target = await realpath(folder);
    assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.match(basename(target), /^yumunio-identity-/);
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const env = { YUMUNIO_ACCOUNTS_ENABLED: 'true', YUMUNIO_PUBLIC_ORIGIN: 'http://127.0.0.1:8792', YUMUNIO_AUTH_SECRET: 'fixture-identity-startup-'.repeat(3) };
  const config = { storage: 'sqlite', database: filename };
  await assert.rejects(createNodeIdentityService(env, config), /migration/);
  const before = new DatabaseSync(filename);
  assert.deepEqual(before.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name), ['prototype_sentinel']);
  before.close();
  service = await createNodeIdentityService(env, config, { verifySchema: false });
  await (await getMigrations(service.auth.options)).runMigrations();
  await service.close(); service = null;
  await assert.rejects(createNodeIdentityService(env, config), /content schema.*migration/);
  service = await createNodeIdentityService(env, config, { verifySchema: false });
  await service.migrateContentSchema();
  await service.close(); service = null;
  service = await createNodeIdentityService(env, config);
  const response = await service.handle(new Request('http://127.0.0.1:8792/api/auth/config'));
  assert.equal((await response.json()).enabled, true);
  await service.close(); service = null;
  const after = new DatabaseSync(filename);
  assert.equal(after.prepare('SELECT value FROM prototype_sentinel').get().value, 'preserved');
  after.close();
});

for(const dialect of ['mysql','postgres'])test(dialect+' production custom migrations apply every maintained DDL serially without executing semicolon-bearing comment fragments',async()=>{
 const kinds=['content','collaboration','preferences','api-tokens','webhooks','room-presence'],schemas=await Promise.all(kinds.map(kind=>readFile(new URL('../../../packages/identity/schema/'+kind+'.'+dialect+'.sql',import.meta.url),'utf8'))),expected=schemas.flatMap(sql=>[...sql.matchAll(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]));
 assert.ok(schemas.some(sql=>/^[\t ]*--[^\r\n]*;/m.test(sql)),'the actual maintained files retain the comment punctuation that exposed the production defect');
 const queries=[];let active=0,maxActive=0;
 await applyAccountCustomDdl({client:{dialect,async query(sql){active++;maxActive=Math.max(maxActive,active);try{await Promise.resolve();assert.match(sql,/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS\s+[A-Za-z0-9_]+\b/);assert.doesNotMatch(sql,/^[\t ]*--|;/m);queries.push(sql);}finally{active--;}}}});
 assert.equal(maxActive,1);assert.deepEqual(queries.map(sql=>/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS\s+([A-Za-z0-9_]+)/.exec(sql)[1]),expected);assert.ok(expected.includes('yumunio_account_content'));assert.ok(expected.includes('yumunio_account_preferences'));assert.ok(expected.includes('yumunio_room_presence'));
 const failure=Error('Synthetic isolated DDL rejection.');let attempted=0;await assert.rejects(applyAccountCustomDdl({client:{dialect,async query(){if(++attempted===2)throw failure;}}}),error=>error===failure);assert.equal(attempted,2,'a driver failure must stop the migration without later DDL or a silent retry');
});
