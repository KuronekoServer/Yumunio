import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountContentApi, validateContentPayload } from '../src/content.js';

const origin = 'https://workspace.example';
const workspaceId = 'workspace-a';
const stamp = '2026-10-15T00:00:00.000Z';
const later = '2026-10-15T01:00:00.000Z';
const clone = value => structuredClone(value);
const principal = (accountId, role = 'member', extra = {}) => ({
  id: 'membership-' + accountId, accountId, email: accountId + '@example.invalid', emailVerified: true, role, ...extra,
});
const block = (id = 'block-a', text = 'Independent fixture text') => ({ id, type: 'paragraph', data: { text } });
const page = (id, parentId = null, extra = {}) => ({
  page: { id, workspaceId, title: 'Title ' + id, parentId, createdAt: stamp, updatedAt: stamp, trashedAt: null },
  document: { pageId: id, workspaceId, version: 1, blocks: [block('block-' + id)], updatedAt: stamp },
  inheritPermissions: parentId !== null, ...extra,
});
const emptyPayload = () => ({ schemaVersion: 1, pages: [], grants: [], grantBindings: [] });
function addGrant(payload, pageId, accountId, permission = 'full', includeDescendants = false, membershipId = 'membership-' + accountId) {
  const id = 'grant-' + payload.grants.length;
  payload.grants.push({ id, workspaceId, pageId, accountId, permission, includeDescendants, status: 'active' });
  payload.grantBindings.push({ grantId: id, membershipId });
  return id;
}
const conflict = () => Object.assign(new Error('Private database details must not escape'), { code: 'CONTENT_CONFLICT' });

// This transport fake enforces only CAS/live membership guards, never the policy
// under test. SQL atomicity and real authentication have separate integration tests.
function fixture(options = {}) {
  const payload = options.payload ?? emptyPayload();
  const principals = options.principals ?? [principal('owner', 'owner'), principal('member'), principal('guest', 'guest')];
  const record = { revision: options.revision ?? 0, payload: clone(payload), principals: clone(principals) };
  const calls = { reads: [], writes: [] };
  let beforeWrite = null;
  const store = {
    async read(workspace, actorId) {
      calls.reads.push({ workspace, actorId });
      if (workspace !== workspaceId || !record.principals.some(row => row.accountId === actorId && row.emailVerified)) return null;
      return clone(record);
    },
    async write(workspace, actorId, input) {
      calls.writes.push(clone({ workspace, actorId, ...input }));
      if (beforeWrite) await beforeWrite(record, input);
      const actor = record.principals.find(row => row.accountId === actorId);
      if (workspace !== workspaceId || record.revision !== input.expectedRevision || !actor?.emailVerified ||
          actor.id !== input.actorMembershipId || actor.role !== input.actorRole ||
          input.guardMemberships.some(guard => !record.principals.some(row => row.id === guard.id &&
            row.accountId === guard.accountId && row.role === guard.role && row.emailVerified))) throw conflict();
      record.payload = clone(input.payload);
      record.revision++;
      return { revision: record.revision };
    },
  };
  let sequence = 0;
  const api = createAccountContentApi({ store, origin, now: () => later, createId: () => 'generated-' + ++sequence,
    resolveSession: async request => {
      const accountId = request.headers.get('x-fixture-account');
      return accountId ? { user: { id: accountId, emailVerified: request.headers.get('x-fixture-verified') !== 'false' } } : null;
    },
  });
  const request = (accountId, path = '', method = 'GET', body, extra = {}) => {
    const headers = new Headers({ ...(accountId ? { 'x-fixture-account': accountId } : {}),
      ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...extra.headers });
    const init = { method, headers, ...extra };
    init.headers = headers;
    if (body !== undefined) init.body = JSON.stringify(body);
    return api(new Request(origin + '/api/content/workspaces/' + workspaceId + '/pages' + path, init));
  };
  return { api, request, record, calls, setBeforeWrite: callback => { beforeWrite = callback; } };
}
function sharedFixture() {
  const payload = emptyPayload();
  payload.pages.push(page('root'), page('child', 'root'), page('private'), page('hidden-parent'), page('scoped-child', 'hidden-parent'));
  addGrant(payload, 'root', 'owner', 'full', true);
  addGrant(payload, 'private', 'owner');
  addGrant(payload, 'hidden-parent', 'owner', 'full', true);
  addGrant(payload, 'child', 'member', 'editor');
  addGrant(payload, 'scoped-child', 'member', 'editor');
  addGrant(payload, 'child', 'guest', 'viewer');
  return fixture({ payload, revision: 7 });
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.doesNotMatch(JSON.stringify(body), /Private database|Title private|membership-/);
  return body;
}

