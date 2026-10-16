import { DomainError, assertId, assertJsonSerializable, assertPlainObject } from './index.js';
import {validateTeamspaceState,liveTeamspaceMember,pageTeamspace} from './teamspaces.js';
import {validateGroupState,liveGroupIds} from './groups.js';

export const WORKSPACE_ROLES = Object.freeze(['owner', 'admin', 'member', 'guest']);
export const PAGE_PERMISSIONS = Object.freeze(['viewer', 'commenter', 'editor', 'full', 'deny']);
const pageCapabilities = Object.freeze({
  viewer: Object.freeze(['read']),
  commenter: Object.freeze(['read', 'comment', 'suggest']),
  editor: Object.freeze(['read', 'comment', 'suggest', 'editBody', 'editRecordValues', 'createRecord',
    'editCollectionSchema', 'manageViews', 'viewHistory', 'restore']),
  full: Object.freeze(['read', 'comment', 'suggest', 'editBody', 'editRecordValues', 'createRecord',
    'editCollectionSchema', 'manageViews', 'viewHistory', 'restore', 'manage', 'invite']),
});
const stateKeys = ['accounts', 'workspaces', 'memberships', 'pages', 'grants', 'invitations'];
const denied = () => ({ allowed: false, capabilities: [] });
const invalid = (field, message = 'Invalid access policy data.') => {
  throw new DomainError('INVALID_INPUT', message, { field });
};
const key = (workspaceId, id) => workspaceId + '\0' + id;

function record(value, fields, field) {
  assertJsonSerializable(value, field);
  assertPlainObject(value, field);
  if (Object.keys(value).some(name => !fields.includes(name)) || fields.some(name => !Object.hasOwn(value, name))) {
    invalid(field, 'Access policy records require exactly the documented fields.');
  }
  return value;
}
function choice(value, options, field) {
  if (!options.includes(value)) invalid(field);
}
function timestamp(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field, 'Expected a canonical UTC timestamp.');
}
function email(value, field) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^@\s\u0000-\u001f\u007f]+@[^@\s\u0000-\u001f\u007f]+$/.test(value)) invalid(field);
  const domain = value.slice(value.lastIndexOf('@') + 1);
  if (domain.length > 253 || domain !== domain.toLowerCase() || domain.split('.').some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid(field, 'Expected an email with a canonical lowercase ASCII domain.');
}
function digest(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{32,256}$/.test(value)) invalid(field, 'Expected an opaque token digest, never a raw token.');
}
function boolean(value, field) {
  if (typeof value !== 'boolean') invalid(field);
}

/** Verified email belongs to the authentication service; local-part spelling is never rewritten here. */
export function validateAccount(value) {
  const account = record(value, ['id', 'email', 'emailVerified', 'status', 'serverRole'], 'account');
  assertId(account.id, 'account.id');
  email(account.email, 'account.email');
  boolean(account.emailVerified, 'account.emailVerified');
  choice(account.status, ['active', 'suspended'], 'account.status');
  choice(account.serverRole, ['user', 'administrator'], 'account.serverRole');
  return structuredClone(account);
}

export function validateWorkspace(value) {
  const workspace = record(value, ['id', 'status'], 'workspace');
  assertId(workspace.id, 'workspace.id');
  choice(workspace.status, ['active', 'suspended'], 'workspace.status');
  return structuredClone(workspace);
}

/** This validates one role, not ownership counts or concurrent last-owner transitions. */
export function validateMembership(value) {
  const membership = record(value, ['id', 'workspaceId', 'accountId', 'role', 'status'], 'membership');
  for (const field of ['id', 'workspaceId', 'accountId']) assertId(membership[field], 'membership.' + field);
  choice(membership.role, WORKSPACE_ROLES, 'membership.role');
  choice(membership.status, ['active', 'revoked'], 'membership.status');
  return structuredClone(membership);
}

/** An authorization projection of a Page, not a replacement for its content model. */
export function validatePageAccess(value) {
  const page = record(value, ['id', 'workspaceId', 'parentId', 'trashedAt', 'inheritPermissions'], 'page');
  assertId(page.id, 'page.id');
  assertId(page.workspaceId, 'page.workspaceId');
  if (page.parentId !== null) assertId(page.parentId, 'page.parentId');
  timestamp(page.trashedAt, 'page.trashedAt', true);
  boolean(page.inheritPermissions, 'page.inheritPermissions');
  return structuredClone(page);
}

