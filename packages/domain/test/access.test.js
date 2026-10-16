import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/index.js';
import {
  validateAccount, validateWorkspace, validateMembership, validatePageAccess, validatePageGrant,
  validateInvitation, validateAccessState, createPageAccessEvaluator, evaluatePageAccess, evaluateWorkspaceAccess, evaluateInvitationAcceptance,
} from '../src/access.js';

const now = '2026-10-15T03:00:00.000Z';
const later = '2026-10-16T03:00:00.000Z';
const tokenHash = 'a'.repeat(64);
const account = (id, extra = {}) => ({ id, email: id + '@example.invalid', emailVerified: true, status: 'active', serverRole: 'user', ...extra });
const membership = (accountId, role, extra = {}) => ({ id: 'membership-' + accountId, workspaceId: 'workspace', accountId, role, status: 'active', ...extra });
const page = (id, parentId = null, extra = {}) => ({ id, workspaceId: 'workspace', parentId, trashedAt: null, inheritPermissions: true, ...extra });
const grant = (id, accountId, pageId, permission = 'full', extra = {}) => ({ id, workspaceId: 'workspace', pageId, accountId, permission, includeDescendants: true, status: 'active', ...extra });
const invitation = (extra = {}) => ({ id: 'invitation', workspaceId: 'workspace', purpose: 'page-guest', tokenHash,
  recipientEmail: 'recipient@example.invalid', recipientAccountId: 'recipient', issuerAccountId: 'owner',
  role: 'commenter', pageId: 'root', includeDescendants: true, expiresAt: later, revokedAt: null, acceptedAt: null, ...extra });
function fixture() {
  return {
    accounts: [account('owner'), account('admin'), account('member'), account('guest'), account('recipient'), account('serveradmin', { serverRole: 'administrator' })],
    workspaces: [{ id: 'workspace', status: 'active' }, { id: 'other-workspace', status: 'active' }],
    memberships: [membership('owner', 'owner'), membership('admin', 'admin'), membership('member', 'member'), membership('guest', 'guest')],
    pages: [page('root'), page('child', 'root'), page('private', 'root', { inheritPermissions: false }), page('sibling'),
      page('root', null, { workspaceId: 'other-workspace' })],
    grants: [grant('owner-root', 'owner', 'root')],
    invitations: [invitation()],
  };
}
const access = (state, accountId, pageId = 'child', workspaceId = 'workspace') => evaluatePageAccess(state, { accountId, workspaceId, pageId });
const accept = (state, extra = {}) => evaluateInvitationAcceptance(state, { accountId: 'recipient', invitationId: 'invitation', purpose: 'page-guest', tokenHash, now, ...extra });
const noAccess = { allowed: false, capabilities: [] };
const invalid = error => error instanceof DomainError && error.code === 'INVALID_INPUT';

test('validators capture strict JSON models and never retain token plaintext or invoke getters', () => {
  const input = account('member');
  const captured = validateAccount(input);
  input.email = 'changed@example.invalid';
  assert.equal(captured.email, 'member@example.invalid');
  for (const [validator, value] of [
    [validateAccount, account('member', { password: 'plaintext' })],
    [validateAccount, account('member', { serverRole: 'owner' })],
    [validateAccount, account('member', { email: 'member@EXAMPLE.INVALID' })],
    [validateWorkspace, { id: 'workspace', status: 'deleted' }],
    [validateMembership, membership('member', 'server-admin')],
    [validatePageAccess, page('invalid/id')],
    [validatePageGrant, grant('grant', 'guest', 'root', 'owner')],
    [validateInvitation, invitation({ token: 'raw-token' })],
    [validateInvitation, invitation({ role: 'owner' })],
  ]) assert.throws(() => validator(value), invalid);
  let invoked = false;
  const getter = Object.defineProperty(account('member'), 'email', { enumerable: true, get() { invoked = true; return 'other@example.invalid'; } });
  assert.throws(() => validateAccount(getter), invalid);
  assert.equal(invoked, false);
  assert.doesNotThrow(() => validateInvitation(invitation({ recipientAccountId: null })));
});

