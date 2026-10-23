import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import { EditorHistory, markdownPrefix, moveEditorBlock } from './editor-model.js';
import {createBlockDnd} from './block-dnd.js';
import {createBoardDnd} from './board-dnd.js';
import {moveEditorBlockTo} from './editor-tree.js';
import { createInlineEditor, createInlineToolbar, inlineFormattingLabels, captureInlineSelection, focusInlineEditor, MAX_INLINE_TEXT } from './inline-editor.js';
import { joinInlineMarks } from './inline-text.js';
import { LocalWorkspaceStore, WorkspacePersistenceBridge, parseWorkspaceJSON, MAX_IMPORT_BYTES, BLOCK_TYPES, STATUSES, OWNERS } from './store.js';
import { buildWorkspaceExport } from './shared/export.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors, contrastRatio } from './preferences.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';

async function resolvePreferenceProfile() {
  try {
    const signal = AbortSignal.timeout(2500);
    const config = await fetch('/api/auth/config', { credentials: 'same-origin', cache: 'no-store', signal });
    if (!config.ok || !(await config.json())?.enabled) return { id: 'local', authenticated: false };
    const response = await fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store', signal });
    if (!response.ok) return { id: 'local', authenticated: false };
    const user = (await response.json())?.user;
    if (typeof user?.id !== 'string' || !user.id || user.id.length > 100) return { id: 'local', authenticated: false };
    return { id: user.id, authenticated: true, name: typeof user.name === 'string' ? user.name : '' };
  } catch { return { id: 'local', authenticated: false }; }
}
const [preferenceProfile,instanceConfig]=await Promise.all([resolvePreferenceProfile(),loadInstanceConfig()]);
const instanceBrand=createInstanceBrand(instanceConfig);
const preferences = new PreferencesStore({ profileId: preferenceProfile.id });
applyInstanceDefaults(preferences,instanceConfig);
let catalogLoadError = false;
const catalogs = await loadCatalogs({namespace:'app',locale:preferences.snapshot().locale}).catch(() => { catalogLoadError = true; return { ja: {}, en: {} }; });
const i18n = createI18n(catalogs, preferences.snapshot().locale); if(!catalogLoadError)await i18n.switchLocale(i18n.requestedLocale);

const store = new LocalWorkspaceStore();
const server = new WorkspacePersistenceBridge(store);
const app = document.getElementById('app');
const modal = document.getElementById('modal');
const toastElement = document.getElementById('toast');
const ui = { expanded: new Set(['page-spec']), navOpen: false, navCollapsed: false, views: new Map(), filters: new Map(), completedOpen: new Map(), focusKey: '', toastTimer: null, modalGeneration: 0 };
const localHistories = new Map();
let applyingLocalHistory = false;
let localBlockDnd=null,localBoardDnd=null,pendingLocalBoard=null,localDndGeneration=0;
const localCompositions=new Set();
const cloneLocalDraft = page => ({ title: page.title, blocks: structuredClone(page.blocks) });
function localSelection() {
  const active = document.activeElement;
  if (active?.classList?.contains('inline-editor')) return { focusKey: active.dataset.focus, ...captureInlineSelection(active) };
  if (active?.matches('.page-title-input')) return { focusKey: active.dataset.focus, start: active.selectionStart, end: active.selectionEnd };
  return null;
}
function localHistory(page) {
  if (!page || page.kind === 'collection') return null;
  if (!localHistories.has(page.id)) {
    try { localHistories.set(page.id, new EditorHistory(cloneLocalDraft(page))); }
    catch { return null; }
    if (localHistories.size > 8) localHistories.delete(localHistories.keys().next().value);
  }
  return localHistories.get(page.id);
}
function rememberLocalSelection(pageId) {
  const page = store.getPage(pageId), history = localHistory(page);
  if (history) history.record(cloneLocalDraft(page), { selection: localSelection() ?? history.current.selection, group: history.group });
}
function updateLocalHistoryControls() {
  const current = route(), page = current.kind === 'page' ? store.getPage(current.id) : null;
  const history = localHistory(page);
  for (const name of ['undo', 'redo']) {
    const control = app.querySelector('[data-local-history="' + name + '"]');
    if (control) control.disabled = !history?.[name === 'undo' ? 'canUndo' : 'canRedo'];
  }
}
function applyLocalHistory(direction) {
  const current = route(), page = current.kind === 'page' ? store.getPage(current.id) : null;
  const history = localHistory(page);
  if (!history || modal.open) return false;
  const restored = direction === 'undo' ? history.undo() : history.redo();
  if (!restored) return true;
  applyingLocalHistory = true;
  try { store.setPageDocument(page.id, restored.draft); }
  catch (error) { history.reset(cloneLocalDraft(page)); notify(error.message); }
  finally { applyingLocalHistory = false; }
  updateLocalHistoryControls();
  requestAnimationFrame(() => {
    const selection = restored.selection;
    if (!selection?.focusKey) return;
    focusByKey(selection.focusKey);
    const active = document.activeElement;
    if (active?.classList?.contains('inline-editor')) focusInlineEditor(active, { start: selection.start ?? 0, end: selection.end ?? selection.start ?? 0 });
    else if (active?.matches('.page-title-input')) active.setSelectionRange(selection.start ?? 0, selection.end ?? selection.start ?? 0);
  });
  return true;
}
function commitLocalBlocks(page, blocks) {
  return attempt(() => store.setPageDocument(page.id, { title: page.title, blocks }));
}
function moveLocalBlock(page, blockId, index) {
  rememberLocalSelection(page.id);
  const blocks = attempt(() => moveEditorBlock(page.blocks, { blockId, index }));
  if (blocks && commitLocalBlocks(page, blocks)) focusLocalBlock(blockId);
}
const blockName=type=>i18n.t('block.'+type);
const statusNames = { 準備: 'preparing', 進行中: 'progress', レビュー: 'review', 完了: 'done' };

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') node[key] = value;
    else node.setAttribute(key, value === true ? '' : ['aria-label', 'title', 'placeholder'].includes(key) ? i18n.text(String(value)) : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    const userContent = Object.hasOwn(attributes, 'data-page-title') || Boolean(attributes['data-user-content']);
    node.append(child instanceof Node ? child : document.createTextNode(userContent ? String(child) : i18n.text(String(child))));
  }
  return node;
}

function icon(name) {
  const shapes = {
    undo: [['path', { d: 'M3 10h11a7 7 0 0 1 0 14M3 10l6-6M3 10l6 6', transform: 'translate(0 -3)' }]],
    redo: [['path', { d: 'M21 7H10a7 7 0 0 0 0 14M21 7l-6-6M21 7l-6 6' }]],
    grip: [['path', { d: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01' }]],
    home: [['path', { d: 'M3 11 12 3 21 11M6 9v12h12V9M10 21v-7h4v7' }]],
    search: [['circle', { cx: 10, cy: 10, r: 6 }], ['path', { d: 'm15 15 6 6' }]],
    page: [['path', { d: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7' }]],
    table: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 10h18M9 4v16M3 15h18' }]],
    board: [['rect', { x: 3, y: 4, width: 7, height: 16, rx: 2 }], ['rect', { x: 14, y: 4, width: 7, height: 11, rx: 2 }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    down: [['path', { d: 'm6 9 6 6 6-6' }]],
    right: [['path', { d: 'm9 5 7 7-7 7' }]],
    up: [['path', { d: 'm6 14 6-6 6 6' }]],
    trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6' }]],
    restore: [['path', { d: 'M4 10a8 8 0 1 1 2 9M4 4v6h6' }]],
    menu: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
    panel: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M9 4v16' }]],
    notebook: [['path', { d: 'M5 3h13a2 2 0 0 1 2 2v15H7a2 2 0 0 1-2-2zM5 16h15M9 3v10M14 7h3M14 10h3' }]],
    more: [['circle', { cx: 5, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }]],
    close: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
    edit: [['path', { d: 'm4 16 12-12 4 4L8 20H4zM14 6l4 4' }]],
    check: [['path', { d: 'm5 12 5 5L20 7' }]],
    help: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9 8c0-4 7-4 7 0 0 3-4 2-4 6M12 17h.01' }]],
    inbox: [['path', { d: 'M5 4h14l3 12v4H2v-4zM2 16h6l2 3h4l2-3h6' }]],
    settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3' }]],
    type: [['path', { d: 'M4 5h16M12 5v15M8 20h8' }]],
    calendar: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M7 2v6M17 2v6M3 11h18' }]],
    share: [['circle', { cx: 6, cy: 12, r: 3 }], ['circle', { cx: 18, cy: 5, r: 3 }], ['circle', { cx: 18, cy: 19, r: 3 }], ['path', { d: 'm9 10 6-3M9 14l6 3' }]],
    download: [['path', { d: 'M12 3v12M7 10l5 5 5-5M4 17v4h16v-4' }]]
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'icon' })) svg.setAttribute(key, value);
  for (const [tag, attributes] of shapes[name] ?? shapes.page) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
    svg.append(child);
  }
  return svg;
}

function button(label, handler, options = {}) {
  return element('button', { type: 'button', class: `button ${options.class ?? ''}`, title: options.title, disabled: options.disabled, 'aria-label': options.ariaLabel, 'data-focus': options.focusKey, onClick: handler }, [options.icon ? icon(options.icon) : null, label]);
}

function iconButton(label, glyph, handler, options = {}) {
  return button('', handler, { ...options, class: `icon-button ${options.class ?? ''}`, icon: glyph, ariaLabel: label, title: options.title ?? label });
}

function pageLink(page, attributes = {}, children) {
  return element('a', { href: `#page/${encodeURIComponent(page.id)}`, ...attributes }, typeof children === 'string' ? element('span', { 'data-page-title': page.id }, children) : children ?? [icon(page.kind === 'collection' ? 'table' : 'page'), element('span', { 'data-page-title': page.id }, page.title)]);
}

function notify(message) {
  clearTimeout(ui.toastTimer);
  toastElement.textContent = i18n.text(message);
  toastElement.hidden = false;
  ui.toastTimer = setTimeout(() => { toastElement.hidden = true; }, 3800);
}

function attempt(action) {
  try { return action(); } catch (error) { notify(error.message); return null; }
}

function route() {
  const hash = window.location.hash || '#home';
  if (hash === '#trash') return { kind: 'trash' };
  if (hash.startsWith('#page/')) {
    try { return { kind: 'page', id: decodeURIComponent(hash.slice(6)) }; } catch { return { kind: 'home' }; }
  }
  return { kind: 'home' };
}

function navigate(hash, focusKey = '') {
  ui.navOpen = false;
  updateNavState();
  ui.focusKey = focusKey;
  if (window.location.hash === hash) render({ focusKey });
  else window.location.hash = hash;
}

function focusByKey(key) {
  if (!key) return;
  const target = [...document.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === key);
  if (target) {
    const details = target.closest('details');
    if (details) details.open = true;
    target.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement && target.type === 'text') target.select();
    target.scrollIntoView({ block: 'nearest' });
  }
}

function openModal(title, build, focusTarget) {
  localBlockDnd?.cancel();localBoardDnd?.cancel();
  modal.classList.remove('settings-modal');
  ui.modalGeneration += 1;
  if (!modal.open) { modal.returnFocus = document.activeElement; modal.returnFocusKey = document.activeElement?.dataset?.focus ?? ''; }
  const heading = element('h2', { id: 'modal-heading' }, title);
  const header = element('header', { class: 'modal-header' }, [heading, iconButton('閉じる', 'close', () => modal.close())]);
  const body = element('div', { class: 'modal-body' });
  modal.replaceChildren(header, body);
  build(body);
  if (!modal.open) modal.showModal();
  requestAnimationFrame(() => { (focusTarget?.() ?? body.querySelector('input,select,button,textarea'))?.focus(); });
}

modal.addEventListener('close', () => { if (modal.returnFocus?.isConnected) modal.returnFocus.focus(); else focusByKey(modal.returnFocusKey); });

function field(label, input) {
  const labelNode = element('label', { class: 'field' }, [element('span', { class: 'field-label' }, label), input]);
  return labelNode;
}

function openCreate(parentId = null, kind = 'document', initialStatus = '準備') {
  let titleInput;
  openModal(kind === 'record' ? '項目を追加' : 'ページを作成', body => {
    const form = element('form');
    titleInput = element('input', { class: 'field-input', type: 'text', name: 'title', placeholder: '無題のページ', maxlength: 200, 'aria-label': 'ページ名' });
    const parents = element('select', { class: 'field-input', name: 'parent', 'aria-label': '作成先' });
    if (kind !== 'record') parents.append(element('option', { value: '' }, 'チームスペースの最上位'));
    for (const page of store.listPages().filter(page => kind !== 'record' || page.kind === 'collection')) parents.append(element('option', { value: page.id, selected: page.id === parentId, 'data-user-content': true }, page.title));
    const types = element('select', { class: 'field-input', name: 'kind', 'aria-label': 'ページの種類' }, [element('option', { value: kind === 'record' ? 'record' : 'document' }, kind === 'record' ? 'コレクションの項目' : 'ドキュメント'), kind !== 'record' ? element('option', { value: 'collection' }, 'コレクション') : null]);
    const error = element('p', { class: 'error-message', role: 'alert', hidden: true });
    form.append(field('ページ名', titleInput), field('作成先', parents), field('種類', types), error, element('div', { class: 'modal-actions' }, [button('キャンセル', () => modal.close(), { class: 'quiet' }), element('button', { class: 'button primary', type: 'submit' }, '作成する')]));
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const page = store.createPage(titleInput.value, parents.value || null, types.value);
        if (page.kind === 'record' && page.properties.status !== initialStatus) store.setRecordProperty(page.id, 'status', initialStatus);
        if (page.parentId) ui.expanded.add(page.parentId);
        modal.close();
        navigate(`#page/${encodeURIComponent(page.id)}`, page.kind==='collection'?`title:${page.id}`:`block:${page.blocks[0].id}`);
        notify('ページを作成しました。端末に保存します。');
      } catch (failure) { error.hidden = false; error.textContent = i18n.text(failure.message); }
    });
    body.append(form);
  }, () => titleInput);
}

function openRename(page) {
  let input;
  openModal('ページ名を変更', body => {
    const form = element('form');
    input = element('input', { type: 'text', class: 'field-input', value: page.title, maxlength: 200, 'aria-label': '新しいページ名' });
    form.append(field('ページ名', input), element('div', { class: 'modal-actions' }, [button('キャンセル', () => modal.close(), { class: 'quiet' }), element('button', { class: 'button primary', type: 'submit' }, '変更する')]));
    form.addEventListener('submit', event => { event.preventDefault(); store.updatePageTitle(page.id, input.value); modal.close(); render(); notify('ページ名を変更しました。'); });
    body.append(form);
  }, () => input);
  requestAnimationFrame(() => input?.select());
}

function openDelete(page) {
  const visibleChildren = store.descendants(page.id).filter(item => store.isVisible(item)).length;
  openModal('ゴミ箱へ移動', body => {
    body.append(element('p', {}, `「${page.title}」をゴミ箱へ移動します。${visibleChildren ? `子ページ${visibleChildren}件も一緒に表示されなくなります。` : ''}`), element('p', { class: 'subtitle' }, 'ゴミ箱からページと階層を復元できます。'), element('div', { class: 'modal-actions' }, [button('キャンセル', () => modal.close(), { class: 'quiet' }), button('ゴミ箱へ移動', () => {
      store.deletePage(page.id);
      modal.close();
      notify('ゴミ箱へ移動しました。後から復元できます。');
    }, { class: 'danger', icon: 'trash' })]));
  });
}

function openBlockMenu(page, index, existingBlock) {
  openModal(existingBlock ? 'ブロックの操作' : 'ブロックを追加', body => {
    const menu = element('div', { class: 'command-menu', role: 'menu', 'aria-label': 'ブロックの種類' });
    const descriptions=Object.fromEntries(BLOCK_TYPES.map(type=>[type,i18n.t('block.description.'+type)]));
    for (const type of BLOCK_TYPES) menu.append(element('button', { class: 'command-item', type: 'button', role: 'menuitem', disabled:type==='divider'&&!!existingBlock?.text, onClick: () => {
      modal.close();
      if (existingBlock) store.updateBlock(page.id, existingBlock.id, { type,...(['code','divider'].includes(type)?{marks:[]}:{} ) });
      else store.addBlock(page.id, type, index);
    } }, [icon(type === 'checklist' ? 'check' : 'type'), element('span', {}, [element('strong', {}, blockName(type)), element('small', {}, descriptions[type])])]));
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...menu.querySelectorAll('button')];
      const current = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    });
    body.append(menu, element('p', { class: 'subtitle' }, '↑ ↓ で選択、Enter で決定、Esc で閉じる'));
    if (existingBlock) body.append(element('div', { class: 'modal-actions' }, [button('前へ移動', () => { modal.close(); store.moveBlock(page.id, existingBlock.id, -1); }, { icon: 'up', disabled: index === 0 }), button('次へ移動', () => { modal.close(); store.moveBlock(page.id, existingBlock.id, 1); }, { icon: 'down', disabled: index === page.blocks.length - 1 }), button('削除', () => { modal.close(); store.removeBlock(page.id, existingBlock.id); }, { class: 'quiet danger', icon: 'trash' })]));
  });
}

