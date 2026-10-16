import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {createI18n,loadCatalogs,applyLocaleDocument} from './i18n.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors } from './preferences.js';
import { loadInstanceConfig, createInstanceBrand, applyInstanceDefaults } from './instance.js';
const app = document.querySelector('#history-app'), query = new URL(location.href).searchParams;
const workspaceId = query.get('workspace'), pageId = query.get('page');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const route = '/api/content/workspaces/' + encodeURIComponent(workspaceId) + '/pages/' + encodeURIComponent(pageId);
const state = { user: null, current: null, versions: [], snapshot: null, revision: null, busy: false, locked: false, message: '', consent: false };
let catalog, preferences, brand, i18n;
const t = key => i18n?.t(key) ?? key;
function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['disabled', 'checked'].includes(key)) element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
function button(key, handler, disabled = false) { return node('button', { type: 'button', disabled: state.busy || disabled, onClick: handler }, t(key)); }
async function request(path, { method = 'GET', body, accountId = state.user?.id } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { ...(accountId ? { 'X-Yumunio-Expected-Account': accountId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error('HISTORY_REQUEST_FAILED'), { status: response.status }); return value;
}
async function sameAccount() {
  const session = await request('/api/auth/get-session', { accountId: null });
  if (!session?.user?.emailVerified || session.user.id !== state.user?.id) { state.locked = true; throw Object.assign(new Error('ACCOUNT_CHANGED'), { status: 401 }); }
}
function documentText(document, original = false) {
  const texts = [];
  const visit = blocks => { for (const block of blocks) { if (typeof block?.data?.text === 'string' && (block.data.purpose === 'import-source') === original) texts.push(block.data.text); if (Array.isArray(block?.children)) visit(block.children); } };
  visit(document.blocks); return texts.join('\n\n');
}
function content(title, data) {
  return node('section', { class: 'history-snapshot' }, [node('h2', {}, t(title)), ...(data ? [node('h3', { translate: 'no' }, data.title), node('div', { class: 'history-content', translate: 'no' }, documentText(data.document)), ...(documentText(data.document, true) ? [node('details', {}, [node('summary', {}, t('source')), node('pre', { class: 'history-content', translate: 'no' }, documentText(data.document, true))])] : [])] : [node('p', { class: 'history-hint' }, t('choose'))])]);
}
function render() {
  const back = '/workspace.html?workspace=' + encodeURIComponent(workspaceId) + '&page=' + encodeURIComponent(pageId);
  const fragment = document.createDocumentFragment();
  fragment.append(node('div', { class: 'history-toolbar' }, [node('h1', {}, t('title')), node('a', { href: back }, t('back')), button('reload', () => void load(), !state.user)]), node('p', { class: 'history-hint' }, t('retention')));
  if (state.message) fragment.append(node('p', { class: 'history-alert', role: 'status' }, t(state.message)));
  if (state.current) {
    const versions = node('nav', { class: 'history-versions', 'aria-label': t('title') });
    for (const version of state.versions) versions.append(node('button', { type: 'button', disabled: state.busy, 'aria-pressed': String(state.snapshot?.id === version.id), onClick: () => void preview(version.id) }, [node('strong', {}, t('version') + ' ' + version.version), node('div', {}, new Date(version.recordedAt).toLocaleString(preferences.snapshot().locale))]));
    if (!state.versions.length) versions.append(node('p', {}, t('empty')));
    const body = node('div', {}, [node('div', { class: 'history-compare' }, [content('current', { title: state.current.page.title, document: state.current.document }), content('previous', state.snapshot)])]);
    if (state.snapshot) {
      const submit = button('restore', () => void restore(), !state.consent || state.locked);
      const check = node('input', { type: 'checkbox', checked: state.consent, disabled: state.busy || state.locked, onChange: event => { state.consent = event.target.checked; submit.disabled = !state.consent || state.busy || state.locked; } });
      body.append(node('section', { class: 'history-confirm' }, [node('p', { class: 'history-hint' }, t('scope')), node('label', { class: 'history-consent' }, [check, node('span', {}, t('consent'))]), submit]));
    }
    fragment.append(node('div', { class: 'history-layout' }, [versions, body]));
  } else if (!state.user) fragment.append(node('a', { href: '/account.html' }, t('auth')));
  app.replaceChildren(fragment); document.querySelector('#history-account').textContent = t('account'); brand?.apply({ titleSuffix: t('title') });
}
async function load() {
  if (state.busy || !state.user) return; state.busy = true; state.message = 'loading'; render();
  try {
    await sameAccount();
    const [current, history] = await Promise.all([request(route), request(route + '/history')]);
    if (current?.page?.id !== pageId || !current.page.capabilities?.includes('manage') || !Array.isArray(current.document?.blocks) || history?.pageId !== pageId || !Array.isArray(history.versions) || history.versions.length > 32 || history.revision !== current.revision) throw new Error('INVALID_HISTORY');
    for (const version of history.versions) if (!validId(version.id) || !Number.isSafeInteger(version.version) || !Number.isFinite(Date.parse(version.recordedAt))) throw new Error('INVALID_HISTORY');
    state.current = current; state.versions = history.versions; state.revision = history.revision; state.snapshot = null; state.consent = false; state.locked = false; state.message = '';
  } catch (error) { state.locked = true; state.message = error.status === 401 ? 'auth' : 'denied'; }
  finally { state.busy = false; render(); }
}
async function preview(id) {
  if (state.busy || state.locked) return; state.busy = true; render();
  try {
    await sameAccount(); const result = await request(route + '/history/' + encodeURIComponent(id));
    if (result.revision !== state.revision || result.pageId !== pageId || result.snapshot?.id !== id || !Array.isArray(result.snapshot.document?.blocks)) throw Object.assign(new Error('HISTORY_CHANGED'), { status: 409 });
    state.snapshot = result.snapshot; state.consent = false; state.message = '';
  } catch (error) { state.locked = true; state.message = error.status === 409 ? 'conflict' : 'denied'; }
  finally { state.busy = false; render(); }
}
async function restore() {
  if (state.busy || state.locked || !state.snapshot || !state.consent) return; state.busy = true; render();
  try {
    await sameAccount();
    const result = await request(route + '/history/' + encodeURIComponent(state.snapshot.id) + '/restore', { method: 'POST', body: { expectedRevision: state.revision, expectedVersion: state.current.document.version } });
    if (result.pageId !== pageId || result.revision !== state.revision + 1 || result.version !== state.current.document.version + 1 || result.restoredFromVersion !== state.snapshot.document.version) throw new Error('UNKNOWN_RESTORE');
    state.busy = false; await load(); if (!state.locked) state.message = 'restored';
  } catch (error) { state.locked = true; state.message = error.status === 409 ? 'conflict' : 'uncertain'; }
  finally { state.busy = false; state.consent = false; render(); }
}
try {
  catalog = await loadCatalogs({namespace:'history'});
  const instance = await loadInstanceConfig(); brand = createInstanceBrand(instance);
  const session = await request('/api/auth/get-session', { accountId: null }); state.user = session?.user?.emailVerified ? session.user : null;
  preferences = new PreferencesStore({ profileId: state.user?.id || 'local' }); applyInstanceDefaults(preferences, instance);
  i18n=createI18n(catalog,preferences.snapshot().locale);await i18n.switchLocale(i18n.requestedLocale);
  const prefs = resolveAppearancePreferences(preferences.snapshot()), theme = THEMES.find(item => item.id === prefs.themeId), colors = validateCustomColors(theme.id, prefs.customColors).colors;
  for (const [role, color] of Object.entries(colors)) document.documentElement.style.setProperty('--' + role, color);
  document.documentElement.style.colorScheme = theme.kind; document.documentElement.style.fontFamily = FONT_OPTIONS.find(font => font.id === prefs.fontId).family; applyLocaleDocument(document,i18n);
  brand.apply({ kind: theme.kind, titleSuffix: t('title') });
  if (!validId(workspaceId) || !validId(pageId) || [...query.keys()].some(key => !['workspace', 'page'].includes(key)) || query.getAll('workspace').length !== 1 || query.getAll('page').length !== 1) { state.locked = true; state.message = 'denied'; render(); }
  else { render(); await load(); }
} catch { app.replaceChildren(node('p', { role: 'alert' }, '履歴を取得できません。 / History is unavailable.')); }

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>brand?.apply({kind})});
