import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorHistory, markdownPrefix, moveEditorBlock } from '../public/editor-model.js';
const draft = text => ({ title: 'Fixture', blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });

test('editor undo coalesces typing but preserves structural changes, selection, redo branches and input snapshots', () => {
  let time = 0; const history = new EditorHistory(draft(''), { now: () => time });
  const first = draft('a'); history.record(first, { group: 'text:a', selection: { blockId: 'a', start: 1 } }); first.blocks[0].data.text = 'external mutation';
  time = 500; history.record(draft('ab'), { group: 'text:a', selection: { blockId: 'a', start: 2 } });
  assert.equal(history.undo().draft.blocks[0].data.text, ''); assert.equal(history.redo().draft.blocks[0].data.text, 'ab');
  const divided = draft('ab'); divided.blocks.push({ id: 'b', type: 'paragraph', data: { text: '' } }); history.record(divided);
  assert.equal(history.undo().draft.blocks.length, 1); assert.equal(history.current.selection.start, 2);
  history.record(draft('branch')); assert.equal(history.canRedo, false);
  assert.equal(history.undo().draft.blocks[0].data.text, 'ab'); history.reset(draft('new page')); assert.equal(history.canUndo, false);
});

test('history ends a typing group after a pause and bounds retained steps', () => {
  let time = 0; const history = new EditorHistory(draft(''), { maxSteps: 2, now: () => time });
  for (const text of ['a', 'b', 'c']) { time += 1000; history.record(draft(text), { group: 'text:a' }); }
  assert.equal(history.undo().draft.blocks[0].data.text, 'b'); assert.equal(history.undo().draft.blocks[0].data.text, 'a'); assert.equal(history.undo(), null);
});

test('Markdown prefixes recognize only complete explicit shortcuts', () => {
  assert.deepEqual(markdownPrefix('### '), { type: 'heading', data: { text: '', level: 3 } });
  assert.equal(markdownPrefix('[x] ').data.checked, true); assert.equal(markdownPrefix('[ ] ').data.checked, false);
  for (const text of ['#', '#### ', 'paragraph # ', '<script>', 'javascript:alert(1)', '`code`']) assert.equal(markdownPrefix(text), null);
  for (const text of ['- ', '1. ', '> ', '``` ', '--- ']) assert.ok(markdownPrefix(text));
});

test('ordered shortcuts preserve positive start values within the migration-compatible bounds', () => {
  for (const [text, start] of [['2. ', 2], ['12) ', 12], ['999999999. ', 999999999]]) {
    assert.deepEqual(markdownPrefix(text), { type: 'numbered-list', data: { text: '', start } });
  }
  for (const text of ['0. ', '-1. ', '01. ', '1000000000. ', '9007199254740992. ', '12.', '12) text', '12.  ']) {
    assert.equal(markdownPrefix(text), null);
  }
});

test('code fence shortcuts retain a bounded literal language name and reject incomplete or unsafe info strings', () => {
  assert.deepEqual(markdownPrefix('``` '), { type: 'code', data: { text: '' } });
  for (const language of ['js', 'typescript', 'c++', 'c#', 'objective-c', 'a'.repeat(100)]) {
    assert.deepEqual(markdownPrefix('```' + language + ' '), { type: 'code', data: { text: '', language } });
  }
  for (const text of ['```js', '```' + 'a'.repeat(101) + ' ', '``` js ', '```js extra ', '```<script> ', '````js ', '```js\n ']) {
    assert.equal(markdownPrefix(text), null);
  }
});

test('block moves preserve stable IDs and nested data without modifying input, while rejecting cyclic and invalid destinations', () => {
  const blocks = [{ id: 'a', type: 'paragraph', data: { text: 'A' }, children: [{ id: 'b', type: 'quote', data: { text: 'B' } }] }, { id: 'c', type: 'code', data: { text: '<script>' } }];
  const next = moveEditorBlock(blocks, { blockId: 'b', index: 2 }); assert.deepEqual(next.map(row => row.id), ['a', 'c', 'b']); assert.equal(blocks[0].children.length, 1); assert.equal(next[2].data.text, 'B');
  assert.throws(() => moveEditorBlock(blocks, { blockId: 'a', parentId: 'b', index: 0 }), /CYCLE/);
  assert.throws(() => moveEditorBlock(blocks, { blockId: 'b', parentId: 'c', index: 0 }), /UNSUPPORTED/);
  assert.throws(() => moveEditorBlock(blocks, { blockId: 'b', index: 99 }), /INDEX/);
  assert.deepEqual(moveEditorBlock(next, { blockId: 'b', index: 0 }).map(row => row.id), ['b', 'a', 'c']);
});