test('workspace roles and server administration never imply private page access', () => {
  const state = fixture();
  state.grants = [];
  for (const id of ['owner', 'admin', 'member', 'guest', 'serveradmin']) assert.deepEqual(access(state, id), noAccess);
  const owner = evaluateWorkspaceAccess(state, { accountId: 'owner', workspaceId: 'workspace' });
  const admin = evaluateWorkspaceAccess(state, { accountId: 'admin', workspaceId: 'workspace' });
  assert.ok(owner.capabilities.includes('inviteAdmin'));
  assert.ok(admin.capabilities.includes('inviteMember'));
  assert.ok(!admin.capabilities.includes('inviteAdmin'));
  assert.deepEqual(evaluateWorkspaceAccess(state, { accountId: 'serveradmin', workspaceId: 'workspace' }), noAccess);
  assert.deepEqual(evaluateWorkspaceAccess(state, { accountId: 'guest', workspaceId: 'workspace' }), { allowed: true, capabilities: ['readSharedPages'] });
});

test('page roles expose capabilities and commenter suggestions remain distinct from direct editing', () => {
  for (const permission of ['viewer', 'commenter', 'editor', 'full']) {
    const state = fixture();
    state.grants.push(grant('guest-role', 'guest', 'child', permission));
    const result = access(state, 'guest');
    assert.equal(result.allowed, true);
    assert.ok(result.capabilities.includes('read'));
    assert.equal(result.capabilities.includes('suggest'), permission !== 'viewer');
    assert.equal(result.capabilities.includes('editBody'), ['editor', 'full'].includes(permission));
    assert.equal(result.capabilities.includes('invite'), permission === 'full');
  }
});

test('guest grants are page scoped, inherit only within their path, and never expose ancestors or siblings', () => {
  const state = fixture();
  state.grants.push(grant('guest-child', 'guest', 'child', 'editor'));
  assert.equal(access(state, 'guest', 'child').allowed, true);
  for (const id of ['root', 'sibling', 'private']) assert.deepEqual(access(state, 'guest', id), noAccess);
  state.pages.push(page('grandchild', 'child'));
  assert.equal(access(state, 'guest', 'grandchild').allowed, true);
  state.grants.find(row => row.id === 'guest-child').includeDescendants = false;
  assert.deepEqual(access(state, 'guest', 'grandchild'), noAccess);
  state.grants.push(grant('guest-root', 'guest', 'root', 'viewer'));
  assert.equal(access(state, 'guest', 'child').capabilities.includes('editBody'), true);
  assert.deepEqual(access(state, 'guest', 'private'), noAccess);
});

test('any applicable deny wins over broad or direct allows but respects its descendant scope', () => {
  const state = fixture();
  state.grants.push(grant('guest-root', 'guest', 'root'), grant('deny-child', 'guest', 'child', 'deny'), grant('guest-child', 'guest', 'child'));
  assert.deepEqual(access(state, 'guest'), noAccess);
  assert.equal(access(state, 'guest', 'root').allowed, true);
  state.pages.push(page('grandchild', 'child'));
  assert.deepEqual(access(state, 'guest', 'grandchild'), noAccess);
  state.grants.find(row => row.id === 'deny-child').includeDescendants = false;
  assert.equal(access(state, 'guest', 'grandchild').allowed, true);
  state.grants.find(row => row.id === 'deny-child').status = 'revoked';
  assert.equal(access(state, 'guest').allowed, true);
});

test('every decision rereads account, membership, workspace, and grant revocations', () => {
  const state = fixture();
  state.grants.push(grant('guest-root', 'guest', 'root'));
  assert.equal(access(state, 'guest').allowed, true);
  const membership = state.memberships.find(row => row.accountId === 'guest');
  membership.status = 'revoked';
  assert.deepEqual(access(state, 'guest'), noAccess);
  membership.status = 'active';
  state.accounts.find(row => row.id === 'guest').status = 'suspended';
  assert.deepEqual(access(state, 'guest'), noAccess);
  state.accounts.find(row => row.id === 'guest').status = 'active';
  state.accounts.find(row => row.id === 'guest').emailVerified = false;
  assert.deepEqual(access(state, 'guest'), noAccess);
  state.accounts.find(row => row.id === 'guest').emailVerified = true;
  state.workspaces[0].status = 'suspended';
  assert.deepEqual(access(state, 'guest'), noAccess);
  state.workspaces[0].status = 'active';
  state.grants.find(row => row.id === 'guest-root').status = 'revoked';
  assert.deepEqual(access(state, 'guest'), noAccess);
});

