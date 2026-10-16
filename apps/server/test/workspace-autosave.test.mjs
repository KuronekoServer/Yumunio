import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { createSqliteContentStore } from '@yumunio/identity/content-store';
import { PageAutosave } from '../../web/public/page-autosave.js';
import { validateSavedPage } from '../../web/public/page-save-result.js';
import { CollectionEdits } from '../../web/public/workspace-data.js';
import {resizeEditorColumns} from '../../web/public/editor-tree.js';
import {EditorHistory} from '../../web/public/editor-model.js';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';

const clone = value => structuredClone(value);
const bodyOf = page => ({ title: page.page.title, blocks: clone(page.document.blocks) });
const block = text => [{ id: 'autosave-text', type: 'paragraph', data: { text } }];
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
class ManualClock {
  timers = new Map(); next = 0;
  now() { return 0; }
  setTimeout(callback, delay) { const id = ++this.next; this.timers.set(id, { callback, delay }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
}
async function ok(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function fixture(t) {
  const legacy = new SqliteSnapshotStore(':memory:'), mail = [];
  let identity, cookie, accountId;
  const server = createAppServer({ snapshotStore: legacy, accessKey: 'autosave-legacy-fixture-'.repeat(3), identity: {
    handle: (...args) => identity.handle(...args), content: (...args) => identity.content(...args)
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await identity?.flushBackgroundTasks(); legacy.close(); });
  identity = createIdentity({ database: legacy.database, origin, workspaceContent: true,
    secret: 'autosave-synthetic-identity-secret-123456789', registrationMode: 'open',
    sendMail: async message => { mail.push(message); return { status: 'accepted' }; } });
  await (await getMigrations(identity.auth.options)).runMigrations();
  legacy.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql', import.meta.url), 'utf8'));
  identity.content = createAccountContentApi({ store: createSqliteContentStore(legacy.database), origin,
    resolveSession: request => identity.auth.api.getSession({ headers: request.headers }) });
  const request = (path, method = 'GET', body) => fetch(origin + path, { method, redirect: 'manual', headers: {
    ...(cookie ? { Cookie: cookie, 'X-Yumunio-Expected-Account': accountId } : {}),
    ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' })
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const email = 'autosave-owner@example.invalid', password = 'Fictional-autosave-password-2026';
  await ok(await request('/api/auth/sign-up/email', 'POST', { name: 'Autosave fixture', email, password }), 202);
  await identity.flushBackgroundTasks();
  const token = new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');
  await ok(await request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(origin + '/account.html')));
  const signed = await request('/api/auth/sign-in/email', 'POST', { email, password });
  accountId = (await ok(signed)).user.id;
  cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const workspace = await ok(await request('/api/auth/organization/create', 'POST', { name: 'Autosave fixture', slug: 'autosave-fixture' }));
  const base = '/api/content/workspaces/' + workspace.id;
  const created = await ok(await request(base + '/collections', 'POST', { expectedRevision: 0, title: 'Typed notes', parentId: null,
    properties: [{ id: 'amount', name: 'Amount', type: 'number' }, { id: 'note', name: 'Note', type: 'text' }] }), 201);
  const collectionPath = base + '/collections/' + created.collectionId;
  const row = (await ok(await request(collectionPath + '/records', 'POST', { expectedRevision: created.revision,
    title: 'Row note', values: { amount: 2, note: null } }), 201)).record;
  const pagePath = base + '/pages/' + row.pageId;
  return { legacy, request, base, collectionPath, pagePath, row, workspaceId: workspace.id, accountId,
    readPage: () => request(pagePath).then(ok),
    readCollection: async () => new CollectionEdits(await ok(await request(collectionPath)), { workspaceId: workspace.id, collectionId: created.collectionId }) };
}

// A small HTTP adapter harness composes the production validators and draft model;
// it has no DOM/rendering implementation and never replaces a live draft on ACK.
function harness(t, f, current, collection, afterResponse = async () => {}) {
  const clock = new ManualClock(), calls = [], state = { current, collection, draft: bodyOf(current), generation: 0, selection: 0, paused: false };
  let active = 0, maximum = 0;
  const controller = new PageAutosave({ clock,
    getState: () => ({ scopeKey: JSON.stringify([f.accountId, f.workspaceId, state.current.page.id, state.selection]),
      generation: state.generation, dirty: JSON.stringify(state.draft) !== JSON.stringify(bodyOf(state.current)), paused: state.paused }),
    save: async operation => {
      const pageId = state.current.page.id;
      const sent = { expectedRevision: state.current.revision, expectedVersion: state.current.document.version, ...clone(state.draft) };
      calls.push({ pageId, sent }); active++; maximum = Math.max(maximum, active);
      try {
        const response = await f.request(f.base + '/pages/' + pageId, 'PATCH', sent);
        if (!response.ok) { await response.arrayBuffer(); throw Object.assign(new Error('SAVE_FAILED'), { status: response.status }); }
        const result = await response.json();
        await afterResponse({ call: calls.length, result, sent });
        if (!operation.isCurrent()) return { status: 'paused' };
        const checked = validateSavedPage(sent, result, { workspaceId: f.workspaceId, pageId });
        state.collection?.advanceDocumentBasis({ expectedRevision: sent.expectedRevision, revision: checked.revision, pageId, title: checked.page.title });
        state.current = checked;
        return { status: 'saved' };
      } finally { active--; }
    }
  });
  t.after(() => controller.stop());
  return { state, calls, clock, controller, maximum: () => maximum,
    edit(title, text) { state.draft.title = title; state.draft.blocks = block(text); state.generation++; controller.notify(); },
    switchPage(page) { state.selection++; state.current = page; state.draft = bodyOf(page); state.collection = null; state.generation++; controller.reset(); } };
}

test('column resize uses normal HTTP autosave, retains rich data and property drafts, and Undo restores the exact saved layout',async t=>{
 const f=await fixture(t),original=await f.readPage(),rich={id:'rich-body',type:'paragraph',data:{text:'2026-10-16 Page',marks:[{start:0,end:10,styles:['bold']}],links:[{start:11,end:15,label:'Page',pageId:f.row.pageId}],mentions:[{kind:'date',start:0,end:10,date:'2026-10-16'},{kind:'page',start:11,end:15,pageId:f.row.pageId}],future:{keep:['opaque',1]}},children:[{id:'unknown-child',type:'future',data:{opaque:{keep:true}}}]},initial=[{id:'http-columns',type:'columns',children:[{id:'http-left',type:'column',children:[{id:'left-body',type:'paragraph',data:{text:'Left'}}]},{id:'http-middle',type:'column',children:[rich]},{id:'http-right',type:'column',children:[{id:'right-body',type:'paragraph',data:{text:'Right'}}]}]}];
 await ok(await f.request(f.pagePath,'PATCH',{expectedRevision:original.revision,expectedVersion:original.document.version,title:'Columns autosave',blocks:initial}));const page=await f.readPage(),collection=await f.readCollection();collection.setRaw(f.row.id,'amount','1e-');const h=harness(t,f,page,collection),history=new EditorHistory(h.state.draft),liveDraft=h.state.draft;
 const apply=async draft=>{h.state.draft=draft;h.state.generation++;h.controller.notify();assert.equal((await h.controller.flush()).status,'saved');assert.deepEqual(bodyOf(await f.readPage()),draft);assert.equal(collection.rawValue(f.row.id,'amount'),'1e-');};
 const reduced=resizeEditorColumns(h.state.draft.blocks,{groupId:'http-columns',count:2});h.state.draft.blocks=reduced.blocks;history.record(h.state.draft);await apply(h.state.draft);assert.equal(h.state.draft,liveDraft);assert.equal(h.calls.length,1);assert.deepEqual(h.state.draft.blocks[0].children[1].children,[rich,initial[0].children[2].children[0]]);
 const undo=history.undo();assert.ok(undo);assert.equal(history.canUndo,false);await apply(undo.draft);assert.deepEqual(h.state.draft.blocks,initial);const redo=history.redo();assert.ok(redo);await apply(redo.draft);assert.equal(h.calls.length,3);
 let sequence=0;const expanded=resizeEditorColumns(h.state.draft.blocks,{groupId:'http-columns',count:3,createId:()=> 'http-added-'+ ++sequence});history.record({...h.state.draft,blocks:expanded.blocks});await apply({...h.state.draft,blocks:expanded.blocks});assert.equal(h.calls.length,4);assert.equal(h.maximum(),1);assert.deepEqual(h.state.draft.blocks[0].children.slice(0,2),reduced.blocks[0].children);assert.equal(h.state.draft.blocks[0].children[2].children[0].id,expanded.focusId);
 const persisted=await f.readPage();assert.equal(persisted.page.id,f.row.pageId);assert.equal(persisted.document.version,page.document.version+4);assert.equal((await f.legacy.read()).snapshot,null);
});

test('autosave HTTP ACK advances body and typed-record CAS basis while retaining later input and unfinished raw properties', async t => {
  const f = await fixture(t), collection = await f.readCollection(), page = await f.readPage();
  collection.setRaw(f.row.id, 'amount', '1e-'); collection.setRaw(f.row.id, 'note', '');
  const arrived = deferred(), release = deferred();
  const h = harness(t, f, page, collection, async ({ call }) => { if (call === 1) { arrived.resolve(); await release.promise; } });
  h.edit('Autosaved row', 'First submitted body'); const liveDraft = h.state.draft;
  const first = h.controller.flush(); await arrived.promise;
  h.edit('Autosaved row', 'First submitted body + later input');
  const second = h.controller.flush();
  assert.equal(h.calls.length, 1); assert.equal(collection.rawValue(f.row.id, 'amount'), '1e-');
  assert.equal(collection.rawValue(f.row.id, 'note'), ''); assert.throws(() => collection.patch(f.row.id));
  release.resolve(); assert.equal((await first).status, 'saved'); assert.equal((await second).status, 'saved');
  assert.equal(h.maximum(), 1); assert.equal(h.calls.length, 2); assert.equal(h.state.draft, liveDraft);
  assert.equal(h.state.draft.blocks[0].data.text, 'First submitted body + later input');
  assert.equal(h.calls[1].sent.expectedRevision, h.calls[0].sent.expectedRevision + 1);
  assert.equal(h.calls[1].sent.expectedVersion, h.calls[0].sent.expectedVersion + 1);
  assert.equal(collection.revision, h.state.current.revision); assert.equal(collection.record(f.row.id).title, 'Autosaved row');
  assert.equal(collection.rawValue(f.row.id, 'amount'), '1e-'); assert.equal(collection.rawValue(f.row.id, 'note'), '');
  assert.equal(collection.dirty, true); assert.equal(h.controller.snapshot().phase, 'idle');
  const persisted = await f.readPage(); assert.deepEqual(bodyOf(persisted), h.state.draft);
  const beforeProperties = await f.readCollection(); assert.equal(beforeProperties.record(f.row.id).values.amount, 2);
  assert.equal(beforeProperties.record(f.row.id).values.note, null);
  collection.setRaw(f.row.id, 'amount', '12.5'); const propertyPatch = collection.patch(f.row.id);
  assert.equal(propertyPatch.expectedRevision, persisted.revision); assert.deepEqual(propertyPatch.values, { amount: 12.5, note: '' });
  const propertyResult = await ok(await f.request(f.collectionPath + '/records/' + f.row.id, 'PATCH', propertyPatch));
  collection.accept(propertyResult, f.row.id); assert.equal(collection.dirty, false);
  assert.equal(collection.record(f.row.id).sourceKind, 'manual'); assert.deepEqual(collection.record(f.row.id).sourceValues, {});
  const finalPage = await f.readPage(); assert.equal(finalPage.document.version, persisted.document.version);
  assert.equal(finalPage.revision, persisted.revision + 1); assert.deepEqual(bodyOf(finalPage), h.state.draft);
  assert.equal((await f.legacy.read()).snapshot, null);
});

test('real HTTP CAS conflict, committed-but-unknown response and late old-page ACK preserve drafts without automatic resend', async t => {
  const f = await fixture(t), original = await f.readPage(), properties = await f.readCollection();
  properties.setRaw(f.row.id, 'amount', '1e-');
  const conflict = harness(t, f, original, properties);
  conflict.edit('Local conflict draft', 'Keep this body draft');
  await ok(await f.request(f.pagePath, 'PATCH', { expectedRevision: original.revision, expectedVersion: original.document.version,
    title: 'Other client saved', blocks: block('Other client body') }));
  assert.equal((await conflict.controller.flush()).status, 'conflict');
  conflict.edit('Still local', 'Still keep this body draft'); conflict.controller.refresh(); await conflict.controller.flush();
  assert.equal(conflict.calls.length, 1); assert.equal(conflict.controller.snapshot().reason, 'conflict');
  assert.equal(conflict.state.current.document.version, original.document.version);
  assert.equal(properties.rawValue(f.row.id, 'amount'), '1e-'); assert.equal(conflict.state.draft.title, 'Still local');
  conflict.controller.stop();

  const uncertainProperties = await f.readCollection(); uncertainProperties.setRaw(f.row.id, 'amount', '1e-');
  const uncertain = harness(t, f, await f.readPage(), uncertainProperties, async () => { throw Object.assign(new Error('SIMULATED_LOST_RESPONSE'), { status: 0 }); });
  const beforeUnknown = uncertain.state.current.revision;
  uncertain.edit('Committed with unknown ACK', 'Server committed, client must inspect before retry');
  assert.equal((await uncertain.controller.flush()).status, 'unknown');
  assert.equal(uncertain.state.current.revision, beforeUnknown); assert.equal((await f.readPage()).revision, beforeUnknown + 1);
  assert.equal(uncertainProperties.rawValue(f.row.id, 'amount'), '1e-');
  uncertain.controller.notify(); uncertain.controller.refresh(); await uncertain.controller.flush();
  assert.equal(uncertain.calls.length, 1); assert.equal(uncertain.controller.snapshot().reason, 'unknown');
  assert.equal(uncertain.state.draft.title, 'Committed with unknown ACK'); uncertain.controller.stop();

  const fresh = await f.readPage();
  const other = await ok(await f.request(f.base + '/pages', 'POST', { expectedRevision: fresh.revision, title: 'New selected page', blocks: block('New page baseline') }), 201);
  const arrived = deferred(), release = deferred();
  const late = harness(t, f, await f.readPage(), await f.readCollection(), async ({ call }) => { if (call === 1) { arrived.resolve(); await release.promise; } });
  late.edit('Old page saved late', 'Old page response is delayed');
  const oldRequest = late.controller.flush(); await arrived.promise;
  late.switchPage(await ok(await f.request(f.base + '/pages/' + other.page.id)));
  late.edit('New page local draft', 'Never replace this with an old-page ACK'); const newDraft = late.state.draft;
  release.resolve(); assert.equal((await oldRequest).status, 'paused');
  assert.equal(late.state.current.page.id, other.page.id); assert.equal(late.state.draft, newDraft);
  assert.equal(late.state.draft.title, 'New page local draft'); assert.equal(late.calls.length, 1);
  assert.equal((await late.controller.flush()).status, 'saved'); assert.equal(late.maximum(), 1);
  assert.equal(late.calls.length, 2); assert.equal(late.calls[1].pageId, other.page.id);
  assert.equal((await f.readPage()).page.title, 'Old page saved late');
  const selected = await ok(await f.request(f.base + '/pages/' + other.page.id)); assert.deepEqual(bodyOf(selected), newDraft);
  assert.equal((await f.legacy.read()).snapshot, null);
});
