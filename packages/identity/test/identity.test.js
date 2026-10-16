import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '../src/index.js';
import { createDomainPolicy } from '../src/config.js';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://workspace.example';
const password = 'fixture-long-password-6482';
async function fixture(t, options = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE prototype_sentinel(value TEXT); INSERT INTO prototype_sentinel VALUES (\'preserved\')');
  const mail = [];
  const identity = createIdentity({ database, origin, secret: 'fixture-auth-secret-'.repeat(4), registrationMode: 'open',
    sendMail: async message => { mail.push(message); return { status: 'accepted' }; }, ...options });
  t.after(async () => { await identity.flushBackgroundTasks(); database.close(); });
  const migrations = await getMigrations(identity.auth.options);
  await migrations.runMigrations();
  const request = (path, body, cookie, extraHeaders = {}) => identity.handle(new Request(origin + '/api/auth' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), { peerAddress: '127.0.0.1' });
  return { database, identity, mail, request };
}
const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function registerAndVerify(f, email = 'user@studio.example') {
  assert.equal((await f.request('/sign-up/email', { email, password, name: 'Fixture User' })).status, 202);
  await f.identity.flushBackgroundTasks();
  assert.ok(f.mail.length);
  const url = new URL(f.mail.at(-1).text.split('\n').at(-1));
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/account.html');
  const token = url.searchParams.get('verify');
  const verified = await f.request('/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(origin + '/account.html'));
  assert.ok([200, 302].includes(verified.status), 'verification status ' + verified.status);
  return email;
}
test('real SQLite identity signs up, verifies, signs in and revokes a private session without changing note data', async t => {
  const f = await fixture(t);
  await f.request('/sign-up/email', { email: 'unverified@studio.example', password, name: 'Unverified' });
  assert.equal((await f.request('/sign-in/email', { email: 'unverified@studio.example', password })).status, 401);
  const email = await registerAndVerify(f);
  const login = await f.request('/sign-in/email', { email, password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(login.headers.get('set-cookie'), /Secure/i);
  const cookie = cookies(login);
  const session = await (await f.request('/get-session', undefined, cookie)).json();
  assert.equal(session.user.email, email);
  assert.equal(session.user.emailVerified, true);
  const stored = f.database.prepare('SELECT password FROM yumunio_auth_accounts WHERE password IS NOT NULL').get();
  assert.ok(stored.password.length > 32 && stored.password !== password);
  assert.equal((await f.request('/sign-out', {}, cookie)).status, 200);
  assert.equal(await (await f.request('/get-session', undefined, cookie)).json(), null);
  assert.equal(f.database.prepare('SELECT value FROM prototype_sentinel').get().value, 'preserved');
});
test('a verified user can create a workspace while another account cannot read its members', async t => {
  const f = await fixture(t);
  const first = await registerAndVerify(f);
  const firstLogin = await f.request('/sign-in/email', { email: first, password });
  const firstCookie = cookies(firstLogin);
  const created = await f.request('/organization/create', { name: 'Studio', slug: 'fixture-studio' }, firstCookie);
  assert.equal(created.status, 200);
  const workspace = await created.json();
  assert.equal(workspace.name, 'Studio');
  const second = await registerAndVerify(f, 'second@studio.example');
  const secondCookie = cookies(await f.request('/sign-in/email', { email: second, password }));
  const hidden = await f.request('/organization/get-full-organization?organizationId=' + workspace.id, undefined, secondCookie);
  assert.ok([401, 403, 404].includes(hidden.status));
  assert.deepEqual(await (await f.request('/organization/list', undefined, secondCookie)).json(), []);
  assert.equal((await f.request('/organization/invite-member', { email: second, role: 'owner', organizationId: workspace.id }, firstCookie)).status, 404);
});
test('workspace directory and creation fence the expected account before exposing or creating workspace data', async t => {
  const f = await fixture(t);
  const first = await registerAndVerify(f, 'first-directory@studio.example');
  const firstLogin = await f.request('/sign-in/email', { email:first, password });
  const firstId = (await firstLogin.clone().json()).user.id;
  const firstCookie = cookies(firstLogin);
  const second = await registerAndVerify(f, 'second-directory@studio.example');
  const secondLogin = await f.request('/sign-in/email', { email:second, password });
  const secondId = (await secondLogin.clone().json()).user.id;
  const secondCookie = cookies(secondLogin);
  const expected = { 'X-Yumunio-Expected-Account':firstId };
  assert.equal((await f.request('/organization/create', {name:'Rejected',slug:'directory-rejected'}, secondCookie, expected)).status,409);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_workspaces').get().n,0);
  assert.equal((await f.request('/organization/list', undefined, secondCookie, expected)).status,409);
  assert.equal((await f.request('/organization/create', {name:'No session',slug:'directory-no-session'}, '', expected)).status,401);
  assert.equal((await f.request('/organization/list', undefined, firstCookie, {'X-Yumunio-Expected-Account':'bad account'})).status,400);
  const created = await f.request('/organization/create', {name:'Personal start',slug:'personal-start'}, firstCookie, expected);
  assert.equal(created.status,200);
  const workspace = await created.json();
  assert.deepEqual(f.database.prepare('SELECT userId,role FROM yumunio_memberships WHERE organizationId=?').all(workspace.id).map(row=>({...row})),[{userId:firstId,role:'owner'}]);
  const own = await (await f.request('/organization/list',undefined,firstCookie,expected)).json();
  assert.equal(own.length,1);assert.equal(own[0].id,workspace.id);
  assert.deepEqual(await (await f.request('/organization/list',undefined,secondCookie,{'X-Yumunio-Expected-Account':secondId})).json(),[]);
});

test('cross-site requests, oversized bodies and unavailable account operations cannot create accounts', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/sign-up/email', { email: 'blocked@studio.example', password, name: 'Blocked' }, '', { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('/sign-up/email', { email: 'blocked@studio.example', password, name: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.request('/delete-user', {})).status, 404);
  assert.equal(f.database.prepare('SELECT count(*) AS total FROM yumunio_users').get().total, 0);
  assert.equal((await f.request('/config')).headers.get('cache-control'), 'no-store');
});
test('registration rules are rechecked on verification and cannot be bypassed by lookalike domains', async t => {
  const f = await fixture(t, { domainPolicy: createDomainPolicy({ mode: 'allowlist', allowedDomains: ['studio.example'] }) });
  const denied = await f.request('/sign-up/email', { email: 'user@evil-studio.example', password, name: 'Denied' });
  assert.equal(denied.status, 202); // Better Auth intentionally keeps registration responses indistinguishable.
  assert.equal(f.database.prepare('SELECT count(*) AS total FROM yumunio_users').get().total, 0);
  assert.equal(f.mail.length, 0);
  await registerAndVerify(f);
  await f.request('/sign-up/email', { email: 'pending@studio.example', password, name: 'Pending' });
  await f.identity.flushBackgroundTasks();
  const pendingToken = new URL(f.mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');
  const changed = createIdentity({ database: f.database, origin, secret: 'fixture-auth-secret-'.repeat(4), domainPolicy: createDomainPolicy({ blockedDomains: ['studio.example'] }) });
  const refused = await changed.handle(new Request(origin + '/api/auth/verify-email?token=' + encodeURIComponent(pendingToken)));
  assert.equal(refused.status, 403);
  assert.equal(f.database.prepare('SELECT emailVerified FROM yumunio_users WHERE email = ?').get('pending@studio.example').emailVerified, 0);
  assert.throws(() => createIdentity({ database: f.database, origin, secret: 'x'.repeat(64), registrationMode: 'open' }), /email delivery/);
});
test('database-backed login throttling survives a new identity instance and ignores forged peer headers', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await f.request('/sign-in/email', { email: 'unknown@studio.example', password }, '', { 'x-yumunio-peer-ip': '198.51.100.' + attempt })).status, 401);
  assert.equal((await f.request('/sign-in/email', { email: 'unknown@studio.example', password })).status, 429);
  const reopened = createIdentity({ database: f.database, origin, secret: 'fixture-auth-secret-'.repeat(4) });
  const limited = await reopened.handle(new Request(origin + '/api/auth/sign-in/email', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'unknown@studio.example', password }) }), { peerAddress: '127.0.0.1' });
  assert.equal(limited.status, 429);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function promptly(promise) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(2000, undefined, { signal: controller.signal }).then(() => {
      throw new Error('Public account response waited for external mail transport.');
    })]);
  } finally { controller.abort(); }
}