test('trash ancestry, private boundaries, missing parents, and cycles fail closed', () => {
  for (const mutate of [
    state => { state.pages.find(row => row.id === 'child').trashedAt = now; },
    state => { state.pages.find(row => row.id === 'root').trashedAt = now; },
    state => { state.pages.find(row => row.id === 'child').parentId = 'missing'; },
    state => { state.pages.find(row => row.id === 'root').parentId = 'child'; },
    state => { state.pages.find(row => row.id === 'child').parentId = 'child'; },
  ]) {
    const state = fixture();
    state.grants.push(grant('guest-child', 'guest', 'child'));
    state.pages.find(row => row.id === 'child').inheritPermissions = false;
    mutate(state);
    assert.deepEqual(access(state, 'guest'), noAccess);
  }
});

test('scoped IDs cannot resolve memberships, parent pages, or grants from another workspace', () => {
  const state = fixture();
  state.grants.push(grant('foreign', 'guest', 'child', 'full', { workspaceId: 'other-workspace' }));
  assert.deepEqual(access(state, 'guest'), noAccess);
  assert.deepEqual(access(state, 'owner', 'root', 'other-workspace'), noAccess);
  state.pages.find(row => row.id === 'child').parentId = 'foreign-parent';
  state.pages.push(page('foreign-parent', null, { workspaceId: 'other-workspace' }));
  state.grants.push(grant('local-child', 'guest', 'child'));
  assert.deepEqual(access(state, 'guest'), noAccess);
});

test('invalid and hidden resources return the same minimal denial without existence information', () => {
  const state = fixture();
  for (const request of [
    { accountId: 'guest', workspaceId: 'workspace', pageId: 'root' },
    { accountId: 'guest', workspaceId: 'workspace', pageId: 'missing' },
    { accountId: 'guest', workspaceId: 'missing', pageId: 'root' },
    { accountId: 'missing', workspaceId: 'workspace', pageId: 'root' },
    { accountId: 'guest', workspaceId: 'workspace', pageId: '../root' },
    { accountId: 'guest', workspaceId: 'workspace', pageId: 'root', role: 'owner' },
  ]) assert.deepEqual(evaluatePageAccess(state, request), noAccess);
  state.memberships.push(membership('guest', 'owner', { id: 'duplicate-current-membership' }));
  assert.throws(() => validateAccessState(state), invalid);
  assert.deepEqual(access(state, 'owner'), noAccess);
});

test('page invitation acceptance binds verified account ID and exact email and produces only assigned guest scope', () => {
  const state = fixture();
  const original = structuredClone(state);
  const result = accept(state);
  assert.deepEqual(result, { allowed: true, capabilities: [], plan: {
    invitationId: 'invitation', accountId: 'recipient', workspaceId: 'workspace', purpose: 'page-guest', membershipRole: 'guest',
    pageGrant: { pageId: 'root', permission: 'commenter', includeDescendants: true },
  } });
  assert.deepEqual(state, original);
  assert.equal(access(state, 'recipient', 'root').allowed, false, 'A plan does not mutate grants or memberships.');
  for (const mutate of [
    state => { state.accounts.find(row => row.id === 'recipient').emailVerified = false; },
    state => { state.accounts.find(row => row.id === 'recipient').status = 'suspended'; },
    state => { state.accounts.find(row => row.id === 'recipient').email = 'different@example.invalid'; },
    state => { state.invitations[0].recipientAccountId = 'guest'; },
  ]) {
    const changed = fixture(); mutate(changed); assert.deepEqual(accept(changed), noAccess);
  }
  state.invitations[0].recipientAccountId = null;
  assert.equal(accept(state).allowed, true, 'A previously unregistered recipient is bound by verified email and the resulting account ID.');
});

test('purpose, digest, expiry boundary, revocation, and consumed state cannot be bypassed', () => {
  const state = fixture();
  for (const request of [
    { purpose: 'workspace-member' }, { tokenHash: 'b'.repeat(64) }, { now: later },
    { now: '2026-10-17T03:00:00.000Z' }, { accountId: 'guest' }, { invitationId: 'missing' }, { role: 'admin' },
  ]) assert.deepEqual(accept(state, request), noAccess);
  for (const field of ['revokedAt', 'acceptedAt']) {
    const changed = fixture(); changed.invitations[0][field] = now; assert.deepEqual(accept(changed), noAccess);
  }
  state.invitations[0].expiresAt = '2026-02-30T00:00:00.000Z';
  assert.deepEqual(accept(state), noAccess);
});

