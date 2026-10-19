import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { createSqliteContentStore } from '@yumunio/identity/content-store';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';

test('Node account pages persist separately, filter private pages, enforce sharing and preserve legacy snapshots', async t => {
  const legacy = new SqliteSnapshotStore(':memory:'); const mail = [];
  let identity;
  const server = createAppServer({ snapshotStore: legacy, accessKey: 'legacy-fixture-'.repeat(4), identity: {
    handle: (...args) => identity.handle(...args), content: (...args) => identity.content(...args)
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await identity?.flushBackgroundTasks(); legacy.close(); });
  identity = createIdentity({ database: legacy.database, origin, workspaceContent: true,
    secret: 'account-content-secret-'.repeat(3), registrationMode: 'open',
    sendMail: async message => { mail.push(message); return { status: 'accepted' }; } });
  await (await getMigrations(identity.auth.options)).runMigrations();
  legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql', import.meta.url), 'utf8'));
  const store = createSqliteContentStore(legacy.database);
  identity.content = createAccountContentApi({ store, origin, resolveSession: request => identity.auth.api.getSession({ headers: request.headers }) });
  const request = (path, method = 'GET', body, cookie) => fetch(origin + path, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' })
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function account(name) {
    const email = name + '@example.invalid'; const password = 'content-fixture-password';
    assert.equal((await request('/api/auth/sign-up/email', 'POST', { name, email, password })).status, 202);
    await identity.flushBackgroundTasks();
    const token = new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');
    assert.equal((await request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(origin + '/account'))).status, 200);
    const login = await request('/api/auth/sign-in/email', 'POST', { email, password });
    assert.equal(login.status, 200);
    return { user: (await login.json()).user, cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  const a = await account('owner-a'); const b = await account('member-b');
  const created = await request('/api/auth/organization/create', 'POST', { name: 'Account Pages', slug: 'account-pages' }, a.cookie);
  assert.equal(created.status, 200); const workspace = await created.json();
  const path = '/api/content/workspaces/' + workspace.id + '/pages';
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, 'GET', undefined, b.cookie)).status, 404);
  // Membership management is not public yet; provision only the owned test fixture row.
  legacy.database.prepare('INSERT INTO yumunio_memberships(id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)')
    .run('fixture-member-b', workspace.id, b.user.id, 'member', Date.now());
  const pageResponse = await request(path, 'POST', { expectedRevision: 0, title: 'A private page', blocks: [{ id: 'paragraph-a', type: 'paragraph', data: { text: 'Private body' } }] }, a.cookie);
  assert.equal(pageResponse.status, 201); const page = await pageResponse.json();
  const pagePath = path + '/' + page.page.id;
  const filtered = await (await request(path, 'GET', undefined, b.cookie)).json();
  assert.deepEqual(filtered.pages, []); assert.equal(Object.hasOwn(filtered, 'payload'), false);
  assert.equal((await request(pagePath, 'GET', undefined, b.cookie)).status, 404);
  const shared = await request(pagePath + '/grants', 'POST', { expectedRevision: 1, accountId: b.user.id, permission: 'viewer' }, a.cookie);
  assert.equal(shared.status, 200); assert.equal((await shared.json()).revision, 2);
  assert.equal((await request(pagePath, 'GET', undefined, b.cookie)).status, 200);
  assert.equal((await request(pagePath, 'PATCH', { expectedRevision: 2, expectedVersion: 1, title: 'Denied edit' }, b.cookie)).status, 404);
  const update = await request(pagePath, 'PATCH', { expectedRevision: 2, expectedVersion: 1, title: 'Saved in SQL' }, a.cookie);
  assert.equal(update.status, 200); assert.equal((await update.json()).document.version, 2);
  assert.equal((await request(pagePath, 'PATCH', { expectedRevision: 2, expectedVersion: 1, title: 'Stale' }, a.cookie)).status, 409);
  assert.equal((await request('/api/workspace/snapshot', 'GET', undefined, a.cookie)).status, 401);
  assert.equal((await legacy.read()).snapshot, null);
  assert.equal((await request('/api/auth/organization/get-full-organization?organizationId=' + workspace.id, 'GET', undefined, a.cookie)).status, 404);
  await request('/api/auth/sign-out', 'POST', {}, a.cookie);
  assert.equal((await request(pagePath, 'GET', undefined, a.cookie)).status, 401);
  assert.equal((await store.read(workspace.id, b.user.id)).revision, 3);
});
