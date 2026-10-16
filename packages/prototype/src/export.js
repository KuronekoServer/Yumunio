import { MAX_SNAPSHOT_BYTES, SnapshotError, validateSnapshot } from './snapshot.js';

export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const fail = (code, message, status = 400) => { throw new SnapshotError(code, message, status); };
const limitsWarning = '添付ファイル・共有権限・コメント・履歴は含まれていません。';
const exchangeWarning = 'Markdown・CSVは交換用です。このZIPからワークスペースを完全復元する機能はありません。';
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function exportOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key => !['format', 'includeTrash', 'now'].includes(key))) fail('INVALID_EXPORT_OPTIONS', 'Invalid export options.');
  const { format = 'markdown-csv-zip', includeTrash = false, now = new Date().toISOString() } = options;
  if (!['markdown-csv-zip', 'native-json'].includes(format) || typeof includeTrash !== 'boolean') fail('INVALID_EXPORT_OPTIONS', 'Invalid export format or trash option.');
  if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) fail('INVALID_EXPORT_OPTIONS', 'Expected a canonical UTC export timestamp.');
  return { format, includeTrash, now };
}

function includedSnapshot(snapshot, includeTrash) {
  const data = validateSnapshot(snapshot);
  const byId = new Map(data.pages.map(page => [page.id, page]));
  const excluded = new Set();
  if (!includeTrash) {
    for (const page of data.pages) {
      let current = page;
      while (current) {
        if (current.deletedAt !== null || excluded.has(current.id)) { excluded.add(page.id); break; }
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
    }
  }
  data.pages = data.pages.filter(page => !excluded.has(page.id));
  const kept = new Set(data.pages.map(page => page.id));
  data.ui.recentPageIds = data.ui.recentPageIds.filter(id => kept.has(id));
  const routePage = data.ui.lastRoute.startsWith('#page/') ? data.ui.lastRoute.slice(6) : null;
  if ((routePage !== null && !kept.has(routePage)) || (!includeTrash && data.ui.lastRoute === '#trash')) data.ui.lastRoute = '#home';
  return { data: validateSnapshot(data), excludedTrash: excluded.size };
}

function slug(value) {
  const cleaned = value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return Array.from(cleaned).slice(0, 32).join('') || 'page';
}

// Content is literal text, never interpreted as user-supplied Markdown or HTML.
function markdown(value, inline = false) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[`*_{}\[\]()#+.!|~\-]/g, character => '\\' + character)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return inline ? escaped.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;') : escaped.replace(/\r\n?/g, '\n').replace(/\t/g, '&#9;');
}

function csvCell(value, recordId, column, transformations) {
  const original = String(value);
  let safe = original.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  if (safe !== original) transformations.push({ recordId, column, action: 'escape-control-character' });
  if (/^[\s\p{Cc}\p{Cf}=+\-@]/u.test(original)) {
    safe = "'" + safe;
    transformations.push({ recordId, column, action: 'prefix-apostrophe' });
  }
  return '"' + safe.replace(/"/g, '""') + '"';
}

function zip(entries, now) {
  if (entries.length > 2100) fail('PAYLOAD_TOO_LARGE', 'Too many export files.', 413);
  let total = 22;
  const files = entries.map(({ name, bytes }) => {
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 180 || !/^[^/\\]+$/.test(name) || name === '.' || name === '..') fail('INVALID_EXPORT', 'Invalid generated export filename.');
    total += 30 + 46 + 2 * nameBytes.length + bytes.length;
    if (total > MAX_EXPORT_BYTES) fail('PAYLOAD_TOO_LARGE', 'Export exceeds the 16 MiB output limit.', 413);
    return { nameBytes, bytes, crc: crc32(bytes), offset: 0 };
  });
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  const date = new Date(now);
  if (date.getUTCFullYear() < 1980) date.setTime(Date.UTC(1980, 0, 1));
  if (date.getUTCFullYear() > 2107) date.setTime(Date.UTC(2107, 11, 31, 23, 59, 58));
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >>> 1);
  let offset = 0;
  for (const file of files) {
    file.offset = offset;
    view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); view.setUint16(offset + 10, dosTime, true); view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, file.crc, true); view.setUint32(offset + 18, file.bytes.length, true); view.setUint32(offset + 22, file.bytes.length, true);
    view.setUint16(offset + 26, file.nameBytes.length, true);
    output.set(file.nameBytes, offset + 30); output.set(file.bytes, offset + 30 + file.nameBytes.length);
    offset += 30 + file.nameBytes.length + file.bytes.length;
  }
  const centralOffset = offset;
  for (const file of files) {
    view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true); view.setUint16(offset + 12, dosTime, true); view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, file.crc, true); view.setUint32(offset + 20, file.bytes.length, true); view.setUint32(offset + 24, file.bytes.length, true);
    view.setUint16(offset + 28, file.nameBytes.length, true); view.setUint32(offset + 42, file.offset, true);
    output.set(file.nameBytes, offset + 46);
    offset += 46 + file.nameBytes.length;
  }
  view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, files.length, true); view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - centralOffset, true); view.setUint32(offset + 16, centralOffset, true);
  return output;
}

/** Pure browser/Workers/Node export over the validated, single-workspace prototype schema. */
export async function buildWorkspaceExport(snapshot, options = {}) {
  const { format, includeTrash, now } = exportOptions(options);
  const { data, excludedTrash } = includedSnapshot(snapshot, includeTrash);
  const summary = { pages: data.pages.length, collections: data.pages.filter(page => page.kind === 'collection').length, records: data.pages.filter(page => page.kind === 'record').length, excludedTrash };
  const warnings = [limitsWarning];
  const filenameBase = 'yumunio-' + slug(data.name) + '-' + now.slice(0, 10);
  if (format === 'native-json') {
    const bytes = encoder.encode(JSON.stringify(data));
    if (bytes.length > MAX_SNAPSHOT_BYTES) fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds the prototype size limit.', 413);
    return { bytes, mimeType: 'application/json', filename: filenameBase + '.json', summary, warnings };
  }

  warnings.push(exchangeWarning);
  const byId = new Map(data.pages.map(page => [page.id, page]));
  const files = new Map(data.pages.map((page, index) => [page.id, String(index + 1).padStart(4, '0') + '-' + slug(page.title)]));
  const children = new Map();
  for (const page of data.pages) {
    if (!children.has(page.parentId)) children.set(page.parentId, []);
    children.get(page.parentId).push(page);
  }
  const transformations = [];
  const entries = [];
  let contentBytes = 0;
  const add = (name, text) => {
    const bytes = encoder.encode(text);
    contentBytes += bytes.length;
    if (contentBytes > MAX_EXPORT_BYTES) fail('PAYLOAD_TOO_LARGE', 'Export exceeds the 16 MiB output limit.', 413);
    entries.push({ name, bytes });
  };
  const link = page => '[' + markdown(page.title || 'Untitled', true) + '](' + files.get(page.id) + '.md)';
  const manifestPages = [];
  for (const page of data.pages) {
    const base = files.get(page.id);
    const lines = ['# ' + markdown(page.title || 'Untitled', true), ''];
    if (page.parentId !== null) lines.push('Parent: ' + link(byId.get(page.parentId)), '');
    if (page.deletedAt !== null) lines.push('Trashed: ' + page.deletedAt, '');
    if (page.kind === 'record') {
      for (const key of ['status', 'owner', 'date']) lines.push('- ' + key + ': ' + markdown(page.properties[key], true));
      lines.push('');
    }
    for (const block of page.blocks) {
      if(block.type==='divider'){lines.push('---','');continue;}
      if(block.type==='code'){
        const text=block.text.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
        const longest=Math.max(0,...Array.from(text.matchAll(/`+/g),match=>match[0].length));
        const fence='`'.repeat(Math.max(3,longest+1));
        lines.push(fence+(block.language||''),text,fence,'');continue;
      }
      const text = markdown(block.text);
      if(block.type==='quote'){lines.push(text.split('\n').map(line=>'> '+line).join('\n'),'');continue;}
      const prefix = block.type === 'heading1' ? '## ' : block.type === 'heading2' ? '### ' : block.type === 'heading3' ? '#### ' : block.type === 'checklist' ? '- [' + (block.checked ? 'x' : ' ') + '] ' : block.type==='bulleted-list'?'- ':block.type==='numbered-list'?String(block.start??1)+'. ':'';
      const continuation=['checklist','bulleted-list','numbered-list'].includes(block.type)?'\n'+' '.repeat(prefix.length):'\n';
      lines.push(prefix + text.replace(/\n/g, continuation), '');
    }
    if (page.kind === 'collection') lines.push('[Records CSV](' + base + '.csv)', '');
    const childPages = children.get(page.id) || [];
    if (childPages.length) lines.push('Children:', '', ...childPages.map(child => '- ' + link(child)), '');
    add(base + '.md', lines.join('\n') + '\n');
    if (page.kind === 'collection') {
      const columns = ['Title', 'Status', 'Owner', 'Date', 'Page'];
      const rows = [columns.map(value => '"' + value + '"').join(',')];
      for (const record of childPages.filter(child => child.kind === 'record')) {
        const values = [record.title, record.properties.status, record.properties.owner, record.properties.date, files.get(record.id) + '.md'];
        rows.push(values.map((value, index) => csvCell(value, record.id, columns[index], transformations)).join(','));
      }
      add(base + '.csv', rows.join('\r\n') + '\r\n');
    }
    manifestPages.push({ id: page.id, parentId: page.parentId, collectionId: page.kind === 'record' ? page.collectionId : null, kind: page.kind, title: page.title, deletedAt: page.deletedAt, sourceFiles: [base + '.md', ...(page.kind === 'collection' ? [base + '.csv'] : [])] });
  }
  if (transformations.length) {
    const changedCells = new Set(transformations.map(item => item.recordId + ':' + item.column)).size;
    warnings.push('CSVの数式実行・制御文字の混入を防ぐため、' + changedCells + 'セルを変換しました。元の値はネイティブJSONで保持できます。');
  }
  const indexLines = ['# ' + markdown(data.name || 'Workspace', true), '', ...warnings.map(message => '- ' + message), '', 'Pages:', '', ...data.pages.map(page => '- ' + link(page)), ''];
  add('index.md', indexLines.join('\n'));
  add('manifest.json', JSON.stringify({ format: 'yumunio-markdown-csv', version: 1, schemaVersion: 1, workspaceName: data.name, generatedAt: now, includeTrash, summary, pages: manifestPages, transformations: { markdown: 'Literal Markdown/HTML escaping; CRLF normalized to LF and unsafe controls represented as text.', csv: transformations }, warnings }, null, 2));
  return { bytes: zip(entries, now), mimeType: 'application/zip', filename: filenameBase + '.zip', summary, warnings };
}