test('guest full control can invite within its page scope without becoming a workspace manager', () => {
  const state = fixture();
  state.grants.push(grant('guest-child', 'guest', 'child'));
  state.invitations[0] = invitation({ issuerAccountId: 'guest', pageId: 'child', role: 'full' });
  assert.equal(accept(state).allowed, true);
  assert.equal(accept(state).plan.membershipRole, 'guest');
  assert.ok(!evaluateWorkspaceAccess(state, { accountId: 'guest', workspaceId: 'workspace' }).capabilities.includes('manageMembers'));
  state.invitations[0].pageId = 'root';
  assert.deepEqual(accept(state), noAccess);
});

test('page-only full control cannot be escalated into descendant sharing', () => {
  const state = fixture();
  state.grants.push(grant('guest-child', 'guest', 'child', 'full', { includeDescendants: false }));
  state.invitations[0] = invitation({ issuerAccountId: 'guest', pageId: 'child', role: 'full' });
  assert.deepEqual(accept(state), noAccess);
  state.invitations[0].includeDescendants = false;
  assert.equal(accept(state).allowed, true);
  state.grants.find(row => row.id === 'guest-child').permission = 'editor';
  assert.deepEqual(accept(state), noAccess);
});

test('subtree invitations cannot delegate through an issuer deny, including currently trashed descendants', () => {
  const state = fixture();
  state.grants.push(grant('owner-denied-child', 'owner', 'child', 'deny'));
  assert.deepEqual(accept(state), noAccess);
  state.pages.find(row => row.id === 'child').trashedAt = now;
  assert.deepEqual(accept(state), noAccess);
  state.invitations[0].includeDescendants = false;
  assert.equal(accept(state).allowed, true);
  state.invitations[0].includeDescendants = true;
  state.pages.find(row => row.id === 'child').inheritPermissions = false;
  assert.equal(accept(state).allowed, true, 'A child that also blocks the proposed inherited grant is outside the delegated scope.');
});

test('revoking or suspending the issuer invalidates an unaccepted invitation immediately', () => {
  for (const mutate of [
    state => { state.grants[0].status = 'revoked'; },
    state => { state.memberships.find(row => row.accountId === 'owner').status = 'revoked'; },
    state => { state.accounts.find(row => row.id === 'owner').status = 'suspended'; },
    state => { state.invitations[0].workspaceId = 'other-workspace'; },
    state => { state.workspaces[0].status = 'suspended'; },
  ]) {
    const state = fixture(); mutate(state); assert.deepEqual(accept(state), noAccess);
  }
});

test('workspace invitations are distinct, cannot assign owner, and restrict admin escalation to an owner issuer', () => {
  const state = fixture();
  state.invitations[0] = invitation({ purpose: 'workspace-member', pageId: null, role: 'member', includeDescendants: false, issuerAccountId: 'admin' });
  const request = { purpose: 'workspace-member' };
  assert.equal(accept(state, request).plan.membershipRole, 'member');
  assert.equal(accept(state, request).plan.pageGrant, null);
  state.invitations[0].role = 'admin';
  assert.deepEqual(accept(state, request), noAccess);
  state.invitations[0].issuerAccountId = 'owner';
  assert.equal(accept(state, request).plan.membershipRole, 'admin');
  state.invitations[0].role = 'owner';
  assert.deepEqual(accept(state, request), noAccess);
  state.invitations[0].role = 'member';
  state.invitations[0].pageId = 'root';
  assert.deepEqual(accept(state, request), noAccess);
});

test('acceptance never downgrades existing roles or converts a page guest invitation to member authority', () => {
  const state = fixture();
  state.memberships.push(membership('recipient', 'admin'));
  assert.equal(accept(state).plan.membershipRole, null);
  state.invitations[0] = invitation({ purpose: 'workspace-member', pageId: null, role: 'member', includeDescendants: false });
  assert.equal(accept(state, { purpose: 'workspace-member' }).plan.membershipRole, null);
  state.memberships.find(row => row.accountId === 'recipient').role = 'guest';
  assert.equal(accept(state, { purpose: 'workspace-member' }).plan.membershipRole, 'member');
});