/** Deny blocks every page capability in its scope, including inherited allows. */
export function validatePageGrant(value) {
  const grant = record(value, ['id', 'workspaceId', 'pageId', 'accountId', 'permission', 'includeDescendants', 'status'], 'grant');
  for (const field of ['id', 'workspaceId', 'pageId', 'accountId']) assertId(grant[field], 'grant.' + field);
  choice(grant.permission, PAGE_PERMISSIONS, 'grant.permission');
  boolean(grant.includeDescendants, 'grant.includeDescendants');
  choice(grant.status, ['active', 'revoked'], 'grant.status');
  return structuredClone(grant);
}

/** Invitations persist an assigned scope and token digest, with no password or token plaintext. */
export function validateInvitation(value) {
  const invitation = record(value, ['id', 'workspaceId', 'purpose', 'tokenHash', 'recipientEmail', 'recipientAccountId',
    'issuerAccountId', 'role', 'pageId', 'includeDescendants', 'expiresAt', 'revokedAt', 'acceptedAt'], 'invitation');
  for (const field of ['id', 'workspaceId', 'issuerAccountId']) assertId(invitation[field], 'invitation.' + field);
  if (invitation.recipientAccountId !== null) assertId(invitation.recipientAccountId, 'invitation.recipientAccountId');
  choice(invitation.purpose, ['workspace-member', 'page-guest'], 'invitation.purpose');
  digest(invitation.tokenHash, 'invitation.tokenHash');
  email(invitation.recipientEmail, 'invitation.recipientEmail');
  boolean(invitation.includeDescendants, 'invitation.includeDescendants');
  timestamp(invitation.expiresAt, 'invitation.expiresAt');
  timestamp(invitation.revokedAt, 'invitation.revokedAt', true);
  timestamp(invitation.acceptedAt, 'invitation.acceptedAt', true);
  if (invitation.purpose === 'workspace-member') {
    choice(invitation.role, ['member', 'admin'], 'invitation.role');
    if (invitation.pageId !== null || invitation.includeDescendants) invalid('invitation', 'Workspace invitations cannot assign page grants.');
  } else {
    assertId(invitation.pageId, 'invitation.pageId');
    choice(invitation.role, ['viewer', 'commenter', 'editor', 'full'], 'invitation.role');
  }
  return structuredClone(invitation);
}

/**
 * Validate the current authoritative projection on every decision. No cached role
 * or session claim substitutes for these rows. Cross-resource integrity is also
 * checked by the relevant policy; a broken page ancestry never authorizes access.
 */
export function validateAccessState(value) {
  assertJsonSerializable(value,'state');assertPlainObject(value,'state');
  if(Object.keys(value).some(name=>![...stateKeys,'teamspaces','teamspaceMembers','teamspacePages','personalPageOwners','groups','groupMembers','groupGrants'].includes(name))||stateKeys.some(name=>!Object.hasOwn(value,name)))invalid('state');
  const state = value;
  const validators = [validateAccount, validateWorkspace, validateMembership, validatePageAccess, validatePageGrant, validateInvitation];
  const captured = {};
  for (let index = 0; index < stateKeys.length; index++) {
    const name = stateKeys[index];
    if (!Array.isArray(state[name])) invalid('state.' + name);
    captured[name] = state[name].map(validators[index]);
    const ids = new Set();
    for (const row of captured[name]) {
      const id = name === 'pages' ? key(row.workspaceId, row.id) : row.id;
      if (ids.has(id)) invalid('state.' + name, 'Ambiguous duplicate policy IDs.');
      ids.add(id);
    }
  }
  const memberships = new Set();
  for (const membership of captured.memberships) {
    const id = key(membership.workspaceId, membership.accountId);
    if (memberships.has(id)) invalid('state.memberships', 'Only one current membership may exist per account and workspace.');
    memberships.add(id);
  }
  const digests = new Set();
  for (const invitation of captured.invitations) {
    if (digests.has(invitation.tokenHash)) invalid('state.invitations', 'Invitation digests must be distinct.');
    digests.add(invitation.tokenHash);
  }
  Object.assign(captured,validateTeamspaceState(state,{pages:new Map(captured.pages.map(page=>[key(page.workspaceId,page.id),page]))}));
  Object.assign(captured,validateGroupState(state,{pages:new Map(captured.pages.map(page=>[key(page.workspaceId,page.id),page]))}));
  return captured;
}

