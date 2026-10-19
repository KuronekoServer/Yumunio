import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlainText, replaceTextRange, splitTextRange, isComposingInput, MAX_INLINE_TEXT, createInlineEditor } from '../public/inline-editor.js';
import { markdownPrefix } from '../public/editor-model.js';
import { inlineDomFixture } from './fixtures/inline-dom.js';

test('plain-text insertion preserves literal HTML and normalizes line endings', () => {
  assert.deepEqual(replaceTextRange('前後', 1, 1, '<img src=x onerror=alert(1)>\r\n次の行'),
    { text: '前<img src=x onerror=alert(1)>\n次の行後', caret: 1 + '<img src=x onerror=alert(1)>\n次の行'.length });
  assert.equal(normalizePlainText('a\r\nb\rc'), 'a\nb\nc');
});

test('Enter splits around a selection without losing adjacent Japanese or emoji', () => {
  const text = 'あ🙂選択う';
  assert.deepEqual(splitTextRange(text, 3, 5), { before: 'あ🙂', after: 'う' });
  assert.deepEqual(splitTextRange('段落', 2, 2), { before: '段落', after: '' });
  assert.deepEqual(splitTextRange('', 0, 0), { before: '', after: '' });
});

test('text replacement rejects invalid ranges and oversize insertion before mutation', () => {
  assert.throws(() => replaceTextRange('本文', -1, 1, 'x'), RangeError);
  assert.throws(() => splitTextRange('本文', 2, 1), RangeError);
  assert.throws(() => replaceTextRange('a'.repeat(MAX_INLINE_TEXT), 0, 0, 'x'), /TEXT_TOO_LONG/);
  assert.equal(replaceTextRange('a'.repeat(MAX_INLINE_TEXT), 0, MAX_INLINE_TEXT, '置換').text, '置換');
});

test('IME composition and legacy keyCode 229 are recognized independently', () => {
  assert.equal(isComposingInput({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isComposingInput({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isComposingInput({ isComposing: false, keyCode: 13 }), false);
});

test('Enter and mobile paragraph input convert complete fences and dividers before splitting', t => {
  const dom = inlineDomFixture(t);
  for (const marker of ['```', '```js', '```c++', '---']) {
    for (const eventName of ['keydown', 'beforeinput']) {
      const shortcuts = [], splits = [], changes = [];
      const element = createInlineEditor({ text: marker, onShortcut: value => { shortcuts.push(markdownPrefix(value)); return true; },
        onSplit: value => splits.push(value), onChange: value => changes.push(value) });
      dom.select(element, marker.length);
      const event = element.dispatch(eventName, eventName === 'keydown' ? { key: 'Enter' } : { inputType: 'insertParagraph' });
      assert.equal(event.prevented, true); assert.equal(shortcuts.length, 1); assert.equal(splits.length, 0); assert.equal(changes.length, 0);
      assert.equal(shortcuts[0].type, marker === '---' ? 'divider' : 'code');
      assert.equal(shortcuts[0].data.language, marker.startsWith('```') && marker.length > 3 ? marker.slice(3) : undefined);
      assert.equal(element.getInlineState().pendingEdit, false);
    }
  }
});

test('ordinary Enter keeps prose and other Markdown literal and a refused fence still follows the normal split path', t => {
  const dom = inlineDomFixture(t);
  for (const text of ['#', '2.', '> quote', 'before ```js', '**bold**', '<script>', '```js extra', '```' + 'x'.repeat(101)]) {
    const shortcuts = [], splits = [], element = createInlineEditor({ text, onShortcut: value => { shortcuts.push(value); return true; }, onSplit: value => splits.push(value) });
    dom.select(element, text.length); element.dispatch('keydown', { key: 'Enter' });
    assert.equal(shortcuts.length, 0); assert.equal(splits.length, 1); assert.equal(splits[0].before, text); assert.equal(splits[0].after, '');
  }
  const shortcuts = [], splits = [], element = createInlineEditor({ text: '```js', onShortcut: value => { shortcuts.push(value); return false; }, onSplit: value => splits.push(value) });
  dom.select(element, 5); element.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(shortcuts, ['```js ']); assert.equal(splits[0].before, '```js');
  const code = createInlineEditor({ text: '```js', formatEnabled: false }); dom.select(code, 5); code.dispatch('keydown', { key: 'Enter' });
  assert.equal(code.textContent, '```js\n', 'code editors without an accepted paragraph shortcut retain literal input');
});

test('shortcut input respects composition, partial selections and soft line breaks without losing marks or page references', t => {
  const dom = inlineDomFixture(t), shortcuts = [], splits = [];
  const element = createInlineEditor({ text: '```js', marks: [{ start: 0, end: 5, styles: ['bold'] }],
    links: [{ start: 3, end: 5, label: 'js', pageId: 'page-b' }], pageHref: link => '/workspace?page=' + link.pageId,
    onShortcut: value => { shortcuts.push(value); return true; }, onSplit: value => splits.push(value) });
  const before = element.getInlineState(); dom.select(element, 5);
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }]) assert.equal(element.dispatch('keydown', event).prevented, false);
  element.dispatch('compositionstart'); assert.equal(element.dispatch('keydown', { key: 'Enter' }).prevented, false);
  assert.equal(element.dispatch('beforeinput', { inputType: 'insertParagraph' }).prevented, false); element.dispatch('compositionend');
  dom.select(element, 3, 5); element.dispatch('keydown', { key: 'Enter' });
  assert.equal(shortcuts.length, 0); assert.equal(splits.length, 1); assert.equal(splits[0].before, '```');
  assert.deepEqual(element.getInlineState().marks, before.marks); assert.deepEqual(element.getInlineState().links, before.links);
  const soft = createInlineEditor({ text: '---', onShortcut: value => { shortcuts.push(value); return true; } });
  dom.select(soft, 3); soft.dispatch('keydown', { key: 'Enter', shiftKey: true }); assert.equal(soft.textContent, '---\n'); assert.equal(shortcuts.length, 0);
});