test('mail transport exceptions cannot distinguish existing and nonexistent accounts in public mail requests', async t => {
  const f = await fixture(t, { sendMail: async () => { throw new Error('private relay credential and delivery detail'); } });
  await f.request('/sign-up/email', { email: 'known@studio.example', password, name: 'Known' });
  await f.identity.flushBackgroundTasks();
  const expected = { status: 'request-received' };
  for (const path of ['/sign-up/email', '/send-verification-email', '/request-password-reset']) {
    const knownBody = { email: 'known@studio.example', ...(path === '/sign-up/email' ? { password, name: 'Known' } : {}) };
    const unknownBody = { ...knownBody, email: path === '/sign-up/email' ? 'new@studio.example' : 'nonexistent@studio.example' };
    const known = await f.request(path, knownBody);
    const unknown = await f.request(path, unknownBody);
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), expected);
    assert.deepEqual(await unknown.json(), expected);
  }
  await f.identity.flushBackgroundTasks();
});

test('public reset and resend responses finish while external transport remains blocked and flush waits for it', async t => {
  const release = deferred();
  const started = deferred();
  let blockMail = false;
  let sent = 0;
  t.after(() => release.resolve());
  const f = await fixture(t, { sendMail: async () => {
    if (blockMail) { started.resolve(); await release.promise; }
    sent++;
    return { status: 'accepted' };
  } });
  await f.request('/sign-up/email', { email: 'known@studio.example', password, name: 'Known' });
  await f.identity.flushBackgroundTasks();
  blockMail = true;
  const reset = await promptly(f.request('/request-password-reset', { email: 'known@studio.example' }));
  await started.promise;
  assert.equal(reset.status, 202);
  const resend = await promptly(f.request('/send-verification-email', { email: 'known@studio.example' }));
  assert.equal(resend.status, 202);
  assert.equal(sent, 1, 'Both new submissions remain behind the transport gate.');
  let drained = false;
  const flushing = f.identity.flushBackgroundTasks().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release.resolve();
  await flushing;
  assert.equal(sent, 3);
});