function principal(state, accountId, workspaceId) {
  const account = state.accounts.find(row => row.id === accountId);
  const workspace = state.workspaces.find(row => row.id === workspaceId);
  const membership = state.memberships.find(row => row.accountId === accountId && row.workspaceId === workspaceId);
  if (account?.status !== 'active' || !account.emailVerified || workspace?.status !== 'active' || membership?.status !== 'active') return null;
  return { account, workspace, membership };
}

function workspaceDecision(state, accountId, workspaceId) {
  const current = principal(state, accountId, workspaceId);
  if (!current) return denied();
  const capabilities = ['readWorkspace'];
  if (current.membership.role === 'owner' || current.membership.role === 'admin') {
    capabilities.push('manageWorkspace', 'manageMembers', 'manageGuests', 'inviteMember');
    if (current.membership.role === 'owner') capabilities.push('inviteAdmin');
  }
  if (current.membership.role === 'guest') return { allowed: true, capabilities: ['readSharedPages'] };
  return { allowed: true, capabilities };
}

function pageContext(state, accountId, workspaceId, pageId) {
  if (!principal(state, accountId, workspaceId)) return null;
  const pages = new Map(state.pages.filter(row => row.workspaceId === workspaceId).map(row => [row.id, row]));
  const ancestors = [];
  const seen = new Set();
  let cursor = pageId;
  while (cursor !== null) {
    const page = pages.get(cursor);
    if (!page || seen.has(cursor) || page.trashedAt !== null) return null;
    seen.add(cursor);
    ancestors.push(page);
    cursor = page.parentId;
  }
  const inheritedScope = new Set();
  for (const page of ancestors) {
    inheritedScope.add(page.id);
    if (!page.inheritPermissions) break;
  }
  const directGrants = state.grants.filter(row => row.workspaceId === workspaceId && row.accountId === accountId &&
    row.status === 'active' && inheritedScope.has(row.pageId) && (row.pageId === pageId || row.includeDescendants));
  const groupIds=liveGroupIds(state,workspaceId,accountId),grants=[...directGrants,...state.groupGrants.filter(row=>row.workspaceId===workspaceId&&groupIds.has(row.groupId)&&row.status==='active'&&inheritedScope.has(row.pageId)&&(row.pageId===pageId||row.includeDescendants))];
  const teamspace=pageTeamspace(state,workspaceId,pageId),binding=state.teamspacePages.find(row=>row.workspaceId===workspaceId&&inheritedScope.has(row.pageId));
  const member=binding&&liveTeamspaceMember(state,binding.teamspaceId,accountId);
  const permission=member?(member.role==='owner'?'full':teamspace?.defaultPermission):null;
  return { grants,permission,archived:teamspace?.archivedAt!==null&&teamspace!==null };
}

function pageDecision(state, accountId, workspaceId, pageId) {
  const context = pageContext(state, accountId, workspaceId, pageId);
  if (!context || context.grants.some(grant => grant.permission === 'deny')) return denied();
  const capabilities = new Set();
  for (const grant of context.grants) for (const capability of pageCapabilities[grant.permission]) capabilities.add(capability);
  if(context.permission)for(const capability of pageCapabilities[context.permission])capabilities.add(capability);
  if(context.archived)for(const capability of capabilities)if(capability!=='read')capabilities.delete(capability);
  return capabilities.size ? { allowed: true, capabilities: [...capabilities] } : denied();
}

function mayDelegateDescendants(state, accountId, workspaceId, pageId) {
  const context = pageContext(state, accountId, workspaceId, pageId);
  if (!context||(context.permission!=='full'&&!context.grants.some(grant => grant.permission === 'full' && grant.includeDescendants))) return false;
  // A lower explicit deny must not be escaped by inviting someone else over the
  // entire subtree. Include trashed descendants in this check: restoring one
  // must not turn an already accepted invitation into a privilege escalation.
  const untrashed = { ...state, pages: state.pages.map(page => ({ ...page, trashedAt: null })) };
  const pages = new Map(untrashed.pages.filter(page => page.workspaceId === workspaceId).map(page => [page.id, page]));
  for (const page of pages.values()) {
    let cursor = page;
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      if (cursor.id === pageId) {
        if (!pageDecision(untrashed, accountId, workspaceId, page.id).capabilities.includes('invite')) return false;
        break;
      }
      seen.add(cursor.id);
      if (!cursor.inheritPermissions) break;
      cursor = cursor.parentId === null ? null : pages.get(cursor.parentId);
    }
  }
  return true;
}

