import { validateInlineMarks, rebaseInlineMarks } from './inline-text.js';
export const STORAGE_KEY = 'yumunio.local-demo.v1';
export const BACKUP_KEY = 'yumunio.local-demo.backup.v1';
export const SCHEMA_VERSION = 1;
export const MAX_IMPORT_BYTES = 900000;
export const BLOCK_TYPES = ['paragraph', 'heading1', 'heading2', 'heading3', 'checklist', 'bulleted-list', 'numbered-list', 'quote', 'divider', 'code'];
export const STATUSES = ['準備', '進行中', 'レビュー', '完了'];
export const OWNERS = ['未設定', 'Aoi', 'Ren', 'Mika', 'Haru'];

const timestamp = () => new Date().toISOString();
const identifier = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const plainClone = value => JSON.parse(JSON.stringify(value));
const string = value => typeof value === 'string';
const validDate = value => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

function block(id, type, text, checked = false) {
  return { id, type, text, checked };
}

export function createDemoWorkspace() {
  const now = timestamp();
  const page = (id, title, parentId = null, kind = 'document', blocks = []) => ({ id, title, parentId, kind, blocks, deletedAt: null, createdAt: now, updatedAt: now });
  const pages = [
    page('page-spec', 'プロダクト仕様', null, 'document', [
      block('spec-intro', 'paragraph', '知識とタスクをひとつにつなぐ。チームに合った場所で運用できるワークスペースを考えています。'),
      block('spec-goal', 'heading1', '目的'),
      block('spec-body', 'paragraph', 'メモ、仕様書、プロジェクトの情報を整理し、必要な情報を見つけやすくします。これは端末内で操作を試すための架空の内容です。'),
      block('spec-todo', 'heading2', 'まず確認すること'),
      block('spec-check-1', 'checklist', 'ページの作成と編集を試す', true),
      block('spec-check-2', 'checklist', 'コレクションで担当と期限を整理する'),
      block('spec-check-3', 'checklist', '削除したページをゴミ箱から復元する')
    ]),
    page('page-guide', 'はじめに', 'page-spec', 'document', [
      block('guide-title', 'heading1', '自分たちの知識を、自分たちの場所に。'),
      block('guide-body', 'paragraph', '左側のページから作業を開きます。ブロックの追加や種類の変更はメニューから行えます。空のブロックで / を入力しても追加メニューが開きます。'),
      block('guide-local', 'paragraph', '変更はブラウザーの localStorage に自動保存します。対応環境では「このサーバーに保存」から手動で保存・読み込みできます。共同編集と自動同期はありません。')
    ]),
    page('collection-roadmap', 'チームのロードマップ', null, 'collection'),
    page('page-meeting', 'ミーティングノート', null, 'document', [
      block('meeting-heading', 'heading1', 'プロジェクトレビュー'),
      block('meeting-purpose', 'paragraph', 'ページ編集と、保存・検索・コレクションの操作を確認します。'),
      block('meeting-actions', 'heading2', '次のアクション'),
      block('meeting-check', 'checklist', 'Aoi と Ren が編集の流れを確認する')
    ])
  ];
  const tasks = [
    ['task-blocks', 'ブロック編集の基礎', '進行中', 'Aoi', '2026-10-16'],
    ['task-sharing', '共有と権限の設計', 'レビュー', 'Ren', '2026-10-17'],
    ['task-search', '検索と挿入メニュー', '準備', 'Mika', '2026-10-19'],
    ['task-table', '表ビューのセル操作', '進行中', 'Haru', '2026-10-20'],
    ['task-board', 'ボードの状態移動', '準備', 'Aoi', '2026-10-21'],
    ['task-mobile', 'モバイル編集の調整', '準備', 'Ren', '2026-10-23'],
    ['task-backup', 'バックアップの導線', 'レビュー', 'Mika', '2026-10-26'],
    ['task-import', 'インポートの形式確認', '完了', 'Haru', '2026-10-27']
  ];
  for (const [id, title, status, owner, date] of tasks) {
    pages.push({ ...page(id, title, 'collection-roadmap', 'record', [block(`${id}-body`, 'paragraph', 'この項目のメモをここに書けます。内容と担当者は架空のサンプルです。')]), collectionId: 'collection-roadmap', properties: { status, owner, date } });
  }
  return { schemaVersion: SCHEMA_VERSION, name: 'チームスペース', pages, ui: { recentPageIds: ['page-spec', 'collection-roadmap', 'page-meeting'], lastRoute: '#home' }, updatedAt: now };
}