test('origin and verified session checks run before storage and a prototype key is not an account session', async () => {
  const f = sharedFixture();
  await error(await f.request('owner', '', 'POST', { expectedRevision: 7, title: 'Page' }, { headers: { Origin: 'https://other.example' } }), 403, 'ORIGIN_REJECTED');
  await error(await f.request('owner', '', 'GET', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'ORIGIN_REJECTED');
  await error(await f.api(new Request('https://other.example/api/content/workspaces/workspace-a/pages')), 403, 'ORIGIN_REJECTED');
  await error(await f.request(null, '', 'GET', undefined, { headers: { Authorization: 'Bearer prototype-key-fixture' } }), 401, 'UNAUTHORIZED');
  await error(await f.request('owner', '', 'GET', undefined, { headers: { 'x-fixture-verified': 'false' } }), 401, 'UNAUTHORIZED');
  assert.equal(f.calls.reads.length, 0);
  assert.equal(f.calls.writes.length, 0);
  const response = await f.request('owner');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('page lists expose only explicitly readable pages and redact hidden ancestors in GET and PATCH', async () => {
  const f = sharedFixture();
  const list = await (await f.request('member')).json();
  assert.deepEqual(list.pages.map(row => row.id), ['child', 'scoped-child']);
  assert.equal(list.pages[0].parentId, null);
  assert.equal(list.pages[1].parentId, null);
  assert.doesNotMatch(JSON.stringify(list), /Title private|hidden-parent|membership-|blocks|grants|principals/);
  const child = await (await f.request('member', '/scoped-child')).json();
  assert.equal(child.page.parentId, null);
  assert.equal(child.document.pageId, 'scoped-child');
  const patched = await f.request('member', '/scoped-child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'Visible new title' });
  assert.equal(patched.status, 200);
  const body = await patched.json();
  assert.equal(body.page.parentId, null);
  assert.equal(f.record.payload.pages.find(row => row.page.id === 'scoped-child').page.parentId, 'hidden-parent');
});

test('workspace owners and admins have no private-page bypass and unknown resources share the denial response', async () => {
  const f = sharedFixture();
  f.record.principals.push(principal('admin', 'admin'));
  assert.deepEqual((await (await f.request('admin')).json()).pages, []);
  const denied = await error(await f.request('member', '/private'), 404, 'CONTENT_NOT_FOUND');
  assert.deepEqual(await (await f.request('member', '/missing')).json(), denied);
  assert.deepEqual(await (await f.request('admin', '/root')).json(), denied);
  assert.deepEqual(await (await f.api(new Request(origin + '/api/content/workspaces/workspace-b/pages/root', { headers: { 'x-fixture-account': 'owner' } }))).json(), denied);
  f.record.payload.grants.find(row => row.pageId === 'private').status = 'revoked';
  await error(await f.request('owner', '/private'), 404, 'CONTENT_NOT_FOUND');
});

test('root and child creation bind creator authority to the trusted current membership', async () => {
  const f = fixture();
  const response = await f.request('member', '', 'POST', { expectedRevision: 0, title: 'New root', blocks: [block()] });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.revision, 1);
  assert.equal(created.page.workspaceId, workspaceId);
  assert.equal(created.page.createdAt, later);
  assert.equal(created.document.version, 1);
  assert.deepEqual(f.record.payload.grants[0], { id: 'generated-2', workspaceId, pageId: 'generated-1',
    accountId: 'member', permission: 'full', includeDescendants: true, status: 'active' });
  assert.deepEqual(f.record.payload.grantBindings, [{ grantId: 'generated-2', membershipId: 'membership-member' }]);
  assert.equal(f.calls.writes[0].actorMembershipId, 'membership-member');
  assert.equal(f.calls.writes[0].actorRole, 'member');
  assert.deepEqual(f.calls.writes[0].guardMemberships, []);
  assert.equal((await f.request('member', '', 'POST', { expectedRevision: 1, title: 'Child', parentId: created.page.id })).status, 201);
  assert.equal(f.record.payload.pages[1].inheritPermissions, true);
  await error(await f.request('guest', '', 'POST', { expectedRevision: 2, title: 'Guest root' }), 404, 'CONTENT_NOT_FOUND');
});

test('child creation requires manage and refuses invisible or cross-workspace parents without writes', async () => {
  const f = sharedFixture();
  for (const parentId of ['child', 'private', 'missing', 'workspace-b-root']) {
    await error(await f.request('member', '', 'POST', { expectedRevision: 7, title: 'Child', parentId }), 404, 'CONTENT_NOT_FOUND');
  }
  assert.equal(f.calls.writes.length, 0);
});

test('view and comment do not permit direct edits; editor changes use both revision and document version', async () => {
  const f = sharedFixture();
  await error(await f.request('guest', '/child', 'PATCH', { expectedRevision: 1, expectedVersion: 1, title: 'Denied' }), 404, 'CONTENT_NOT_FOUND');
  const guestGrant = f.record.payload.grants.find(row => row.accountId === 'guest');
  guestGrant.permission = 'commenter';
  await error(await f.request('guest', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'Denied' }), 404, 'CONTENT_NOT_FOUND');
  await error(await f.request('member', '/child/grants'), 404, 'CONTENT_NOT_FOUND');
  await error(await f.request('member', '/child', 'PATCH', { expectedRevision: 6, expectedVersion: 1, title: 'Stale' }), 409, 'CONTENT_CONFLICT');
  await error(await f.request('member', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 2, title: 'Stale version' }), 409, 'CONTENT_CONFLICT');
  assert.equal(f.calls.writes.length, 0);
  const result = await f.request('member', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'Updated', blocks: [block('changed')] });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.revision, 8);
  assert.equal(body.document.version, 2);
  assert.equal(body.page.updatedAt, later);
  assert.equal(f.record.payload.pages.find(row => row.page.id === 'private').page.title, 'Title private');
});

