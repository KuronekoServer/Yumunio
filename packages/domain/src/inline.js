export const INLINE_STYLES = Object.freeze(['bold', 'italic', 'strike', 'underline', 'code']);
export const MAX_INLINE_MARKS = 1000;
const MAX_TEXT = 100000;
export class InlineTextError extends TypeError {
  constructor() { super('INVALID_INLINE_MARKS'); this.name = 'InlineTextError'; this.code = 'INVALID_INLINE_MARKS'; }
}
const fail = () => { throw new InlineTextError(); };
const plain = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
};
const array = (value, maximum = MAX_INLINE_MARKS) => {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
};
const textValue = text => { if (typeof text !== 'string' || text.length > MAX_TEXT) fail(); };
export function isInlineBoundary(text, offset) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length &&
    !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}
function range(text, start, end) {
  textValue(text);
  if (!isInlineBoundary(text, start) || !isInlineBoundary(text, end) || end < start) fail();
}
/** Only absolute web URLs are accepted; there is no HTML, fetching, or credential support. */
export function safeInlineHref(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || /[\u0000-\u0020\u007F-\u009F\u202A-\u202E\u2066-\u2069\\]/.test(value) || !/^https?:\/\//i.test(value)) fail();
  let url; try { url = new URL(value); } catch { fail(); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 2048) fail();
  return url.href;
}
/** Canonical disjoint UTF-16 runs. Adjacent equal runs are accepted and returned independently. */
export function validateInlineMarks(text, marks) {
  textValue(text); array(marks);
  if (marks.length > MAX_INLINE_MARKS) fail();
  let previousEnd = 0;
  return marks.map(mark => {
    plain(mark);
    if (Object.keys(mark).some(key => !['start', 'end', 'styles', 'href'].includes(key))) fail();
    range(text, mark.start, mark.end);
    if (mark.start < previousEnd || mark.start === mark.end) fail();
    array(mark.styles, INLINE_STYLES.length);
    let previousStyle = -1;
    for (const style of mark.styles) {
      const index = INLINE_STYLES.indexOf(style);
      if (index <= previousStyle) fail();
      previousStyle = index;
    }
    if (!mark.styles.length && !Object.hasOwn(mark, 'href')) fail();
    if (Object.hasOwn(mark, 'href')) safeInlineHref(mark.href);
    previousEnd = mark.end;
    return { start: mark.start, end: mark.end, styles: [...mark.styles], ...(Object.hasOwn(mark, 'href') ? { href: mark.href } : {}) };
  });
}
const attributesEqual = (a, b) => a.href === b.href && a.styles.length === b.styles.length && a.styles.every((style, i) => style === b.styles[i]);
function compact(text, marks) {
  const result = [];
  for (const mark of marks.sort((a, b) => a.start - b.start)) {
    if (mark.start === mark.end || !mark.styles.length && !mark.href) continue;
    const previous = result.at(-1);
    if (previous && previous.end === mark.start && attributesEqual(previous, mark)) previous.end = mark.end;
    else result.push({ start: mark.start, end: mark.end, styles: [...mark.styles], ...(mark.href ? { href: mark.href } : {}) });
  }
  return validateInlineMarks(text, result);
}
/** Apply a toolbar command to a nonempty selection in one block. */
export function formatInlineRange(text, marks, start, end, command) {
  range(text, start, end); const source = validateInlineMarks(text, marks);
  plain(command);
  if (Object.keys(command).length !== 1 || !(Object.hasOwn(command, 'style') || Object.hasOwn(command, 'href'))) fail();
  if (Object.hasOwn(command, 'style') && !INLINE_STYLES.includes(command.style)) fail();
  const href = Object.hasOwn(command, 'href') ? (command.href === null ? null : safeInlineHref(command.href)) : undefined;
  if (start === end) return source;
  let covered = start;
  if (command.style) for (const mark of source) {
    if (mark.end <= covered) continue;
    if (mark.start > covered || !mark.styles.includes(command.style)) break;
    covered = Math.min(end, mark.end); if (covered === end) break;
  }
  const remove = covered === end;
  const points = [...new Set([0, text.length, start, end, ...source.flatMap(mark => [mark.start, mark.end])])].sort((a, b) => a - b);
  const result = []; let cursor = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const left = points[i], right = points[i + 1];
    while (cursor < source.length && source[cursor].end <= left) cursor++;
    const existing = source[cursor]?.start <= left ? source[cursor] : { styles: [] };
    const mark = { start: left, end: right, styles: [...existing.styles], ...(existing.href ? { href: existing.href } : {}) };
    if (left >= start && right <= end) {
      if (command.style) mark.styles = INLINE_STYLES.filter(style => style === command.style ? !remove : mark.styles.includes(style));
      else if (href === null) delete mark.href;
      else mark.href = href;
    }
    result.push(mark);
  }
  return compact(text, result);
}
/** Preserve surviving runs. Insertions inherit only one enclosing run, with end-exclusive affinity. */
export function replaceInlineMarks(text, marks, start, end, inserted, { inherit = true } = {}) {
  range(text, start, end); textValue(inserted);
  const source = validateInlineMarks(text, marks), next = text.slice(0, start) + inserted + text.slice(end);
  textValue(next);
  const delta = inserted.length - (end - start), result = [];
  for (const mark of source) {
    if (mark.start < start) result.push({ ...mark, end: Math.min(mark.end, start) });
    if (mark.end > end) result.push({ ...mark, start: Math.max(mark.start, end) + delta, end: mark.end + delta });
  }
  const enclosing = source.find(mark => mark.start <= start && mark.end >= end && (start !== end || start < mark.end));
  if (inherit && inserted && enclosing) result.push({ ...enclosing, start, end: start + inserted.length });
  return compact(next, result);
}
/** A conservative single replacement for IME/browser edits and text-only room updates. */
export function rebaseInlineMarks(before, after, marks) {
  textValue(before); textValue(after); const source = validateInlineMarks(before, marks);
  if (before === after) return source;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (!isInlineBoundary(before, start) || !isInlineBoundary(after, start)) start--;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  while (!isInlineBoundary(before, oldEnd) || !isInlineBoundary(after, newEnd)) { oldEnd++; newEnd++; }
  return replaceInlineMarks(before, source, start, oldEnd, after.slice(start, newEnd), { inherit: false });
}
export function splitInlineMarks(text, marks, start, end) {
  range(text, start, end); const source = validateInlineMarks(text, marks);
  return {
    beforeMarks: compact(text.slice(0, start), source.filter(mark => mark.start < start).map(mark => ({ ...mark, end: Math.min(mark.end, start) }))),
    afterMarks: compact(text.slice(end), source.filter(mark => mark.end > end).map(mark => ({ ...mark, start: Math.max(mark.start, end) - end, end: mark.end - end })))
  };
}
export function joinInlineMarks(before, beforeMarks, after, afterMarks) {
  const left = validateInlineMarks(before, beforeMarks), right = validateInlineMarks(after, afterMarks);
  return compact(before + after, [...left, ...right.map(mark => ({ ...mark, start: mark.start + before.length, end: mark.end + before.length }))]);
}