function validateWorkspace(data) {
  if (!data || data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.pages) || !string(data.name)) throw new Error('保存データの形式がこのデモに対応していません。');
  const ids = new Set();
  const blockIds = new Set();
  for (const page of data.pages) {
    if (!page || !string(page.id) || ids.has(page.id) || !string(page.title) || !['document', 'collection', 'record'].includes(page.kind) || !(page.parentId === null || string(page.parentId)) || !Array.isArray(page.blocks) || !(page.deletedAt === null || string(page.deletedAt))) throw new Error('保存したページを読み込めませんでした。');
    ids.add(page.id);
    for (const item of page.blocks) {
      if (!item || !string(item.id) || blockIds.has(item.id) || !BLOCK_TYPES.includes(item.type) || !string(item.text) || typeof item.checked !== 'boolean') throw new Error('保存したブロックを読み込めませんでした。');
      if(item.type==='divider'&&item.text!=='')throw new Error('INVALID_DIVIDER_TEXT');
      if (Object.hasOwn(item,'start') && (item.type!=='numbered-list'||!Number.isSafeInteger(item.start)||item.start<1||item.start>999999999)) throw new Error('INVALID_BLOCK_START');
      if (Object.hasOwn(item,'language') && (item.type!=='code'||typeof item.language!=='string'||!/^[A-Za-z0-9_+.#-]{1,100}$/.test(item.language))) throw new Error('INVALID_BLOCK_LANGUAGE');
      if (Object.hasOwn(item,'children')) throw new Error('NESTED_BLOCKS_UNSUPPORTED');
      blockIds.add(item.id);
      if (Object.hasOwn(item, 'marks')) validateInlineMarks(item.text, item.marks);
    }
    if (page.kind === 'record' && (!page.properties || !STATUSES.includes(page.properties.status) || !OWNERS.includes(page.properties.owner) || !string(page.properties.date) || !validDate(page.properties.date))) throw new Error('保存した項目の型を確認できませんでした。');
  }
  const byId = new Map(data.pages.map(page => [page.id, page]));
  for (const page of data.pages) {
    let current = page;
    const ancestors = new Set();
    while (current.parentId !== null) {
      if (ancestors.has(current.id) || !byId.has(current.parentId)) throw new Error('ページの階層を確認できませんでした。');
      ancestors.add(current.id);
      current = byId.get(current.parentId);
    }
  }
  data.ui ??= { recentPageIds: [], lastRoute: '#home' };
  if (!Array.isArray(data.ui.recentPageIds)) data.ui.recentPageIds = [];
  data.ui.recentPageIds = data.ui.recentPageIds.filter(string);
  if (!string(data.ui.lastRoute)) data.ui.lastRoute = '#home';
  return data;
}

export function validatePortableWorkspace(value) {
  let raw;
  try { raw = JSON.stringify(value); } catch { throw new Error('保存内容をJSONとして読み込めませんでした。'); }
  if (!raw || new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) throw new Error('JSONは900,000バイト以下にしてください。');
  const data = JSON.parse(raw);
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) === Object.prototype;
  const fields = (item, allowed) => object(item) && Object.keys(item).every(key => allowed.includes(key));
  const shortString = (item, length) => string(item) && item.length <= length;
  const id = item => string(item) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item);
  const time = item => string(item) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && !Number.isNaN(Date.parse(item)) && new Date(item).toISOString() === item;
  if (!fields(data, ['schemaVersion', 'name', 'pages', 'ui', 'updatedAt']) || data.schemaVersion !== SCHEMA_VERSION || !shortString(data.name, 200) || !Array.isArray(data.pages) || data.pages.length > 1000 || !time(data.updatedAt)) throw new Error('YumunioのschemaVersion 1のJSONを選んでください。ページは1,000件までです。');
  let totalBlocks = 0;
  for (const page of data.pages) {
    if (!fields(page, ['id', 'title', 'parentId', 'kind', 'blocks', 'deletedAt', 'createdAt', 'updatedAt', 'collectionId', 'properties']) || !id(page.id) || !shortString(page.title, 500) || !(page.parentId === null || id(page.parentId)) || !Array.isArray(page.blocks) || page.blocks.length > 2000 || !(page.deletedAt === null || time(page.deletedAt)) || !time(page.createdAt) || !time(page.updatedAt)) throw new Error('ページのID・日時・タイトル・ブロック数を確認してください。');
    totalBlocks += page.blocks.length;
    if (totalBlocks > 20000) throw new Error('ブロックは全体で20,000件までです。');
    for (const item of page.blocks) if (!fields(item, ['id', 'type', 'text', 'checked', 'marks', 'start', 'language']) || !id(item.id) || !shortString(item.text, 100000)) throw new Error('ブロックのID・本文・保存項目を確認してください。');
    if (page.kind === 'record') {
      if (!(page.collectionId === null || id(page.collectionId)) || !fields(page.properties, ['status', 'owner', 'date'])) throw new Error('項目の所属コレクションとプロパティを確認してください。');
    } else if (page.collectionId !== undefined || page.properties !== undefined) throw new Error('コレクションのプロパティは項目だけに設定できます。');
  }
  if (!fields(data.ui, ['recentPageIds', 'lastRoute']) || !Array.isArray(data.ui.recentPageIds) || data.ui.recentPageIds.length > 8 || !data.ui.recentPageIds.every(id) || !shortString(data.ui.lastRoute, 256) || !/^#(?:home|trash|page\/[A-Za-z0-9._:-]+)$/.test(data.ui.lastRoute)) throw new Error('ページナビゲーションの保存形式を確認してください。');
  validateWorkspace(data);
  const byId = new Map(data.pages.map(page => [page.id, page]));
  for (const page of data.pages) if (page.kind === 'record' && (page.collectionId !== page.parentId || (page.collectionId !== null && byId.get(page.collectionId)?.kind !== 'collection'))) throw new Error('項目は親のコレクションに所属させるか、最上位に復元した形式にしてください。');
  return data;
}

export function parseWorkspaceJSON(text) {
  if (!string(text) || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('JSONは900,000バイト以下にしてください。');
  let snapshot;
  try { snapshot = JSON.parse(text); } catch { throw new Error('JSONを読み込めませんでした。Yumunioから書き出したJSONを指定してください。'); }
  return validatePortableWorkspace(snapshot);
}

export class LocalWorkspaceStore {
  constructor(options = {}) {
    this.key = options.key ?? STORAGE_KEY;
    this.listeners = new Set();
    this.status = 'saved';
    this.error = '';
    this.saveTimer = null;
    this.contentRevision = 0;
    this.preserveUnreadableData = false;
    try {
      this.storage = options.storage ?? globalThis.localStorage;
      if (!this.storage) throw new Error('ブラウザーの保存領域を利用できません。');
      const raw = this.storage.getItem(this.key);
      if (raw === null) {
        this.data = createDemoWorkspace();
        this.flush();
      } else {
        try {
          this.data = validateWorkspace(JSON.parse(raw));
        } catch (error) {
          this.data = createDemoWorkspace();
          this.preserveUnreadableData = true;
          this.status = 'error';
          this.error = `${error.message} 元の保存データを保持し、この画面では一時的なデモを表示しています。`;
        }
      }
    } catch (error) {
      this.data ??= createDemoWorkspace();
      this.status = 'error';
      this.error = '端末に保存できません。変更はこの画面のメモリ内にだけ残ります。';
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, detail = {}) {
    for (const listener of this.listeners) listener({ type, ...detail });
  }

  queueSave(type = 'change', detail = {}) {
    if (detail.field !== 'navigation') this.contentRevision += 1;
    this.data.updatedAt = timestamp();
    this.status = 'saving';
    this.emit(type, detail);
    this.emit('status');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 220);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      if (this.preserveUnreadableData) throw new Error('既存の保存データを上書きしないため、一時的なデモは保存していません。');
      if (!this.storage) throw new Error('ブラウザーの保存領域を利用できません。');
      this.storage.setItem(this.key, JSON.stringify(this.data));
      this.status = 'saved';
      this.error = '';
      this.emit('status');
      return true;
    } catch (error) {
      this.status = 'error';
      this.error = this.preserveUnreadableData ? error.message : '端末に保存できませんでした。変更はメモリ内に残っています。';
      this.emit('status');
      return false;
    }
  }

  snapshot() { return plainClone(this.data); }

  backupSnapshot() {
    if (!this.storage) return null;
    const raw = this.storage.getItem(BACKUP_KEY);
    if (raw === null) return null;
    const backup = JSON.parse(raw);
    if (backup?.backupVersion !== 1 || !string(backup.createdAt)) throw new Error('端末のバックアップを読み込めませんでした。');
    return { createdAt: backup.createdAt, snapshot: validateWorkspace(plainClone(backup.snapshot)) };
  }

  replaceWithBackup(snapshot) {
    const next = validatePortableWorkspace(snapshot);
    if (this.preserveUnreadableData) throw new Error('元の保存データを保護しているため、サーバーの内容を開けません。先に現在の内容をダウンロードしてください。');
    if (!this.storage) throw new Error('端末にバックアップを保存できないため、内容を置き換えませんでした。');
    const previous = { backupVersion: 1, createdAt: timestamp(), snapshot: this.snapshot() };
    try {
      this.storage.setItem(BACKUP_KEY, JSON.stringify(previous));
      this.storage.setItem(this.key, JSON.stringify(next));
    } catch {
      throw new Error('端末に保存できないため、現在の内容を置き換えませんでした。JSONをダウンロードして容量を確認してください。');
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.data = next;
    this.contentRevision += 1;
    this.status = 'saved';
    this.error = '';
    this.emit('change', { field: 'import' });
    this.emit('status');
    return previous;
  }
  getPage(id) { return this.data.pages.find(page => page.id === id); }

  isVisible(pageOrId) {
    let page = typeof pageOrId === 'string' ? this.getPage(pageOrId) : pageOrId;
    const visited = new Set();
    while (page) {
      if (page.deletedAt || visited.has(page.id)) return false;
      visited.add(page.id);
      if (page.parentId === null) return true;
      page = this.getPage(page.parentId);
    }
    return false;
  }

  listPages() { return this.data.pages.filter(page => this.isVisible(page)); }
  listRecords(collectionId) { return this.listPages().filter(page => page.kind === 'record' && page.collectionId === collectionId); }
  children(parentId) { return this.listPages().filter(page => page.parentId === parentId); }
  trash() { return this.data.pages.filter(page => page.deletedAt); }

  descendants(id) {
    const found = [];
    const visit = parentId => {
      for (const child of this.data.pages.filter(page => page.parentId === parentId)) {
        found.push(child);
        visit(child.id);
      }
    };
    visit(id);
    return found;
  }

  requirePage(id) {
    const page = this.getPage(id);
    if (!page || !this.isVisible(page)) throw new Error('このページは表示できません。');
    return page;
  }

  createPage(title = '無題のページ', parentId = null, kind = 'document') {
    if (!['document', 'collection', 'record'].includes(kind)) throw new Error('ページの種類を確認してください。');
    const parent = parentId === null ? null : this.requirePage(parentId);
    if (kind === 'record' && parent?.kind !== 'collection') throw new Error('項目の作成先はコレクションを選んでください。');
    if (kind === 'document' && parent?.kind === 'collection') kind = 'record';
    const now = timestamp();
    const page = { id: identifier('page'), title: title.trim() || '無題のページ', parentId, kind, blocks: kind === 'collection' ? [] : [block(identifier('block'), 'paragraph', '')], deletedAt: null, createdAt: now, updatedAt: now };
    if (kind === 'record') {
      page.collectionId = parentId;
      page.properties = { status: '準備', owner: '未設定', date: '' };
    }
    this.data.pages.push(page);
    this.queueSave('change', { pageId: page.id });
    return page;
  }

  updatePageTitle(id, value) {
    const page = this.requirePage(id);
    page.title = value.trim() || '無題のページ';
    page.updatedAt = timestamp();
    this.queueSave('content', { pageId: id, field: 'title' });
  }

  setPageDocument(id, { title, blocks } = {}) {
    const page = this.requirePage(id);
    if (page.kind === 'collection') throw new Error('コレクションの項目を開いて本文を編集してください。');
    if (typeof title !== 'string' || !Array.isArray(blocks) || !blocks.length) throw new Error('ページのタイトルと本文を確認してください。');
    const candidate = this.snapshot();
    const next = candidate.pages.find(item => item.id === id);
    next.title = title.trim() || '無題のページ';
    next.blocks = plainClone(blocks);
    next.updatedAt = timestamp();
    const validated = validatePortableWorkspace(candidate).pages.find(item => item.id === id);
    page.title = validated.title;
    page.blocks = validated.blocks;
    page.updatedAt = validated.updatedAt;
    this.queueSave('change', { pageId: id, field: 'document' });
    return page;
  }

  deletePage(id) {
    const page = this.requirePage(id);
    page.deletedAt = timestamp();
    page.updatedAt = page.deletedAt;
    this.queueSave('change', { pageId: id });
  }

  restorePage(id) {
    const page = this.getPage(id);
    if (!page?.deletedAt) throw new Error('復元するページを確認してください。');
    if (page.parentId !== null && !this.isVisible(page.parentId)) {
      page.parentId = null;
      if (page.kind === 'record') page.collectionId = null;
    }
    page.deletedAt = null;
    page.updatedAt = timestamp();
    this.queueSave('change', { pageId: id });
    return page;
  }

  addBlock(pageId, type = 'paragraph', index, text = '') {
    if (!BLOCK_TYPES.includes(type)) throw new Error('ブロックの種類を確認してください。');
    const page = this.requirePage(pageId);
    if (page.kind === 'collection') throw new Error('コレクションの項目を開いて本文を編集してください。');
    if(type==='divider'&&String(text)!=='')throw new Error('INVALID_DIVIDER_TEXT');
    const next = block(identifier('block'), type, String(text));
    page.blocks.splice(index ?? page.blocks.length, 0, next);
    page.updatedAt = timestamp();
    this.queueSave('change', { pageId, focusKey: `block:${next.id}` });
    return next;
  }

  updateBlock(pageId, blockId, changes) {
    const page = this.requirePage(pageId);
    const item = page.blocks.find(candidate => candidate.id === blockId);
    if (!item) throw new Error('ブロックが見つかりません。');
    if (changes.type !== undefined) {
      if (!BLOCK_TYPES.includes(changes.type)) throw new Error('ブロックの種類を確認してください。');

    }
    const nextText = changes.text === undefined ? item.text : String(changes.text);
    if((changes.type??item.type)==='divider'&&nextText!=='')throw new Error('INVALID_DIVIDER_TEXT');
    const nextMarks = Object.hasOwn(changes, 'marks') ? validateInlineMarks(nextText, changes.marks) : rebaseInlineMarks(item.text, nextText, item.marks || []);
    if (changes.type !== undefined) {
      item.type = changes.type;
      if(item.type!=='numbered-list')delete item.start;
      if(item.type!=='code')delete item.language;
    }
    item.text = nextText;
    if (nextMarks.length) item.marks = nextMarks; else delete item.marks;
    if (changes.checked !== undefined) item.checked = Boolean(changes.checked);
    page.updatedAt = timestamp();
    this.queueSave(changes.type !== undefined || changes.format === true ? 'change' : 'content', { pageId, focusKey: `block:${blockId}` });
  }

  moveBlock(pageId, blockId, direction) {
    const page = this.requirePage(pageId);
    const index = page.blocks.findIndex(item => item.id === blockId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= page.blocks.length) return;
    [page.blocks[index], page.blocks[target]] = [page.blocks[target], page.blocks[index]];
    page.updatedAt = timestamp();
    this.queueSave('change', { pageId, focusKey: `block:${blockId}` });
  }

  removeBlock(pageId, blockId) {
    const page = this.requirePage(pageId);
    const index = page.blocks.findIndex(item => item.id === blockId);
    if (index < 0) return;
    page.blocks.splice(index, 1);
    if (!page.blocks.length) page.blocks.push(block(identifier('block'), 'paragraph', ''));
    page.updatedAt = timestamp();
    this.queueSave('change', { pageId, focusKey: `block:${page.blocks[Math.min(index, page.blocks.length - 1)].id}` });
  }

  setRecordProperty(id, key, value) {
    const page = this.requirePage(id);
    if (page.kind !== 'record') throw new Error('項目を選んでください。');
    if (key === 'status' && !STATUSES.includes(value)) throw new Error('状態を選んでください。');
    if (key === 'owner' && !OWNERS.includes(value)) throw new Error('担当を選んでください。');
    if (key === 'date' && (!string(value) || !validDate(value))) throw new Error('期限は有効な日付を指定してください。');
    if (!['status', 'owner', 'date'].includes(key)) throw new Error('プロパティが見つかりません。');
    page.properties[key] = value;
    page.updatedAt = timestamp();
    this.queueSave('change', { pageId: id });
  }

  visitPage(id, route) {
    this.requirePage(id);
    this.data.ui.recentPageIds = [id, ...this.data.ui.recentPageIds.filter(existing => existing !== id)].slice(0, 8);
    this.data.ui.lastRoute = route;
    this.queueSave('content', { pageId: id, field: 'navigation' });
  }
}

class WorkspaceApiError extends Error {
  constructor(message, status = 0, actualRevision = null) {
    super(message);
    this.status = status;
    this.actualRevision = actualRevision;
  }
}

function validateEnvelope(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || (value.revision === 0 ? value.snapshot !== null : !value.snapshot)) throw new Error('サーバーの保存形式を確認できませんでした。端末の内容は維持しています。');
  return { revision: value.revision, snapshot: value.snapshot === null ? null : validatePortableWorkspace(value.snapshot) };
}

export class WorkspacePersistenceBridge {
  constructor(store, options = {}) {
    this.store = store;
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 12000;
    this.listeners = new Set();
    this.enabled = false;
    this.storageType = null;
    this.authentication = 'none';
    this.authenticated = false;
    this.status = 'checking';
    this.error = '';
    this.remote = null;
    this.remoteLoaded = false;
    this.busy = false;
    this.savedContentRevision = null;
    this.lastAction = '';
    this.store.subscribe(event => {
      if (event.type !== 'status' && event.field !== 'navigation' && this.savedContentRevision !== null && !this.busy && this.status === 'saved') {
        this.status = 'dirty';
        this.emit();
      }
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() { for (const listener of this.listeners) listener(); }

  async request(path, options = {}) {
    if (!this.fetch) throw new WorkspaceApiError('このブラウザーではサーバー保存を利用できません。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      const raw = await response.text();
      let value = null;
      try { if (raw) value = JSON.parse(raw); } catch { if (response.ok) throw new WorkspaceApiError('サーバーの応答を読み込めませんでした。'); }
      if (!response.ok) {
        if (response.status === 401) {
          this.authenticated = false;
          this.remoteLoaded = false;
          throw new WorkspaceApiError('アクセスキーを入力してください。接続期限が切れた場合も再入力が必要です。', 401);
        }
        if (response.status === 409) {
          const actualRevision = value?.error?.details?.actualRevision ?? value?.actualRevision;
          throw new WorkspaceApiError('別の保存が先に行われました。手元の編集を維持しています。最新版を確認してから操作を選んでください。', 409, Number.isSafeInteger(actualRevision) ? actualRevision : null);
        }
        if (response.status === 413) throw new WorkspaceApiError('保存する内容がサーバーの容量制限を超えています。端末の内容は維持しています。', 413);
        throw new WorkspaceApiError(`サーバーの操作に失敗しました（${response.status}）。端末の内容は維持しています。`, response.status);
      }
      return value;
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(error.name === 'AbortError' ? 'サーバーへの接続が時間切れになりました。端末の内容は維持しています。' : 'サーバーに接続できません。端末の内容は維持しています。');
    } finally { clearTimeout(timer); }
  }

  async initialize() {
    this.status = 'checking';
    this.emit();
    try {
      const capability = await this.request('/api/capabilities');
      this.enabled = ['sqlite', 'd1', 'mariadb', 'mysql', 'tidb', 'postgres'].includes(capability?.storage) && capability.workspaceSync === true && ['none', 'access-key'].includes(capability.authentication);
      this.storageType = this.enabled ? capability.storage : null;
      this.authentication = capability?.authentication === 'access-key' ? 'access-key' : 'none';
      this.authenticated = this.enabled && (this.authentication === 'none' || capability.authenticated === true);
      this.status = this.enabled ? (this.authenticated ? 'ready' : 'signin') : 'unavailable';
      this.error = '';
    } catch {
      this.enabled = false;
      this.storageType = null;
      this.status = 'unavailable';
      this.error = '';
    }
    this.emit();
    return this.enabled;
  }

  requireAccess() {
    if (!this.enabled) throw new Error('この環境は端末内保存で利用します。');
    if (!this.authenticated) throw new WorkspaceApiError('アクセスキーを入力してください。', 401);
    if (this.busy) throw new Error('進行中のサーバー操作が終わるまでお待ちください。');
  }

  async signIn(accessKey) {
    if (!this.enabled || this.busy) throw new Error('現在サーバーへ接続できません。');
    if (typeof accessKey !== 'string' || !accessKey.trim()) throw new Error('アクセスキーを入力してください。');
    this.busy = true;
    this.error = '';
    this.emit();
    try {
      await this.request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey }) });
      await this.initialize();
      if (!this.authenticated) throw new WorkspaceApiError('サーバーへの接続を確認できませんでした。', 401);
    } catch (error) {
      this.status = 'signin';
      this.error = error.message;
      throw error;
    } finally { this.busy = false; this.emit(); }
  }

  async signOut() {
    this.requireAccess();
    this.busy = true;
    this.emit();
    try {
      await this.request('/api/session', { method: 'DELETE' });
      this.authenticated = false;
      this.remoteLoaded = false;
      this.remote = null;
      this.savedContentRevision = null;
      this.status = 'signin';
      this.error = '';
    } catch (error) {
      this.error = error.message;
      this.status = error.status === 401 ? 'signin' : 'error';
      throw error;
    } finally { this.busy = false; this.emit(); }
  }

  async refresh({ conflict = false } = {}) {
    this.requireAccess();
    const previousRevision = this.remote?.revision;
    this.busy = true;
    this.remoteLoaded = false;
    this.status = 'loading';
    if (!conflict) this.error = '';
    this.emit();
    try {
      this.remote = validateEnvelope(await this.request('/api/workspace/snapshot'));
      this.remoteLoaded = true;
      if (!conflict && this.savedContentRevision !== null && this.remote.revision === previousRevision) this.status = this.store.contentRevision === this.savedContentRevision ? 'saved' : 'dirty';
      else {
        this.status = conflict ? 'conflict' : 'review';
        this.savedContentRevision = null;
      }
      return plainClone(this.remote);
    } catch (error) {
      this.status = error.status === 401 ? 'signin' : 'error';
      this.error = error.message;
      throw error;
    } finally { this.busy = false; this.emit(); }
  }

  async saveCurrent(expectedRevision) {
    this.requireAccess();
    if (!this.remoteLoaded || this.remote.revision !== expectedRevision) throw new Error('サーバーの最新版を確認してから、保存する内容を選んでください。');
    const snapshot = validatePortableWorkspace(this.store.snapshot());
    const contentRevision = this.store.contentRevision;
    this.busy = true;
    this.status = 'saving';
    this.error = '';
    this.emit();
    let failure = null;
    try {
      const remote = validateEnvelope(await this.request('/api/workspace/snapshot', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, snapshot }) }));
      if (remote.revision !== expectedRevision + 1 || remote.snapshot === null) throw new Error('サーバーの保存結果を確認できませんでした。最新版を確認してください。');
      this.remote = remote;
      this.remoteLoaded = true;
      this.savedContentRevision = contentRevision;
      this.lastAction = 'save';
      this.status = this.store.contentRevision === contentRevision ? 'saved' : 'dirty';
      return plainClone(remote);
    } catch (error) {
      failure = error;
      this.remoteLoaded = false;
      this.error = error.message;
      this.status = error.status === 401 ? 'signin' : error.status === 409 ? 'conflict' : 'error';
    } finally { this.busy = false; this.emit(); }
    if (failure?.status === 409) {
      try { await this.refresh({ conflict: true }); } catch { /* Keep local content when the conflict preview is unavailable. */ }
    }
    throw failure;
  }

  importRemote(expectedRevision) {
    this.requireAccess();
    if (!this.remoteLoaded || this.remote.revision !== expectedRevision || this.remote.snapshot === null) throw new Error('開くサーバーの内容を確認してください。');
    const backup = this.store.replaceWithBackup(this.remote.snapshot);
    this.savedContentRevision = this.store.contentRevision;
    this.lastAction = 'import';
    this.status = 'saved';
    this.error = '';
    this.emit();
    return backup;
  }
}