test('clients cannot replace the aggregate, move pages, inject authorization fields or supply invalid grant scopes', async () => {
  const f = sharedFixture();
  await error(await f.request('owner', '', 'PUT', f.record.payload), 405, 'METHOD_NOT_ALLOWED');
  const mutations = [
    ['', { expectedRevision: 7, title: 'Injected', pages: [] }],
    ['', { expectedRevision: 7, title: 'Injected', actorRole: 'owner' }],
    ['', { expectedRevision: 7, title: 'Injected', workspaceId: 'workspace-b' }],
    ['/root', { expectedRevision: 7, expectedVersion: 1, title: 'Injected', parentId: 'private' }],
    ['/root', { expectedRevision: 7, expectedVersion: 1, blocks: [], grants: [] }],
    ['/root/grants', { expectedRevision: 7, accountId: 'guest', permission: 'full', includeDescendants: 'all' }],
    ['/root/grants', { expectedRevision: 7, accountId: 'guest', permission: 'full', actorMembershipId: 'membership-owner' }],
  ];
  for (const [path, data] of mutations) await error(await f.request('owner', path, path === '/root' ? 'PATCH' : 'POST', data), 400, 'INVALID_CONTENT');
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.record.revision, 7);
});

test('page-only sharing permits an existing verified guest and guards actor and recipient memberships', async () => {
  const f = sharedFixture();
  const response = await f.request('owner', '/root/grants', 'POST', { expectedRevision: 7, accountId: 'guest', permission: 'editor' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.grant.includeDescendants, false);
  assert.equal(body.grant.accountId, 'guest');
  assert.deepEqual(f.calls.writes[0].guardMemberships, [{ id: 'membership-guest', accountId: 'guest', role: 'guest' }]);
  assert.equal(f.calls.writes[0].actorId, 'owner');
  assert.equal(f.calls.writes[0].actorMembershipId, 'membership-owner');
  assert.equal(f.calls.writes[0].actorRole, 'owner');
  assert.deepEqual(f.record.payload.grantBindings.at(-1), { grantId: body.grant.id, membershipId: 'membership-guest' });
  // Remove the pre-existing child grant to isolate the scope of the new root grant.
  f.record.payload.grants.find(row => row.pageId === 'child' && row.accountId === 'guest').status = 'revoked';
  assert.equal((await f.request('guest', '/root')).status, 200);
  await error(await f.request('guest', '/child'), 404, 'CONTENT_NOT_FOUND');
  f.record.principals.push(principal('unverified', 'member', { emailVerified: false }));
  for (const accountId of ['unverified', 'outside-workspace']) {
    await error(await f.request('owner', '/root/grants', 'POST', { expectedRevision: 8, accountId, permission: 'viewer' }), 404, 'CONTENT_NOT_FOUND');
  }
  assert.equal(f.calls.writes.length, 1);
});

test('sharing replaces a recipient grant, revocation takes effect immediately and the last manager cannot be removed', async () => {
  const f = sharedFixture();
  const granted = await (await f.request('owner', '/root/grants', 'POST', { expectedRevision: 7, accountId: 'guest', permission: 'full' })).json();
  assert.equal((await f.request('guest', '/root/grants')).status, 200);
  const replaced = await (await f.request('owner', '/root/grants', 'POST', { expectedRevision: 8, accountId: 'guest', permission: 'viewer' })).json();
  assert.equal(f.record.payload.grants.find(row => row.id === granted.grant.id).status, 'revoked');
  assert.equal(f.record.payload.grants.filter(row => row.accountId === 'guest' && row.pageId === 'root' && row.status === 'active').length, 1);
  assert.equal((await f.request('owner', '/root/grants/' + replaced.grant.id, 'DELETE', { expectedRevision: 9 })).status, 200);
  await error(await f.request('guest', '/root'), 404, 'CONTENT_NOT_FOUND');
  const ownerGrant = f.record.payload.grants.find(row => row.pageId === 'root' && row.accountId === 'owner');
  await error(await f.request('owner', '/root/grants/' + ownerGrant.id, 'DELETE', { expectedRevision: 10 }), 409, 'LAST_PAGE_MANAGER');
  await error(await f.request('owner', '/root/grants', 'POST', { expectedRevision: 10, accountId: 'owner', permission: 'deny' }), 409, 'LAST_PAGE_MANAGER');
  assert.equal(f.record.payload.grants.find(row => row.id === ownerGrant.id).status, 'active');
  assert.equal(f.calls.writes.length, 3);
});

test('removed and re-created membership identities do not reactivate old grants', async () => {
  const f = sharedFixture();
  const oldMember = f.record.principals.find(row => row.accountId === 'member');
  oldMember.id = 'membership-member-new-generation';
  assert.deepEqual((await (await f.request('member')).json()).pages, []);
  await error(await f.request('member', '/child'), 404, 'CONTENT_NOT_FOUND');
  assert.equal((await f.request('owner', '/root/grants', 'POST', { expectedRevision: 7, accountId: 'member', permission: 'viewer' })).status, 200);
  assert.deepEqual(f.record.payload.grantBindings.at(-1), { grantId: 'generated-1', membershipId: 'membership-member-new-generation' });
  assert.equal((await f.request('member', '/root')).status, 200);
  await error(await f.request('member', '/child'), 404, 'CONTENT_NOT_FOUND');
});

test('a concurrent grant revocation prevents stale editing and returns a uniform not-found instead of a revision', async () => {
  const f = sharedFixture();
  f.setBeforeWrite(record => {
    record.payload.grants.find(row => row.pageId === 'child' && row.accountId === 'member').status = 'revoked';
    record.revision++;
  });
  await error(await f.request('member', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'Must not commit' }), 404, 'CONTENT_NOT_FOUND');
  assert.equal(f.record.payload.pages.find(row => row.page.id === 'child').page.title, 'Title child');
  assert.equal(f.record.revision, 8);
  assert.equal(f.calls.reads.length, 2);
});

