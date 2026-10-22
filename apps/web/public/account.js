import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors, contrastRatio } from './preferences.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';
import {InvitationFlow,readInvitationLink} from './invitation-flow.js';
import {workspaceMonogram} from './workspace-chooser-model.js';

const main = document.getElementById('account-main');
const language = document.getElementById('language');
const raw = new URL(location.href);
const invitationFlow=new InvitationFlow(readInvitationLink(raw));
let inviteBusy=false,inviteError='';
let verifyToken = raw.searchParams.get('verify');
let resetToken = raw.searchParams.get('reset');
let view = verifyToken ? 'verify' : resetToken ? 'reset' : invitationFlow.present ? 'invite' : ['signup', 'forgot', 'verify', 'reset', 'account'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'login';
if (raw.search) history.replaceState(null, '', '/account#' + view);
raw.searchParams.delete('invite');raw.searchParams.delete('token');
const instanceConfig=await loadInstanceConfig();
const instanceBrand=createInstanceBrand(instanceConfig);
let config, session, preferences = new PreferencesStore(), i18n;
applyInstanceDefaults(preferences,instanceConfig);
instanceBrand.apply({titleSuffix:'アカウント'});
const oauthReturnedError = raw.searchParams.has('error') || raw.searchParams.get('oauth') === 'error';
let busy = false, generation = 0;
const node = (tag, attrs = {}, children = []) => {
  const result = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') result.className = value;
    else if (name === 'onClick') result.addEventListener('click', value);
    else if (name === 'value' || name === 'disabled' || name === 'required') result[name] = value;
    else result.setAttribute(name, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child !== null && child !== undefined) result.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return result;
};
const t = key => i18n?.t(key) ?? key;
function applyPreferences() {
  const pref = resolveAppearancePreferences(preferences.snapshot());
  const colors = validateCustomColors(pref.themeId, pref.customColors).colors || THEMES[1].colors;
  for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty('--' + key, value);
  const theme=THEMES.find(item=>item.id===pref.themeId);
  const appearance=pref.customColors.canvas ? (contrastRatio('#FFFFFF',colors.canvas)>contrastRatio('#102030',colors.canvas)?'dark':'light') : theme?.kind || 'light';
  document.documentElement.style.colorScheme=appearance;document.documentElement.dataset.appearance=appearance;
  document.documentElement.style.fontFamily = FONT_OPTIONS.find(item => item.id === pref.fontId)?.family || FONT_OPTIONS[0].family;
  i18n?.setLocale(pref.locale); language.replaceChildren(...createLocaleOptions(document,i18n,{value:pref.locale})); language.value=pref.locale; applyLocaleDocument(document,i18n);
}
async function api(path, body) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/auth' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    let data; try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw new Error(response.status === 429 ? 'rateLimited' : 'failed');
    return data;
  } catch (error) { throw new Error(['rateLimited', 'failed'].includes(error.message) ? error.message : 'unavailable'); }
  finally { clearTimeout(timer); }
}
function setView(next) { view = next; history.replaceState(null, '', '/account#' + next); render(); }
function action(key, handler, primary = false) { return node('button', { type: 'button', class: 'button' + (primary ? ' primary' : ''), onClick: handler }, t(key)); }
function link(key, next) { return node('a', { href: '#' + next, onClick: event => { event.preventDefault(); setView(next); } }, t(key)); }
function field(key, type, autocomplete, attributes = {}) {
  const input = node('input', { type, required: true, autocomplete, 'aria-label': t(key), ...attributes });
  return [node('label', { class: 'field' }, [node('span', {}, t(key)), input]), input];
}
function status(message = '') { return node('p', { class: 'status', role: 'status', 'aria-live': 'polite' }, message); }
async function perform(form, message, task) {
  if (busy) return;
  busy = true;
  for (const control of form.querySelectorAll('input,button')) control.disabled = true;
  message.textContent = t('working');
  try { await task(); } catch (error) { message.textContent = t(error.message in i18nCatalog ? error.message : 'failed'); }
  finally { busy = false; for (const control of form.querySelectorAll('input,button')) control.disabled = false; }
}
let i18nCatalog = {};
function render() {
  try {
  generation++;
  main.replaceChildren();
  document.getElementById('language-label').textContent = t('language');
  document.getElementById('back-link').textContent = t('back');
  document.getElementById('privacy-note').textContent = t('privacy');
  if (!config?.enabled) { main.append(node('h1', {}, t('title')), status(t('disabled'))); return; }
  if(invitationFlow.present&&!['verify','reset','forgot','account'].includes(view)){
    if(session?.user){renderInvitation();return;}
    main.append(node('aside',{class:'invite-panel'},[node('h2',{},t('inviteTitle')),node('p',{},t(invitationFlow.valid?'inviteSignIn':'inviteInvalid')),node('p',{class:'hint'},t('inviteMemory'))]));
  }
  if (session?.user && !['verify', 'reset'].includes(view)) { renderAccount(); return; }
  if (view === 'verify') {
    main.append(node('h1', {}, t('verifyTitle')), node('p', { class: 'intro' }, t('verifyIntro')));
    const message = status(verifyToken ? '' : t('missingToken'));
    const form = node('form');
    const submit = node('button', { type: 'submit', class: 'button primary', 'data-instance-primary': '', disabled: !verifyToken }, t('verify'));
    form.append(submit, message);
    form.addEventListener('submit', event => { event.preventDefault(); void perform(form, message, async () => {
      await api('/verify-email?token=' + encodeURIComponent(verifyToken) + '&callbackURL=' + encodeURIComponent(location.origin + '/account'));
      verifyToken = null; message.textContent = t('verified'); submit.hidden = true;
    }); });
    main.append(form, node('div', { class: 'links' }, link('login', 'login'))); return;
  }
  const reset = view === 'reset'; const signup = view === 'signup'; const forgot = view === 'forgot';
  if (signup && config.registrationMode !== 'open') { main.append(node('h1', {}, t('signup')), status(t('closed')), link('login', 'login')); return; }
  main.append(node('h1', {}, t(reset || forgot ? 'resetTitle' : signup ? 'signup' : 'loginTitle')),
    node('p', { class: 'intro' }, t(reset ? 'resetIntro' : signup ? 'signupIntro' : 'loginIntro')));
  if (oauthReturnedError && !reset && !forgot) main.append(status(t('oauthFailed')));
  const form = node('form', { class: 'account-form' }); const message = status(reset && !resetToken ? t('missingToken') : '');
  let name, email, password, confirmation;
  if (signup) { const item = field('name', 'text', 'name', { maxlength: '100' }); form.append(item[0]); name = item[1]; }
  if (!reset) { const item = field('email', 'email', 'username', { maxlength: '254' }); form.append(item[0]); email = item[1]; }
  if (!forgot) {
    const item = field('password', 'password', signup || reset ? 'new-password' : 'current-password', { minlength: '12', maxlength: '128' }); form.append(item[0]); password = item[1];
    if (signup || reset) { const confirm = field('confirmPassword', 'password', 'new-password', { minlength: '12', maxlength: '128' }); form.append(confirm[0], node('p', { class: 'hint' }, t('passwordHint'))); confirmation = confirm[1]; }
  }
  const submitKey = reset ? 'savePassword' : forgot ? 'requestReset' : signup ? 'signup' : 'login';
  const submit = node('button', { type: 'submit', class: 'button primary', 'data-instance-primary': '', disabled: reset && !resetToken }, t(submitKey));
  form.append(submit, message);
  form.addEventListener('submit', event => { event.preventDefault(); void perform(form, message, async () => {
    if (confirmation && password.value !== confirmation.value) throw new Error('mismatch');
    if (reset) { await api('/reset-password', { token: resetToken, newPassword: password.value }); resetToken = null; session = null; password.value = ''; confirmation.value = ''; message.textContent = t('resetDone'); submit.hidden = true; }
    else if (forgot) { await api('/request-password-reset', { email: email.value, redirectTo: location.origin + '/account' }); message.textContent = t('received'); }
    else if (signup) { await api('/sign-up/email', { name: name.value, email: email.value, password: password.value, callbackURL: location.origin + '/account' }); password.value = ''; confirmation.value = ''; message.textContent = t('received'); }
    else {
      await api('/sign-in/email', { email: email.value, password: password.value }); password.value = '';
      session = await api('/get-session'); if (!session?.user) throw new Error('failed');
      preferences = new PreferencesStore({ profileId: session.user.id }); applyInstanceDefaults(preferences,instanceConfig); await i18n.switchLocale(preferences.snapshot().locale); applyPreferences();
      if (!invitationFlow.present && session.user.emailVerified === true) { location.assign('/workspace'); return; }
      render();
    }
  }); });
  if (signup) { const providers = providerButtons(true); if (providers) main.append(providers); }
  main.append(form, node('div', { class: 'links' }, [link('login', 'login'), ...(config.registrationMode === 'open' ? [link('signup', 'signup')] : []), link('forgot', 'forgot')]));
  if (!signup && !reset && !forgot) { const providers = providerButtons(false); if (providers) main.append(providers); }
  if (config.emailDelivery && !reset) main.append(action('resend', () => void perform(form, message, async () => {
    if (!email.checkValidity()) { email.reportValidity(); return; }
    await api('/send-verification-email', { email: email.value, callbackURL: location.origin + '/account' }); message.textContent = t('received');
  })), node('p', { class: 'hint' }, t('deliveryNote')));
  main.append(node('p', { class: 'hint boundary' }, t('boundary')));
  } finally { instanceBrand.apply({kind:document.documentElement.dataset.appearance,titleSuffix:t('title')}); }
}
function renderInvitation(){
  const snapshot=invitationFlow.snapshot;
  if(snapshot.preview&&snapshot.actorId!==session.user.id)invitationFlow.clearPreview();
  main.append(node('h1',{},t('inviteTitle')),node('p',{class:'intro'},t('inviteIntro')),node('p',{class:'identity-email',translate:'no'},session.user.email));
  if(snapshot.result){
    const result=snapshot.result,path='/workspace?workspace='+encodeURIComponent(result.workspaceId)+(result.pageId?'&page='+encodeURIComponent(result.pageId):'');
    main.append(status(t('inviteAccepted')),node('a',{class:'button primary',href:path},t('inviteOpen')),action('accountTitle',()=>setView('account')));return;
  }
  if(!invitationFlow.valid){main.append(status(t('inviteInvalid')),action('accountTitle',()=>setView('account')));return;}
  main.append(node('p',{class:'hint'},t('inviteMemory')),node('p',{class:'hint'},t('inviteEmailMatch')),
    node('dl',{class:'invite-details'},[node('dt',{},t('inviteId')),node('dd',{translate:'no'},invitationFlow.invitationId)]));
  if(inviteError)main.append(status(t(inviteError)));
  if(session.user.emailVerified!==true){main.append(status(t('inviteNeedsVerification')),action('resend',()=>void api('/send-verification-email',{email:session.user.email,callbackURL:location.origin+'/account'}).then(()=>{inviteError='received';render();}).catch(()=>{inviteError='failed';render();})));return;}
  const preview=invitationFlow.snapshot.preview;
  const run=async(accepting)=>{
    if(inviteBusy)return;inviteBusy=true;inviteError='';render();
    try{if(accepting)await invitationFlow.accept(session.user.id,{confirmed:true});else await invitationFlow.preview(session.user.id);}
    catch(error){inviteError=error.code==='ACTOR_CHANGED'?'inviteActorChanged':accepting?'inviteAcceptUncertain':'inviteUnavailable';}
    finally{inviteBusy=false;render();}
  };
  if(!preview){
    main.append(node('button',{type:'button',class:'button primary',disabled:inviteBusy,onClick:()=>void run(false)},t(inviteBusy?'working':'invitePreview')),
      node('p',{class:'hint'},t('inviteScopeUnknown')));
  }else{
    const details=node('dl',{class:'invite-details'},[node('dt',{},t('inviteWorkspace')),node('dd',{translate:'no'},preview.workspaceName),
      node('dt',{},t('inviteScope')),node('dd',{},t(preview.purpose==='page-guest'?'inviteSinglePage':'inviteWorkspaceMember')),
      ...(preview.pageId?[node('dt',{},t('invitePage')),node('dd',{translate:'no'},preview.pageTitle||preview.pageId)]:[]),
      node('dt',{},t('inviteRole')),node('dd',{},t('role_'+preview.role)),node('dt',{},t('inviteExpires')),node('dd',{},new Date(preview.expiresAt).toLocaleString(preferences.snapshot().locale)),
      ...(preview.issuerName?[node('dt',{},t('inviteIssuer')),node('dd',{translate:'no'},preview.issuerName)]:[])]);
    const consent=node('input',{type:'checkbox',required:true,disabled:inviteBusy}),submit=node('button',{type:'submit',class:'button primary',disabled:true},t(inviteBusy?'working':'inviteAccept'));
    consent.addEventListener('change',()=>{submit.disabled=inviteBusy||!consent.checked;});
    const form=node('form',{class:'account-form'},[details,node('label',{class:'invite-consent'},[consent,node('span',{},t('inviteConsent'))]),submit]);
    form.addEventListener('submit',event=>{event.preventDefault();if(consent.checked&&!inviteBusy)void run(true);});main.append(form);
  }
  main.append(node('div',{class:'links'},[action('accountTitle',()=>setView('account')),action('logout',()=>void api('/sign-out',{}).then(()=>{session=null;invitationFlow.clearPreview();setView('login');}).catch(()=>{inviteError='failed';render();}))]));
}
function providerButtons(signup) {
  const providers = Array.isArray(config?.providers) ? config.providers.filter(provider =>
    ['google', 'github', 'discord', 'oidc'].includes(provider.id) && typeof provider.label === 'string' && provider.label.length <= 80) : [];
  if (!providers.length) return null;
  const message = status();
  const grid = node('div', { class: 'oauth-grid' });
  const divider = node('p', { class: 'oauth-divider' }, t('oauthOr'));
  const section = node('section', { class: 'oauth-methods', 'aria-label': t('oauthMethods') }, signup ? [grid, message, divider] : [divider, grid, message]);
  if(invitationFlow.valid)section.append(node('p',{class:'hint'},t('inviteExternalNote')));
  for (const provider of providers) grid.append(node('button', { type: 'button', class: 'button oauth-button', onClick: () => {
    void perform(section, message, async () => {
      const data = await api('/sign-in/social', { provider: provider.id, callbackURL: invitationFlow.valid ? '/account' : '/workspace', requestSignUp: signup });
      let target; try { target = new URL(data?.url); } catch { throw new Error('oauthFailed'); }
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('oauthFailed');
      message.textContent = t('oauthOpening'); location.assign(target.href);
    });
  } }, [node('span', { translate: 'no' }, provider.label), node('span', { 'aria-hidden': 'true' }, '↗')]));
  return section;
}
function renderAccount() {
  if(invitationFlow.valid)main.append(action('inviteResume',()=>setView('invite')));
  history.replaceState(null, '', '/account#account');
  const marker = generation;
  main.append(node('h1', {}, t('accountTitle')), node('p', { class: 'identity-name', translate: 'no' }, session.user.name), node('p', { class: 'identity-email', translate: 'no' }, session.user.email));
  const accountStatus = status();
  const controls = node('div', {}, [action('logout', () => void perform(controls, accountStatus, async () => {
    await api('/sign-out', {}); session = null; preferences = new PreferencesStore(); applyPreferences(); setView('login');
  })), accountStatus]);
  main.append(controls, node('h2', {}, t('workspaceTitle')));
  const list = node('ul', { class: 'workspaces' }); main.append(list);
  void api('/organization/list').then(items => {
    if (marker !== generation) return;
    list.replaceChildren();
    if (!Array.isArray(items) || !items.length) list.append(node('li', {}, t('empty')));
    else for (const workspace of items) list.append(node('li', { class: 'workspace-row', translate: 'no' }, [
      node('span', { class: 'workspace-tile', 'aria-hidden': 'true' }, workspaceMonogram(workspace.name)),
      node('span', { class: 'workspace-identity' }, [node('strong', {}, workspace.name), node('span', { class: 'workspace-slug' }, workspace.slug)]),
      node('span', { class: 'workspace-actions' }, [
        node('a', { href: '/workspace?workspace=' + encodeURIComponent(workspace.id), class: 'workspace-open' }, t('openWorkspace')),
        node('a', { href: '/templates?workspace=' + encodeURIComponent(workspace.id), class: 'workspace-templates' }, t('personalTemplates'))
      ])
    ]));
  }).catch(() => { if (marker === generation) list.replaceChildren(node('li', {}, t('workspaceError'))); });
  const form = node('form', { class: 'account-form' }); const [nameField, name] = field('workspaceName', 'text', 'off', { maxlength: '100' });
  const [slugField, slug] = field('workspaceSlug', 'text', 'off', { maxlength: '100', pattern: '[a-z0-9]+(?:-[a-z0-9]+)*' }); const message = status();
  form.append(nameField, slugField, node('button', { class: 'button primary', type: 'submit' }, t('createWorkspace')), message);
  form.addEventListener('submit', event => { event.preventDefault(); void perform(form, message, async () => {
    const workspace = await api('/organization/create', { name: name.value, slug: slug.value }); if (workspace?.id) { location.assign('/workspace?workspace=' + encodeURIComponent(workspace.id)); return; } render();
  }); });
  main.append(node('details', { class: 'workspace-create' }, [node('summary', {}, t('chooserCreate')), form]), node('p', { class: 'hint boundary' }, t('boundary')), node('a', { class: 'migration-preview-link', href: '/import' }, t('importPreview')),node('p',{},node('a',{href:'/integrations'},t('integrations'))));
}
window.addEventListener('beforeunload',event=>{if(invitationFlow.valid){event.preventDefault();event.returnValue='';}});
language.addEventListener('change', async () => { try { const nextLocale=language.value;if(!await i18n.switchLocale(nextLocale))return;preferences.update({locale:nextLocale}); applyPreferences(); render(); } catch {} });
try {
  const catalogs = await loadCatalogs({namespace:'account'});

  i18nCatalog = catalogs.ja; i18n = createI18n(catalogs, preferences.snapshot().locale); await i18n.switchLocale(i18n.requestedLocale); applyPreferences();
  config = await api('/config');
  if (config.enabled) { session = await api('/get-session'); if (session?.user?.id) { preferences = new PreferencesStore({ profileId: session.user.id }); applyInstanceDefaults(preferences,instanceConfig); applyPreferences(); } }
  render();
} catch { main.replaceChildren(node('p', { role: 'status', class: 'status' }, i18n ? t('unavailable') : 'アカウント機能を読み込めません。 / Accounts are unavailable.')); }

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>instanceBrand?.apply({kind})});
