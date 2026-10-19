const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export class WorkspaceSettingsError extends Error {
  constructor(code) { super(code); this.name = 'WorkspaceSettingsError'; this.code = code; }
}
export function settingsLocation(href) {
  const url = new URL(href);
  const values = url.searchParams.getAll('workspace');
  if (values.length !== 1 || !validId(values[0])) throw new WorkspaceSettingsError('INVALID_WORKSPACE');
  return { workspaceId: values[0], section: url.searchParams.get('section') === 'import' ? 'import' : 'overview' };
}
export function importHref(workspaceId, source) {
  if (!validId(workspaceId) || !['notion', 'appflowy'].includes(source)) throw new WorkspaceSettingsError('INVALID_WORKSPACE');
  return '/import?workspace=' + encodeURIComponent(workspaceId) + '&source=' + source;
}
export async function loadWorkspaceSettings({ workspaceId, expectedAccountId = null, request }) {
  if (!validId(workspaceId) || typeof request !== 'function') throw new WorkspaceSettingsError('INVALID_WORKSPACE');
  const config = await request('/api/auth/config');
  if (config?.enabled !== true) throw new WorkspaceSettingsError('ACCOUNTS_DISABLED');
  const session = await request('/api/auth/get-session');
  const user = session?.user;
  if (!user || !validId(user.id)) throw new WorkspaceSettingsError('SIGN_IN');
  if (expectedAccountId !== null && user.id !== expectedAccountId) throw new WorkspaceSettingsError('ACCOUNT_CHANGED');
  if (user.emailVerified !== true) throw new WorkspaceSettingsError('VERIFY_EMAIL');
  if (config.workspaceContent !== true) throw new WorkspaceSettingsError('CONTENT_DISABLED');
  const memberships = await request('/api/auth/organization/list');
  if (!Array.isArray(memberships) || memberships.length > 1000) throw new WorkspaceSettingsError('INVALID_RESPONSE');
  const selected = memberships.filter(item => item && item.id === workspaceId);
  if (selected.length !== 1) throw new WorkspaceSettingsError('WORKSPACE_UNAVAILABLE');
  const workspace = selected[0];
  if (typeof workspace.name !== 'string' || workspace.name.length > 500 || workspace.name.includes('\0')) throw new WorkspaceSettingsError('INVALID_RESPONSE');
  const metadata = await request('/api/content/workspaces/' + encodeURIComponent(workspaceId) + '/pages', { headers: { 'X-Yumunio-Expected-Account': user.id } });
  if (metadata?.workspaceId !== workspaceId || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 ||
      !['owner', 'admin', 'member', 'guest'].includes(metadata.role) || !Array.isArray(metadata.pages) || metadata.pages.length > 1000) throw new WorkspaceSettingsError('INVALID_RESPONSE');
  const current = await request('/api/auth/get-session');
  if (current?.user?.id !== user.id || current.user.emailVerified !== true) throw new WorkspaceSettingsError('ACCOUNT_CHANGED');
  return Object.freeze({ user: Object.freeze({ id: user.id, name: typeof user.name === 'string' ? user.name : '' }),
    workspace: Object.freeze({ id: workspaceId, name: workspace.name }), role: metadata.role,
    canImport: metadata.role !== 'guest', attachmentsEnabled: metadata.attachmentsEnabled === true });
}
