import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { createNodeIdentityService } from '../identity.mjs';
import { createAppServer } from '../server.mjs';

test('Node durable auth mail survives restart and page-guest invitation is consumed through real HTTP routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yumunio-collaboration-'));
  const database = join(directory, 'account.sqlite');
  let service; const mail = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://relay.example.invalid/send') return realFetch(url, options);
    mail.push(JSON.parse(options.body)); return new Response(null, { status: 202 });
  };
  const server = createAppServer({ instanceEnvironment: { YUMUNIO_BRAND_NAME: 'Test Studio', YUMUNIO_AUTH_SECRET: 'never-public-fixture' }, identity: {
    handle: (...args) => service.handle(...args), content: (...args) => service.content(...args),
    collaboration: { handle: (...args) => service.collaboration.handle(...args) }, preferences: (...args) => service.preferences(...args), admin: (...args) => service.admin(...args)
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const env = { YUMUNIO_ACCOUNTS_ENABLED: 'true', YUMUNIO_PUBLIC_ORIGIN: origin,
    YUMUNIO_AUTH_SECRET: 'durable-fixture-secret-'.repeat(3), YUMUNIO_REGISTRATION_MODE: 'open',
    YUMUNIO_MAIL_DRIVER: 'http', YUMUNIO_SMTP_FROM: 'no-reply@example.invalid',
    YUMUNIO_MAIL_HTTP_ENDPOINT: 'https://relay.example.invalid/send', YUMUNIO_MAIL_HTTP_TOKEN: 'fixture-only' };
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve)); await service?.close();
    const target = await realpath(directory);
    assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.match(basename(target), /^yumunio-collaboration-/);
    await rm(target, { recursive: true, force: true });
  });
  const open = verifySchema => createNodeIdentityService(env, { storage: 'sqlite', database }, { verifySchema });
  service = await open(false);
  await (await getMigrations(service.auth.options)).runMigrations(); await service.migrateContentSchema();
  await service.collaboration.runJobs();
  const request = (path, { method = 'GET', body, account, headers = {} } = {}) => realFetch(origin + path, {
    method, redirect: 'manual', headers: { ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...(account ? { Cookie: account.cookie, 'X-Yumunio-Expected-Account': account.user.id } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const signup = name => request('/api/auth/sign-up/email', { method: 'POST', body: { name, email: name + '@example.invalid', password: 'durable-fixture-password' } });
  async function login(name) {
    const message = mail.find(row => row.to === name + '@example.invalid' && row.text.includes('?verify='));
    const token = new URL(message.text.split('\n').at(-1)).searchParams.get('verify');
    assert.equal((await request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(origin + '/account.html'))).status, 200);
    const response = await request('/api/auth/sign-in/email', { method: 'POST', body: { email: name + '@example.invalid', password: 'durable-fixture-password' } });
    assert.equal(response.status, 200);
    return { user: (await response.json()).user, cookie: response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ') };
  }
  const publicBrand = await (await request('/api/instance')).json();
  assert.equal(publicBrand.applicationName, 'Test Studio'); assert.doesNotMatch(JSON.stringify(publicBrand), /never-public|AUTH_SECRET/);
  assert.equal((await signup('owner')).status, 202);
  const check = new DatabaseSync(database);
  try {
    const queued = check.prepare('SELECT status,payload_ciphertext FROM yumunio_mail_jobs').get();
    assert.equal(queued.status, 'queued'); assert.doesNotMatch(queued.payload_ciphertext, /owner@example|verify=/);
  } finally { check.close(); }
  assert.equal(mail.length, 0); await service.close();
  service = await open(true); await service.collaboration.runJobs();
  assert.equal(mail.length, 1); const owner = await login('owner');
  assert.deepEqual(await (await request('/api/preferences', { account: owner })).json(), { revision: 0, preferences: null });
  const preferences = { schemaVersion: 1, themeId: 'midnight', customColors: {}, fontId: 'line-seed-jp', locale: 'en' };
  const savedPreferences = await request('/api/preferences', { method: 'PUT', account: owner, body: { expectedRevision: 0, preferences } });
  assert.equal(savedPreferences.status, 200); assert.deepEqual(await savedPreferences.json(), { revision: 1, preferences });
  assert.equal((await request('/api/preferences', { account: owner, headers: { 'X-Yumunio-Expected-Account': 'other' } })).status, 404);
  assert.equal((await request('/api/preferences', { method: 'PUT', account: owner, body: { expectedRevision: 0, preferences } })).status, 409);

  const workspaceResponse = await request('/api/auth/organization/create', { method: 'POST', account: owner, body: { name: 'Durable workspace', slug: 'durable-workspace' } });
  assert.equal(workspaceResponse.status, 200); const workspace = await workspaceResponse.json();
  const content = '/api/content/workspaces/' + workspace.id;
  const pageResponse = await request(content + '/pages', { method: 'POST', account: owner, body: { expectedRevision: 0, title: 'Shared fixture', blocks: [] } });
  assert.equal(pageResponse.status, 201); const page = (await pageResponse.json()).page;
  assert.equal((await signup('recipient')).status, 202); await service.collaboration.runJobs();
  const recipient = await login('recipient');
  const invitations = '/api/collaboration/workspaces/' + workspace.id + '/invitations';
  const issued = await request(invitations, { method: 'POST', account: owner, body: { expectedRevision: 1, requestId: 'fixture-invitation', purpose: 'page-guest', email: recipient.user.email, role: 'viewer', pageId: page.id, includeDescendants: false } });
  assert.equal(issued.status, 201); const result = await issued.json(); assert.equal(result.mailStatus, 'queued');
  assert.doesNotMatch(JSON.stringify(result), /tokenHash|ciphertext|membershipId/);
  await service.collaboration.runJobs();
  const link = new URL(mail.find(row => row.text.includes('?invite=')).text.split('\n').at(-1));
  const invitationBody = { invitationId: link.searchParams.get('invite'), token: link.searchParams.get('token') };
  const preview = await request('/api/collaboration/preview', { method: 'POST', account: recipient, body: invitationBody });
  assert.equal(preview.status, 200); assert.deepEqual(await preview.json(), { invitationId: 'fixture-invitation', purpose: 'page-guest', workspaceId: workspace.id, workspaceName: 'Durable workspace', pageId: page.id, pageTitle: 'Shared fixture', role: 'viewer', includeDescendants: false, expiresAt: result.invitation.expiresAt });
  assert.equal((await request(content + '/pages/' + page.id, { account: recipient })).status, 404);
  assert.equal((await request('/api/collaboration/preview', { method: 'POST', account: owner, body: invitationBody })).status, 404);
  assert.equal((await (await request(invitations, { account: owner })).json()).invitations[0].status, 'pending');
  const accepted = await request('/api/collaboration/accept', { method: 'POST', account: recipient, body: { invitationId: link.searchParams.get('invite'), token: link.searchParams.get('token') } });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).role, 'guest');
  assert.equal((await request(content + '/pages/' + page.id, { account: recipient })).status, 200);
  assert.equal((await request('/api/collaboration/accept', { method: 'POST', account: recipient, body: { invitationId: link.searchParams.get('invite'), token: link.searchParams.get('token') } })).status, 404);
  assert.equal((await request(invitations, { account: owner, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const listing = await (await request(invitations, { account: owner })).json(); assert.equal(listing.invitations[0].status, 'accepted');
  const beforeEdit = await (await request(content + '/pages/' + page.id, { account: owner })).json();
  const edited = await request(content + '/pages/' + page.id, { method: 'PATCH', account: owner, body: { expectedRevision: beforeEdit.revision, expectedVersion: beforeEdit.document.version, title: 'Edited fixture' } });
  assert.equal(edited.status, 200); const editedPage = await edited.json();
  const historyPath = content + '/pages/' + page.id + '/history';
  const versions = await (await request(historyPath, { account: owner })).json(); assert.equal(versions.versions.length, 1); assert.equal(versions.versions[0].version, 1);
  assert.equal((await request(historyPath, { account: recipient })).status, 404);
  const snapshot = await (await request(historyPath + '/' + versions.versions[0].id, { account: owner })).json(); assert.equal(snapshot.snapshot.title, 'Shared fixture');
  const restored = await request(historyPath + '/' + versions.versions[0].id + '/restore', { method: 'POST', account: owner, body: { expectedRevision: editedPage.revision, expectedVersion: editedPage.document.version } });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).version, 3);
  assert.equal((await request(content + '/pages/' + page.id, { method: 'PATCH', account: owner, body: { expectedRevision: editedPage.revision, expectedVersion: editedPage.document.version, title: 'Stale before restore' } })).status, 409);
  env.YUMUNIO_SERVER_ADMIN_IDS = owner.user.id;
  await service.close(); service = await open(true); await service.collaboration.runJobs();
  assert.deepEqual(await (await request('/api/preferences', { account: owner })).json(), { revision: 1, preferences });
  assert.equal((await request(content + '/pages/' + page.id, { account: recipient })).status, 200);
  const adminConfig = await request('/api/admin/config', { account: owner }); assert.equal(adminConfig.status, 200);
  const diagnostics = await adminConfig.json(); assert.equal(diagnostics.readonly, true); assert.equal(diagnostics.database.driver, 'sqlite');
  assert.doesNotMatch(JSON.stringify(diagnostics), /durable-fixture-secret|fixture-only|relay.example|payload_ciphertext/);
  assert.equal((await request('/api/admin/config', { account: recipient })).status, 404);
  const users = await (await request('/api/admin/users', { account: owner })).json(); assert.equal(users.users.length, 2); assert.equal(users.users.find(user => user.id === owner.user.id).serverAdmin, true);
  const testRequest = { requestId: 'node-admin-mail-test', consent: true };
  const testMail = await request('/api/admin/mail-test', { method: 'POST', account: owner, body: testRequest }); assert.equal(testMail.status, 202); assert.equal((await testMail.json()).status, 'queued');
  const replayMail = await request('/api/admin/mail-test', { method: 'POST', account: owner, body: testRequest }); assert.equal((await replayMail.json()).replayed, true);
  await service.collaboration.runJobs(); assert.equal(mail.at(-1).to, owner.user.email);
  const jobs = await (await request('/api/admin/jobs', { account: owner })).json(); assert.equal(jobs.tests.length, 1); assert.equal(jobs.tests[0].status, 'accepted');
  const sessions = await (await request('/api/admin/users/' + recipient.user.id + '/sessions', { account: owner })).json(); assert.equal(sessions.sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(sessions), /token|ipAddress|userAgent/);
  assert.equal((await request('/api/admin/users/' + recipient.user.id + '/sessions/' + sessions.sessions[0].id, { method: 'DELETE', account: owner, body: { consent: true } })).status, 200);
  assert.equal((await request(content + '/pages/' + page.id, { account: recipient })).status, 401);
});