test('a competing authorized write preserves its content and reports a conflict without retrying an old edit', async () => {
  const f = sharedFixture();
  f.setBeforeWrite(record => {
    const item = record.payload.pages.find(row => row.page.id === 'child');
    item.page.title = 'Concurrent winner';
    item.document.version = 2;
    record.revision++;
  });
  await error(await f.request('member', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'Loser' }), 409, 'CONTENT_CONFLICT');
  assert.equal(f.record.payload.pages.find(row => row.page.id === 'child').page.title, 'Concurrent winner');
  assert.equal(f.calls.writes.length, 1);
});

test('live actor and sharing-target membership guards stop removal, generation changes and lost verification races', async () => {
  for (const change of [
    record => { record.principals = record.principals.filter(row => row.accountId !== 'member'); },
    record => { record.principals.find(row => row.accountId === 'member').id = 'replacement-member'; },
    record => { record.principals.find(row => row.accountId === 'member').emailVerified = false; },
  ]) {
    const f = sharedFixture();
    f.setBeforeWrite(change);
    await error(await f.request('member', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'Denied race' }), 404, 'CONTENT_NOT_FOUND');
    assert.equal(f.record.revision, 7);
  }
  const f = sharedFixture();
  f.setBeforeWrite(record => { record.principals.find(row => row.accountId === 'guest').id = 'replacement-guest'; });
  await error(await f.request('owner', '/root/grants', 'POST', { expectedRevision: 7, accountId: 'guest', permission: 'full' }), 404, 'CONTENT_NOT_FOUND');
  assert.equal(f.record.revision, 7);
  assert.equal(f.record.payload.grants.some(row => row.id === 'generated-1'), false);
});