test('recipient denies remain effective after applying an acceptance plan and no unrelated page becomes readable', () => {
  const state = fixture();
  state.grants.push(grant('recipient-deny', 'recipient', 'child', 'deny'));
  const { plan } = accept(state);
  state.memberships.push(membership('recipient', plan.membershipRole));
  state.grants.push(grant('accepted-grant', 'recipient', plan.pageGrant.pageId, plan.pageGrant.permission, { includeDescendants: plan.pageGrant.includeDescendants }));
  assert.equal(access(state, 'recipient', 'root').allowed, true);
  assert.deepEqual(access(state, 'recipient', 'child'), noAccess);
  assert.deepEqual(access(state, 'recipient', 'sibling'), noAccess);
  assert.deepEqual(access(state, 'recipient', 'private'), noAccess);
});

test('a request-scoped evaluator captures policy once and isolates both input and result mutations', () => {
  const state = fixture();
  state.grants.push(grant('guest-root', 'guest', 'root', 'editor'));
  const evaluate = createPageAccessEvaluator(state);
  const request = { accountId: 'guest', workspaceId: 'workspace', pageId: 'child' };
  const first = evaluate(request);
  assert.ok(first.capabilities.includes('editBody'));
  first.capabilities.length = 0;
  first.allowed = false;
  assert.ok(evaluate(request).capabilities.includes('editBody'));
  state.grants.find(row => row.id === 'guest-root').status = 'revoked';
  state.accounts.find(row => row.id === 'guest').status = 'suspended';
  state.pages.find(row => row.id === 'root').trashedAt = now;
  assert.ok(evaluate(request).capabilities.includes('editBody'), 'The existing capture is confined to its original request.');
  assert.deepEqual(createPageAccessEvaluator(state)(request), noAccess, 'The next request must create a fresh evaluator.');
});

test('captured evaluation preserves inheritance, deny, trash and workspace boundaries', () => {
  const state = fixture();
  state.grants.push(grant('guest-root', 'guest', 'root', 'editor'), grant('guest-deny', 'guest', 'child', 'deny'));
  state.pages.push(page('grandchild', 'child'), page('trashed', 'root', { trashedAt: now }));
  const evaluate = createPageAccessEvaluator(state);
  const read = (pageId, workspaceId = 'workspace') => evaluate({ accountId: 'guest', workspaceId, pageId });
  assert.ok(read('root').capabilities.includes('editBody'));
  for (const id of ['child', 'grandchild', 'private', 'trashed', 'missing']) assert.deepEqual(read(id), noAccess);
  assert.deepEqual(read('root', 'other-workspace'), noAccess);
  assert.deepEqual(evaluate({ accountId: 'admin', workspaceId: 'workspace', pageId: 'root' }), noAccess);
});

test('captured evaluator validates each request and fails permanently closed on invalid captures', () => {
  const state = fixture();
  const evaluate = createPageAccessEvaluator(state);
  for (const request of [
    null, [], { accountId: 'owner', workspaceId: 'workspace' },
    { accountId: 'owner', workspaceId: 'workspace', pageId: '../root' },
    { accountId: 'owner', workspaceId: 'workspace', pageId: 'root', role: 'owner' },
  ]) assert.deepEqual(evaluate(request), noAccess);
  let invoked = false;
  const getter = Object.defineProperty({ accountId: 'owner', workspaceId: 'workspace' }, 'pageId',
    { enumerable: true, get() { invoked = true; return 'root'; } });
  assert.deepEqual(evaluate(getter), noAccess);
  assert.equal(invoked, false);
  state.memberships.push(membership('owner', 'owner', { id: 'duplicate-membership' }));
  const invalidCapture = createPageAccessEvaluator(state);
  state.memberships.pop();
  const request = { accountId: 'owner', workspaceId: 'workspace', pageId: 'root' };
  assert.deepEqual(invalidCapture(request), noAccess);
  assert.equal(createPageAccessEvaluator(state)(request).allowed, true);
  assert.deepEqual(createPageAccessEvaluator(null)(request), noAccess);
});
