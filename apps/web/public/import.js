import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import { previewNotionImport, previewAppFlowyImport, extractMarkdownCsvAttachments, extractAppFlowyAttachments, inflateRawWeb, IMPORT_LIMITS, APPFLOWY_IMPORT_LIMITS } from './shared/importer/index.js';
import { prepareImportBundle, buildImportBundle } from './shared/importer/apply-plan.js';
import { AccountImportAssets } from './import-assets.js';
import { AccountImportFlow } from './import-flow.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors } from './preferences.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';

const main = document.getElementById('import-main'), language = document.getElementById('language'), dialog = document.getElementById('import-confirm');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const suggestedWorkspace = new URL(location.href).searchParams.get('workspace') || '';
let pinnedImportId = '';
let importSource = new URL(location.href).searchParams.get('source') === 'appflowy' ? 'appflowy' : 'notion';
const defaultRootTitle = () => t(importSource === 'appflowy' ? 'defaultAppFlowyRootTitle' : 'defaultRootTitle');
const flow = new AccountImportFlow({ prepare: prepareImportBundle, build: buildImportBundle, createId: () => pinnedImportId || 'import-' + crypto.randomUUID() });
let assetFlow = new AccountImportAssets(), assetPreparing = false, includeAttachments = false, selectedAssets = new Set(), stagedAssets = [], assetNotice = '';
let preferences = new PreferencesStore(), i18n, chosen, plan, rootTitle = '', session, workspaces = [];
let authState = 'checking', contentEnabled = false, selectedId = '', accountBusy = false, inspectionBusy = false, generation = 0, authGeneration = 0, notice = '', applyNotice = '';
let acknowledgements = {}, consent = false, submitControl, csvMode = 'native', rowMappings = {}, rootTitleEdited = false;
const t = (key, values) => i18n.t(key, values);
function node(tag, attributes = {}, children = []) {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) result.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['disabled', 'checked', 'value', 'required'].includes(key)) result[key] = value;
    else if (key === 'class') result.className = value;
    else result.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child !== null && child !== undefined) result.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return result;
}
function button(key, onClick, { primary = false, disabled = false } = {}) {
  return node('button', { type: 'button', class: 'button' + (primary ? ' primary' : ''), disabled, onClick }, t(key));
}
function accountLink(key = 'account') { return node('a', { href: '/account#account', target: '_blank', rel: 'noopener', class: 'text-link' }, t(key)); }
function settingsLocked() { return flow.locked || !!pinnedImportId; }
function busy() { return assetPreparing || assetFlow.pending || inspectionBusy || accountBusy || flow.pending || flow.phase === 'loading'; }
function applyPreferences() {
  const pref = resolveAppearancePreferences(preferences.snapshot()), colors = validateCustomColors(pref.themeId, pref.customColors).colors || THEMES.find(item => item.id === 'light').colors;
  for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty('--' + key, value);
  const brightness = [0, 2, 4].reduce((sum, start, index) => sum + parseInt(colors.canvas.slice(1 + start, 3 + start), 16) * [0.2126, 0.7152, 0.0722][index], 0);
  document.documentElement.style.colorScheme = brightness < 128 ? 'dark' : 'light';
  document.documentElement.style.fontFamily = FONT_OPTIONS.find(item => item.id === pref.fontId)?.family || FONT_OPTIONS[0].family;
  document.querySelector('meta[name="theme-color"]').content = colors.nav;
  i18n.setLocale(pref.locale); if(!rootTitleEdited && !settingsLocked() && rootTitle !== defaultRootTitle()){rootTitle=defaultRootTitle();flow.invalidate();} applyLocaleDocument(document,i18n); language.replaceChildren(...createLocaleOptions(document,i18n,{value:pref.locale})); language.value=pref.locale;
  document.title = 'Yumunio — ' + t('title'); document.querySelector('.skip-link').textContent = t('skip');
  document.getElementById('language-label').textContent = t('language'); language.setAttribute('aria-label', t('language'));
  document.getElementById('account-back').textContent = t('account');
}
function errorMessage(error) {
  const names = { NETWORK_UNCERTAIN: 'uncertain', INVALID_RESPONSE: flow.attempted ? 'uncertain' : 'connectionFailed',
    UNAUTHORIZED: 'sessionExpired', ACCOUNT_CHANGED: 'accountChanged', VERIFIED_ACCOUNT_REQUIRED: 'unverified',
    GUEST_IMPORT_FORBIDDEN: 'guest', SELECT_WORKSPACE: 'chooseWorkspace', CONTENT_CONFLICT: 'conflict',
    CONTENT_NOT_FOUND: 'accessChanged', CONTENT_TOO_LARGE: 'bundleTooLarge', IMPORT_BUNDLE_TOO_LARGE: 'bundleTooLarge',
    TOO_MANY_IMPORT_PAGES: 'tooManyPages', NO_IMPORTABLE_CONTENT: 'noContent', ACKNOWLEDGEMENT_REQUIRED: 'acksRequired',
    INVALID_APPFLOWY_NATIVE:'invalidPlan', APPFLOWY_MODEL_LIMIT:'bundleTooLarge', INVALID_ROW_MAPPING: 'invalidMapping', INVALID_IMPORT_PLAN: 'invalidPlan', INVALID_IMPORT_OPTIONS: 'invalidPlan', IMPORT_LOCKED: 'locked',
    PREVIEW_CHANGED: 'invalidPlan', IMPORT_REVIEW_REQUIRED: 'reviewAgain' };
  if (plan?.source === 'appflowy-native' && ['IMPORT_BUNDLE_TOO_LARGE','CONTENT_TOO_LARGE','TOO_MANY_IMPORT_PAGES','IMPORT_PAGE_LIMIT'].includes(error?.code)) return t(error.code === 'CONTENT_TOO_LARGE' ? 'nativeWorkspaceTooLarge' : ['TOO_MANY_IMPORT_PAGES','IMPORT_PAGE_LIMIT'].includes(error.code) ? 'nativeTooManyPages' : 'nativeBundleTooLarge');
  return t(names[error?.code] || (error?.status === 401 ? 'sessionExpired' : error?.status === 404 || error?.status === 403 ? 'accessChanged' : 'applyFailed'));
}
const zipInput = node('input', { type: 'file', accept: '.zip,application/zip', id: 'export-file', 'aria-describedby': 'import-limit' });
zipInput.addEventListener('change', () => {
  if (settingsLocked()) return;
  chosen = zipInput.files?.[0]; plan = null; notice = ''; applyNotice = ''; generation++; rootTitleEdited = false; rootTitle = defaultRootTitle();
  flow.invalidate(); includeAttachments = false; selectedAssets = new Set(); stagedAssets = []; assetNotice = ''; csvMode = 'native'; rowMappings = {}; acknowledgements = {}; consent = false; render();
});
function report() {
  if (!plan) return;
  const data = { schemaVersion: 1, source: plan.source, createdAt: new Date().toISOString(), summary: plan.summary,
    warnings: plan.warnings.map(({ code, count }) => ({ code, count })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = node('a', { href: url, download: 'yumunio-'+(importSource==='appflowy'?'appflowy':'notion')+'-import-report.json' });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function warningList(warnings, prefix) {
  return node('ul', { class: 'import-warnings' }, warnings.map(warning => {
    const key = prefix + warning.code;
    return node('li', {}, (t(key) === key ? t('warningUnknown') : t(key)) + (warning.count > 1 ? ' (' + warning.count + ')' : ''));
  }));
}
function summaryTable(summary, prefix = '') {
  return node('table', { class: 'import-summary' }, node('tbody', {}, Object.entries(summary).map(([key, value]) => {
    const label = prefix + (key === 'unsupported' ? 'unsupportedCount' : key);
    const formatted = new Intl.NumberFormat(i18n.locale).format(Number.isSafeInteger(value) && value >= 0 ? value : 0) + (key.endsWith('Bytes') ? ' B' : '');
    return node('tr', {}, [node('th', { scope: 'row' }, t(label)), node('td', {}, formatted)]);
  })));
}
function render() {
  const activeId = document.activeElement?.id;
  const focusStart = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text' ? document.activeElement.selectionStart : null;
  main.setAttribute('aria-busy', String(busy())); language.disabled = busy();
  main.replaceChildren(node('h1', {}, t('title')), node('p', { class: 'intro' }, t('intro')), node('p', { class: 'hint' }, t('privacy')));
  zipInput.disabled = busy() || settingsLocked(); zipInput.setAttribute('aria-label', t('choose'));
  const sourceSelect = node('select',{id:'import-source','aria-label':t('sourceLabel'),disabled:busy() || settingsLocked()},[node('option',{value:'notion'},t('sourceNotion')),node('option',{value:'appflowy'},t('sourceAppFlowy'))]);
  sourceSelect.value=importSource;
  sourceSelect.addEventListener('change',()=> {
    if(busy() || settingsLocked())return;
    importSource=sourceSelect.value;plan=null;generation++;notice='';applyNotice='';rootTitleEdited=false;rootTitle=defaultRootTitle();flow.invalidate();includeAttachments=false;selectedAssets=new Set();stagedAssets=[];assetNotice='';csvMode='native';rowMappings={};acknowledgements={};consent=false;render();
  });
  const form = node('form', { class: 'import-form' }, [
    node('label',{class:'field',for:'import-source'},[t('sourceLabel'),sourceSelect]),
    node('p',{class:'hint'},t(importSource==='appflowy'?'appflowyFormatHint':'notionFormatHint')),
    node('label', { class: 'field', for: 'export-file' }, [t('choose'), zipInput]),
    node('p', { id: 'import-limit', class: 'hint' }, t(importSource==='appflowy'?'appflowyLimit':'limit')),
    node('div', { class: 'import-actions' }, node('button', { type: 'submit', class: 'button primary', disabled: busy() || !chosen || settingsLocked() }, t('inspect'))),
    node('p', { class: 'import-status status', role: 'status', 'aria-live': 'polite' }, notice ? t(notice) : '')
  ]);
  form.addEventListener('submit', event => { event.preventDefault(); void inspect(); }); main.append(form);
  if (plan) {
    const details = node('details', { class: 'inspection-results', open:true }, [node('summary', {}, t('summary')),node('p',{class:'hint'},t('inspectedSource',{source:t(importSource==='appflowy'?'sourceAppFlowy':'sourceNotion')})),summaryTable(plan.summary),
      node('h2', {}, t('warnings')), plan.warnings.length ? warningList(plan.warnings, 'warning_') : node('p', { class: 'hint' }, t('none')),
      node('p', { class: 'hint' }, t(plan.source==='appflowy-native'?'nativeReview':'review')), node('div', { class: 'import-actions' }, button('download', report)), node('p', { class: 'hint' }, t('report'))]);
    main.append(details);
  }
  main.append(renderDestination());
  if (flow.prepared) main.append(renderPrepared());
  main.append(node('p', { class: 'hint boundary' }, t('scope')));
  if (!dialog.open && activeId) requestAnimationFrame(() => {
    const target = document.getElementById(activeId);
    if (target && !target.disabled) { target.focus({ preventScroll: true }); if (focusStart !== null && target instanceof HTMLInputElement && target.type === 'text') target.setSelectionRange(focusStart, focusStart); }
  });
}
function renderDestination() {
  const section = node('section', { class: 'import-destination', 'aria-labelledby': 'destination-heading' }, [node('h2', { id: 'destination-heading' }, t('destination'))]);
  if (authState !== 'ready') {
    section.append(node('p', { class: 'status', role: 'status' }, t({ checking: 'checkingAccount', anonymous: 'signInRequired', disabled: 'accountsDisabled',
      unverified: 'unverified', unavailable: 'connectionFailed', 'content-disabled': 'contentDisabled', changed: 'accountChanged' }[authState] || 'connectionFailed')),
      accountLink(authState === 'anonymous' ? 'signIn' : 'account'), button('checkAccount', () => void loadAccount(), { disabled: busy() }));
    return section;
  }
  section.append(node('p', { class: 'connected-account' }, [t('signedInAs') + ' ', node('strong', { translate: 'no' }, session.user.name || session.user.email)]));
  if (!workspaces.length) { section.append(node('p', {}, t('noWorkspaces')), accountLink('createWorkspace'), button('checkAccount', () => void loadAccount(), { disabled: busy() })); return section; }
  const select = node('select', { id: 'destination-workspace', disabled: busy() || settingsLocked(), 'aria-label': t('workspace') },
    [node('option', { value: '' }, t('chooseWorkspace')), ...workspaces.map(workspace => node('option', { value: workspace.id, translate: 'no' }, workspace.name))]);
  select.value = selectedId; select.addEventListener('change', () => void chooseWorkspace(select.value));
  section.append(node('label', { class: 'field', for: 'destination-workspace' }, [t('workspace'), select]));
  if (flow.phase === 'loading') section.append(node('p', { class: 'status', role: 'status' }, t('checkingDestination')));
  if (flow.error && !flow.prepared) section.append(node('p', { class: 'status', role: 'alert' }, errorMessage(flow.error)));
  if (flow.workspace) section.append(node('p', { class: 'hint' }, t('privateBranch')), node('p', { class: 'hint' }, t('revision', { revision: flow.workspace.revision })));
  if (selectedId && !settingsLocked()) section.append(button('recheckDestination', () => void chooseWorkspace(selectedId), { disabled: busy() }));
  const titleInput = node('input', { id: 'import-root-title', type: 'text', maxlength: '240', value: rootTitle, disabled: busy() || settingsLocked(), autocomplete: 'off', 'aria-label': t('rootTitle') });
  titleInput.addEventListener('input', () => {
    rootTitleEdited = true; rootTitle = titleInput.value;
    if (!settingsLocked()) flow.invalidate();
    main.querySelector('.import-prepared')?.remove();
    const control = document.getElementById('prepare-import');
    if (control) control.disabled = !canPrepare();
  });
  if (plan?.source==='appflowy-native') section.append(node('p',{class:'hint'},t('nativeImportMode')));
  else if (plan?.collections?.length) section.append(renderImportOptions());
  if (plan?.entries.some(entry => entry.kind === 'attachment')) section.append(renderAttachments());
  const prepareButton = button('prepare', () => {
    try { flow.prepare(plan, rootTitle, importOptions()); acknowledgements = {}; consent = false; applyNotice = ''; render(); document.getElementById('prepared-heading')?.focus(); }
    catch (error) { applyNotice = errorMessage(error); render(); }
  }, { primary: true, disabled: !canPrepare() }); prepareButton.id = 'prepare-import';
  section.append(node('label', { class: 'field', for: 'import-root-title' }, [t('rootTitle'), titleInput]),
    node('p', { class: 'hint' }, t(plan?.source==='appflowy-native'?'nativeBundleLimit':'bundleLimit')), prepareButton);
  if (applyNotice && !flow.prepared) section.append(node('p', { class: 'status', role: 'alert' }, applyNotice));
  return section;
}
function resetPreparedOptions() {
  if (settingsLocked()) return;
  flow.invalidate(); acknowledgements = {}; consent = false; applyNotice = ''; render();
}
function renderImportOptions() {
  const mode = node('select', { id: 'csv-mode', disabled: busy() || settingsLocked(), 'aria-label': t('csvMode') }, [
    node('option', { value: 'native' }, t('csvNative')), node('option', { value: 'reference' }, t('csvReference'))
  ]);
  mode.value = csvMode;
  mode.addEventListener('change', () => { csvMode = mode.value; rowMappings = {}; resetPreparedOptions(); });
  const group = node('div', { class: 'import-options' }, [node('label', { class: 'field', for: 'csv-mode' }, [t('csvMode'), mode]),
    node('p', { class: 'hint' }, t(csvMode === 'native' ? 'csvNativeHint' : 'csvReferenceHint'))]);
  if (csvMode !== 'native') return group;
  const matches = plan.matches || [], rows = new Map();
  for (const match of matches) {
    const collection = plan.collections.find(item => item.id === match.collectionId), row = collection?.rows.find(item => item.id === match.rowId);
    const page = plan.pages.find(item => item.id === match.pageId);
    if (!collection || !row || !page) continue;
    const key = collection.id + ':' + row.id;
    if (!rows.has(key)) rows.set(key, { collection, row, candidates: [] });
    if (!rows.get(key).candidates.some(item => item.id === page.id)) rows.get(key).candidates.push(page);
  }
  if (!rows.size) { group.append(node('p', { class: 'hint' }, t('noMappingCandidates'))); return group; }
  const list = node('div', { class: 'row-mapping-list' });
  const assigned = new Set(Object.values(rowMappings).map(item => item.pageId));
  for (const [key, item] of rows) {
    const selected = rowMappings[key]?.pageId || '', label = item.collection.title + ' / ' + (item.row.cells[0] || t('emptyCell'));
    const select = node('select', { 'aria-label': t('mappingFor', { row: label }), disabled: busy() || settingsLocked() }, [
      node('option', { value: '' }, t('newRowPage')), ...item.candidates.map(page => node('option', {
        value: page.id, disabled: assigned.has(page.id) && selected !== page.id, translate: 'no'
      }, page.title))
    ]);
    select.value = selected;
    select.addEventListener('change', () => {
      if (settingsLocked()) return;
      if (select.value) rowMappings[key] = { collectionId: item.collection.id, rowId: item.row.id, pageId: select.value };
      else delete rowMappings[key];
      resetPreparedOptions();
    });
    list.append(node('label', { class: 'field' }, [node('span', { translate: 'no' }, label), select]));
  }
  group.append(node('details', { class: 'row-mappings' }, [node('summary', {}, t('rowMappingTitle', { count: Object.keys(rowMappings).length })),
    node('p', { class: 'hint' }, t('rowMappingHint')), list]));
  return group;
}
function importOptions() { return { csvMode, rowPageMappings: Object.values(rowMappings), ...(stagedAssets.length ? { assets: stagedAssets } : {}) }; }
function assetEntries() { return (plan?.entries || []).filter(entry=>entry.kind === 'attachment'); }
function chosenAssetEntries() { return assetEntries().filter(entry=>selectedAssets.has(entry.id)); }
function assetSummary() { const entries=chosenAssetEntries(); return {count:entries.length,bytes:entries.reduce((sum,entry)=>sum+entry.bytes,0)}; }
function resetAssetOptions() { includeAttachments=selectedAssets.size > 0; resetPreparedOptions(); }
function renderAttachments() {
  const locked=settingsLocked(), snapshot=assetFlow.snapshot(), summary=assetSummary();
  const include=node('input',{type:'checkbox',checked:includeAttachments,disabled:busy() || locked || flow.workspace?.attachmentsEnabled !== true});
  include.addEventListener('change',()=> { includeAttachments=include.checked; selectedAssets=new Set(include.checked?assetEntries().map(entry=>entry.id):[]); resetPreparedOptions(); });
  const section=node('section',{class:'import-attachments','aria-label':t('attachmentsTitle')},[
    node('h3',{},t('attachmentsTitle')),node('label',{class:'acknowledgement'},[include,node('span',{},t('includeAttachments'))]),node('p',{class:'hint'},t('attachmentsHint'))
  ]);
  if (!flow.workspace) section.append(node('p',{class:'hint'},t('chooseWorkspaceForAssets')));
  else if (!flow.workspace.attachmentsEnabled) section.append(node('p',{class:'hint'},t('attachmentsDisabled')));
  if (includeAttachments) {
    const list=node('div',{class:'attachment-list'});
    for (const entry of assetEntries()) {
      const selected=node('input',{type:'checkbox',checked:selectedAssets.has(entry.id),disabled:busy() || locked});
      selected.addEventListener('change',()=> { if(selected.checked)selectedAssets.add(entry.id);else selectedAssets.delete(entry.id); resetAssetOptions(); });
      list.append(node('label',{class:'acknowledgement'},[selected,node('span',{translate:'no'},entry.path),node('small',{},new Intl.NumberFormat(i18n.locale).format(entry.bytes)+' B')]));
    }
    section.append(node('details',{},[node('summary',{},t('selectedAttachments',{count:summary.count,bytes:new Intl.NumberFormat(i18n.locale).format(summary.bytes)})),list]));
    if (assetNotice) section.append(node('p',{class:'status',role:'alert'},assetNotice));
    if (pinnedImportId) {
      section.append(node('p',{class:'status',role:'status'},t('assetPhase_'+assetFlow.phase,{ready:snapshot.ready,count:snapshot.count})));
      if (!busy() && !flow.result && !flow.attempted) {
        if (['conflict','forbidden','uncertain','failed'].includes(assetFlow.phase)) section.append(button('recheckAssets',()=>void recheckAssets()));
        if (['prepared','rechecked'].includes(assetFlow.phase)) section.append(button('resumeAssets',()=>void uploadAssets(),{primary:true}));
        section.append(button(assetFlow.phase==='cancel-uncertain'?'retryCancelAssets':'cancelAssets',()=>void cancelAssets()));
      }
      if (flow.attempted && !flow.result) section.append(node('p',{class:'hint'},t('assetAwaitingPages')));
    } else section.append(button('reviewAttachments',openAssetConfirmation,{primary:true,disabled:!canPrepareBase() || !summary.count}));
  }
  return section;
}
function openAssetConfirmation() {
  if (!canPrepareBase() || settingsLocked() || !flow.workspace.attachmentsEnabled || !chosenAssetEntries().length) return;
  let preview;
  try { preview=prepareImportBundle(plan,{...importOptions(),expectedRevision:flow.workspace.revision,importId:'preview-'+crypto.randomUUID(),rootTitle}); }
  catch(error) { applyNotice=errorMessage(error); render(); return; }
  const summary=assetSummary(), agreement=node('input',{type:'checkbox'});
  const submit=button('uploadAttachments',()=>void stageAttachments(),{primary:true,disabled:true});
  agreement.addEventListener('change',()=> { submit.disabled=!agreement.checked; });
  dialog.replaceChildren(node('header',{class:'dialog-header'},[node('h2',{id:'import-confirm-heading'},t('reviewAttachments')),button('cancel',()=>dialog.close())]),
    node('div',{class:'dialog-body'},[
      node('p',{},t('assetSendBoundary')),node('dl',{class:'review-destination'},[
        node('dt',{},t('workspace')),node('dd',{translate:'no'},flow.workspace.name),node('dt',{},t('rootTitle')),node('dd',{translate:'no'},rootTitle),
        node('dt',{},t('bundle_pages')),node('dd',{},preview.summary.pages),node('dt',{},t('attachments')),node('dd',{},t('selectedAttachments',{count:summary.count,bytes:new Intl.NumberFormat(i18n.locale).format(summary.bytes)}))
      ]),node('p',{class:'hint'},t('assetStagingBoundary')),
      node('label',{class:'acknowledgement'},[agreement,node('span',{},t('assetConsent'))]),
      node('p',{id:'confirm-import-status',class:'status',role:'status','aria-live':'polite'}),node('div',{class:'import-actions'},submit)
    ])); dialog.showModal(); agreement.focus();
}
async function stageAttachments() {
  if (!canPrepareBase() || settingsLocked() || !flow.workspace.attachmentsEnabled || !chosen) return;
  pinnedImportId='import-'+crypto.randomUUID(); assetPreparing=true; assetNotice='';
  for (const input of dialog.querySelectorAll('input,button')) input.disabled=true;
  dialog.setAttribute('aria-busy','true'); document.getElementById('confirm-import-status').textContent=t('preparingAssetBytes'); render();
  try {
    const extract=importSource==='appflowy'?extractAppFlowyAttachments:extractMarkdownCsvAttachments;
    const extracted=await extract(new Uint8Array(await chosen.arrayBuffer()),{inflateRaw:inflateRawWeb});
    const assets=chosenAssetEntries().map(entry=>({sourceId:entry.id,name:entry.path.split('/').at(-1),mediaType:'application/octet-stream',bytes:extracted.get(entry.id)}));
    await assetFlow.prepare({workspaceId:flow.workspace.id,accountId:flow.actor.id,importId:pinnedImportId,revision:flow.workspace.revision,assets});
    assetPreparing=false; await uploadAssets();
  } catch(error) {
    if(!assetFlow.context && !assetFlow.started) pinnedImportId='';
    assetNotice=assetErrorMessage(error);
  } finally { assetPreparing=false; dialog.setAttribute('aria-busy','false'); if(dialog.open)dialog.close(); render(); document.getElementById('prepared-heading')?.focus(); }
}
function assetErrorMessage(error) {
  return t(error?.status===409?'assetConflict':error?.status===401?'sessionExpired':[403,404].includes(error?.status)?'accessChanged':
    error?.code==='ASSETS_TOO_LARGE'||error?.status===413?'assetsTooLarge':error?.code==='INVALID_ASSET_PLAN'?'invalidAssets':
    error?.code==='ASSET_CONTEXT_CHANGED'?'assetContextChanged':'assetFailed');
}
async function uploadAssets() {
  if(assetFlow.pending || assetPreparing || flow.attempted || !assetFlow.context) return;
  assetNotice='';
  try {
    const uploading=assetFlow.upload(progress=> {
      const status=document.getElementById('confirm-import-status'); if(status)status.textContent=t('assetProgress',{ready:progress.ready,count:progress.count});
      render();
    }); render();
    const result=await uploading; stagedAssets=result.assets; flow.workspace={...flow.workspace,revision:result.revision};
    try { flow.prepare(plan,rootTitle,importOptions()); acknowledgements={}; consent=false; applyNotice=''; }
    catch(error) { applyNotice=errorMessage(error); assetNotice=t('assetReadyReviewFailed'); }
  } catch(error) { assetNotice=assetErrorMessage(error); }
  render();
}
async function recheckAssets() {
  if(busy() || flow.attempted) return;
  assetNotice=''; const pending=assetFlow.recheck(); render();
  try { await pending; } catch(error) { assetNotice=assetErrorMessage(error); }
  render();
}
async function cancelAssets() {
  if(busy() || flow.attempted || flow.result) return;
  assetNotice=''; const pending=assetFlow.cancel(); render();
  try {
    await pending; if(flow.workspace)flow.workspace={...flow.workspace,revision:assetFlow.revision};
    pinnedImportId=''; stagedAssets=[]; assetFlow=new AccountImportAssets(); flow.invalidate(); acknowledgements={}; consent=false;
  } catch(error) { assetNotice=assetErrorMessage(error); }
  render();
}

function canPrepareBase() { return !!plan && !!flow.workspace && authState === 'ready' && !!rootTitle.trim() && !busy() && !flow.locked; }
function canPrepare() { return canPrepareBase() && (!includeAttachments || (stagedAssets.length > 0 && assetFlow.phase === 'uploaded')); }
function renderPrepared() {
  const prepared = flow.prepared, root = prepared.body.pages.find(page => page.parentSourceId === null);
  const section = node('section', { class: 'import-prepared', 'aria-labelledby': 'prepared-heading' }, [
    node('h2', { id: 'prepared-heading', tabindex: '-1' }, t(flow.result ? 'successTitle' : 'preparedTitle')),
    node('dl', { class: 'review-destination' }, [
      node('dt', {}, t('workspace')), node('dd', { translate: 'no' }, flow.workspace.name),
      node('dt', {}, t('rootTitle')), node('dd', { translate: 'no' }, root.title)
    ]), summaryTable(prepared.summary, 'bundle_')
  ]);
  if (flow.result) {
    const href = '/workspace?workspace=' + encodeURIComponent(flow.workspace.id) + '&page=' + encodeURIComponent(flow.result.rootPageId);
    section.append(node('p', { class: 'status', role: 'status' }, t(flow.result.replayed ? 'successReplayed' : 'success')),
      node('a', { class: 'button primary', href }, t('openImportedRoot')),
      button('startOver', resetImport));
    return section;
  }
  section.append(warningList(prepared.warnings, 'bundleWarning_'));
  const pages = node('ul', { class: 'import-page-preview' });
  for (const page of prepared.body.pages.slice(0, 20)) pages.append(node('li', {}, [
    node('span', { translate: 'no' }, page.title), node('small', {}, page.parentSourceId === null ? t('newRoot') : t('newPrivatePage'))
  ]));
  section.append(node('details', { class: 'page-preview' }, [node('summary', {}, t('pagePreview')), pages,
    ...(prepared.body.pages.length > 20 ? [node('p', { class: 'hint' }, t('morePages', { count: prepared.body.pages.length - 20 }))] : [])]));
  if (flow.error || applyNotice) section.append(node('p', { class: 'status', role: 'alert' }, applyNotice || errorMessage(flow.error)));
  if (flow.phase === 'conflict' || flow.phase === 'forbidden') section.append(button('recheckAndReview', () => void recheckConflict(), { disabled: busy() }));
  else if (flow.phase === 'failed') {}
  else if (flow.phase === 'account-changed' || authState !== 'ready') section.append(accountLink(), button('checkAccount', () => void loadAccount(), { disabled: busy() }));
  else section.append(button(flow.attempted ? 'reviewRetry' : 'finalReview', openConfirmation, { primary: true, disabled: busy() }));
  if (flow.phase === 'auth-required') section.append(accountLink('signIn'), button('checkAccount', () => void loadAccount(), { disabled: busy() }));
  if (flow.phase === 'failed' && !busy()) section.append(button('editAgain', () => { flow.resetKnownFailure(); applyNotice = ''; acknowledgements = {}; consent = false; render(); }));
  return section;
}
function openConfirmation() {
  if (busy() || !flow.prepared || flow.result) return;
  consent = false;
  const prepared = flow.prepared, root = prepared.body.pages.find(page => page.parentSourceId === null);
  const controls = [];
  for (const key of prepared.requiredAcknowledgements) {
    const input = node('input', { type: 'checkbox', checked: acknowledgements[key] === true, 'data-ack': key });
    input.addEventListener('change', () => { acknowledgements[key] = input.checked; updateConfirmation(); });
    controls.push(node('label', { class: 'acknowledgement' }, [input, node('span', {}, t('ack_' + key))]));
  }
  const agreement = node('input', { type: 'checkbox', id: 'import-consent', checked: false });
  agreement.addEventListener('change', () => { consent = agreement.checked; updateConfirmation(); });
  submitControl = button(flow.attempted ? 'retrySame' : 'apply', () => void submitImport(), { primary: true, disabled: true });
  dialog.replaceChildren(node('header', { class: 'dialog-header' }, [node('h2', { id: 'import-confirm-heading' }, t('finalReview')),
    button('cancel', () => dialog.close())]),
    node('div', { class: 'dialog-body' }, [
      node('p', {}, t('sendBoundary')),
      node('dl', { class: 'review-destination' }, [node('dt', {}, t('workspace')), node('dd', { translate: 'no' }, flow.workspace.name),
        node('dt', {}, t('rootTitle')), node('dd', { translate: 'no' }, root.title),
        node('dt', {}, t('bundle_pages')), node('dd', {}, prepared.summary.pages)]),
      node('div', { class: 'acknowledgements' }, controls),
      node('label', { class: 'acknowledgement consent' }, [agreement, node('span', {}, t('consent'))]),
      node('p', { id: 'confirm-import-status', class: 'status', role: 'status', 'aria-live': 'polite' }, flow.attempted ? t('sameRequest') : ''),
      node('div', { class: 'import-actions' }, submitControl)
    ]));
  dialog.showModal(); dialog.querySelector('input')?.focus();
}
function updateConfirmation() {
  if (submitControl) submitControl.disabled = flow.pending || !consent || flow.prepared.requiredAcknowledgements.some(key => acknowledgements[key] !== true);
}
async function submitImport() {
  if (!consent || flow.pending) return;
  const pending = flow.submit({ acknowledgements, consent });
  for (const input of dialog.querySelectorAll('input,button')) input.disabled = true;
  dialog.setAttribute('aria-busy', 'true');
  document.getElementById('confirm-import-status').textContent = t('applying');
  render();
  try { await pending; if (stagedAssets.length && assetFlow.phase === 'uploaded') assetFlow.markCommitted(); applyNotice = ''; dialog.close(); render(); document.getElementById('prepared-heading')?.focus(); }
  catch (error) {
    applyNotice = errorMessage(error); consent = false;
    dialog.close(); render(); document.getElementById('prepared-heading')?.focus();
  } finally { dialog.setAttribute('aria-busy', 'false'); }
}
async function recheckConflict() {
  if (busy()) return;
  const pending = flow.recheckConflict(); render();
  try { await pending; acknowledgements = {}; consent = false; applyNotice = t('reviewRefreshed'); }
  catch (error) { applyNotice = errorMessage(error); }
  render();
}
function resetImport() {
  flow.resetKnownFailure(); pinnedImportId = ''; assetFlow = new AccountImportAssets(); stagedAssets = []; selectedAssets = new Set(); includeAttachments = false; assetNotice = ''; chosen = undefined; zipInput.value = ''; plan = null; rootTitle = defaultRootTitle();
  notice = ''; applyNotice = ''; csvMode = 'native'; rowMappings = {}; acknowledgements = {}; consent = false; generation++; render();
}
async function chooseWorkspace(workspaceId) {
  if (settingsLocked()) return;
  selectedId = workspaceId; applyNotice = ''; acknowledgements = {}; consent = false;
  const workspace = workspaces.find(item => item.id === workspaceId);
  const pending = flow.selectWorkspace(workspace || null); render();
  try { await pending; if (flow.workspace && !flow.workspace.attachmentsEnabled) { includeAttachments=false; selectedAssets.clear(); } } catch {}
  render();
}
async function loadAccount() {
  if (busy()) return;
  const marker = ++authGeneration; accountBusy = true; authState = 'checking'; render();
  try {
    const config = await flow.request('/api/auth/config');
    if (marker !== authGeneration) return;
    if (!config?.enabled) { authState = 'disabled'; session = null; return; }
    session = await flow.request('/api/auth/get-session');
    if (marker !== authGeneration) return;
    if (assetFlow.context && assetFlow.phase !== 'cancelled' && assetFlow.phase !== 'committed' && session?.user?.id !== assetFlow.context.accountId) { authState = 'changed'; applyNotice = t('accountChanged'); return; }
    try { flow.setActor(session?.user || null); } catch (error) { authState = session?.user ? 'changed' : 'anonymous'; applyNotice = errorMessage(error); return; }
    preferences = new PreferencesStore({ profileId: typeof session?.user?.id === 'string' && session.user.id.length <= 100 ? session.user.id : 'local' });
    applyPreferences(); contentEnabled = config.workspaceContent === true;
    if (!session?.user) { authState = 'anonymous'; workspaces = []; return; }
    if (!session.user.emailVerified) { authState = 'unverified'; workspaces = []; return; }
    if (!contentEnabled) { authState = 'content-disabled'; workspaces = []; return; }
    const items = await flow.request('/api/auth/organization/list');
    if (marker !== authGeneration) return;
    workspaces = Array.isArray(items) ? items.filter(item => validId(item.id) && typeof item.name === 'string') : [];
    authState = 'ready';
  } catch { if (marker === authGeneration) authState = 'unavailable'; }
  finally {
    if (marker === authGeneration) {
      accountBusy = false; render();
      if (authState === 'ready' && !settingsLocked()) {
        const preferred = selectedId || suggestedWorkspace;
        if (preferred && workspaces.some(item => item.id === preferred)) await chooseWorkspace(preferred);
      }
    }
  }
}
async function inspect() {
  if (busy() || settingsLocked()) return;
  if (!chosen) { notice = 'chooseFirst'; render(); return; }
  if (chosen.size > (importSource==='appflowy'?APPFLOWY_IMPORT_LIMITS:IMPORT_LIMITS).archiveBytes) { notice = importSource==='appflowy'?'appflowyTooLarge':'tooLarge'; render(); return; }
  const marker = ++generation, file = chosen; inspectionBusy = true; notice = 'working'; flow.invalidate(); render();
  try {
    const previewAdapter = importSource === 'appflowy' ? previewAppFlowyImport : previewNotionImport;
    const preview = await previewAdapter(new Uint8Array(await file.arrayBuffer()), { inflateRaw: inflateRawWeb });
    if (marker !== generation) return;
    plan = preview; notice = 'done'; if (!rootTitle) rootTitle = defaultRootTitle();
  } catch (error) { if (marker === generation) { notice = error?.code === 'APPFLOWY_PORTABLE_CONTENT_REQUIRED' ? 'appflowyPortableRequired' : error?.code === 'DEFLATE_UNAVAILABLE' ? 'unsupported' : error?.code?.startsWith('APPFLOWY_') ? 'appflowyInvalidBackup' : 'failed'; } }
  finally { if (marker === generation) { inspectionBusy = false; render(); } }
}
language.addEventListener('change', async () => {
  if (busy()) { language.value = preferences.snapshot().locale; return; }
  try { const nextLocale=language.value;if(!await i18n.switchLocale(nextLocale))return;preferences.update({locale:nextLocale}); applyPreferences(); render(); } catch {}
});
dialog.addEventListener('cancel', event => { if (flow.pending || assetFlow.pending || assetPreparing) event.preventDefault(); });
window.addEventListener('beforeunload', event => { if ((assetFlow.locked && assetFlow.phase !== 'committed') || assetPreparing || flow.pending || (flow.attempted && !flow.result && !['failed'].includes(flow.phase))) { event.preventDefault(); event.returnValue = ''; } });
try {
  const catalogs = await loadCatalogs({namespace:'import'});

  i18n = createI18n(catalogs, preferences.snapshot().locale); await i18n.switchLocale(i18n.requestedLocale);
  rootTitle = defaultRootTitle(); applyPreferences(); render(); await loadAccount();
} catch { main.replaceChildren(node('p', { role: 'alert' }, '移行画面を読み込めません。 / The migration screen could not be loaded.')); }

watchSystemAppearance(()=>preferences?.snapshot());
