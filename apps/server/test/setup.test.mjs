import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNodeSetup, readNodeInstanceEnvironment } from '../setup.mjs';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';
import { createInstanceSetup } from '../../../packages/identity/src/setup.js';
import { createSqliteSetupStore } from '../../../packages/identity/src/setup-store.js';

const token = 'synthetic-install-key-2026-'.repeat(3), password = 'Synthetic-owner-password-2026!';
async function fixture(t, { automatic = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yumunio-setup-test-')), database = join(directory, 'workspace.sqlite');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const env = { ...(automatic ? { YUMUNIO_WEB_SETUP: 'true' } : { YUMUNIO_SETUP_TOKEN: token }), YUMUNIO_DATABASE: database, YUMUNIO_PUBLIC_ORIGIN: origin, YUMUNIO_PORT: String(port) };
  let setup, server, snapshot;
  const start = async () => {
    setup = await createNodeSetup(env); snapshot = new SqliteSnapshotStore(database);
    server = createAppServer({ snapshotStore: snapshot, storage: 'sqlite', accessKey: setup.config.accessKey, publicOrigin: origin, runtimeProvider: () => setup.acquire() });
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
  };
  const stop = async () => { if (server) await new Promise(resolve => server.close(resolve)); await setup?.close(); snapshot?.close(); server = setup = snapshot = null; };
  t.after(async () => { await stop(); const target = await realpath(directory); assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(target).startsWith('yumunio-setup-test-')); await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await start();
  const request = (path, { method = 'GET', body, cookie, key, headers = {} } = {}) => fetch(origin + path, { method, redirect: 'manual', headers: { ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'X-Yumunio-Setup-Token': key } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const owner = settings => ({ name: 'Setup owner', email: 'owner@example.invalid', password, settings: settings || {} });
  const login = async () => {
    const response = await request('/api/auth/sign-in/email', { method: 'POST', body: { email: 'owner@example.invalid', password } });
    assert.equal(response.status, 200, await response.clone().text()); const body = await response.json();
    return { id: body.user.id, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  return { env, database, directory, origin, request, owner, login, get initialUrl() { return setup.setup.initialSetupUrl; }, async restart() { await stop(); await start(); }, stop };
}
test('ordinary self-host installation generates and persists credentials and a ready-to-open initial link', async t => {
  const f = await fixture(t, { automatic: true });
  const secret = await readFile(join(f.directory, 'instance-secret'), 'utf8');
  assert.equal(secret.length, 64);
  const initial = new URL(f.initialUrl), authorization = new URLSearchParams(initial.hash.slice(1)).get('start');
  assert.ok(authorization); assert.ok(!f.initialUrl.includes(secret));
  assert.equal((await f.request('/api/setup', { method: 'POST', key: secret, body: f.owner() })).status, 403);
  assert.equal((await f.request('/api/setup', { method: 'POST', key: authorization, body: f.owner() })).status, 201);
  await f.restart(); assert.equal(await readFile(join(f.directory, 'instance-secret'), 'utf8'), secret);
  await f.login();
  const commandEnvironment = await readNodeInstanceEnvironment(f.env);
  assert.equal(commandEnvironment.YUMUNIO_ACCOUNTS_ENABLED, 'true');
  assert.equal(commandEnvironment.YUMUNIO_SERVER_ADMIN_IDS.length, 36);
  assert.ok(commandEnvironment.YUMUNIO_AUTH_SECRET);
});
test('fresh Node install creates an owner and workspace without mail, persists encrypted settings and reloads them', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).headers.get('location'), '/setup');
  assert.equal((await f.request('/api/setup')).headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/api/auth/get-session')).status, 503);
  assert.equal((await f.request('/api/setup', { method: 'POST', key: 'wrong', body: f.owner() })).status, 403);
  assert.equal((await f.request('/api/setup', { method: 'POST', key: token, body: f.owner(), headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await f.request('/api/setup', { method: 'POST', key: token, body: f.owner({ YUMUNIO_REGISTRATION_MODE: 'open' }) })).status, 400);
  const response = await f.request('/api/setup', { method: 'POST', key: token, body: f.owner({ YUMUNIO_BRAND_NAME: 'My notes', YUMUNIO_OAUTH_GITHUB_CLIENT_ID: 'fixture-client-id', YUMUNIO_OAUTH_GITHUB_CLIENT_SECRET: 'fixture-oauth-secret' }) });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await f.request('/')).headers.get('location'), '/account');
  assert.equal((await f.request('/api/setup', { method: 'POST', key: token, body: f.owner() })).status, 409);
  const account = await f.login();
  assert.equal((await f.request('/api/admin/config', { cookie: account.cookie })).status, 200);
  const workspaces = await (await f.request('/api/auth/organization/list', { cookie: account.cookie })).json();
  assert.equal(workspaces.length, 1); assert.equal(workspaces[0].name, 'My notes');
  assert.equal((await f.request('/api/admin/settings')).status, 404);
  const settings = await (await f.request('/api/admin/settings', { cookie: account.cookie })).json();
  assert.equal(settings.settings.YUMUNIO_BRAND_NAME, 'My notes');
  assert.equal(settings.secrets.YUMUNIO_OAUTH_GITHUB_CLIENT_SECRET, true);
  assert.ok(!JSON.stringify(settings).includes('fixture-oauth-secret'));
  const db = new DatabaseSync(f.database);
  const sealed = db.prepare('SELECT sealed FROM yumunio_instance_settings').get().sealed;
  for (const value of ['My notes', 'fixture-oauth-secret', password, token]) assert.ok(!sealed.includes(value));
  db.close();
  const update = { revision: settings.revision, settings: { YUMUNIO_BRAND_NAME: 'Updated notes', YUMUNIO_OAUTH_GITHUB_CLIENT_SECRET: '' } };
  assert.equal((await f.request('/api/admin/settings', { method: 'PUT', body: update, cookie: account.cookie })).status, 404);
  assert.equal((await f.request('/api/admin/settings', { method: 'PUT', body: update, cookie: account.cookie, headers: { 'X-Yumunio-Expected-Account': account.id } })).status, 200);
  assert.equal((await f.request('/api/admin/settings', { method: 'PUT', body: update, cookie: account.cookie, headers: { 'X-Yumunio-Expected-Account': account.id } })).status, 409);
  await f.restart();
  assert.equal((await (await f.request('/api/setup')).json()).required, false);
  assert.equal((await (await f.request('/api/instance')).json()).applicationName, 'Updated notes');
  await f.login();
  const next = await (await f.request('/api/admin/settings', { cookie: account.cookie })).json();
  assert.equal(next.secrets.YUMUNIO_OAUTH_GITHUB_CLIENT_SECRET, true);
  const disabled = await f.request('/api/admin/settings', { method: 'PUT', cookie: account.cookie, headers: { 'X-Yumunio-Expected-Account': account.id }, body: { revision: next.revision, settings: { YUMUNIO_OAUTH_GITHUB_CLIENT_ID: '', YUMUNIO_OAUTH_GITHUB_CLIENT_SECRET: null } } });
  assert.equal(disabled.status, 200);
  assert.equal((await (await f.request('/api/auth/config')).json()).providers.length, 0);
});
test('concurrent setup claims commit exactly one owner and wrong keys cannot decrypt an installed instance', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([1, 2].map(() => f.request('/api/setup', { method: 'POST', key: token, body: f.owner() })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const db = new DatabaseSync(f.database);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM yumunio_users').get().total, 1);
  const bad = await createInstanceSetup({ env: { ...f.env, YUMUNIO_SETUP_TOKEN: 'a-different-installation-key-'.repeat(3) }, store: createSqliteSetupStore(db), origin: f.origin });
  await assert.rejects(() => bad.load()); db.close();
});
test('setup cannot claim existing accounts even with the installation key', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.database), stamp = Date.now();
  db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run('existing', 'Existing', 'existing@example.invalid', stamp, stamp);
  assert.equal((await f.request('/api/setup', { method: 'POST', key: token, body: f.owner() })).status, 409);
  // Exercise the same guard at the atomic write boundary, bypassing the public precheck.
  await assert.rejects(() => createSqliteSetupStore(db).initialize({ sealed: 'fixture', owner: { id: 'intruder', name: 'No', email: 'intruder@example.invalid' }, passwordHash: 'fixture', workspaceName: 'No' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM yumunio_instance_settings').get().total, 0); db.close();
  await f.stop();
  await assert.rejects(() => createNodeSetup(f.env));
});

test('origin inference shares the first settings read while later loads observe updates',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/setup',{method:'POST',key:token,body:f.owner()})).status,201);
 const db=new DatabaseSync(f.database),store=createSqliteSetupStore(db);let reads=0;
 try{
 const setup=await createInstanceSetup({env:{YUMUNIO_SETUP_TOKEN:token},store:{...store,async read(){reads++;return store.read();}}});
 const initial=await setup.load();assert.equal(reads,1);assert.equal(initial.env.YUMUNIO_PUBLIC_ORIGIN,f.origin);
 const account=await f.login();assert.equal((await f.request('/api/admin/settings',{method:'PUT',cookie:account.cookie,headers:{'X-Yumunio-Expected-Account':account.id},body:{revision:initial.revision,settings:{YUMUNIO_BRAND_NAME:'Changed after origin lookup'}}})).status,200);
 const latest=await setup.load();assert.equal(reads,2);assert.equal(latest.env.YUMUNIO_BRAND_NAME,'Changed after origin lookup');assert.equal(latest.revision,initial.revision+1);
 }finally{db.close();}
});