function openSearch() {
  let input;
  openModal('ワークスペースを検索', body => {
    input = element('input', { type: 'search', class: 'field-input search-input', placeholder: 'ページ名や本文を検索', 'aria-label': '検索語', autocomplete: 'off' });
    const results = element('div', { class: 'search-results', 'aria-live': 'polite' });
    const update = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const pages = query ? store.listPages().filter(page => `${page.title} ${page.blocks.map(item => item.text).join(' ')}`.toLocaleLowerCase().includes(query)) : store.data.ui.recentPageIds.map(id => store.getPage(id)).filter(page => page && store.isVisible(page));
      results.replaceChildren();
      if (!pages.length) results.append(element('p', { class: 'empty-state' }, '一致するページがありません。検索語を変えてください。'));
      for (const page of pages.slice(0, 30)) {
        const excerpt = page.blocks.map(item => item.text).find(text => query && text.toLocaleLowerCase().includes(query)) ?? (page.kind === 'record' ? `担当 ${page.properties.owner} · ${page.properties.status}` : 'チームスペース');
        results.append(element('button', { class: 'search-result', type: 'button', onClick: () => { modal.close(); navigate(`#page/${encodeURIComponent(page.id)}`); } }, [icon(page.kind === 'collection' ? 'table' : 'page'), element('span', {}, [element('strong', { 'data-page-title': page.id }, page.title), element('small', { 'data-user-content': true }, excerpt.slice(0, 90))])]));
      }
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); } });
    results.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const items = [...results.querySelectorAll('button')];
      const current = items.indexOf(document.activeElement);
      event.preventDefault();
      if (event.key === 'ArrowUp' && current === 0) input.focus();
      else items[Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
    body.append(field('検索語', input), results, element('p', { class: 'subtitle' }, 'ゴミ箱のページは検索対象に含みません。検索も端末内で行います。'));
    update();
  }, () => input);
}

