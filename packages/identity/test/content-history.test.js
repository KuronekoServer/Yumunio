import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberPage, trimHistory, validateHistory } from '../src/content-history.js';
const stamp = '2026-10-15T00:00:00.000Z';
function fixture() {
  const item = { page: { id: 'page', title: 'Original' }, document: { pageId: 'page', workspaceId: 'workspace', version: 1, updatedAt: stamp, blocks: [{ id: 'a', type: 'paragraph', data: { text: 'Initial' } }] } };
  return { item, payload: { pages: [item] }, pages: new Map([['page', item]]) };
}
test('history captures independent pre-edit documents and prunes to its explicit workspace retention bound', () => {
  const f = fixture(); let next = 0;
  for (let index = 0; index < 35; index++) {
    rememberPage(f.payload, f.item, { actorId: 'actor', now: () => stamp, createId: () => 'history-' + ++next });
    f.item.document.version++; f.item.document.blocks[0].data.text = 'Edit ' + index;
  }
  trimHistory(f.payload); assert.equal(f.payload.history.length, 32); assert.equal(f.payload.history[0].document.version, 4);
  assert.equal(f.payload.history.at(-1).document.blocks[0].data.text, 'Edit 33'); validateHistory(f.payload, f.pages, 'workspace');
  const forged = structuredClone(f.payload); forged.history[0].document.workspaceId = 'other'; assert.throws(() => validateHistory(forged, f.pages, 'workspace'));
  forged.history[0].document.workspaceId = 'workspace'; forged.history[0].document.version = f.item.document.version; assert.throws(() => validateHistory(forged, f.pages, 'workspace'));
});
test('history does not prevent editing a valid large current document or promise snapshots beyond its byte quota', () => {
  const f = fixture(); f.item.document.blocks = Array.from({ length: 4 }, (_, index) => ({ id: 'block-' + index, type: 'paragraph', data: { text: 'x'.repeat(80000) } }));
  rememberPage(f.payload, f.item, { actorId: 'actor', now: () => stamp, createId: () => 'large-history' }); f.item.document.version++;
  trimHistory(f.payload); assert.equal(Object.hasOwn(f.payload, 'history'), false); assert.equal(f.item.document.blocks[0].data.text.length, 80000);
});