/**
 * Capture one authoritative policy projection for multiple decisions in a single
 * request. Build a new evaluator after changes or on the next request; this is
 * deliberately not a session or cross-request permission cache. Invalid policy
 * data produces a permanently denied evaluator. Caller mutations cannot alter
 * the captured policy, and each request still receives strict validation.
 */
export function createPageAccessEvaluator(value) {
  let state;
  try { state = validateAccessState(value); } catch { return () => denied(); }
  return request => {
    try {
      record(request, ['accountId', 'workspaceId', 'pageId'], 'request');
      for (const field of ['accountId', 'workspaceId', 'pageId']) assertId(request[field], 'request.' + field);
      return pageDecision(state, request.accountId, request.workspaceId, request.pageId);
    } catch { return denied(); }
  };
}

/** No owner/admin/server-admin page bypass and no anonymous/public access in this policy version. */
export function evaluatePageAccess(state, request) {
  return createPageAccessEvaluator(state)(request);
}

/** Workspace administration never implies permission to read a private page. */
export function evaluateWorkspaceAccess(state, request) {
  try {
    record(request, ['accountId', 'workspaceId'], 'request');
    assertId(request.accountId, 'request.accountId');
    assertId(request.workspaceId, 'request.workspaceId');
    return workspaceDecision(validateAccessState(state), request.accountId, request.workspaceId);
  } catch { return denied(); }
}

/**
 * Pure acceptance plan, not token consumption or a membership transaction.
 * tokenHash must be computed by trusted server code. This digest equality is a
 * policy condition; constant-time crypto verification belongs to the service.
 * The service must recheck current policy and consume/apply the plan atomically.
 * Last-owner protection and initial owner/page-grant creation are separate work.
 */
export function evaluateInvitationAcceptance(state, request) {
  try {
    record(request, ['accountId', 'invitationId', 'purpose', 'tokenHash', 'now'], 'request');
    assertId(request.accountId, 'request.accountId');
    assertId(request.invitationId, 'request.invitationId');
    choice(request.purpose, ['workspace-member', 'page-guest'], 'request.purpose');
    digest(request.tokenHash, 'request.tokenHash');
    timestamp(request.now, 'request.now');
    const current = validateAccessState(state);
    const invitation = current.invitations.find(row => row.id === request.invitationId);
    const account = current.accounts.find(row => row.id === request.accountId);
    if (!invitation || invitation.purpose !== request.purpose || invitation.tokenHash !== request.tokenHash ||
        invitation.revokedAt !== null || invitation.acceptedAt !== null || invitation.expiresAt <= request.now ||
        account?.status !== 'active' || !account.emailVerified || account.email !== invitation.recipientEmail ||
        (invitation.recipientAccountId !== null && invitation.recipientAccountId !== account.id) ||
        current.workspaces.find(row => row.id === invitation.workspaceId)?.status !== 'active') return denied();
    const existing = current.memberships.find(row => row.workspaceId === invitation.workspaceId && row.accountId === account.id);
    let membershipRole;
    let pageGrant = null;
    if (invitation.purpose === 'workspace-member') {
      const issuer = workspaceDecision(current, invitation.issuerAccountId, invitation.workspaceId);
      const capability = invitation.role === 'admin' ? 'inviteAdmin' : 'inviteMember';
      if (!issuer.capabilities.includes(capability)) return denied();
      const ranks = { guest: 0, member: 1, admin: 2, owner: 3 };
      membershipRole = existing?.status === 'active' && ranks[existing.role] >= ranks[invitation.role] ? null : invitation.role;
    } else {
      const issuer = pageDecision(current, invitation.issuerAccountId, invitation.workspaceId, invitation.pageId);
      if (!issuer.capabilities.includes('invite')) return denied();
      if (invitation.includeDescendants && !mayDelegateDescendants(current, invitation.issuerAccountId, invitation.workspaceId, invitation.pageId)) return denied();
      membershipRole = existing?.status === 'active' ? null : 'guest';
      pageGrant = { pageId: invitation.pageId, permission: invitation.role, includeDescendants: invitation.includeDescendants };
    }
    return { allowed: true, capabilities: [], plan: {
      invitationId: invitation.id, accountId: account.id, workspaceId: invitation.workspaceId,
      purpose: invitation.purpose, membershipRole, pageGrant,
    } };
  } catch { return denied(); }
}
