import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWorkspaceStore, STORAGE_KEY, parseWorkspaceJSON } from '../public/store.js';
import { EditorHistory, markdownPrefix, moveEditorBlock } from '../public/editor-model.js';
import { validateSnapshot } from '../../../packages/prototype/src/index.js';

function fixture(t) {
  const values = new Map();
  const writes = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push(key); } };
  const store = new LocalWorkspaceStore({ storage });
  t.after(() => store.flush());
  writes.length = 0;
  return { store, writes, values };
}
const draft = page => ({ title: page.title, blocks: structuredClone(page.blocks) });

test('document replacement validates before one mutation and keeps hierarchy and record properties', t => {
  const { store, writes, values } = fixture(t);
  const page = store.listPages().find(item => item.kind === 'record');
  const metadata = { id: page.id, parentId: page.parentId, collectionId: page.collectionId, properties: structuredClone(page.properties), createdAt: page.createdAt };
  const next = draft(page);
  next.title = 'Plain <script> & # heading';
  next.blocks = [{ id: page.blocks[0].id, type: 'paragraph', text: '<img src=x onerror=alert(1)>\n# literal', checked: false }];
  const events = [];
  store.subscribe(event => { if (event.type !== 'status') events.push(event); });
  const revision = store.contentRevision;
  store.setPageDocument(page.id, next);
  assert.equal(store.contentRevision, revision + 1);
  assert.deepEqual(events, [{ type: 'change', pageId: page.id, field: 'document' }]);
  assert.equal(writes.length, 0);
  assert.deepEqual({ id: page.id, parentId: page.parentId, collectionId: page.collectionId, properties: page.properties, createdAt: page.createdAt }, metadata);
  next.blocks[0].text = 'caller later mutated';
  assert.equal(page.blocks[0].text, '<img src=x onerror=alert(1)>\n# literal');
  store.flush();
  assert.equal(writes.length, 1);
  const restored = parseWorkspaceJSON(values.get(STORAGE_KEY));
  assert.deepEqual(validateSnapshot(restored), restored);
  assert.equal(restored.pages.find(item => item.id === page.id).blocks[0].text, page.blocks[0].text);
});

test('invalid atomic editor replacements never change the existing page or emit saves', t => {
  const { store } = fixture(t), page = store.getPage('page-spec');
  const before = store.snapshot(), revision = store.contentRevision;
  let changed = 0;
  store.subscribe(event => { if (event.type !== 'status') changed++; });
  const otherBlock = store.getPage('page-guide').blocks[0];
  for (const replacement of [
    { title: 'bad', blocks: [] },
    { title: 'bad', blocks: [{ ...page.blocks[0], id: otherBlock.id }] },
    { title: 'bad', blocks: [{ ...page.blocks[0], type: 'future-block' }] },
    { title: 'bad', blocks: [{ ...page.blocks[0], text: 'x'.repeat(100001) }] },
    { title: 'bad', blocks: [{ ...page.blocks[0], checked: 'yes' }] },
    { title: 'x'.repeat(501), blocks: page.blocks }
  ]) assert.throws(() => store.setPageDocument(page.id, replacement));
  assert.throws(() => store.setPageDocument('collection-roadmap', { title: 'bad', blocks: page.blocks }));
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.contentRevision, revision);
  assert.equal(changed, 0);
});

test('flat split, join, reorder and undo/redo restore stable IDs through the local snapshot validator', t => {
  const { store } = fixture(t), page = store.getPage('page-spec');
  const initial = draft(page), history = new EditorHistory(initial);
  const blocks = structuredClone(page.blocks);
  const firstText = blocks[0].text;
  blocks[0].text = firstText.slice(0, 4);
  blocks.splice(1, 0, { id: 'qa-split-block', type: 'paragraph', text: firstText.slice(4), checked: false });
  store.setPageDocument(page.id, { title: page.title, blocks });
  history.record(draft(page));
  assert.equal(history.past.length, 1);
  const reordered = moveEditorBlock(page.blocks, { blockId: 'qa-split-block', index: page.blocks.length });
  store.setPageDocument(page.id, { title: page.title, blocks: reordered });
  history.record(draft(page));
  assert.equal(page.blocks.at(-1).id, 'qa-split-block');
  store.setPageDocument(page.id, history.undo().draft);
  assert.equal(page.blocks[1].id, 'qa-split-block');
  store.setPageDocument(page.id, history.undo().draft);
  assert.deepEqual(draft(page), initial);
  store.setPageDocument(page.id, history.redo().draft);
  const joined = structuredClone(page.blocks);
  joined[0].text += joined[1].text;
  joined.splice(1, 1);
  store.setPageDocument(page.id, { title: page.title, blocks: joined });
  assert.equal(page.blocks[0].text, firstText);
  assert.deepEqual(validateSnapshot(store.snapshot()), store.snapshot());
  assert.deepEqual(markdownPrefix('# '), { type: 'heading', data: { text: '', level: 1 } });
  assert.equal(markdownPrefix('<script> '), null);
});


test('local inline formatting survives exact JSON roundtrip, split/join and a separate Undo/Redo step', async t => {
  const { formatInlineRange, splitInlineMarks, joinInlineMarks } = await import('../../../packages/domain/src/inline.js');
  const { store } = fixture(t), page=store.getPage('page-spec'), block=page.blocks[0];
  store.updateBlock(page.id,block.id,{text:'Alpha beta'});
  const before=draft(page), history=new EditorHistory(before);
  const marks=formatInlineRange(block.text,[],0,5,{style:'bold'});
  store.updateBlock(page.id,block.id,{marks,format:true}); history.record(draft(page));
  store.updateBlock(page.id,block.id,{text:'XAlpha beta'}); history.record(draft(page),{group:'typing'});
  assert.deepEqual(block.marks,[{start:1,end:6,styles:['bold']}]);
  store.setPageDocument(page.id,history.undo().draft); assert.equal(page.blocks[0].text,'Alpha beta'); assert.deepEqual(page.blocks[0].marks,marks);
  store.setPageDocument(page.id,history.undo().draft); assert.equal(page.blocks[0].marks,undefined);
  store.setPageDocument(page.id,history.redo().draft);
  const selected=page.blocks[0], split=splitInlineMarks(selected.text,selected.marks,3,3);
  const joined=joinInlineMarks(selected.text.slice(0,3),split.beforeMarks,selected.text.slice(3),split.afterMarks);
  assert.deepEqual(joined,marks);
  assert.deepEqual(parseWorkspaceJSON(JSON.stringify(store.snapshot())),store.snapshot());
  assert.deepEqual(validateSnapshot(store.snapshot()),store.snapshot());
  const saved=store.snapshot(); assert.throws(()=>store.updateBlock(page.id,selected.id,{type:'heading2',marks:[{start:0,end:99,styles:['bold']}]}));
  assert.deepEqual(store.snapshot(),saved);
});