test('the real pending mail promise is registered with the runtime background hook and failure stays private', async t => {
  const release = deferred();
  const jobs = [];
  let active = 0;
  t.after(() => release.resolve());
  const f = await fixture(t, {
    backgroundTask: promise => { jobs.push(promise); },
    sendMail: async () => { active++; await release.promise; throw new Error('private relay failure'); },
  });
  const signup = await promptly(f.request('/sign-up/email', { email: 'known@studio.example', password, name: 'Known' }));
  assert.equal(signup.status, 202);
  assert.ok(jobs.length >= 1);
  assert.ok(jobs.every(job => job instanceof Promise));
  assert.equal(active, 1);
  let completed = false;
  const flushing = f.identity.flushBackgroundTasks().then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  release.resolve();
  await flushing;
  await Promise.all(jobs);
  assert.deepEqual(await signup.json(), { status: 'request-received' });
});

test('bad verification links fail and a reset token changes the password once while revoking prior sessions', async t => {
  const f = await fixture(t);
  const email = await registerAndVerify(f);
  const login = await f.request('/sign-in/email', { email, password });
  const cookie = cookies(login);
  const bad = await f.request('/verify-email?token=invalid-fixture-token&callbackURL=' + encodeURIComponent(origin + '/account.html'));
  assert.equal(bad.status, 400);
  assert.equal((await f.request('/request-password-reset', { email, redirectTo: origin + '/account.html' })).status, 202);
  await f.identity.flushBackgroundTasks();
  const reset = new URL(f.mail.at(-1).text.split('\n').at(-1)).searchParams.get('reset');
  assert.ok(reset);
  const replacement = 'replacement-fixture-password';
  const raced = await Promise.all([f.request('/reset-password', { token: reset, newPassword: replacement }), f.request('/reset-password', { token: reset, newPassword: replacement })]);
  assert.deepEqual(raced.map(result => result.status).sort(), [200, 400]);
  assert.equal(await (await f.request('/get-session', undefined, cookie)).json(), null);
  assert.equal((await f.request('/sign-in/email', { email, password: replacement })).status, 200);
  const stored = f.database.prepare('SELECT * FROM yumunio_auth_verifications').all();
  assert.ok(!JSON.stringify(stored).includes(reset));
});
