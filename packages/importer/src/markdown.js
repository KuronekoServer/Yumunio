// Deliberately bounded Markdown subset for portable Notion/AppFlowy exports.
// This module never interprets HTML, resolves URLs, or reads external data.
const punctuation = char => !!char && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(char);
const blank = char => !char || /\s/.test(char);
const indentation = value => [...value].reduce((size, char) => size + (char === '\t' ? 4 - size % 4 : 1), 0);
const listKinds = new Set(['todo', 'list-item']);
const html = value => /<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*|\/?)>/.test(value);

export function parseMarkdownBlocks(text, id, maxBlocks) {
  const lines = text.split(/\r\n|\n|\r/), blocks = [], propertyCandidates = [];
  let title = '', rawHtml = false, fence = null, code = [], unsupported = 0;
  let listStack = [], quotes = [], quoteKey = '', separated = true;
  const hasChildren = new Set(), depths = new Map();
  const push = (kind, value, extra = {}, parent = null) => {
    if (blocks.length >= maxBlocks) { const error = new Error('MODEL_LIMIT'); error.code = 'MODEL_LIMIT'; throw error; }
    const block = {id: id + '-block-' + (blocks.length + 1), kind, text: value, ...extra};
    if (parent && (depths.get(parent.id) ?? 0) >= 8) { parent = null; unsupported++; }
    if (parent) { block.parentBlockId = parent.id; hasChildren.add(parent.id); }
    depths.set(block.id, parent ? depths.get(parent.id) + 1 : 0);
    blocks.push(block); return block;
  };
  const listParent = indent => {
    while (listStack.length && listStack.at(-1).indent >= indent) listStack.pop();
    return listStack.at(-1)?.block ?? null;
  };
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (fence) {
      if (fence.quoteDepth) {
        for (let depth = 0; depth < fence.quoteDepth; depth++) line = line.replace(/^\s*> ?/, '');
      }
      if (fence.indent) line = line.replace(new RegExp('^ {0,' + fence.indent + '}'), '');
      const marker = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length) {
        push('code', code.join('\n'), fence.language ? {language: fence.language} : {}, fence.parent);
        fence = null; code = [];
      } else code.push(line);
      continue;
    }
    if (!line.trim()) { separated = true; continue; }
    const leading = /^[ \t]*/.exec(line)[0], indent = indentation(leading);
    line = line.slice(leading.length);
    let quoteDepth = 0;
    while (/^> ?/.test(line)) { line = line.replace(/^> ?/, ''); quoteDepth++; }
    let parent = null;
    if (quoteDepth) {
      const enclosing = listParent(indent), key = (enclosing?.id ?? '') + ':' + indent;
      if (key !== quoteKey) quotes = [];
      quoteKey = key;
      for (let depth = 0; depth < Math.min(quoteDepth, 8); depth++) {
        if (!quotes[depth]) quotes[depth] = push('quote', '', {}, depth ? quotes[depth - 1] : enclosing);
      }
      if (quoteDepth > 8) unsupported++;
      quotes.length = Math.min(quoteDepth, 8); parent = quotes.at(-1);
      // Lists inside a quote use the quote itself as their outer container.
      listStack = listStack.filter(frame => !frame.quoteId || frame.quoteId === parent.id);
    } else {
      quotes = []; quoteKey = '';
      while (listStack.length && indent < listStack.at(-1).contentIndent) listStack.pop();
      parent = listStack.at(-1)?.block ?? null;
    }
    if (html(line)) rawHtml = true;
    const marker = /^(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (marker) {
      const info = marker[2].trim(), language = /^[A-Za-z0-9_+.#-]{1,100}$/.test(info) ? info : '';
      if (info && !language) unsupported++;
      fence = {marker: marker[1], language, parent, indent: Math.min(indent, 64), quoteDepth};
      code = []; separated = false; continue;
    }
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(line)) {
      push('divider', '', {}, parent); separated = false; continue;
    }
    const heading = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    const setext = !heading && index + 1 < lines.length && /^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1]);
    if (heading || setext) {
      const value = heading ? heading[2] : line, level = heading ? heading[1].length : lines[++index].trim()[0] === '=' ? 1 : 2;
      if (!title && level === 1 && !parent) title = renderMarkdownInline(value).text;
      push('heading', value, {level}, parent); if (level > 3) unsupported++;
      separated = false; continue;
    }
    const list = /^(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/.exec(line);
    if (list) {
      const actualIndent = indent + quoteDepth * 2, outer = quoteDepth ? parent : listParent(actualIndent);
      const checked = /^\[([ xX])\][ \t]*(.*)$/.exec(list[3]);
      const extras = checked ? {checked: checked[1].toLowerCase() === 'x'} : {listStyle: list[2] ? 'numbered' : 'bulleted', ...(list[2] ? {start: Number(list[2])} : {})};
      const nesting = listStack.length + quoteDepth;
      const block = push(checked ? 'todo' : 'list-item', checked ? checked[2] : list[3], extras, nesting <= 8 ? outer : null);
      if (nesting > 8) unsupported++;
      listStack.push({indent: actualIndent, contentIndent: actualIndent + line.length - list[3].length, block, quoteId: parent?.id});
      separated = false; continue;
    }
    if (quoteDepth && parent && !parent.text && !hasChildren.has(parent.id)) parent.text = line;
    else if (quoteDepth && parent && !separated && blocks.at(-1) === parent) parent.text += '\n' + line;
    else if (parent && listKinds.has(parent.kind) && !separated && blocks.at(-1) === parent) parent.text += '\n' + line;
    else {
      const property = /^([^#\s][^:]{0,100}):[ \t]*(.*)$/.exec(line);
      if (property && !parent) propertyCandidates.push({name: property[1], value: property[2], confirmed: false});
      push('paragraph', line, {}, parent);
    }
    if (/^\|.*\|$|^\$\$|^\[\^[^\]]+\]:/.test(line)) unsupported++;
    separated = false;
  }
  if (fence) { push('code', code.join('\n'), fence.language ? {language: fence.language} : {}, fence.parent); unsupported++; }
  return {title, blocks, propertyCandidates, rawHtml, unclosedFence: fence !== null, unsupported};
}

