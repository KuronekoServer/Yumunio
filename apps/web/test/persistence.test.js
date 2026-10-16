import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWorkspaceStore, WorkspacePersistenceBridge, STORAGE_KEY, BACKUP_KEY, createDemoWorkspace, parseWorkspaceJSON, validatePortableWorkspace, MAX_IMPORT_BYTES } from '../public/store.js';
import { validateSnapshot } from '../../../packages/prototype/src/index.js';

class MemoryStorage {
  constructor() { this.values = new Map(); this.failKey = null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === this.failKey) throw new Error('Storage quota exhausted');
    this.values.set(key, value);
  }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const capabilities = (storage = 'sqlite', authenticated = true, authentication = 'none') => ({ storage, workspaceSync: true, authentication, authenticated });
const remoteWorkspace = () => ({ ...createDemoWorkspace(), name: 'Remote workspace' });

function fixture(responses = []) {
  const storage = new MemoryStorage();
  const store = new LocalWorkspaceStore({ storage });
  const calls = [];
  const bridge = new WorkspacePersistenceBridge(store, { fetch: async (path, options) => {
    calls.push({ path, ...options });
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${path}`);
    return typeof response === 'function' ? response(path, options) : response;
  } });
  return { store, storage, bridge, calls, responses };
}

test('startup probes capabilities and preserves local data for every supported storage backend', async () => {
  for (const storageType of ['sqlite', 'd1', 'mariadb', 'mysql', 'tidb', 'postgres']) {
    const { store, bridge, calls } = fixture([json(capabilities(storageType))]);
    const original = store.snapshot();
    assert.equal(await bridge.initialize(), true);
    assert.equal(bridge.storageType, storageType);
    assert.equal(bridge.remoteLoaded, false);
    assert.deepEqual(store.snapshot(), original);
    assert.deepEqual(calls.map(call => call.path), ['/api/capabilities']);
  }
});

test('unsupported or unavailable API leaves browser-local editing usable', async () => {
  for (const response of [json({ storage: 'memory', workspaceSync: false }), json({ error: 'NOT_FOUND' }, 404), () => { throw new TypeError('Network unavailable'); }]) {
    const { store, bridge, calls } = fixture([response]);
    assert.equal(await bridge.initialize(), false);
    assert.equal(bridge.status, 'unavailable');
    const page = store.createPage('Still local');
    assert.equal(store.flush(), true);
    assert.equal(store.requirePage(page.id).title, 'Still local');
    assert.equal(calls.length, 1);
  }
});

test('remote preview never replaces or saves local workspace', async () => {
  const remote = remoteWorkspace();
  const { store, bridge, calls } = fixture([json(capabilities()), json({ revision: 4, snapshot: remote })]);
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  assert.deepEqual(store.snapshot(), original);
  assert.equal(bridge.remote.snapshot.name, remote.name);
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
});

test('manual first save sends one CAS request and preserves literal text', async () => {
  const { store, bridge, calls, responses } = fixture([json(capabilities()), json({ revision: 0, snapshot: null }), (_path, options) => {
    const { expectedRevision, snapshot } = JSON.parse(options.body);
    assert.equal(expectedRevision, 0);
    assert.equal(snapshot.pages.find(page => page.id === 'page-spec').blocks[0].text, '<img src=x onerror=alert(1)>');
    return json({ revision: 1, snapshot });
  }]);
  store.updateBlock('page-spec', 'spec-intro', { text: '<img src=x onerror=alert(1)>' });
  store.flush();
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  await bridge.saveCurrent(0);
  assert.equal(bridge.status, 'saved');
  assert.deepEqual(store.snapshot(), original);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  store.visitPage('page-spec', '#page/page-spec');
  store.flush();
  assert.equal(bridge.status, 'saved');
  store.updateBlock('page-spec', 'spec-intro', { text: 'Unsaved server edit' });
  store.flush();
  assert.equal(bridge.status, 'dirty');
  responses.push(json(bridge.remote));
  await bridge.refresh();
  assert.equal(bridge.status, 'dirty');
  responses.push(json({ revision: 2, snapshot: remoteWorkspace() }));
  await bridge.refresh();
  assert.equal(bridge.status, 'review');
  assert.equal(bridge.savedContentRevision, null);
});

test('edits made while save is pending remain local and mark server as dirty', async () => {
  let finish;
  const pendingResponse = new Promise(resolve => { finish = resolve; });
  const { store, bridge } = fixture([json(capabilities()), json({ revision: 0, snapshot: null }), async (_path, options) => {
    const body = JSON.parse(options.body);
    await pendingResponse;
    return json({ revision: 1, snapshot: body.snapshot });
  }]);
  await bridge.initialize();
  await bridge.refresh();
  const save = bridge.saveCurrent(0);
  store.updateBlock('page-spec', 'spec-intro', { text: 'A newer local edit' });
  store.flush();
  finish();
  await save;
  assert.equal(store.getPage('page-spec').blocks[0].text, 'A newer local edit');
  assert.notEqual(bridge.remote.snapshot.pages.find(page => page.id === 'page-spec').blocks[0].text, 'A newer local edit');
  assert.equal(bridge.status, 'dirty');
});

test('409 refreshes remote preview without retrying or losing local edits', async () => {
  const { store, bridge, calls, responses } = fixture([json(capabilities()), json({ revision: 1, snapshot: remoteWorkspace() }), json({ error: { code: 'VERSION_CONFLICT', details: { actualRevision: 2 } } }, 409), json({ revision: 2, snapshot: remoteWorkspace() })]);
  store.updatePageTitle('page-spec', 'My local title');
  store.flush();
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  await assert.rejects(bridge.saveCurrent(1), error => error.status === 409 && error.actualRevision === 2 && /別の保存/.test(error.message));
  assert.equal(bridge.status, 'conflict');
  assert.equal(bridge.remote.revision, 2);
  assert.deepEqual(store.snapshot(), original);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  await assert.rejects(bridge.saveCurrent(1), /最新版/);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  responses.push((_path, options) => json({ revision: 3, snapshot: JSON.parse(options.body).snapshot }));
  await bridge.saveCurrent(2);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
});

test('network failure preserves local changes and requires fresh preview before retry', async () => {
  const { store, bridge, calls } = fixture([json(capabilities()), json({ revision: 0, snapshot: null }), () => { throw new TypeError('Offline'); }]);
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  await assert.rejects(bridge.saveCurrent(0), /接続できません/);
  assert.deepEqual(store.snapshot(), original);
  assert.equal(bridge.remoteLoaded, false);
  await assert.rejects(bridge.saveCurrent(0), /最新版/);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

test('invalid remote snapshot cannot overwrite local workspace', async () => {
  const invalid = remoteWorkspace();
  invalid.pages[0].parentId = invalid.pages[1].id;
  const { store, bridge } = fixture([json(capabilities()), json({ revision: 1, snapshot: invalid })]);
  const original = store.snapshot();
  await bridge.initialize();
  await assert.rejects(bridge.refresh(), /階層/);
  assert.equal(bridge.remoteLoaded, false);
  assert.deepEqual(store.snapshot(), original);
  assert.throws(() => bridge.importRemote(1), /確認/);
});

test('explicit import saves previous local snapshot before adopting remote', async () => {
  const remote = remoteWorkspace();
  const { store, storage, bridge, calls } = fixture([json(capabilities()), json({ revision: 2, snapshot: remote })]);
  store.createPage('A local-only page');
  store.flush();
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  bridge.importRemote(2);
  assert.deepEqual(store.backupSnapshot().snapshot, original);
  assert.deepEqual(store.snapshot(), remote);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), remote);
  assert.equal(bridge.lastAction, 'import');
  assert.ok(calls.every(call => call.method !== 'PUT'));
});

test('import does not replace local when backup or main storage runs out of capacity', async () => {
  for (const failKey of [BACKUP_KEY, STORAGE_KEY]) {
    const { store, storage, bridge } = fixture([json(capabilities()), json({ revision: 1, snapshot: remoteWorkspace() })]);
    const original = store.snapshot();
    const originalRaw = storage.getItem(STORAGE_KEY);
    await bridge.initialize();
    await bridge.refresh();
    storage.failKey = failKey;
    assert.throws(() => bridge.importRemote(1), /置き換えませんでした/);
    assert.deepEqual(store.snapshot(), original);
    assert.equal(storage.getItem(STORAGE_KEY), originalRaw);
  }
});

test('access key is sent only to session endpoint and is never saved locally', async () => {
  const { store, storage, bridge, calls } = fixture([json(capabilities('sqlite', false, 'access-key')), json({ authenticated: true }), json(capabilities('sqlite', true, 'access-key'))]);
  await bridge.initialize();
  await assert.rejects(bridge.refresh(), /アクセスキー/);
  await bridge.signIn('fictional-test-key');
  assert.equal(bridge.authenticated, true);
  assert.equal(calls[1].path, '/api/session');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), { accessKey: 'fictional-test-key' });
  assert.equal([...storage.values.values()].some(value => value.includes('fictional-test-key')), false);
  assert.equal(JSON.stringify(store.snapshot()).includes('fictional-test-key'), false);
  assert.equal(calls.some(call => call.path === '/api/workspace/snapshot'), false);
});

test('expired session asks for sign-in while preserving local state', async () => {
  const { store, bridge } = fixture([json(capabilities('sqlite', true, 'access-key')), json({ error: 'UNAUTHENTICATED' }, 401)]);
  const original = store.snapshot();
  await bridge.initialize();
  await assert.rejects(bridge.refresh(), /接続期限/);
  assert.equal(bridge.authenticated, false);
  assert.equal(bridge.status, 'signin');
  assert.equal(bridge.remoteLoaded, false);
  assert.deepEqual(store.snapshot(), original);
});

test('manual sign-out clears remote access without changing local workspace', async () => {
  const { store, bridge, calls } = fixture([json(capabilities('sqlite', true, 'access-key')), json({ revision: 1, snapshot: remoteWorkspace() }), json({ authenticated: false })]);
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  await bridge.signOut();
  assert.equal(bridge.authenticated, false);
  assert.equal(bridge.remoteLoaded, false);
  assert.equal(bridge.remote, null);
  assert.equal(bridge.status, 'signin');
  assert.equal(calls.at(-1).path, '/api/session');
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.deepEqual(store.snapshot(), original);
  await assert.rejects(bridge.saveCurrent(1), /アクセスキー/);
});

test('unexpected save response does not report confirmed persistence', async () => {
  const { store, bridge } = fixture([json(capabilities()), json({ revision: 0, snapshot: null }), json({ revision: 9, snapshot: remoteWorkspace() })]);
  const original = store.snapshot();
  await bridge.initialize();
  await bridge.refresh();
  await assert.rejects(bridge.saveCurrent(0), /保存結果/);
  assert.equal(bridge.status, 'error');
  assert.equal(bridge.remoteLoaded, false);
  assert.deepEqual(store.snapshot(), original);
});

test('local hierarchy, trash restore, blocks and typed dates still survive reload', () => {
  const { store, storage } = fixture();
  const parent = store.createPage('Parent');
  const child = store.createPage('Child', parent.id);
  store.deletePage(parent.id);
  assert.equal(store.isVisible(child.id), false);
  store.restorePage(parent.id);
  assert.equal(store.isVisible(child.id), true);
  const next = store.addBlock(child.id, 'heading2', 0, 'A heading');
  store.moveBlock(child.id, next.id, 1);
  assert.equal(store.getPage(child.id).blocks[1].id, next.id);
  assert.throws(() => store.setRecordProperty('task-blocks', 'date', '2026-02-31'), /有効/);
  store.flush();
  const reload = new LocalWorkspaceStore({ storage });
  assert.deepEqual(reload.snapshot(), store.snapshot());
});

test('unreadable existing local data is protected from server import', async () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, 'not-valid-json');
  const store = new LocalWorkspaceStore({ storage });
  assert.equal(store.preserveUnreadableData, true);
  assert.throws(() => store.replaceWithBackup(remoteWorkspace()), /元の保存データ/);
  assert.equal(storage.getItem(STORAGE_KEY), 'not-valid-json');
  assert.equal(store.flush(), false);
});

test('portable JSON roundtrip matches the shared server schema without network calls', () => {
  const { store, calls } = fixture();
  store.updateBlock('page-spec', 'spec-intro', { text: '<script>literal text</script>\n日本語のバックアップ' });
  store.flush();
  const original = store.snapshot();
  const parsed = parseWorkspaceJSON(JSON.stringify(original, null, 2));
  assert.deepEqual(parsed, original);
  assert.deepEqual(validateSnapshot(parsed), original);
  parsed.name = 'Different workspace';
  assert.equal(store.data.name, original.name);
  assert.equal(calls.length, 0);
});

test('malformed JSON and UTF-8 oversized files cannot modify local storage', () => {
  const { store, storage } = fixture();
  const original = store.snapshot();
  const originalRaw = storage.getItem(STORAGE_KEY);
  const oversized = JSON.stringify({ ...original, name: '字'.repeat(300001) });
  assert.ok(new TextEncoder().encode(oversized).length > MAX_IMPORT_BYTES);
  for (const text of ['not-json', '{', JSON.stringify({ ...original, schemaVersion: 2 }), oversized]) {
    assert.throws(() => store.replaceWithBackup(parseWorkspaceJSON(text)));
    assert.deepEqual(store.snapshot(), original);
    assert.equal(storage.getItem(STORAGE_KEY), originalRaw);
    assert.equal(storage.getItem(BACKUP_KEY), null);
  }
});

test('portable schema rejects invalid IDs, relationships, dates and extra fields like the server', () => {
  const mutations = [
    snapshot => { snapshot.pages[0].id = '../invalid-id'; },
    snapshot => { snapshot.pages[1].id = snapshot.pages[0].id; },
    snapshot => { snapshot.pages[0].blocks[1].id = snapshot.pages[0].blocks[0].id; },
    snapshot => { snapshot.pages[0].parentId = 'page-guide'; },
    snapshot => { snapshot.pages.find(page => page.kind === 'record').collectionId = 'page-spec'; },
    snapshot => { snapshot.pages.find(page => page.kind === 'record').properties.date = '2026-02-30'; },
    snapshot => { snapshot.pages[0].createdAt = '2026-02-30T00:00:00.000Z'; },
    snapshot => { snapshot.pages[0].title = 'x'.repeat(501); },
    snapshot => { snapshot.pages[0].blocks[0].text = 'x'.repeat(100001); },
    snapshot => { snapshot.name = 'x'.repeat(201); },
    snapshot => { snapshot.ui.lastRoute = '#page/invalid%2Fid'; },
    snapshot => { snapshot.pages[0].properties = { status: '準備' }; },
    snapshot => { snapshot.pages[0].unexpected = 'unsupported'; },
    snapshot => { snapshot.unexpected = 'unsupported'; }
  ];
  for (const mutate of mutations) {
    const snapshot = createDemoWorkspace();
    mutate(snapshot);
    const original = structuredClone(snapshot);
    assert.throws(() => validatePortableWorkspace(snapshot));
    assert.throws(() => validateSnapshot(snapshot));
    assert.deepEqual(snapshot, original);
  }
});

test('restored collection record at root remains portable to the server', () => {
  const { store } = fixture();
  store.deletePage('task-blocks');
  store.deletePage('collection-roadmap');
  store.restorePage('task-blocks');
  store.flush();
  const snapshot = parseWorkspaceJSON(JSON.stringify(store.snapshot()));
  const record = snapshot.pages.find(page => page.id === 'task-blocks');
  assert.equal(record.parentId, null);
  assert.equal(record.collectionId, null);
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
});

test('confirmed JSON import backs up edits made after file selection and can roundtrip restore', () => {
  const { store, storage, calls } = fixture();
  const candidate = parseWorkspaceJSON(JSON.stringify(remoteWorkspace()));
  store.updatePageTitle('page-spec', 'Edited after file selection');
  const beforeConfirm = store.snapshot();
  store.replaceWithBackup(candidate);
  assert.deepEqual(store.snapshot(), candidate);
  assert.deepEqual(store.backupSnapshot().snapshot, beforeConfirm);
  const backupFile = JSON.stringify(store.backupSnapshot().snapshot);
  store.replaceWithBackup(parseWorkspaceJSON(backupFile));
  assert.deepEqual(store.snapshot(), beforeConfirm);
  assert.deepEqual(store.backupSnapshot().snapshot, candidate);
  assert.deepEqual(new LocalWorkspaceStore({ storage }).snapshot(), beforeConfirm);
  assert.equal(calls.length, 0);
});