function downloadSnapshot(snapshot, prefix = 'yumunio-workspace') {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = element('a', { href: url, download: `${prefix}-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openWorkspaceExport() {
  openModal('ワークスペースを書き出す', body => {
    const generation = ui.modalGeneration;
    let format = 'markdown-csv-zip';
    let includeTrash = false;
    let preparing = false;
    let prepared = null;
    let preparedAt = '';
    let error = '';
    let downloadStarted = false;

    function draw(focusTarget = '') {
      const current = store.snapshot();
      body.replaceChildren();
      body.setAttribute('aria-busy', String(preparing));
      body.append(element('p', { class: 'export-workspace-name', 'data-user-content': true }, current.name), element('div', { class: 'notice export-source-note' }, element('p', {}, 'この端末で編集中の内容を書き出します。サーバーに保存済みの版とは別です。この操作ではサーバーを更新しません。')));
      if (store.status === 'saving') body.append(element('p', { class: 'subtitle' }, '端末への自動保存が終わる前の変更も、現在の編集内容として含めます。'));
      if (store.status === 'error') body.append(element('p', { class: 'subtitle' }, store.preserveUnreadableData ? '以前の保存データを読み込めなかったため、現在画面に表示している内容が対象です。読み込めなかった元データは含みません。' : '端末への自動保存に失敗している変更も、現在の編集内容として書き出します。'));

      const formats = element('fieldset', { class: 'export-formats', disabled: preparing }, element('legend', {}, '書き出す形式'));
      for (const [value, title, description] of [
        ['markdown-csv-zip', 'Markdown + CSV（ZIP）', 'ページ本文をMarkdown、コレクションの項目をCSVでまとめます。'],
        ['native-json', 'Yumunio JSON', '現在の編集データを、既存のJSON読込みで戻せる形式にします。']
      ]) {
        const input = element('input', { type: 'radio', name: 'workspace-export-format', value, checked: format === value });
        input.addEventListener('change', () => {
          format = value;
          prepared = null;
          error = '';
          downloadStarted = false;
          draw(`format-${value}`);
        });
        input.dataset.exportFocus = `format-${value}`;
        formats.append(element('label', { class: `export-format ${format === value ? 'selected' : ''}` }, [input, element('span', { class: 'export-format-copy' }, [element('span', { class: 'export-format-title' }, title), element('span', { class: 'subtitle' }, description)])]));
      }
      body.append(formats);

      const trash = element('input', { type: 'checkbox', checked: includeTrash, disabled: preparing, 'aria-describedby': 'export-trash-help' });
      trash.dataset.exportFocus = 'trash';
      trash.addEventListener('change', () => {
        includeTrash = trash.checked;
        prepared = null;
        error = '';
        downloadStarted = false;
        draw('trash');
      });
      body.append(element('div', { class: 'export-scope' }, [element('label', { class: 'export-trash-option' }, [trash, element('span', {}, 'ゴミ箱のページも含める')]), element('p', { id: 'export-trash-help', class: 'subtitle' }, '含めない場合は、削除した親ページの下にあるページも除外します。')]));

      const limitations = format === 'native-json'
        ? 'schemaVersion 1の編集データです。「JSONバックアップと読込み」から読み込めます。添付ファイル・共有権限・変更履歴は含みません。'
        : '本文・見出し・チェックリストと、項目の状態・担当・期限が対象です。添付ファイル・共有権限・変更履歴は含みません。このZIPを読み込んで復元する機能はまだありません。';
      body.append(element('p', { class: 'subtitle export-limitations' }, limitations));
      if (error) body.append(element('div', { class: 'notice error', role: 'alert' }, element('p', {}, error)));

      if (prepared) {
        const summary = prepared.summary;
        const preview = element('section', { class: 'export-preview', 'aria-labelledby': 'export-preview-heading' });
        preview.append(element('h3', { id: 'export-preview-heading' }, '書き出す内容を確認'), element('dl', { class: 'export-summary' }, [
          element('dt', {}, '対象'), element('dd', {}, `${summary.pages}ページ（コレクション${summary.collections}件・項目${summary.records}件を含む）`),
          element('dt', {}, '除外'), element('dd', {}, includeTrash ? 'ゴミ箱を含めます' : `ゴミ箱・削除された親の配下から${summary.excludedTrash}件を除外`),
          element('dt', {}, 'ファイル名'), element('dd', { class: 'export-filename' }, prepared.filename),
          element('dt', {}, 'サイズ'), element('dd', {}, `${new Intl.NumberFormat(i18n.locale).format(prepared.bytes.byteLength)}バイト`),
          element('dt', {}, '作成時刻'), element('dd', {}, preparedAt)
        ]));
        if (prepared.warnings.length) preview.append(element('h4', {}, '形式上の注意'), element('ul', { class: 'export-warnings' }, prepared.warnings.map(message => element('li', {}, message))));
        const download = button('この端末へダウンロード', () => {
          let url;
          try {
            url = URL.createObjectURL(new Blob([prepared.bytes], { type: prepared.mimeType }));
            const link = element('a', { href: url, download: prepared.filename, hidden: true });
            document.body.append(link);
            try { link.click(); } finally { link.remove(); }
            error = '';
            downloadStarted = true;
            draw('download');
            notify('ダウンロードを開始しました。');
          } catch {
            error = 'ダウンロードを開始できませんでした。作成した内容は保持しています。もう一度お試しください。';
            draw('download');
          } finally {
            if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
          }
        }, { class: 'primary', icon: 'download' });
        download.dataset.exportFocus = 'download';
        preview.append(element('div', { class: 'modal-actions' }, download));
        if (downloadStarted) preview.append(element('p', { class: 'export-download-status', role: 'status' }, 'ダウンロードを開始しました。ブラウザーで保存先や完了状態を確認してください。'));
        body.append(preview);
      }

      const prepare = button(preparing ? '書き出しを準備中…' : prepared ? '現在の内容で作り直す' : '書き出す内容を確認', async () => {
        preparing = true;
        prepared = null;
        downloadStarted = false;
        error = '';
        const snapshot = store.snapshot();
        draw();
        try {
          const result = await buildWorkspaceExport(snapshot, { format, includeTrash });
          if (!modal.open || generation !== ui.modalGeneration) return;
          prepared = result;
          preparedAt = new Date().toLocaleString(i18n.locale);
        } catch (caught) {
          if (!modal.open || generation !== ui.modalGeneration) return;
          error = caught.message || '書き出しを準備できませんでした。現在の内容は維持しています。';
        } finally {
          preparing = false;
          if (modal.open && generation === ui.modalGeneration) draw(prepared ? 'download' : 'prepare');
        }
      }, { class: prepared ? 'quiet' : 'primary', disabled: preparing });
      prepare.dataset.exportFocus = 'prepare';
      body.append(element('div', { class: 'modal-actions export-secondary-actions' }, [button('JSONバックアップと読込み', openJSONBackup, { class: 'quiet', disabled: preparing }), prepare]));
      if (preparing) body.append(element('p', { class: 'subtitle', role: 'status' }, 'この端末でファイルを作成しています。現在のページ内容は変更しません。'));
      if (focusTarget) requestAnimationFrame(() => body.querySelector(`[data-export-focus="${focusTarget}"]`)?.focus());
    }
    draw();
  });
}

function serverSaveLabel() {
  if (server.status === 'saved') return server.lastAction === 'import' ? 'サーバーから読込済み' : 'サーバーに自動保存済み';
  return { signin: 'サーバー: 接続が必要', ready: 'サーバー: 初回の保存方法を選択', loading: 'サーバーを確認中…', review: 'サーバー: 初回の保存方法を選択', saving: 'サーバーに保存中…', dirty: 'サーバーに自動保存中…', conflict: 'サーバー: 保存競合', error: 'サーバー: 接続を確認' }[server.status] ?? '';
}

function openServerPersistence() {
  if (!server.enabled) return;
  openModal('サーバーへの保存', body => {
    const generation = ui.modalGeneration;
    let phase = 'overview';
    let expectedRevision = null;
    const active = () => modal.open && generation === ui.modalGeneration;
    const storageName = { d1: 'Cloudflare D1', sqlite: 'SQLite', mariadb: 'MariaDB', mysql: 'MySQL', tidb: 'TiDB', postgres: 'PostgreSQL' }[server.storageType] ?? 'サーバー';
    const target = `${window.location.host} · ${storageName}`;

    async function run(action, success = '') {
      phase = 'overview';
      try {
        const pending = action();
        draw();
        await pending;
        if (success) notify(success);
      } catch (error) {
        if (!server.error) server.error = error.message;
        if (!active()) notify(error.message);
      }
      if (active()) draw();
    }

    function draw() {
      body.replaceChildren();
      body.setAttribute('aria-busy', String(server.busy));
      body.append(element('p', { class: 'subtitle' }, `保存先: ${target}`), element('p', {}, '端末には自動保存します。初回だけサーバーの内容を確認して保存方法を選ぶと、以後の変更はサーバーへも自動保存します。'));
      if (server.error) body.append(element('div', { class: 'notice', role: 'alert' }, element('p', {}, server.error)));
      if (!server.authenticated) {
        const input = element('input', { class: 'field-input', type: 'password', name: 'access-key', autocomplete: 'off', required: true, disabled: server.busy, 'aria-label': 'サーバーのアクセスキー' });
        const submit = element('button', { type: 'submit', class: 'button primary', disabled: server.busy }, server.busy ? '接続中…' : '接続する');
        const form = element('form', {}, [field('アクセスキー', input), element('p', { class: 'subtitle' }, 'キーは端末の保存データに含めません。接続後はサーバーのセッションを利用します。'), element('div', { class: 'modal-actions' }, submit)]);
        form.addEventListener('submit', event => {
          event.preventDefault();
          let key = input.value;
          input.value = '';
          const pending = server.signIn(key);
          key = '';
          run(async () => { await pending; await server.refresh(); });
        });
        body.append(form);
      } else if (server.busy) {
        body.append(element('p', { role: 'status', 'aria-live': 'polite' }, server.status === 'saving' ? '選んだ内容をサーバーに保存しています…' : 'サーバーの内容を確認しています…'));
      } else if (!server.remoteLoaded) {
        body.append(element('p', {}, 'サーバーの保存内容を確認してから、保存する内容を選びます。'), button('サーバーの内容を確認', () => run(() => server.refresh()), { class: 'primary' }));
      } else if (phase === 'save-confirm') {
        const exists = expectedRevision > 0;
        body.append(element('h3', {}, 'この端末の内容を保存します'), element('p', {}, `${store.snapshot().pages.length}ページ（ゴミ箱を含む）を、サーバーのリビジョン ${expectedRevision} に対して保存します。`), element('div', { class: 'notice' }, element('p', {}, exists ? 'サーバーにあるページとゴミ箱の内容全体を、この端末の内容に置き換えます。既存内容を残したい場合は、先にサーバーのJSONをダウンロードしてください。' : 'サーバーにはまだ内容がありません。現在の端末の内容を初めて保存します。')), element('div', { class: 'modal-actions' }, [button('戻る', () => { phase = 'overview'; draw(); }, { class: 'quiet' }), button(exists ? '確認して置き換える' : '現在の内容をサーバーに保存', () => run(() => server.saveCurrent(expectedRevision), 'サーバーに手動で保存しました。'), { class: 'primary' })]));
      } else if (phase === 'import-confirm') {
        body.append(element('h3', {}, 'サーバーの内容を開きます'), element('p', {}, `${server.remote.snapshot.name} · ${server.remote.snapshot.pages.length}ページ · リビジョン ${expectedRevision}`), element('div', { class: 'notice' }, element('p', {}, '現在の端末の内容をバックアップしてから、サーバーで確認した内容に切り替えます。端末のバックアップは直前の1回分を保持します。以前のバックアップが必要なら先にダウンロードしてください。')), element('div', { class: 'modal-actions' }, [button('戻る', () => { phase = 'overview'; draw(); }, { class: 'quiet' }), button('バックアップして開く', () => {
          try {
            server.importRemote(expectedRevision);
            ui.expanded = new Set();
            ui.views.clear();
            ui.filters.clear();
            phase = 'overview';
            navigate('#home');
            draw();
            notify('端末の内容をバックアップして、サーバーの内容を開きました。');
          } catch (error) { server.error = error.message; draw(); }
        }, { class: 'primary' })]));
      } else {
        const remote = server.remote;
        body.append(element('h3', {}, '保存する内容を選ぶ'), element('p', {}, `この端末: ${store.data.name} · ${store.data.pages.length}ページ（ゴミ箱を含む）`), element('p', {}, remote.snapshot ? `サーバー: ${remote.snapshot.name} · ${remote.snapshot.pages.length}ページ · リビジョン ${remote.revision}` : 'サーバー: 未保存 · リビジョン 0'), element('div', { class: 'modal-actions' }, [button('この内容を保存', () => { expectedRevision = remote.revision; phase = 'save-confirm'; draw(); }, { class: 'primary' }), button(server.status === 'conflict' ? 'サーバーの最新版を開く' : 'サーバーの内容を開く', () => { expectedRevision = remote.revision; phase = 'import-confirm'; draw(); }, { class: 'quiet', disabled: remote.snapshot === null })]), button('サーバーの最新版を確認', () => run(() => server.refresh()), { class: 'quiet' }));
      }
      let backup = null;
      try { backup = store.backupSnapshot(); } catch (error) { body.append(element('p', { class: 'subtitle' }, error.message)); }
      body.append(element('h3', {}, 'JSONバックアップ'), element('div', { class: 'modal-actions' }, [button('現在の端末の内容をダウンロード', () => downloadSnapshot(store.snapshot()), { class: 'quiet' }), button('切替前のバックアップをダウンロード', () => downloadSnapshot(backup.snapshot, 'yumunio-before-server-import'), { class: 'quiet', disabled: backup === null }), server.remoteLoaded && server.remote.snapshot ? button('サーバーのJSONをダウンロード', () => downloadSnapshot(server.remote.snapshot, `yumunio-server-r${server.remote.revision}`), { class: 'quiet' }) : null]), element('p', { class: 'subtitle' }, backup ? `切替前の保存日時: ${new Date(backup.createdAt).toLocaleString('ja-JP')}。ダウンロードしたJSONにページ本文を含みます。` : 'ダウンロードしたJSONにページ本文を含みます。切替前のバックアップはまだありません。'));
      if (server.authentication === 'access-key' && server.authenticated) body.append(button('サーバーから切断', () => run(() => server.signOut(), 'サーバーの接続を終了しました。端末の内容は残ります。'), { class: 'quiet', disabled: server.busy }));
    }

    draw();
    if (server.authenticated && !server.busy) run(() => server.refresh());
  });
}

function openJSONBackup() {
  openModal('JSONバックアップと読込み', body => {
    const generation = ui.modalGeneration;
    let candidate = null;
    let candidateSource = '';
    let filename = '';
    let pastedText = '';
    let reading = false;
    let error = '';
    let readSequence = 0;
    const active = () => modal.open && generation === ui.modalGeneration;

    function prepareJsonImport(text, sourceName, sourceType) {
      candidate = null;
      candidateSource = '';
      filename = '';
      error = '';
      try {
        candidate = parseWorkspaceJSON(text);
        candidateSource = sourceType;
        filename = sourceName;
      } catch (caught) { error = `${caught.message || 'JSONを読み込めませんでした。'} 現在の内容は維持しています。`; }
    }

    function draw(focusTarget = '') {
      body.replaceChildren();
      body.setAttribute('aria-busy', String(reading));
      body.append(element('p', {}, 'Yumunioの端末データをJSONで書き出し、ファイル選択やテキストの貼り付けで読み込めます。内容を確認して取り込むまで、現在のデータは変更しません。サーバーへの送信は行いません。'));
      let backup = null;
      try { backup = store.backupSnapshot(); } catch (caught) { body.append(element('p', { class: 'subtitle' }, caught.message)); }
      body.append(element('h3', {}, 'JSONを書き出す'), element('div', { class: 'modal-actions' }, [button('現在の内容をダウンロード', () => downloadSnapshot(store.snapshot()), { class: 'quiet' }), button('切替前のバックアップをダウンロード', () => downloadSnapshot(backup.snapshot, 'yumunio-before-import'), { class: 'quiet', disabled: backup === null })]));
      if (backup) body.append(element('p', { class: 'subtitle' }, `切替前の保存日時: ${new Date(backup.createdAt).toLocaleString('ja-JP')}`));
      body.append(element('h3', {}, 'JSONを読み込む'), element('p', { class: 'subtitle' }, 'schemaVersion 1 · 900,000バイト以下。Yumunioのバックアップが対象です。Notionのエクスポート形式には対応していません。'));
      body.append(element('a', { class: 'button quiet', href: '/import', target: '_blank', rel: 'noopener' }, 'NotionのZIPを検査する'));
      const input = element('input', { class: 'field-input', type: 'file', accept: '.json,application/json', disabled: reading, 'aria-label': '読み込むJSONファイル' });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        const sequence = ++readSequence;
        candidate = null;
        candidateSource = '';
        filename = '';
        error = '';
        if (!file) { draw(); return; }
        if (file.size > MAX_IMPORT_BYTES) { error = 'JSONファイルは900,000バイト以下にしてください。現在の内容は維持しています。'; input.value = ''; draw(); return; }
        reading = true;
        draw();
        try {
          const text = await file.text();
          if (!active() || sequence !== readSequence) return;
          prepareJsonImport(text, file.name, 'file');
        } catch (caught) {
          if (!active() || sequence !== readSequence) return;
          error = `${caught.message || 'ファイルを読み込めませんでした。'} 現在の内容は維持しています。`;
        } finally {
          if (active() && sequence === readSequence) { reading = false; draw(candidate ? 'preview' : ''); }
        }
      });
      body.append(field('JSONファイルを選ぶ', input));
      const textarea = element('textarea', { class: 'field-input', rows: 5, value: pastedText, disabled: reading, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'JSONテキストを貼り付け', placeholder: '{ "schemaVersion": 1, ... }' });
      const checkPasted = button('内容を確認', () => {
        readSequence += 1;
        prepareJsonImport(pastedText, '貼り付けたJSONテキスト', 'paste');
        draw(candidate ? 'preview' : 'paste');
      }, { class: 'quiet', disabled: reading || !pastedText.trim() });
      textarea.addEventListener('input', () => {
        pastedText = textarea.value;
        checkPasted.disabled = reading || !pastedText.trim();
        if (candidateSource) {
          candidate = null;
          candidateSource = '';
          filename = '';
          body.querySelector('.json-import-preview')?.remove();
        }
        error = '';
        body.querySelector('.json-import-error')?.remove();
      });
      body.append(field('JSONテキストを貼り付け', textarea), element('div', { class: 'modal-actions' }, checkPasted));
      if (reading) body.append(element('p', { role: 'status', 'aria-live': 'polite' }, 'ファイルの保存形式を確認しています…'));
      if (error) body.append(element('div', { class: 'notice json-import-error', role: 'alert' }, element('p', {}, error)));
      if (candidate) {
        body.append(element('section', { class: 'modal-body json-import-preview', 'aria-label': '読み込む内容を確認' }, [element('h3', {}, '読み込む内容を確認'), element('p', {}, filename), element('p', {}, `${candidate.name} · schemaVersion: ${candidate.schemaVersion} · ${candidate.pages.length}ページ（ゴミ箱を含む）`), element('div', { class: 'notice' }, element('p', {}, '現在の内容を端末にバックアップしてから、選んだ内容に切り替えます。バックアップは直前の1回分です。以前のバックアップが必要なら先にダウンロードしてください。')), element('div', { class: 'modal-actions' }, [button('選択を取り消す', () => { candidate = null; candidateSource = ''; filename = ''; draw('paste'); }, { class: 'quiet' }), button('バックアップして読み込む', () => {
          try {
            store.replaceWithBackup(candidate);
            ui.expanded = new Set();
            ui.views.clear();
            ui.filters.clear();
            candidate = null;
            candidateSource = '';
            filename = '';
            pastedText = '';
            error = '';
            navigate('#home');
            draw();
            notify('現在の内容をバックアップして、JSONを読み込みました。サーバーへは送信していません。');
          } catch (caught) { error = caught.message; draw(); }
        }, { class: 'primary' })])]));
      }
      body.append(element('p', { class: 'subtitle' }, 'JSONにはページ本文とゴミ箱の内容を含みます。ブラウザーのサイトデータを削除すると、端末に保持したバックアップも失われます。'));
      if (focusTarget) requestAnimationFrame(() => {
        if (!active()) return;
        if (focusTarget === 'preview') body.querySelector('.json-import-preview button')?.focus();
        else textarea.focus();
      });
    }

    draw();
  });
}

function applyPreferences() {
  const current = resolveAppearancePreferences(preferences.snapshot());
  const result = validateCustomColors(current.themeId, current.customColors);
  const theme = THEMES.find(item => item.id === current.themeId);
  const root = document.documentElement;
  const names = { rail: 'rail', canvas: 'canvas', surface: 'surface', nav: 'nav', accent: 'accent', on: 'on-accent', soft: 'accent-soft', text: 'text', muted: 'muted', border: 'border', disabledBg: 'disabled-bg', disabledFg: 'disabled-fg' };
  for (const [role, variable] of Object.entries(names)) root.style.setProperty(`--${variable}`, result.colors[role]);
  root.style.setProperty('--accent-hover', result.colors.accent);
  root.style.setProperty('--focus', result.colors.accent);
  root.style.setProperty('--control-border', result.colors.muted);
  root.style.setProperty('--font-family', FONT_OPTIONS.find(font => font.id === current.fontId).family);
  root.style.fontFamily = FONT_OPTIONS.find(font => font.id === current.fontId).family;
  const appearance = current.customColors.canvas ? (contrastRatio('#FFFFFF', result.colors.canvas) > contrastRatio('#000000', result.colors.canvas) ? 'dark' : 'light') : theme.kind;
  root.style.colorScheme = appearance;
  root.dataset.appearance = appearance;
  root.dataset.theme = current.themeId;
  applyLocaleDocument(document,i18n);
  i18n.setLocale(catalogLoadError?'ja':current.locale);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', result.colors.nav);
  const skip = document.querySelector('.skip-link');
  if (skip) skip.textContent = i18n.text('本文に移動');
}

function openSettings() {
  let draft = { ...preferences.snapshot().customColors };
  let saveError = '';
  openModal('設定', body => {
    body.classList.add('settings-content');
    const update = (patch, focus) => {
      try { preferences.update(patch); saveError = ''; notify('個人設定をこの端末に保存しました。'); }
      catch { saveError = '個人設定を保存できませんでした。現在の設定を維持しています。'; }
      draw(focus);
    };
    function draw(focus = '') {
      const current = preferences.snapshot();
      const theme = THEMES.find(item => item.id === current.themeId);
      body.replaceChildren();
      modal.querySelector('#modal-heading').textContent = i18n.text('設定');
      modal.querySelector('.modal-header button').setAttribute('aria-label', i18n.text('閉じる'));
      modal.querySelector('.modal-header button').title = i18n.text('閉じる');
      body.append(element('p', { class: 'settings-scope' }, preferenceProfile.authenticated ? i18n.t('settings.accountScope') : '現在はローカルプロファイル local の個人設定です。実アカウントとの接続・同期はまだありません。ページの内容やワークスペースJSONには含めません。'));
      if (preferences.error === 'PREFERENCES_READ_FAILED') body.append(element('p', { class: 'notice', role: 'status' }, '保存済みの個人設定を読めなかったため、初期設定で表示しています。ページの内容は変更していません。'));
      if (saveError) body.append(element('p', { class: 'notice error', role: 'alert' }, saveError));
      const grid = element('div', { class: 'theme-grid', role: 'group', 'aria-label': '外観' });
      for (const preset of THEMES) {
        const control = button('', () => { draft = {}; update({ themeId: preset.id, customColors: {} }, `theme:${preset.id}`); }, { class: `theme-choice ${current.themeId === preset.id ? 'selected' : ''}`, ariaLabel: i18n.t(`settings.theme.${preset.id}`) });
        control.dataset.prefFocus = `theme:${preset.id}`;
        control.setAttribute('aria-pressed', String(current.themeId === preset.id));
        const swatch = element('span', { class: 'theme-swatch', 'aria-hidden': true }, [element('span', { class: 'theme-swatch-nav' }), element('span', { class: 'theme-swatch-page' }, [element('i'), element('i'), element('i')])]);
        for (const [role, color] of Object.entries(preset.colors)) swatch.style.setProperty(`--swatch-${role}`, color);
        control.append(swatch, element('span', {}, i18n.t(`settings.theme.${preset.id}`)));
        if (current.themeId === preset.id) control.append(icon('check'));
        grid.append(control);
      }
      body.append(element('section', { class: 'settings-section' }, [element('h3', {}, '外観'), element('p', { class: 'subtitle' }, 'テーマを選ぶと、個人色をリセットして適用します。'), grid]));
      const font = element('select', { 'aria-label': '本文と画面のフォント', 'data-pref-focus': 'font', onChange: event => update({ fontId: event.target.value }, 'font') });
      for (const choice of FONT_OPTIONS) font.append(element('option', { value: choice.id, selected: current.fontId === choice.id }, choice.id === 'system' ? 'システム' : choice.id === 'monospace' ? '等幅' : choice.label));
      const language = element('select', { 'aria-label': '表示言語', 'data-pref-focus': 'locale', onChange: async event => { const code=event.target.value; if(await i18n.switchLocale(code))update({locale:code},'locale'); } }, createLocaleOptions(document,i18n,{value:i18n.requestedLocale}));
      body.append(element('section', { class: 'settings-section' }, [element('div', { class: 'settings-field-grid' }, [field('本文と画面のフォント', font), field('表示言語', language)]), element('p', { class: 'subtitle' }, FONT_OPTIONS.find(choice => choice.id === current.fontId).localOnly ? 'このアプリはフォント本体を同梱・ダウンロードしません。選んだフォントが端末にある場合に使用し、未導入・未収録の文字はシステムフォントへフォールバックします。' : '端末のシステムフォントを使います。利用できる書体はOSと言語により異なります。'), current.locale === 'en' ? element('p', { class: 'locale-note' }, '英語UIは段階的に追加しています。未翻訳の画面・説明は日本語へ戻ります。ページ名と本文は自動翻訳しません。') : null]));
      const colorInputs = element('div', { class: 'settings-color-grid' });
      const preview = element('div', { class: 'settings-color-preview' }, [element('h3', {}, '配色プレビュー'), element('p', { class: 'preview-body' }, '考えを書き、次の作業につなげましょう。'), element('p', { class: 'preview-secondary' }, '補助文字と無効状態も確認できます。'), element('div', { class: 'preview-actions' }, [button('変更を保存', null, { class: 'preview-primary', disabled: true }), button('無効な操作', null, { class: 'preview-disabled', disabled: true })])]);
      const colorError = element('p', { class: 'error-message', role: 'status', 'aria-live': 'polite', hidden: true });
      const ratios = element('dl', { class: 'contrast-results' });
      const save = button('個人色を適用', () => { const checked = validateCustomColors(current.themeId, draft); if (checked.valid) { draft = { ...checked.normalized }; update({ customColors: checked.normalized }, 'colors:accent'); } }, { class: 'primary' });
      function checkColors() {
        const checked = validateCustomColors(current.themeId, draft);
        colorError.hidden = checked.valid;
        colorError.textContent = checked.valid ? '' : i18n.text(checked.errors.includes('LOW_CONTRAST') ? 'この組合せは読みやすさの基準を満たしません。本文・補助文字・リンク・ボタンは4.5:1以上、無効状態は3:1以上にしてください。' : '色を #RRGGBB、#RGB、または rgb(0, 0, 0) で入力してください。透明色やCSS式は使えません。');
        save.disabled = !checked.valid || JSON.stringify(checked.normalized) === JSON.stringify(current.customColors);
        const visible = checked.colors ?? validateCustomColors(current.themeId, current.customColors).colors;
        for (const role of ['surface', 'text', 'muted', 'accent', 'on', 'disabledBg', 'disabledFg', 'border']) preview.style.setProperty(`--preview-${role}`, visible[role]);
        const pairs = checked.contrast;
        const rows = [['本文 / 背景', pairs['text/canvas']], ['本文 / カード', pairs['text/surface']], ['本文 / ナビ', pairs['text/nav']], ['補助文字 / 背景の最低値', Math.min(...['canvas', 'surface', 'nav'].map(role => pairs[`muted/${role}`]))], ['リンク / 背景の最低値', Math.min(...['canvas', 'surface', 'nav'].map(role => pairs[`accent/${role}`]))], ['ボタン文字 / アクセント', pairs['on/accent']], ['無効文字 / 無効背景', pairs['disabledFg/disabledBg']]];
        ratios.replaceChildren(...rows.flatMap(([label, value]) => [element('dt', {}, label), element('dd', {}, Number.isFinite(value) ? `${value.toFixed(2)}:1` : '—')]));
      }
      for (const [role, label] of [['accent', 'アクセント色'], ['canvas', '背景色'], ['text', '文字色']]) {
        const input = element('input', { type: 'text', value: draft[role] ?? '', placeholder: theme.colors[role], maxlength: 64, spellcheck: false, autocomplete: 'off', 'aria-label': label, 'data-pref-focus': `colors:${role}`, onInput: event => { draft[role] = event.target.value; checkColors(); } });
        colorInputs.append(field(label, input));
      }
      body.append(element('section', { class: 'settings-section' }, [element('h3', {}, '個人の色'), element('p', { class: 'subtitle' }, 'HEX または rgb(56, 87, 114) を入力できます。背景色はページ・カード・ナビにも適用します。'), colorInputs, colorError, preview, ratios, element('p', { class: 'settings-contrast-note' }, '表示値は指定色の組合せの計算結果です。画面全体のアクセシビリティ適合を示すものではありません。'), element('div', { class: 'modal-actions' }, [button('個人色をリセット', () => { draft = {}; update({ customColors: {} }, 'colors:accent'); }, { class: 'quiet', disabled: !Object.keys(current.customColors).length }), save])]), element('section', { class: 'settings-reset' }, [element('p', { class: 'subtitle' }, 'Light・システムフォント・日本語へ戻します。ページやサーバーの設定は変更しません。'), button('個人設定を初期化', () => { try { preferences.reset(); draft = {}; saveError = ''; } catch { saveError = '個人設定を保存できませんでした。現在の設定を維持しています。'; } draw(); }, { class: 'quiet' })]));
      body.append(element('section', { class: 'settings-section' }, [element('h3', {}, 'アカウント'), element('p', { class: 'subtitle' }, 'ログイン・登録はアカウント画面で行います。アカウントを切り替えても、この端末のページを自動送信・削除しません。個人設定の保存先は次の読み込み時に切り替わります。'), element('a', { class: 'button quiet', href: '/account' }, 'アカウントを開く')]));
      checkColors();
      if (focus) requestAnimationFrame(() => [...body.querySelectorAll('[data-pref-focus]')].find(node => node.dataset.prefFocus === focus)?.focus());
    }
    draw();
  });
  modal.classList.add('settings-modal');
}

function openHelp() {
  openModal('この端末内デモについて', body => {
    body.append(element('p', {}, 'ページとコレクションの操作を試すためのデモです。変更はこのブラウザーの localStorage に保存します。'), element('p', {}, server.enabled ? 'この環境はサーバー保存にも対応しています。初回だけ保存方法を確認し、以後の変更は自動で保存します。共同編集とページの共有は未実装です。' : 'この環境では端末内に保存します。共同編集、ページの共有、サーバーへの保存は利用できません。'), button('ワークスペースを書き出す', openWorkspaceExport, { class: 'quiet', icon: 'download' }), button('JSONバックアップと読込み', openJSONBackup, { class: 'quiet' }), server.enabled ? button('サーバー保存の設定', openServerPersistence, { class: 'primary' }) : null, element('p', {}, 'ページ名と本文はプレーンテキストとして扱います。サンプルのページと担当者は架空の内容です。'), element('a', { class: 'button quiet', href: './LICENSE.txt', target: '_blank', rel: 'noopener' }, 'MITライセンスを読む'));
  });
}

function renderTree(parentId, current, depth = 0) {
  const list = element('ul', { class: 'page-tree' });
  for (const page of store.children(parentId)) {
    const children = store.children(page.id);
    const expanded = ui.expanded.has(page.id);
    const item = element('li', { class: 'tree-item' });
    const row = element('div', { class: `tree-row ${current.kind === 'page' && current.id === page.id ? 'active' : ''}` });
    row.append(children.length ? iconButton(`${page.title} の子ページを${expanded ? '閉じる' : '開く'}`, expanded ? 'down' : 'right', () => { expanded ? ui.expanded.delete(page.id) : ui.expanded.add(page.id); render(); }, { class: 'tree-toggle' }) : element('span', { class: 'tree-toggle tree-toggle-empty', 'aria-hidden': true }));
    if (children.length) row.firstChild.setAttribute('aria-expanded', String(expanded));
    row.append(pageLink(page, { class: 'tree-link', 'aria-current': current.kind === 'page' && current.id === page.id ? 'page' : null }));
    row.append(element('div', { class: 'tree-actions' }, [iconButton(`${page.title} の下にページを追加`, 'plus', () => openCreate(page.id)), iconButton(`${page.title} の名前を変更`, 'edit', () => openRename(page))]));
    item.append(row);
    if (expanded && children.length && depth < 30) item.append(renderTree(page.id, current, depth + 1));
    list.append(item);
  }
  return list;
}

function renderNavigation(current) {
  const nav = element('nav', { class: 'page-nav', id: 'page-navigation', 'aria-label': 'ワークスペースのページ' });
  nav.addEventListener('click', event => { if (event.target.closest('a[href^="#page/"], a[href="#home"]')) { ui.navOpen = false; updateNavState(); } });
  const closeNavigation = () => { ui.navOpen = false; updateNavState(); app.querySelector('.mobile-nav-toggle')?.focus(); };
  const brandMark=icon('notebook');brandMark.setAttribute('data-instance-default-logo','');brandMark.setAttribute('data-instance-brand-mark','');
  nav.append(element('div', { class: 'sidebar-brand-row' }, [element('a', { class: 'workspace-brand', href: '#home', 'data-instance-label':true }, [element('img',{'data-instance-logo':true,width:'24',height:'24',alt:'Yumunio',hidden:true}),brandMark,element('span',{'data-instance-name':true},'Yumunio')]), iconButton('ページナビゲーションを閉じる', 'close', closeNavigation, { class: 'nav-close quiet' })]), element('div', { class: 'workspace-name', 'data-user-content': true }, store.data.name));
  const search = button('検索または移動', openSearch, { class: 'sidebar-search', icon: 'search' });
  search.append(element('kbd', {}, 'Ctrl K'));
  nav.append(search, element('div', { class: 'sidebar-primary' }, [button('ホーム', () => navigate('#home'), { class: `nav-item ${current.kind === 'home' ? 'active' : ''}`, icon: 'home' }), button('受信箱', null, { class: 'nav-item', icon: 'inbox', disabled: true, title: '受信箱は準備中です。' }), button('テンプレート', null, { class: 'nav-item', icon: 'page', disabled: true, title: 'テンプレートは準備中です。' })]));
  for (const control of nav.querySelectorAll('.sidebar-primary button:disabled')) control.append(element('small', { class: 'planned-label' }, '準備中'));
  const recents = store.data.ui.recentPageIds.map(id => store.getPage(id)).filter(page => page && store.isVisible(page)).slice(0, 3);
  if (recents.length) nav.append(element('section', { class: 'nav-section recent-nav' }, [element('h2', { class: 'nav-section-title' }, '最近開いたページ'), ...recents.map(page => pageLink(page, { class: `nav-recent-link ${current.kind === 'page' && current.id === page.id ? 'active' : ''}` }))]));
  nav.append(element('section', { class: 'nav-section workspace-tree-section' }, [element('div', { class: 'nav-section-heading' }, [element('h2', { class: 'nav-section-title' }, 'ワークスペース'), iconButton('ページを作成', 'plus', () => openCreate(), { class: 'quiet' })]), renderTree(null, current)]));
  nav.append(element('div', { class: 'nav-bottom' }, [button('ワークスペースを書き出す', openWorkspaceExport, { class: 'nav-item', icon: 'download' }), button('設定', openSettings, { class: 'nav-item', icon: 'settings', focusKey: 'settings:open' }), button('ゴミ箱', () => navigate('#trash'), { class: `nav-item ${current.kind === 'trash' ? 'active' : ''}`, icon: 'trash' }), button('使い方とライセンス', openHelp, { class: 'nav-item', icon: 'help' }), button(preferenceProfile.authenticated ? '個人設定' : 'ローカルの利用者', openSettings, { class: 'account-button', title: preferenceProfile.authenticated ? i18n.t('settings.accountScope') : 'アカウントへのログインはまだありません。この端末内で利用しています。', focusKey: 'settings:account' }), element('p', { class: 'sidebar-demo-note' }, '端末内デモ · 共同編集なし'), element('footer', { class: 'workspace-footer' }, [element('a', { href: './LICENSE.txt', target: '_blank', rel: 'noopener' }, 'MITライセンス'), element('span', {}, '0.1.0')])]));
  const account = nav.querySelector('.account-button');
  account.prepend(element('span', { class: 'account-avatar', 'aria-hidden': true }, 'L'));
  account.append(icon('down'));
  return nav;
}

function saveLabel() {
  return store.status === 'saved' ? 'ローカル保存済み' : store.status === 'saving' ? '端末に保存中…' : '保存できません';
}

function renderHeader(current) {
  const page = current.kind === 'page' ? store.getPage(current.id) : null;
  const breadcrumbs = element('div', { class: 'breadcrumbs' }, [element('a', { href: '#home', 'data-user-content': true }, store.data.name), element('span', { 'aria-hidden': true }, '/'), page ? element('span', { 'data-page-title': page.id }, page.title) : element('span', {}, current.kind === 'trash' ? 'ゴミ箱' : 'ホーム')]);
  const history = localHistory(page);
  const historyActions = history ? element('div', { class: 'local-history-actions', role: 'group', 'aria-label': '編集履歴' }, ['undo', 'redo'].map(name => {
    const control = iconButton(name === 'undo' ? '元に戻す' : 'やり直す', name, () => applyLocalHistory(name), { class: 'quiet', disabled: !history[name === 'undo' ? 'canUndo' : 'canRedo'] });
    control.dataset.localHistory = name;
    return control;
  })) : null;
  const serverStatus = element('span', { class: 'demo-badge server-save-status', hidden: !server.enabled, role: 'status', 'aria-live': 'polite' }, serverSaveLabel());
  const header = element('header', { class: 'topbar' }, [iconButton('ページナビゲーションを開閉', 'panel', () => { if (window.matchMedia('(max-width: 959px)').matches) ui.navOpen = !ui.navOpen; else ui.navCollapsed = !ui.navCollapsed; updateNavState(); }, { class: 'mobile-nav-toggle quiet' }), breadcrumbs, historyActions, element('span', { class: 'demo-badge' }, '端末内デモ'), element('span', { class: `save-status ${store.status === 'error' ? 'error' : ''}`, role: 'status', 'aria-live': 'polite' }, saveLabel()), serverStatus, button('共有', null, { class: 'quiet share-button', icon: 'share', disabled: true, title: '共有と共同編集は準備中です。' }), page ? pageMenu(page) : null]);
  header.querySelector('.mobile-nav-toggle').setAttribute('aria-expanded', String(window.matchMedia('(max-width: 959px)').matches ? ui.navOpen : !ui.navCollapsed));
  header.querySelector('.mobile-nav-toggle').setAttribute('aria-controls', 'page-navigation');
  return header;
}

function renderHome() {
  const home = element('section', { class: 'home-page' });
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
  home.append(element('div', { class: 'page-heading home-heading' }, [element('div', {}, [element('p', { class: 'eyebrow' }, today), element('h1', {}, '今日のワークスペース'), element('p', { class: 'subtitle' }, '最近のページから、今日の作業をはじめましょう。')]), button('ページを作成', () => openCreate(), { class: 'primary', icon: 'plus' })]));
  const recents = store.data.ui.recentPageIds.map(id => store.getPage(id)).filter(page => page && store.isVisible(page)).slice(0, 3);
  const grid = element('div', { class: 'home-grid' });
  for (const page of recents) grid.append(pageLink(page, { class: 'home-card' }, [icon(page.kind === 'collection' ? 'table' : 'page'), element('h2', { 'data-page-title': page.id }, page.title), element('p', { 'data-user-content': page.kind !== 'collection' ? true : null }, page.kind === 'collection' ? `${store.listRecords(page.id).length}件の項目を、担当と期限で整理。` : page.blocks.find(block => block.text)?.text.slice(0, 75) ?? 'ここから新しいページを始めましょう。'), element('div', { class: 'card-meta' }, [element('span', { class: 'card-label' }, page.kind === 'collection' ? 'コレクション' : 'ドキュメント'), element('span', {}, '端末内に保存')])]));
  if (!recents.length) grid.append(element('div', { class: 'empty-state' }, [element('h2', {}, '最初のページをつくる'), element('p', {}, 'ページを作成して、考えを書いてみましょう。'), button('ページを作成', () => openCreate(), { class: 'primary', icon: 'plus' })]));
  home.append(element('div', { class: 'section-heading' }, [element('h2', {}, '最近開いたページ'), button('すべてのページ', openSearch, { class: 'quiet text-button' })]), grid);
  const columns = element('div', { class: 'home-columns' });
  const pages = element('section', { class: 'recent-list' }, [element('h2', {}, 'ワークスペースのページ')]);
  for (const page of store.children(null)) pages.append(pageLink(page, { class: 'recent-row' }, [icon(page.kind === 'collection' ? 'table' : 'page'), element('span', { 'data-page-title': page.id }, page.title), element('small', {}, `${store.children(page.id).length} 子ページ`)]));
  const tasks = element('section', { class: 'activity-list' }, [element('h2', {}, '近い期限の項目')]);
  const upcoming = store.listPages().filter(item => item.kind === 'record' && item.properties.status !== '完了').sort((a, b) => (a.properties.date || '9999').localeCompare(b.properties.date || '9999')).slice(0, 3);
  for (const page of upcoming) tasks.append(pageLink(page, { class: 'task-row' }, [element('span', { class: 'task-check', 'aria-hidden': true }), element('span', { class: 'task-copy' }, [element('strong', { 'data-page-title': page.id }, page.title), element('small', { 'data-user-content': true }, store.getPage(page.collectionId)?.title ?? 'ワークスペース')]), element('span', { class: `status-badge status-${statusNames[page.properties.status]}` }, page.properties.status), element('small', {}, formatDate(page.properties.date))]));
  if (!upcoming.length) tasks.append(element('p', { class: 'empty-copy' }, '未完了の項目はありません。'));
  columns.append(tasks, pages);
  home.append(columns, element('div', { class: 'home-quick-start' }, [element('span', {}, 'すぐに始める'), button('ページを作成', () => openCreate(), { icon: 'plus' }), button('コレクションを作成', () => openCreate(null, 'collection'), { icon: 'table' }), button('データを書き出す', openWorkspaceExport, { icon: 'download' })]), element('p', { class: 'local-mode-note' }, '端末内デモ：変更はこのブラウザーに保存します。サーバー保存は対応環境で手動操作できます。自動同期・共同編集は準備中です。'));
  return home;
}

function formatDate(value) { return value ? `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日` : '期限なし'; }

function pageMenu(page) {
  const details = element('details', { class: 'page-menu' });
  details.append(element('summary', { class: 'button quiet icon-button', 'aria-label': 'ページの操作', title: 'ページの操作' }, icon('more')), element('div', { class: 'page-menu-items' }, [button('名前を変更', () => openRename(page), { class: 'quiet', icon: 'edit' }), button('子ページを追加', () => openCreate(page.id), { class: 'quiet', icon: 'plus' }), button('ゴミ箱へ移動', () => openDelete(page), { class: 'quiet danger', icon: 'trash' })]));
  return details;
}

function titleField(page) {
  return element('input', { type: 'text', class: 'page-title-input', value: page.title, placeholder: '無題のページ', maxlength: 200, 'aria-label': 'ページタイトル', 'data-focus': `title:${page.id}`, onBeforeInput: () => rememberLocalSelection(page.id), onInput: event => store.updatePageTitle(page.id, event.target.value) });
}

function recordControls(page, mode = 'editor') {
  const controls = element('div', { class: mode === 'editor' ? 'record-properties' : 'board-card-meta' });
  for (const [key, label, choices] of [['status', '状態', STATUSES], ['owner', '担当', OWNERS]]) {
    const select = element('select', { class: `${key === 'status' ? 'status-select' : 'owner-select'} ${key === 'status' ? `status-${statusNames[page.properties.status]}` : ''}`, 'aria-label': `${page.title} の${label}`, 'data-focus': `property:${page.id}:${key}`, onChange: event => attempt(() => store.setRecordProperty(page.id, key, event.target.value)) });
    for (const value of choices) select.append(element('option', { value, selected: page.properties[key] === value }, value));
    controls.append(mode === 'editor' ? field(label, select) : select);
  }
  const date = element('input', { class: 'cell-input', type: 'date', value: page.properties.date, 'aria-label': `${page.title} の期限`, 'data-focus': `property:${page.id}:date`, onChange: event => attempt(() => store.setRecordProperty(page.id, 'date', event.target.value)) });
  controls.append(mode === 'editor' ? field('期限', date) : date);
  return controls;
}

function recordCard(record) {
  const menu = iconButton(`${record.title} の項目メニュー`, 'more', () => openModal('項目のプロパティ', body => {
    body.append(element('h3', { 'data-page-title': record.id }, record.title), recordControls(record), element('p', { class: 'subtitle' }, '変更はこの端末に自動保存されます。'), element('div', { class: 'modal-actions' }, [button('ゴミ箱へ移動', () => openDelete(record), { class: 'quiet danger', icon: 'trash' }), button('閉じる', () => modal.close(), { class: 'primary' })]));
  }), { class: 'board-card-menu quiet', title: '状態・担当・期限の編集、ゴミ箱へ移動' });
  menu.dataset.focus = `record-menu:${record.id}`;
  const owner = record.properties.owner;
  const grip=iconButton(i18n.t('boardDnd.handle',{text:record.title}),'grip',()=>{}, {class:'board-dnd-handle quiet',title:i18n.t('boardDnd.instructions'),focusKey:'board-card:'+record.id});grip.setAttribute('data-board-dnd-handle','');
  return element('article', { class: 'board-card','data-board-dnd-card':record.id,'data-board-dnd-label':record.title }, [element('div', { class: 'board-card-top' }, [grip,element('span', { class: `status-badge status-${statusNames[record.properties.status]}` }, record.properties.status), menu]), pageLink(record, { class: 'board-card-title' }, record.title), element('div', { class: 'board-record-meta' }, [element('span', { class: 'record-owner', 'aria-label': `担当 ${owner}` }, [element('span', { class: 'owner-avatar', 'aria-hidden': true }, owner === '未設定' ? '—' : owner.slice(0, 1)), owner]), element(record.properties.date ? 'time' : 'span', { datetime: record.properties.date || null, 'aria-label': `期限 ${formatDate(record.properties.date)}` }, formatDate(record.properties.date))])]);
}

function focusLocalBlock(blockId, offset = 0) {
  requestAnimationFrame(() => {
    const target = [...app.querySelectorAll('.inline-editor[data-focus]')].find(item => item.dataset.focus === 'block:' + blockId);
    focusInlineEditor(target, { start: offset });
  });
}

function localDndBlocks(page) {
 return page.blocks.map(block=>({id:block.id,type:/^heading[123]$/.test(block.type)?'heading':block.type,data:{text:block.text,checked:block.checked,...(/^heading[123]$/.test(block.type)?{level:Number(block.type.at(-1))}:{}),...(block.marks?{marks:block.marks}:{}),...(block.start!==undefined?{start:block.start}:{}),...(block.language?{language:block.language}:{})}}));
}
function renderLocalBodyEntry(page) {
 const generation=localDndGeneration,host=element('div',{class:'local-body-entry'});
 let pending=false;
 const materialize=(text,metadata={},selection={start:text.length},split=false)=>{
  if(pending||!split&&!text)return;pending=true;
  queueMicrotask(()=>{
   pending=false;if(generation!==localDndGeneration||!host.isConnected||modal.open||localCompositions.size||route().kind!=='page'||route().id!==page.id||!store.isVisible(page))return;
   const block={id:'block-'+crypto.randomUUID(),type:'paragraph',text,checked:false,...(metadata.marks?.length?{marks:metadata.marks}:{})};
   rememberLocalSelection(page.id);const blocks=[...page.blocks,block];
   let focusId=block.id,offset=selection.start;
   if(split){const added={id:'block-'+crypto.randomUUID(),type:'paragraph',text:'',checked:false};blocks.push(added);focusId=added.id;offset=0;}
   if(commitLocalBlocks(page,blocks))focusLocalBlock(focusId,offset);
  });
 };
 const previous=()=>{const block=[...page.blocks].reverse().find(block=>block.type!=='divider');if(block)focusLocalBlock(block.id,block.text.length);return true;};
 const input=createInlineEditor({text:'',className:'block-input body-entry-input',label:i18n.t('bodyEntry.label'),placeholder:i18n.t(page.blocks.length?'bodyEntry.continue':'block.placeholder'),
  onChange:(text,metadata)=>materialize(text,metadata,captureInlineSelection(input)||{start:text.length}),onSplit:selection=>materialize('',{},selection,true),
  onSlash:()=>openBlockMenu(page,page.blocks.length),onHistory:applyLocalHistory,onMerge:previous,onNavigate:direction=>direction<0?previous():false,
  onLimit:()=>notify(i18n.t('editor.textLimit')),onFormatError:()=>notify(i18n.t('inline.error'))});
 input.addEventListener('compositionstart',()=>{localCompositions.add('body-entry');localBlockDnd?.cancel();});
 input.addEventListener('compositionend',()=>{localCompositions.delete('body-entry');});
 host.append(input);return host;
}

function renderEditor(page) {
  const editor = element('article', { class: 'editor-page' });
  editor.append(element('div', { class: 'document-mark', 'aria-hidden': true }, icon('page')), element('p', { class: 'eyebrow' }, page.kind === 'record' ? 'コレクション / 項目' : 'チーム / ドキュメント'), element('h1', { class: 'visually-hidden', 'data-page-title': page.id }, page.title), titleField(page), element('p', { class: 'document-meta' }, '端末内のドキュメント · 本文をクリックして編集'));
  if (page.kind === 'record') editor.append(recordControls(page));
  const blocks = element('div', { class: 'block-list', 'aria-label': 'ページのブロック' });
  page.blocks.forEach((item, index) => {
    const row = element('div', { class: 'block-row local-block-'+item.type+' ' + (item.checked && item.type === 'checklist' ? 'completed' : ''), 'data-block-id': item.id,'data-dnd-block-id':item.id });
    const actions = element('div', { class: 'block-actions' }, [
      iconButton('ここにブロックを追加', 'plus', () => openBlockMenu(page, index), { class: 'inline-add' }),
      iconButton('ブロック ' + (index + 1) + ' の操作', 'grip', () => openBlockMenu(page, index, item))
    ]);
    const grip = actions.lastElementChild;
    grip.setAttribute('data-block-drag-handle','');grip.setAttribute('aria-describedby','block-dnd-instructions');
    grip.title=i18n.t('blockDnd.handle');
    const input = createInlineEditor({
      text: item.text, marks: item.marks || [], className: 'block-input ' + (item.type === 'heading1' ? 'block-heading-1' : item.type === 'heading2' ? 'block-heading-2' : ''),
      placeholder:item.type==='paragraph'?i18n.t('block.placeholder'):blockName(item.type),
      formatEnabled:item.type!=='code',
      label: i18n.text(blockName(item.type)) + ' ' + (index + 1),
      onChange: (text, change) => store.updateBlock(page.id, item.id, { text, marks: change.marks, format: change.kind === 'format' }),
      onBeforeFormat: () => rememberLocalSelection(page.id),
      onFormatError: () => notify(i18n.t('inline.error')),
      onLimit: () => notify('1ブロックは100000文字までです。'),
      onSlash:item.type==='code'?undefined:() => openBlockMenu(page, index, item),
      onHistory: applyLocalHistory,
      onShortcut: prefix => {
        if (item.type !== 'paragraph') return false;
        const converted = markdownPrefix(prefix);
        const type=converted?.type==='heading'?({1:'heading1',2:'heading2',3:'heading3'})[converted.data.level]:converted?.type;
        if(!BLOCK_TYPES.includes(type))return false;
        rememberLocalSelection(page.id);
        store.updateBlock(page.id, item.id, { text: prefix });
        const next = page.blocks.map(block => block.id === item.id ? {id:block.id,type,text:'',checked:converted.data.checked??false,...(converted.data.start!==undefined?{start:converted.data.start}:{}),...(converted.data.language?{language:converted.data.language}:{})} : { ...block });
        if(type==='divider')next.splice(index+1,0,{id:'block-'+crypto.randomUUID(),type:'paragraph',text:'',checked:false});
        if (commitLocalBlocks(page, next)) focusLocalBlock(type==='divider'?next[index+1].id:item.id);
        return true;
      },
      onSplit:item.type==='code'?undefined:({ before, after, beforeMarks, afterMarks }) => {
        if (!before && !after && item.type !== 'paragraph') {
          store.updateBlock(page.id, item.id, { type: 'paragraph' }); focusLocalBlock(item.id); return;
        }
        rememberLocalSelection(page.id);
        const next = { id: 'block-' + crypto.randomUUID(), type: ['checklist','bulleted-list','numbered-list','quote'].includes(item.type)?item.type:'paragraph', text: after, checked: false, ...(item.type==='numbered-list'?{start:Math.min(999999999,(item.start||1)+1)}:{}), ...(afterMarks.length ? { marks: afterMarks } : {}) };
        const blocks = page.blocks.map(block => ({ ...block }));
        blocks[index].text = before;
        if (beforeMarks.length) blocks[index].marks = beforeMarks; else delete blocks[index].marks;
        blocks.splice(index + 1, 0, next);
        if (commitLocalBlocks(page, blocks)) focusLocalBlock(next.id);
      },
      onMerge:item.type==='code'?undefined:text => {
        if (index === 0) {
          if (!text && page.blocks.length > 1) { const nextId = page.blocks[1].id; store.removeBlock(page.id, item.id); focusLocalBlock(nextId); return true; }
          if (item.type !== 'paragraph') { store.updateBlock(page.id, item.id, { type: 'paragraph' }); focusLocalBlock(item.id); return true; }
          return false;
        }
        const previous = page.blocks[index - 1];if(['divider','code'].includes(previous.type))return false;const caret=previous.text.length;
        if (previous.text.length + text.length > MAX_INLINE_TEXT) { notify('1ブロックは100000文字までです。'); return true; }
        rememberLocalSelection(page.id);
        const blocks = page.blocks.map(block => ({ ...block }));
        blocks[index - 1].text = previous.text + text;
        let mergedMarks; try { mergedMarks=joinInlineMarks(previous.text, previous.marks || [], text, item.marks || []); } catch { notify(i18n.t('inline.error')); return true; }
        if (mergedMarks.length) blocks[index - 1].marks = mergedMarks; else delete blocks[index - 1].marks;
        blocks.splice(index, 1);
        if (commitLocalBlocks(page, blocks)) focusLocalBlock(previous.id, caret);
        return true;
      },
      onNavigate: direction => {
        const target = page.blocks[index + direction];
        if (!target) return false;
        focusLocalBlock(target.id, direction < 0 ? target.text.length : 0); return true;
      }
    });
    input.dataset.focus = 'block:' + item.id;
    input.addEventListener('beforeinput', () => rememberLocalSelection(page.id));
    input.addEventListener('compositionstart',()=>{localCompositions.add(item.id);localBlockDnd?.cancel();});
    input.addEventListener('compositionend',()=>{localCompositions.delete(item.id);});
    const surface = element('div', { class: 'inline-edit-surface' }, input);
    const toolbar = createInlineToolbar(input, { labels: inlineFormattingLabels(key => i18n.t(key)) }); if (toolbar) surface.append(toolbar);
    row.append(actions);
    if (item.type === 'checklist') {
      const check = element('input', { type: 'checkbox', checked: item.checked, 'aria-label': 'チェック: ' + (item.text || '未入力の項目'), onChange: event => {
        row.classList.toggle('completed', event.target.checked); store.updateBlock(page.id, item.id, { checked: event.target.checked });
      } });
      row.append(element('div', { class: 'block-check' }, [check, surface]));
    }else if(['bulleted-list','numbered-list'].includes(item.type))row.append(element('div',{class:'local-list-body'},[element('span',{class:'local-list-marker','aria-hidden':'true'},item.type==='bulleted-list'?'•':String(item.start||1)+'.'),surface]));
    else if(item.type==='divider')row.append(element('hr',{class:'local-block-divider'}));
    else row.append(surface);
    blocks.append(row);
  });
  const last=page.blocks.at(-1);
  if(!(last?.type==='paragraph'&&last.text===''))blocks.append(renderLocalBodyEntry(page));
  const endDrop=element('div',{class:'block-end-drop'},i18n.t('blockDnd.end'));
  const help=element('details',{class:'local-editor-help'},[element('summary',{},i18n.t('editor.writingTips')),element('p',{class:'editor-hint'},i18n.t('block.hint')),element('p',{class:'editor-hint'},i18n.t('inline.hint')),element('p',{class:'editor-hint'},i18n.t('blockDnd.instructions'))]);
  editor.append(blocks,endDrop,iconButton(i18n.t('block.add'),'plus',()=>openBlockMenu(page,page.blocks.length),{class:'quiet insert-block-button'}),help);
  const children = store.children(page.id);
  if (children.length) {
    const section = element('section', { class: 'child-pages' }, [element('h2', {}, '子ページ')]);
    for (const child of children) section.append(pageLink(child, { class: 'recent-row' }));
    editor.append(section);
  }
  return editor;
}

function renderCollection(page) {
  const section = element('section', { class: 'collection-page' });
  const view = ui.views.get(page.id) ?? 'table';
  const filter = ui.filters.get(page.id) ?? '';
  const targets=new Map(STATUSES.map((status,index)=>['status-'+index,status]));targets.set('complete-summary',STATUSES.at(-1));
  section.append(element('p', { class: 'eyebrow' }, 'ワークスペース / コレクション'), element('h1', { class: 'visually-hidden', 'data-page-title': page.id }, page.title), element('div', { class: 'page-heading' }, [titleField(page), button('項目を追加', () => openCreate(page.id, 'record'), { class: 'primary', icon: 'plus' })]), element('p', { class: 'subtitle' }, 'チームの進み具合を、ひとつの場所で。状態・担当・期限を端末内で編集できます。'));
  const tabs = element('div', { class: 'collection-tabs', role: 'group', 'aria-label': 'コレクションのビュー' });
  for (const [kind, label, glyph] of [['table', '一覧', 'table'], ['board', '進行ボード', 'board']]) {
    const control = button(label, () => { ui.views.set(page.id, kind); render(); }, { class: `view-tab ${view === kind ? 'active' : ''}`, icon: glyph });
    control.setAttribute('aria-pressed', String(view === kind));
    tabs.append(control);
  }
  tabs.append(button('カレンダー（準備中）', null, { class: 'view-tab', icon: 'calendar', disabled: true, title: 'この端末内デモでは、一覧と進行ボードを利用できます。' }));
  section.append(tabs);
  const filters = element('select', { class: 'field-input collection-filter', 'aria-label': '状態で絞り込む', 'data-focus': `filter:${page.id}`, onChange: event => { ui.filters.set(page.id, event.target.value); render({ focusKey: `filter:${page.id}` }); } });
  filters.append(element('option', { value: '' }, 'すべての状態'));
  for (const state of STATUSES) filters.append(element('option', { value: state, selected: state === filter }, state));
  const records = store.listRecords(page.id).filter(record => !filter || record.properties.status === filter);
  section.append(element('div', { class: 'collection-toolbar' }, [element('label', { class: 'filter-control' }, [icon('table'), element('span', { class: 'visually-hidden' }, '状態で絞り込む'), filters]), element('span', { class: 'result-count' }, `${records.length}件表示 · 全${store.listRecords(page.id).length}件`)]));
  if (view === 'table') {
    const table = element('table', { class: 'collection-table', 'aria-label': `${page.title} の項目` });
    table.append(element('caption', { class: 'visually-hidden' }, '項目名、状態、担当、期限を編集できます。'), element('thead', {}, element('tr', {}, ['項目', '状態', '担当', '期限', '操作'].map(label => element('th', { scope: 'col' }, label)))));
    const body = element('tbody');
    for (const record of records) {
      const row = element('tr');
      const name = element('td');
      name.append(element('div', { class: 'record-name-field' }, [pageLink(record, { class: 'record-link', 'aria-label': `${record.title} を開く`, title: '項目のページを開く' }, icon('page')), element('input', { class: 'cell-input record-title-input', type: 'text', value: record.title, 'aria-label': `${record.title} の項目名`, 'data-focus': `record-title:${record.id}`, onChange: event => { store.updatePageTitle(record.id, event.target.value); render({ focusKey: `record-title:${record.id}` }); } })]));
      const props = recordControls(record, 'table');
      row.append(name);
      for (const input of [...props.children]) row.append(element('td', {}, input));
      row.append(element('td', {}, iconButton(`${record.title} をゴミ箱へ移動`, 'trash', () => openDelete(record))));
      body.append(row);
    }
    table.append(body);
    const tableWrap = element('div', { class: 'collection-table-wrap', tabindex: '0', 'aria-label': '項目の一覧。横にスクロールできます。' }, table);
    tableWrap.append(button('項目を追加', () => openCreate(page.id, 'record'), { class: 'quiet table-add-button', icon: 'plus' }));
    section.append(tableWrap, element('p', { class: 'table-caption' }, `${records.length}件の項目 · 項目のアイコンからページを開けます。`));
  } else {
    const board = element('div', { class: 'board', tabindex: '0', 'aria-label': '状態別のボード。横にスクロールできます。' });
    const completed = element('details', { class: 'completed-records', 'data-collection': page.id });
    const done = records.filter(record => record.properties.status === '完了');
    completed.open = filter === '完了' || ui.completedOpen.get(page.id) === true;
    completed.append(element('summary', {'data-board-dnd-target':'complete-summary','data-board-dnd-label':i18n.text(STATUSES.at(-1))}, [element('span', { class: 'status-badge status-done' }, '完了'), element('span', {}, `${done.length}件の項目`)]));
    for (const [statusIndex,state] of STATUSES.entries()) {
      const members = records.filter(record => record.properties.status === state);
      const column = element('section', { class: 'board-column', 'aria-label': state,'data-board-dnd-target':'status-'+statusIndex,'data-board-dnd-label':i18n.text(state) }, [element('header', { class: 'board-header' }, [element('h2', { class: `status-badge status-${statusNames[state]}` }, state), element('span', {}, String(members.length))])]);
      for (const record of members) column.append(recordCard(record));
      if (!members.length) column.append(element('p', { class: 'board-empty' }, 'この状態の項目はありません。'));
      column.append(button('項目を追加', () => openCreate(page.id, 'record', state), { class: 'quiet', icon: 'plus' }));
      if (state === '完了') completed.append(column);
      else board.append(column);
    }
    section.append(board,completed,element('p',{class:'board-hint'},i18n.t('collection.boardHint')));
    const generation=localDndGeneration,revision=store.contentRevision,data=store.data,scope={generation,revision,collectionId:page.id,view,filter};
    const available=()=>generation===localDndGeneration&&revision===store.contentRevision&&data===store.data&&!modal.open&&!localCompositions.size&&route().kind==='page'&&route().id===page.id&&store.getPage(page.id)?.kind==='collection'&&store.isVisible(page.id)&&(ui.views.get(page.id)??'table')==='board'&&(ui.filters.get(page.id)??'')===filter;
    const movable=recordId=>{if(!available())return false;const record=store.getPage(recordId);return!!record&&record.kind==='record'&&record.collectionId===page.id&&store.isVisible(record)&&(!filter||record.properties.status===filter);};
    const droppable=(recordId,targetKey)=>{if(!movable(recordId)||!targets.has(targetKey))return false;const targetStatus=targets.get(targetKey);if(targetKey==='complete-summary'&&completed.open||targetStatus===STATUSES.at(-1)&&targetKey!=='complete-summary'&&!completed.open)return false;return store.getPage(recordId).properties.status!==targetStatus;};
    pendingLocalBoard={root:section,getScope:()=>available()?scope:null,canMove:movable,canDrop:droppable,onCommit:({recordId,targetKey})=>{
      if(!droppable(recordId,targetKey))return false;const record=store.getPage(recordId),text=record.title,status=targets.get(targetKey);
      if(status===STATUSES.at(-1)){completed.open=true;ui.completedOpen.set(page.id,true);}
      try{store.setRecordProperty(recordId,'status',status);}catch(error){notify(error.message);return false;}
      const nextRevision=store.contentRevision;notify(i18n.t('boardDnd.moved',{text}));
      requestAnimationFrame(()=>{if(route().kind!=='page'||route().id!==page.id||store.contentRevision!==nextRevision||modal.open||!document.hasFocus()||document.activeElement&&document.activeElement!==document.body)return;const handle=[...app.querySelectorAll('[data-board-dnd-card]')].find(card=>card.dataset.boardDndCard===recordId)?.querySelector('[data-board-dnd-handle]');(handle||app.querySelector('.board'))?.focus({preventScroll:true});});
      return true;
    },labels:(key,values)=>i18n.t('boardDnd.'+key,values)};
  }
  if (!records.length) section.append(element('div', { class: 'empty-state' }, [element('p', {}, filter ? '条件に一致する項目がありません。' : 'まだ項目がありません。'), filter ? button('絞り込みを解除', () => { ui.filters.set(page.id, ''); render(); }, { class: 'quiet' }) : button('項目を追加', () => openCreate(page.id, 'record'), { class: 'primary', icon: 'plus' })]));
  return section;
}

function renderTrash() {
  const section = element('section', { class: 'trash-page' }, [element('div', { class: 'page-heading' }, [element('div', {}, [element('p', { class: 'eyebrow' }, 'WORKSPACE / TRASH'), element('h1', {}, 'ゴミ箱'), element('p', { class: 'subtitle' }, 'ページを復元すると、子ページの階層も戻ります。')])])]);
  const pages = store.trash();
  if (!pages.length) section.append(element('div', { class: 'empty-state' }, [icon('trash'), element('h2', {}, 'ゴミ箱は空です'), element('p', {}, '削除したページはここから復元できます。')]));
  const list = element('div', { class: 'trash-list' });
  for (const page of pages) {
    const unavailableParent = page.parentId !== null && !store.isVisible(page.parentId);
    list.append(element('div', { class: 'trash-row' }, [icon(page.kind === 'collection' ? 'table' : 'page'), element('div', {}, [element('strong', { 'data-page-title': page.id }, page.title), element('p', { class: 'subtitle' }, `${store.descendants(page.id).length}件の子ページ${unavailableParent ? ' · 元の親ページがないため最上位へ復元' : ''}`)]), button('復元する', () => { const restored = attempt(() => store.restorePage(page.id)); if (restored) notify('ページを復元しました。'); }, { class: 'quiet', icon: 'restore' })]));
  }
  section.append(list);
  return section;
}

function updateNavState() {
  const compact = window.matchMedia('(max-width: 959px)').matches;
  app.querySelector('.app-shell')?.classList.toggle('nav-open', compact && ui.navOpen);
  app.querySelector('.app-shell')?.classList.toggle('nav-collapsed', !compact && ui.navCollapsed);
  const scrim = app.querySelector('.nav-scrim');
  if (scrim) scrim.hidden = !compact || !ui.navOpen;
  const nav = app.querySelector('.page-nav');
  if (nav) nav.inert = compact ? !ui.navOpen : ui.navCollapsed;
  const main = app.querySelector('.workspace-main');
  if (main) main.inert = compact && ui.navOpen;
  app.querySelector('.mobile-nav-toggle')?.setAttribute('aria-expanded', String(compact ? ui.navOpen : !ui.navCollapsed));
  if (compact && ui.navOpen) app.querySelector('.nav-close')?.focus();
}

function updateSaveStatus() {
  const status = app.querySelector('.save-status');
  if (status) { status.textContent = i18n.text(saveLabel()); status.classList.toggle('error', store.status === 'error'); }
  const warning = app.querySelector('.storage-warning');
  if (warning) {
    warning.hidden = !store.error;
    warning.querySelector('p').textContent = i18n.text(store.error);
  }
}

function updateServerStatus() {
  const status = app.querySelector('.server-save-status');
  if (status) { status.hidden = !server.enabled; status.textContent = i18n.text(serverSaveLabel()); }
}

function updatePageLabels(id) {
  const page = store.getPage(id);
  if (!page) return;
  for (const node of app.querySelectorAll('[data-page-title]')) if (node.dataset.pageTitle === id) node.textContent = page.title;
  instanceBrand.apply({kind:document.documentElement.dataset.appearance,titleSuffix:i18n.text('端末内デモ'),pageTitle:route().kind==='page'?store.getPage(route().id)?.title:null});
}

function render(options = {}) {
  const dndGeneration=++localDndGeneration;localBlockDnd?.destroy();localBlockDnd=null;localBoardDnd?.destroy();localBoardDnd=null;pendingLocalBoard=null;localCompositions.clear();
  const previousCompleted = app.querySelector('.completed-records');
  if (previousCompleted) ui.completedOpen.set(previousCompleted.dataset.collection, previousCompleted.open);
  const current = route();
  if (current.kind === 'page' && !store.isVisible(current.id)) { navigate('#trash'); return; }
  const active = document.activeElement;
  const previousFocusKey = active?.dataset?.focus ?? '';
  const focusKey = options.focusKey ?? (app.contains(active) ? active?.dataset?.focus : '') ?? '';
  const inlineSelection = active?.classList?.contains('inline-editor') ? captureInlineSelection(active) : null;
  const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  const shell = element('div', { class: 'app-shell' });
  const main = element('main', { class: 'workspace-main' });
  const content = element('div', { class: 'main-scroll', id: 'workspace-content', tabindex: '-1' });
  const storageWarning = element('div', { class: 'notice storage-warning', role: 'alert', hidden: !store.error }, [element('p', {}, store.error), button('保存を再試行', () => { if (store.flush()) notify('端末に保存しました。'); }, { class: 'quiet' })]);
  content.append(storageWarning);
  if (preferences.snapshot().locale === 'en') content.append(element('p', { class: 'locale-note' }, '英語UIは段階的に追加しています。未翻訳の画面・説明は日本語へ戻ります。ページ名と本文は自動翻訳しません。'));
  if (catalogLoadError) content.append(element('p', { class: 'notice', role: 'status' }, '翻訳カタログを読み込めなかったため、日本語で表示しています。'));
  const page = current.kind === 'page' ? store.getPage(current.id) : null;
  content.classList.add(page ? (page.kind === 'collection' ? 'collection-scroll-area' : 'document-scroll-area') : current.kind === 'trash' ? 'trash-scroll-area' : 'home-scroll-area');
  content.append(current.kind === 'trash' ? renderTrash() : page ? (page.kind === 'collection' ? renderCollection(page) : renderEditor(page)) : renderHome());
  main.append(renderHeader(current), content);
  const scrim = element('button', { class: 'nav-scrim', type: 'button', 'aria-label': 'ページナビゲーションを閉じる', hidden: !ui.navOpen, onClick: () => { ui.navOpen = false; updateNavState(); app.querySelector('.mobile-nav-toggle')?.focus(); } });
  shell.append(renderNavigation(current), main, scrim);
  app.replaceChildren(shell,element('p',{id:'block-dnd-instructions',class:'sr-only'},i18n.t('blockDnd.instructions')),element('p',{id:'block-dnd-status',class:'sr-only',role:'status','aria-live':'polite','aria-atomic':'true'}));
  if(page&&page.kind!=='collection')localBlockDnd=createBlockDnd({root:app,allowInside:false,canStart:blockId=>dndGeneration===localDndGeneration&&!modal.open&&!localCompositions.size&&route().kind==='page'&&route().id===page.id&&store.isVisible(page)&&page.blocks.some(block=>block.id===blockId),getScope:()=>route().kind==='page'?route().id:null,getBlocks:()=>localDndBlocks(page),onCommit:operation=>{
    if(dndGeneration!==localDndGeneration||modal.open||localCompositions.size||!store.isVisible(page)||operation.placement==='inside')return false;
    const ordered=attempt(()=>moveEditorBlockTo(localDndBlocks(page),operation));if(!ordered)return false;const raw=new Map(page.blocks.map(block=>[block.id,block]));rememberLocalSelection(page.id);if(!commitLocalBlocks(page,ordered.map(block=>raw.get(block.id))))return false;
    requestAnimationFrame(()=>[...app.querySelectorAll('.block-row[data-block-id]')].find(row=>row.dataset.blockId===operation.blockId)?.querySelector('[data-block-drag-handle]')?.focus({preventScroll:true}));return true;
  },labels:(key,values)=>i18n.t('blockDnd.'+key,values)});
  if(pendingLocalBoard)localBoardDnd=createBoardDnd(pendingLocalBoard);
  updateNavState();
  instanceBrand.apply({kind:document.documentElement.dataset.appearance,titleSuffix:i18n.text('端末内デモ'),pageTitle:page?.title??null});
  requestAnimationFrame(() => {
    focusByKey(focusKey);
    if (inlineSelection && focusKey && focusKey === previousFocusKey) focusInlineEditor(document.activeElement, { ...inlineSelection, scroll: false });
    if (selection && focusKey && focusKey === previousFocusKey) {
      const focused = document.activeElement;
      if ((focused instanceof HTMLInputElement && focused.type === 'text') || focused instanceof HTMLTextAreaElement) focused.setSelectionRange(selection[0], selection[1]);
    }
  });
}

store.subscribe(event => {
  if (event.field === 'import') localHistories.clear();
  if (event.type !== 'status' && event.field !== 'navigation' && event.pageId && !applyingLocalHistory) {
    const page = store.getPage(event.pageId), history = localHistories.get(event.pageId);
    if (history && page && store.isVisible(page)) {
      try { history.record(cloneLocalDraft(page), { group: event.type === 'content' ? event.field === 'title' ? 'title' : event.focusKey ?? null : null, selection: localSelection() ?? history.current.selection }); }
      catch { localHistories.delete(event.pageId); notify('編集履歴の容量を超えたため履歴をリセットしました。本文は保持しています。'); }
    }
  }
  if (event.type === 'status') updateSaveStatus();
  else if (event.type === 'content') { if (event.field === 'title') updatePageLabels(event.pageId); }
  else render({ focusKey: event.focusKey });
  updateLocalHistoryControls();
});
let serverAutoTimer=null;
function autoSaveServer(){
  if(serverAutoTimer||server.busy||!server.enabled||!server.authenticated||!server.remoteLoaded||server.savedContentRevision===null||server.status!=='dirty')return;
  if(!Number.isSafeInteger(server.remote?.revision))return;
  serverAutoTimer=setTimeout(()=>{
    serverAutoTimer=null;
    const expected=server.remote?.revision;
    if(server.busy||server.status!=='dirty'||!Number.isSafeInteger(expected))return;
    // The bridge keeps the terminal copy on failure; only a confirmed save
    // advances the revision, so a later keystroke retries from a fresh basis.
    void server.saveCurrent(expected).catch(()=>{}).finally(()=>{if(server.status==='dirty')autoSaveServer();});
  },1200);
}
server.subscribe(()=>{updateServerStatus();autoSaveServer();});
preferences.subscribe(() => { applyPreferences(); render(); });

window.addEventListener('hashchange', () => {
  const current = route();
  ui.navOpen = false;
  if (current.kind === 'page' && store.isVisible(current.id)) {
    let page = store.getPage(current.id);
    while (page.parentId) { ui.expanded.add(page.parentId); page = store.getPage(page.parentId); }
    store.visitPage(current.id, window.location.hash);
  }
  render({ focusKey: ui.focusKey });
  ui.focusKey = '';
});
document.addEventListener('keydown', event => {
  if (!event.isComposing && event.keyCode !== 229 && !event.altKey && !modal.open && (event.metaKey || event.ctrlKey) && document.activeElement?.matches('.inline-editor,.page-title-input')) {
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y') {
      if (applyLocalHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo')) event.preventDefault();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
  if (event.key === 'Escape' && !modal.open) {
    if(localBoardDnd?.active||localBlockDnd?.active)return;
    if (ui.navOpen) { ui.navOpen = false; updateNavState(); app.querySelector('.mobile-nav-toggle')?.focus(); }
    for (const details of app.querySelectorAll('details[open]')) details.open = false;
  }
});
window.addEventListener('resize', updateNavState);
window.addEventListener('pagehide',()=>{localBoardDnd?.destroy();localBlockDnd?.destroy();});
window.addEventListener('beforeunload', () => store.flush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flush(); });

if (!window.location.hash && store.data.ui.lastRoute.startsWith('#page/')) {
  try { if (store.isVisible(decodeURIComponent(store.data.ui.lastRoute.slice(6)))) window.location.hash = store.data.ui.lastRoute; } catch { /* Leave an unreadable saved route at home. */ }
}
applyPreferences();
render();
server.initialize();

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>instanceBrand?.apply({kind})});