const styles = ['bold', 'italic', 'strike', 'underline', 'code'];
const entityPattern = /^&(?:amp|lt|gt|quot|apos|#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6}));/;
function entity(value) {
  const known = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"};
  if (Object.hasOwn(known, value)) return known[value];
  const hex = value[2]?.toLowerCase() === 'x', point = Number.parseInt(value.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : value;
}

/**
 * Render supported inline styles as canonical disjoint UTF-16 runs. Unconverted
 * link ranges are literal. Offsets map input boundaries to rendered boundaries
 * so separately validated private page/asset references retain exact labels.
 */
export function renderMarkdownInline(value, {literalRanges = []} = {}) {
  const offsets = new Uint32Array(value.length + 1);
  if (html(value)) {
    for (let i = 0; i <= value.length; i++) offsets[i] = i;
    return {text: value, marks: [], offsets};
  }
  const replacements = new Map(), events = new Map(), ranges = [...literalRanges].sort((a, b) => a.start - b.start);
  const event = (at, style, amount) => { if (!events.has(at)) events.set(at, []); events.get(at).push([style, amount]); };
  const pair = (open, close) => {
    replacements.set(open.start, {end: open.end, value: ''}); replacements.set(close.start, {end: close.end, value: ''});
    for (const style of open.styles) { event(open.end, style, 1); event(close.start, style, -1); }
  };
  const stack = []; let rangeIndex = 0, tokens = 0;
  const ticks = [...value.matchAll(/`+/g)].map(match => ({start: match.index, end: match.index + match[0].length, length: match[0].length, next: -1}));
  const nextTick = new Map(), tickByStart = new Map();
  for (let index = ticks.length - 1; index >= 0; index--) { ticks[index].next = nextTick.get(ticks[index].length) ?? -1; nextTick.set(ticks[index].length, index); tickByStart.set(ticks[index].start, index); }
  for (let position = 0; position < value.length;) {
    while (ranges[rangeIndex]?.end <= position) rangeIndex++;
    if (ranges[rangeIndex]?.start <= position) { position = ranges[rangeIndex].end; continue; }
    const char = value[position];
    if (char === '\\' && punctuation(value[position + 1])) { replacements.set(position, {end: position + 2, value: value[position + 1]}); position += 2; continue; }
    if (char === '&') {
      const match = entityPattern.exec(value.slice(position, position + 20));
      if (match) { replacements.set(position, {end: position + match[0].length, value: entity(match[0])}); position += match[0].length; continue; }
    }
    if (char === '`') {
      const open = ticks[tickByStart.get(position)], close = ticks[open?.next];
      if (!open || !close) { position = value.length; continue; }
      if (ranges[rangeIndex]?.start < close.end) { position = open.end; continue; }
      pair({...open, styles: ['code']}, close);
      let start = open.end, end = close.start;
      if (value[start] === ' ' && value[end - 1] === ' ' && /[^ ]/.test(value.slice(start, end))) {
        replacements.set(start, {end: start + 1, value: ''}); replacements.set(end - 1, {end, value: ''});
      }
      for (let at = start; at < end; at++) if (value[at] === '\n' || value[at] === '\r') replacements.set(at, {end: at + 1, value: ' '});
      position = close.end; continue;
    }
    if (!['*', '_', '~'].includes(char)) { position++; continue; }
    let end = position + 1; while (value[end] === char) end++;
    const count = end - position;
    if (count > 3 || char === '~' && count !== 2 || ++tokens > 20000) { position = end; continue; }
    const before = value[position - 1], after = value[end];
    const left = !blank(after) && (!punctuation(after) || blank(before) || punctuation(before));
    const right = !blank(before) && (!punctuation(before) || blank(after) || punctuation(after));
    const canOpen = left && (char !== '_' || !right || punctuation(before));
    const canClose = right && (char !== '_' || !left || punctuation(after));
    let remaining = count, at = position;
    if (canClose) {
      while (remaining && stack.at(-1)?.char === char && stack.at(-1).size <= remaining) {
        const open = stack.pop(), close = {start: at, end: at + open.size};
        if (open.end === close.start) { stack.push(open); break; }
        pair(open, close); at += open.size; remaining -= open.size;
      }
    }
    if (canOpen && stack.length < 32) {
      while (remaining && stack.length < 32) {
        const size = char === '~' ? 2 : remaining >= 2 ? 2 : 1;
        stack.push({char, size, start: at, end: at + size, styles: [char === '~' ? 'strike' : size === 2 ? 'bold' : 'italic']});
        at += size; remaining -= size;
      }
    }
    position = end;
  }
  const active = Object.fromEntries(styles.map(style => [style, 0])), parts = [], marks = [];
  let length = 0, run = null;
  for (let position = 0; position < value.length;) {
    for (const [style, amount] of events.get(position) ?? []) active[style] += amount;
    const replacement = replacements.get(position), end = replacement?.end ?? position + 1, text = replacement?.value ?? value[position];
    const runStyles = styles.filter(style => active[style] > 0), key = runStyles.join(',');
    for (let at = position; at < end; at++) offsets[at] = length;
    if (text) {
      if (key) {
        if (run?.key === key && run.end === length) run.end += text.length;
        else { run = {start: length, end: length + text.length, styles: runStyles, key}; marks.push(run); }
      } else run = null;
      parts.push(text); length += text.length;
    }
    offsets[end] = length; position = end;
  }
  return {text: parts.join(''), marks: marks.map(({key, ...mark}) => mark), offsets};
}