test('payload validation rejects ambiguous scopes, hierarchy corruption, binding corruption and oversized content, returning an independent capture', () => {
  const f = sharedFixture();
  const original = f.record.payload;
  const captured = validateContentPayload(original, workspaceId);
  original.pages[0].page.title = 'Changed after validation';
  assert.equal(captured.pages[0].page.title, 'Title root');
  const corruptions = [
    value => { value.pages[0].page.workspaceId = 'workspace-b'; },
    value => { value.pages[0].document.pageId = 'other'; },
    value => { value.pages.push(clone(value.pages[0])); },
    value => { value.pages[0].page.parentId = 'child'; },
    value => { value.pages[0].page.parentId = 'missing'; },
    value => { value.grants[0].workspaceId = 'workspace-b'; },
    value => { value.grantBindings.pop(); },
    value => { value.grantBindings[1] = clone(value.grantBindings[0]); },
    value => { value.grantBindings[0].grantId = 'missing'; },
    value => { value.grants[0].unknownCapability = true; },
    value => { value.sessionToken = 'not-a-content-field'; },
  ];
  for (const corrupt of corruptions) {
    const value = clone(captured); corrupt(value);
    assert.throws(() => validateContentPayload(value, workspaceId));
  }
  const huge = clone(captured);
  huge.pages[0].document.blocks[0].data.text = 'x'.repeat(8000000);
  assert.throws(() => validateContentPayload(huge, workspaceId), cause => cause.code === 'CONTENT_TOO_LARGE');
});

test('JSON parsing and byte limits reject malformed or oversized bodies and storage failures stay sanitized', async () => {
  const f = sharedFixture();
  const path = origin + '/api/content/workspaces/' + workspaceId + '/pages/child';
  const headers = { Origin: origin, 'x-fixture-account': 'member', 'Content-Type': 'application/json' };
  await error(await f.api(new Request(path, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })), 415, 'CONTENT_TYPE');
  for (const body of ['{', new Uint8Array([0xff])]) {
    await error(await f.api(new Request(path, { method: 'PATCH', headers, body })), 400, 'INVALID_CONTENT');
  }
  await error(await f.api(new Request(path, { method: 'PATCH', headers: { ...headers, 'Content-Length': '256001' }, body: '{}' })), 413, 'CONTENT_TOO_LARGE');
  let cancelled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(150000)); controller.enqueue(new Uint8Array(150000));
  }, cancel() { cancelled = true; } });
  await error(await f.api(new Request(path, { method: 'PATCH', headers: { ...headers, 'Content-Length': '1' }, body, duplex: 'half' })), 413, 'CONTENT_TOO_LARGE');
  assert.equal(cancelled, true);
  assert.equal(f.calls.writes.length, 0);
  f.setBeforeWrite(() => { throw new Error('mysql://private-user:secret@database/internal-page'); });
  const unavailable = await error(await f.request('member', '/child', 'PATCH', { expectedRevision: 7, expectedVersion: 1, title: 'No leak' }), 503, 'CONTENT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailable), /mysql|private-user|secret|internal-page/);
  assert.equal(f.record.revision, 7);
});

test('corrupt persisted or fresh conflict payloads are service failures and stale membership grants are not listed', async () => {
  for (const corrupt of [
    record => { record.payload = null; },
    record => { record.payload.grantBindings = []; },
    record => { record.payload.pages[0].page.workspaceId = 'other-workspace'; },
  ]) {
    const f = sharedFixture(); corrupt(f.record);
    await error(await f.request('owner'), 503, 'CONTENT_UNAVAILABLE');
    assert.equal(f.calls.writes.length, 0);
  }
  const initial = fixture();
  initial.record.payload = null;
  assert.equal((await initial.request('owner', '', 'POST', { expectedRevision: 0, title: 'First page' })).status, 201);
  const fresh = sharedFixture();
  fresh.setBeforeWrite(record => { record.revision++; record.payload.grantBindings = []; });
  await error(await fresh.request('member', '/child', 'PATCH',
    { expectedRevision: 7, expectedVersion: 1, title: 'No commit' }), 503, 'CONTENT_UNAVAILABLE');
  const f = sharedFixture();
  f.record.principals.find(row => row.accountId === 'member').id = 'new-membership-generation';
  const grants = await (await f.request('owner', '/child/grants')).json();
  assert.deepEqual(grants.grants.map(row => row.accountId), ['guest']);
});
