import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBlocks, DomainError } from '../src/index.js';
import { validateInlineMarks, formatInlineRange, rebaseInlineMarks, replaceInlineMarks, splitInlineMarks, joinInlineMarks, safeInlineHref } from '../src/inline.js';
const mark = (start, end, styles = ['bold'], href) => ({ start, end, styles, ...(href ? { href } : {}) });

test('inline runs are disjoint, bounded, canonical and captured independently', () => {
  const input = [mark(0, 3, ['bold', 'italic'], 'https://example.invalid/')];
  const captured = validateInlineMarks('abcde', input); input[0].styles.push('code'); assert.deepEqual(captured[0].styles, ['bold', 'italic']);
  for (const runs of [[mark(0, 4), mark(3, 5)], [mark(0, 0)], [mark(0, 2, [])], [mark(0, 2, ['italic', 'bold'])], [mark(0, 1002)], Array.from({ length: 1001 }, (_, i) => mark(i, i + 1))]) assert.throws(() => validateInlineMarks('x'.repeat(1001), runs));
  assert.throws(() => validateInlineMarks('abc', [{ ...mark(0, 2), html: '<b>' }]));
});
test('inline URLs permit absolute web links only, without credentials or concealed controls', () => {
  assert.equal(safeInlineHref('HTTPS://example.invalid/path?q=1#ok'), 'https://example.invalid/path?q=1#ok');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//example.invalid', '/page', 'file:///a', 'https://user:pass@example.invalid', ' https://example.invalid', 'https://example.invalid\\@other.invalid', 'https://example.invalid/\ntext', 'https://example.invalid/\u202Eabc']) assert.throws(() => safeInlineHref(value));
});
test('format overlapping selections produces canonical combinations and toggles only selected attributes', () => {
  let runs = formatInlineRange('abcdef', [], 0, 4, { style: 'bold' });
  runs = formatInlineRange('abcdef', runs, 2, 6, { style: 'italic' });
  assert.deepEqual(runs, [mark(0, 2), mark(2, 4, ['bold', 'italic']), mark(4, 6, ['italic'])]);
  runs = formatInlineRange('abcdef', runs, 1, 3, { style: 'bold' });
  assert.deepEqual(runs, [mark(0, 1), mark(2, 3, ['italic']), mark(3, 4, ['bold', 'italic']), mark(4, 6, ['italic'])]);
  assert.deepEqual(formatInlineRange('abcdef', runs, 0, 0, { style: 'code' }), runs);
});
test('link commands preserve styles and removing links does not clear other formatting', () => {
  let runs = formatInlineRange('abc', [mark(0, 3)], 1, 3, { href: 'https://example.invalid' });
  assert.equal(runs[1].href, 'https://example.invalid/');
  assert.deepEqual(formatInlineRange('abc', runs, 0, 3, { href: null }), [mark(0, 3)]);
  assert.throws(() => formatInlineRange('abc', [], 0, 3, { style: 'bold', href: null }));
});
test('replacements preserve surviving spans and insertion affinity without styling surrounding plain text', () => {
  const runs = [mark(2, 5)];
  assert.deepEqual(replaceInlineMarks('abcdefg', runs, 0, 0, 'X'), [mark(3, 6)]);
  assert.deepEqual(replaceInlineMarks('abcdefg', runs, 3, 3, 'X'), [mark(2, 6)]);
  assert.deepEqual(replaceInlineMarks('abcdefg', runs, 5, 5, 'X'), runs);
  assert.deepEqual(replaceInlineMarks('abcdefg', runs, 1, 6, 'X'), []);
  assert.deepEqual(replaceInlineMarks('abcdefg', runs, 3, 4, ''), [mark(2, 4)]);
});
test('IME fallback preserves styles outside the replacement and never cuts a surrogate pair', () => {
  assert.deepEqual(rebaseInlineMarks('A日本語Z', 'A新しい日本語Z', [mark(1, 4)]), [mark(4, 7)]);
  assert.deepEqual(rebaseInlineMarks('A😀B', 'A😇B', [mark(1, 3)]), []);
  assert.deepEqual(replaceInlineMarks('A😀B', [mark(1, 3)], 1, 3, '😇'), [mark(1, 3)]);
  assert.deepEqual(rebaseInlineMarks('Hello World', 'Hello A World', [mark(6, 11, [], 'https://example.invalid/')]), [mark(8, 13, [], 'https://example.invalid/')]);
  assert.throws(() => validateInlineMarks('A😀B', [mark(1, 2)]));
  assert.throws(() => formatInlineRange('A😀B', [], 2, 3, { style: 'bold' }));
});
test('split and join preserve original range attributes and discard replaced selection only', () => {
  const runs = [mark(0, 5, ['underline']), mark(5, 8, ['code'])];
  const split = splitInlineMarks('abcdefgh', runs, 3, 6);
  assert.deepEqual(split, { beforeMarks: [mark(0, 3, ['underline'])], afterMarks: [mark(0, 2, ['code'])] });
  assert.deepEqual(joinInlineMarks('abc', split.beforeMarks, 'gh', split.afterMarks), [mark(0, 3, ['underline']), mark(3, 5, ['code'])]);
  assert.deepEqual(joinInlineMarks('ab', [mark(0, 2)], 'cd', [mark(0, 2)]), [mark(0, 4)]);
});
test('standalone validation does not execute getters or accept sparse/custom arrays', () => {
  let called = false; const value = { start: 0, end: 1, styles: ['bold'], get href() { called = true; return 'https://example.invalid'; } };
  assert.throws(() => validateInlineMarks('x', [value])); assert.equal(called, false);
  assert.throws(() => validateInlineMarks('x', new Array(1)));
});
test('Domain validates optional marks while preserving unrelated extensible payloads', () => {
  assert.doesNotThrow(() => validateBlocks([{ id: 'b', type: 'paragraph', data: { text: 'abc', marks: [mark(0, 2)], extra: true } }]));
  for (const value of [{ type: 'paragraph', data: { text: 'abc', marks: [mark(1, 5)] } }, { type: 'code', data: { text: 'abc', marks: [mark(0, 2)] } }, { type: 'paragraph', data: { text: 'abc', marks: [], purpose: 'import-source' } }]) assert.throws(() => validateBlocks([{ id: 'b', ...value }]), DomainError);
});
