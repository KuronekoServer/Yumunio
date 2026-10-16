import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors } from './preferences.js';
import { loadInstanceConfig, createInstanceBrand, applyInstanceDefaults } from './instance.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
import { publicToken, validatePublicPage, readPublicationJson } from './publication-data.js';
import { renderPublicationBody } from './publication-view.js';

const app = document.getElementById('site-app'), language = document.getElementById('language');
const preferences = new PreferencesStore({ profileId: 'local' });
let i18n, brand, page = null, busy = false, message = 'siteLoading';
const t = (key, values) => i18n.t(key, values);
function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
function applyPreferences() {
  const pref = resolveAppearancePreferences(preferences.snapshot()), theme = THEMES.find(item => item.id === pref.themeId);
  const colors = validateCustomColors(pref.themeId, pref.customColors).colors;
  for (const [role, color] of Object.entries(colors)) document.documentElement.style.setProperty('--' + role, color);
  document.documentElement.style.fontFamily = FONT_OPTIONS.find(item => item.id === pref.fontId)?.family;
  document.documentElement.style.colorScheme = theme.kind;
  applyLocaleDocument(document,i18n);
  i18n.setLocale(pref.locale);
  language.replaceChildren(...createLocaleOptions(document,i18n,{value:pref.locale})); language.value=pref.locale;
  language.setAttribute('aria-label', t('language'));
  document.getElementById('language-label').textContent = t('language');
  document.querySelector('.skip-link').textContent = t('skip');
  brand?.apply({ kind: theme.kind, titleSuffix: t('siteTitle') });
}
function render() {
  app.setAttribute('aria-busy', String(busy));
  language.disabled = busy;
  if (page) {
    const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(page.publishedAt));
    app.replaceChildren(node('p', { class: 'site-meta' }, t('siteSnapshot')), node('h1', { class: 'publication-page-title', translate: 'no' }, page.title), node('p', { class: 'site-meta' }, t('sitePublishedAt', { date })), node('article', { class: 'publication-document', translate: 'no' }, renderPublicationBody({ title: page.title, blocks: page.blocks }, document, { checked: t('checked'), unchecked: t('unchecked') })), node('p', { class: 'site-boundary' }, t('siteReadOnly')));
  } else {
    app.replaceChildren(node('h1', {}, t('siteTitle')), node('p', { role: busy ? 'status' : 'alert' }, t(message)));
    if (!busy && message === 'siteNetwork') app.append(node('button', { type: 'button', class: 'button', onClick: () => void loadPage() }, t('siteRetry')));
  }
  brand?.apply({ titleSuffix: t('siteTitle') });
}
async function loadPage() {
  if (busy) return;
  busy = true;
  page = null;
  message = 'siteLoading';
  render();
  try {
    const query = new URL(location.href).searchParams;
    if (query.getAll('publication').length !== 1 || [...query.keys()].some(key => key !== 'publication')) throw new TypeError('INVALID_PUBLICATION');
    const token = publicToken(query.get('publication'));
    const response = await fetch('/api/public/pages/' + encodeURIComponent(token), { method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { try { await response.body?.cancel(); } catch {} throw Object.assign(new Error(), { status: response.status }); }
    page = validatePublicPage(await readPublicationJson(response));
  } catch (error) { message = error?.message === 'INVALID_PUBLICATION' || [400,401,403,404].includes(error?.status) ? 'siteUnavailable' : 'siteNetwork'; }
  finally { busy = false; render(); }
}
language.addEventListener('change', async () => { if (busy) return; try { const nextLocale=language.value;if(!await i18n.switchLocale(nextLocale))return;preferences.update({locale:nextLocale}); applyPreferences(); render(); } catch {} });
try {
  const fetchAnonymous = (input, options = {}) => fetch(input, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer' });
  const catalogs = await loadCatalogs({namespace:'publication'});

  const instance = await loadInstanceConfig({ fetcher: fetchAnonymous });
  brand = createInstanceBrand(instance);
  applyInstanceDefaults(preferences, instance);
  i18n = createI18n(catalogs, preferences.snapshot().locale); await i18n.switchLocale(i18n.requestedLocale);
  applyPreferences();
  await loadPage();
} catch { app.replaceChildren(node('p', { role: 'alert' }, '公開ページを読み込めません。 / The public page is unavailable.')); }

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>brand?.apply({kind})});
