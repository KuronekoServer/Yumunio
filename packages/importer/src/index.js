import { isAppFlowyNativeArchive, parseAppFlowyNative } from './appflowy-native.js';
import { parseMarkdownBlocks } from './markdown.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const IMPORT_LIMITS = Object.freeze({
  archiveBytes: 16 * 1024 * 1024, entries: 2000, entryBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, compressionRatio: 200, depth: 16,
  pathChars: 1024, textBytes: 2 * 1024 * 1024, csvRows: 10000, csvColumns: 128, cellChars: 65536,
  blocks: 20000, links: 10000, matches: 10000, columns: 10000,
});
// Native backups include duplicate collaboration snapshots and larger binary
// attachments. These bounds apply only to the AppFlowy archive reader.
export const APPFLOWY_IMPORT_LIMITS = Object.freeze({
  ...IMPORT_LIMITS, archiveBytes: 64 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024,
});
export class ImportPreviewError extends Error {
  constructor(code) { super('The import preview could not be prepared.'); this.name = 'ImportPreviewError'; this.code = code; }
}
const fail = code => { throw new ImportPreviewError(code); };
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
};
function limitsOf(value = {}, maximum = IMPORT_LIMITS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_OPTIONS');
  const result = { ...maximum };
  for (const [name, limit] of Object.entries(value)) {
    if (!Object.hasOwn(result, name) || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum[name]) fail('INVALID_OPTIONS');
    result[name] = limit;
  }
  return result;
}
const decode = bytes => { try { return decoder.decode(bytes); } catch { fail('INVALID_UTF8'); } };
function safePath(value, limits) {
  if (!value || value.length > limits.pathChars || /[\\:\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) || value.startsWith('/')) fail('UNSAFE_ZIP_PATH');
  const directory = value.endsWith('/');
  const path = (directory ? value.slice(0, -1) : value).normalize('NFC');
  const parts = path.split('/');
  if (parts.length > limits.depth || parts.some(part => !part || part === '.' || part === '..' ||
      part.length > 255 || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('UNSAFE_ZIP_PATH');
  return { path, directory };
}
function extraFields(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) fail('INVALID_ZIP');
    const kind = view.getUint16(offset, true), size = view.getUint16(offset + 2, true);
    if (kind === 1) fail('UNSUPPORTED_ZIP64');
    offset += 4 + size;
    if (offset > bytes.length) fail('INVALID_ZIP');
  }
}
function directory(bytes, limits) {
  if (bytes.length > limits.archiveBytes) fail('ARCHIVE_TOO_LARGE');
  if (bytes.length < 22) fail('INVALID_ZIP');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail('INVALID_ZIP');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count === 65535 || size === 0xffffffff || start === 0xffffffff) fail('UNSUPPORTED_ZIP64');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) fail('UNSUPPORTED_SPLIT_ZIP');
  if (count > limits.entries) fail('TOO_MANY_ENTRIES');
  if (start + size !== end || start > end) fail('INVALID_ZIP');
  const entries = [], names = new Set();
  let offset = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail('INVALID_ZIP');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true), uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true), recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > end || !nameLength || view.getUint16(offset + 34, true)) fail('INVALID_ZIP');
    if ([compressed, uncompressed, local].includes(0xffffffff)) fail('UNSUPPORTED_ZIP64');
    if (flags & 1) fail('ENCRYPTED_ZIP');
    if (flags & ~0x080e || ![0, 8].includes(method)) fail('UNSUPPORTED_COMPRESSION');
    if ((view.getUint32(offset + 38, true) >>> 16 & 0xf000) === 0xa000) fail('UNSAFE_ZIP_SYMLINK');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x0800) && nameBytes.some(byte => byte > 127)) fail('UNSUPPORTED_FILENAME_ENCODING');
    const decodedName = decode(nameBytes), { path, directory: isDirectory } = safePath(decodedName, limits);
    const collisionKey = path.toLowerCase();
    if (names.has(collisionKey)) fail('DUPLICATE_ZIP_PATH');
    names.add(collisionKey);
    extraFields(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    total += uncompressed;
    if (uncompressed > limits.entryBytes || total > limits.totalBytes ||
        uncompressed / Math.max(1, compressed) > limits.compressionRatio) fail('DECOMPRESSION_LIMIT');
    if (isDirectory && uncompressed !== 0) fail('INVALID_ZIP');
    if (local + 30 > start || view.getUint32(local, true) !== 0x04034b50 ||
        view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) fail('ZIP_HEADER_MISMATCH');
    const localNameLength = view.getUint16(local + 26, true), localExtraLength = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
    if (localNameLength !== nameLength || dataEnd > start || dataStart > start ||
        !nameBytes.every((byte, n) => byte === bytes[local + 30 + n])) fail('ZIP_HEADER_MISMATCH');
    extraFields(bytes.subarray(local + 30 + localNameLength, dataStart));
    const localCrc = view.getUint32(local + 14, true), localCompressed = view.getUint32(local + 18, true), localUncompressed = view.getUint32(local + 22, true);
    if (flags & 8) {
      if ((localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressed) ||
          (localUncompressed !== 0 && localUncompressed !== uncompressed)) fail('ZIP_HEADER_MISMATCH');
    } else if (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed) fail('ZIP_HEADER_MISMATCH');
    let rangeEnd = dataEnd;
    if (flags & 8) {
      const hasSignature = rangeEnd + 4 <= start && view.getUint32(rangeEnd, true) === 0x08074b50;
      const descriptor = rangeEnd + (hasSignature ? 4 : 0);
      if (descriptor + 12 > start || view.getUint32(descriptor, true) !== crc ||
          view.getUint32(descriptor + 4, true) !== compressed || view.getUint32(descriptor + 8, true) !== uncompressed) fail('ZIP_HEADER_MISMATCH');
      rangeEnd = descriptor + 12;
    }
    entries.push({ path, directory: isDirectory, method, crc, compressed, uncompressed, local, dataStart, dataEnd, rangeEnd });
    offset = recordEnd;
  }
  if (offset !== end) fail('INVALID_ZIP');
  const paths = new Map(entries.map(entry => [entry.path.toLowerCase(), entry]));
  const prefixes = new Map();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/'), key = prefix.toLowerCase();
      if (prefixes.has(key) && prefixes.get(key) !== prefix) fail('DUPLICATE_ZIP_PATH');
      prefixes.set(key, prefix);
      if (length < parts.length && paths.has(key) && !paths.get(key).directory) fail('UNSAFE_ZIP_PATH');
    }
  }
  let covered = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== covered) fail('ZIP_OVERLAP_OR_UNLISTED_DATA');
    covered = entry.rangeEnd;
  }
  if (covered !== start) fail('ZIP_OVERLAP_OR_UNLISTED_DATA');
  return { entries, total };
}

/** Bounded browser/Workers adapter. Support for deflate-raw is runtime-dependent. */
export async function inflateRawWeb(bytes, { maxOutputBytes }) {
  let stream;
  try { stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
  catch { fail('DEFLATE_UNAVAILABLE'); }
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxOutputBytes) { try { await reader.cancel(); } catch {} fail('DECOMPRESSION_LIMIT'); }
      chunks.push(value);
    }
  } catch (cause) { if (cause instanceof ImportPreviewError) throw cause; fail('INVALID_DEFLATE'); }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function csv(text, limits) {
  if (text === '') fail('INVALID_CSV');
  const rows = [], row = [];
  let cell = '', quoted = false, closed = false, atStart = true, endedWithNewline = false;
  const saveCell = () => { if (cell.length > limits.cellChars) fail('CSV_LIMIT'); row.push(cell); cell = ''; closed = false; atStart = true; if (row.length > limits.csvColumns) fail('CSV_LIMIT'); };
  const saveRow = () => { saveCell(); rows.push(row.splice(0)); if (rows.length > limits.csvRows + 1) fail('CSV_LIMIT'); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]; endedWithNewline = false;
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === ',') saveCell();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[index + 1] === '\n') index++; saveRow(); endedWithNewline = true; }
    else if (char === '"' && atStart && !closed) { quoted = true; atStart = false; }
    else { if (closed || char === '"') fail('INVALID_CSV'); cell += char; atStart = false; }
    if (cell.length > limits.cellChars) fail('CSV_LIMIT');
  }
  if (quoted) fail('INVALID_CSV');
  if (!endedWithNewline) saveRow();
  if (!rows.length || rows.some(row => row.length !== rows[0].length)) fail('CSV_ROW_WIDTH');
  return rows;
}
const fileStem = (path, source) => { const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''); return source === 'appflowy-markdown-csv' ? stem : stem.replace(/ [a-f0-9]{32}(?:_all)?$/i, ''); };
function markdown(text, id, maxBlocks) {
  try { return parseMarkdownBlocks(text, id, maxBlocks); }
  catch (cause) { if (cause?.code === 'MODEL_LIMIT') fail('MODEL_LIMIT'); throw cause; }
}
export function scanMarkdownLinks(text, maxLinks = IMPORT_LIMITS.links) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maxLinks) || maxLinks < 0 || maxLinks > IMPORT_LIMITS.links) fail('INVALID_OPTIONS');
  // HTML-containing blocks remain literal; this subset does not parse HTML semantics.
  if (/<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*|\/?)>/.test(text)) return [];
  const runs=[...text.matchAll(/`+/g)].map(match=>({start:match.index,end:match.index+match[0].length,length:match[0].length,next:-1}));
  const nextRuns=new Map(),literalRanges=[];
  for(let index=runs.length-1;index>=0;index--){runs[index].next=nextRuns.get(runs[index].length)??-1;nextRuns.set(runs[index].length,index);}
  for(let index=0;index<runs.length;) {
    const end=runs[index].next;
    literalRanges.push({start:runs[index].start,end:end<0?text.length:runs[end].end});
    if(end<0)break;
    index=end+1;
  }
  let literalIndex=0;
  const result = [];
  for (let position = 0; position < text.length;) {
    const open = text.indexOf('[', position);
    if (open < 0) break;
    while(literalRanges[literalIndex]?.end<=open)literalIndex++;
    if(literalRanges[literalIndex]?.start<=open){position=literalRanges[literalIndex].end;continue;}
    const image = open > 0 && text[open - 1] === '!';
    let backslashes=0;for(let index=(image?open-1:open)-1;index>=0&&text[index]==='\\';index--)backslashes++;
    if(backslashes%2){position=open+1;continue;}
    const labelEnd = text.indexOf(']', open + 1);
    if (labelEnd < 0) break;
    position = labelEnd + 1;
    if (text[position] !== '(') continue;
    let cursor = position + 1;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    let href, hrefEnd, hrefStart;
    if (text[cursor] === '<') {
      hrefEnd = text.indexOf('>', cursor + 1);
      if (hrefEnd < 0) break;
      hrefStart = cursor + 1; href = text.slice(hrefStart, hrefEnd); cursor = hrefEnd + 1;
    } else {
      hrefEnd = cursor;
      while (hrefEnd < text.length && !/[\s)]/.test(text[hrefEnd])) hrefEnd++;
      hrefStart = cursor; href = text.slice(hrefStart, hrefEnd); cursor = hrefEnd;
    }
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (text[cursor] === '"') {
      const titleEnd = text.indexOf('"', cursor + 1);
      if (titleEnd < 0) break;
      cursor = titleEnd + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    }
    position = Math.max(position, cursor + 1);
    if (text[cursor] !== ')' || !href) continue;
    if(literalRanges[literalIndex]?.start<cursor+1)continue;
    if (result.length >= maxLinks) fail('MODEL_LIMIT');
    result.push({ label: text.slice(open + 1, labelEnd), href, image, start: image ? open - 1 : open, end: cursor + 1,
      labelStart: open + 1, labelEnd, hrefStart, hrefEnd });
  }
  return result;
}

function linkFragment(href) {
  const index = href.indexOf('#');
  if (index < 0) return undefined;
  try {
    const fragment = decodeURIComponent(href.slice(index + 1));
    if (fragment.length > 512 || /[\u0000-\u001f\u007f]/.test(fragment)) return undefined;
    return fragment;
  } catch { return undefined; }
}

export function resolveImportLink(href, source, entryMap) {
  if (/[\u0000-\u001f\u007f]/.test(href)) return { kind: 'blocked', reason: 'UNSAFE_URL' };
  if (href.startsWith('#')) return { kind: 'fragment', href, ...(linkFragment(href) !== undefined ? { fragment: linkFragment(href) } : {}) };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (scheme) return /^(?:https?|mailto|tel)$/i.test(scheme[1]) ? { kind: 'external', href } : { kind: 'blocked', reason: 'UNSAFE_URL' };
  if (href.startsWith('//') || href.startsWith('/') || href.includes('\\')) return { kind: 'blocked', reason: 'UNSAFE_URL' };
  let path;
  try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return { kind: 'unresolved', reason: 'INVALID_URL_ENCODING' }; }
  if (/[\\:\u0000-\u001f\u007f]/.test(path) || path.startsWith('/')) return { kind: 'blocked', reason: 'UNSAFE_URL' };
  const parts = source.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return { kind: 'blocked', reason: 'OUTSIDE_ARCHIVE' }; parts.pop(); }
    else parts.push(part);
  }
  const entry = entryMap.get(parts.join('/').normalize('NFC'));
  return entry ? { kind: entry.kind, targetId: entry.modelId ?? entry.id,
    ...(linkFragment(href) !== undefined ? { fragment: linkFragment(href) } : {}) } : { kind: 'unresolved', reason: 'MISSING_TARGET' };
}
const warningMessages = Object.freeze({
  APPFLOWY_PORTABLE_ONLY: 'AppFlowyのMarkdown/CSVのみ変換します。ネイティブworkspace backupやJSON設定は復元しません。',
  APPFLOWY_UNREFERENCED_FILES: 'Markdownから参照されないファイルは、内部データや設定を送らないため対象外にします。',
  PREVIEW_ONLY: '構造の確認用です。既存データへの取込みや置換は行いません。',
  NOT_FULL_BACKUP: 'このZIPから権限、履歴、コメント、全ビュー、数式やrelationを完全復元できるとは限りません。',
  CSV_TYPES_UNCONFIRMED: 'CSVの列は文字列として保持しています。型の対応付けは未確定です。',
  ROW_MATCH_UNCONFIRMED: 'CSV行とページの同題候補があります。対応付けは未確定です。',
  AMBIGUOUS_ROW_MATCH: '同題の行またはページが複数あります。自動結合しません。',
  ATTACHMENTS_NOT_IMPORTED: '添付は件数と所在のみ確認しました。保存や取込みは行いません。',
  UNSUPPORTED_ENTRIES: 'HTMLや入れ子ZIPなど未対応の形式が含まれます。',
  UNRESOLVED_LINKS: '解決できない相対リンクがあります。',
  BLOCKED_LINKS: '安全でないリンクは有効なリンクとして扱いません。',
  HTML_AS_TEXT: 'Markdown内のHTMLは文字列として保持し、実行しません。',
  CSV_FORMULA_AS_TEXT: '数式に似たCSVセルを文字列として保持しています。実行しません。',
  CSV_DUPLICATE_HEADERS: '空または重複するCSV見出しがあります。列IDは分けて保持します。',
  MARKDOWN_SUBSET: 'Markdownは限定的な構造解析です。元の文字列も保持し、完全な書式変換は行いません。',
});

/**
 * Pure preview only. The returned plan contains private text and paths; expose
 * summary/warnings by default. No filesystem, network, ACL or persistence calls.
 */
async function unpackEntry(bytes, entry, limits, inflateRaw) {
  const packed = bytes.subarray(entry.dataStart, entry.dataEnd);
  let content;
  if (entry.method === 0) content = packed.slice();
  else {
    if (!inflateRaw) fail('DEFLATE_UNAVAILABLE');
    try { content = await inflateRaw(packed.slice(), { maxOutputBytes: Math.min(limits.entryBytes, entry.uncompressed + 1), expectedBytes: entry.uncompressed }); }
    catch (cause) { if (cause instanceof ImportPreviewError) throw cause; fail('INVALID_DEFLATE'); }
    if (!(content instanceof Uint8Array)) fail('INVALID_DEFLATE');
  }
  if (content.length !== entry.uncompressed || content.length > limits.entryBytes) fail('ZIP_SIZE_MISMATCH');
  if (crc32(content) !== entry.crc) fail('ZIP_CRC_MISMATCH');
  return content.slice();
}
export function classifyImportEntry(path, source = 'notion-markdown-csv') {
  const extension = /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase() ?? '';
  return extension === 'md' || extension === 'markdown' ? 'page' : extension === 'csv' ? 'collection' :
    ['html', 'htm', 'zip'].includes(extension) || source === 'appflowy-markdown-csv' && (['json','db','sqlite','sqlite3','collab','af','bak','backup'].includes(extension) || /(?:^|\/)(?:\.DS_Store|config|manifest|metadata)(?:\.|$)/i.test(path)) ? 'unsupported' : 'attachment';
}

/** Return attachment bytes separately from the JSON preview; no filesystem or network operations. */
export async function extractNotionAttachments(input, { inflateRaw, limits: overrides } = {}) {
  if (!(input instanceof Uint8Array) || (inflateRaw !== undefined && typeof inflateRaw !== 'function')) fail('INVALID_OPTIONS');
  const limits = limitsOf(overrides), bytes = input.slice(), archive = directory(bytes, limits), attachments = new Map();
  let fileIndex = 0;
  for (const entry of archive.entries) {
    const content = await unpackEntry(bytes, entry, limits, inflateRaw);
    if (entry.directory) continue;
    const id = 'entry-' + (++fileIndex);
    if (classifyImportEntry(entry.path) === 'attachment') attachments.set(id, content);
  }
  return attachments;
}

async function previewMarkdownCsvImport(input, { inflateRaw, limits: overrides } = {}, source) {
  if (!(input instanceof Uint8Array) || (inflateRaw !== undefined && typeof inflateRaw !== 'function')) fail('INVALID_OPTIONS');
  const limits = limitsOf(overrides);
  // Capture the caller's bytes before the first await.
  const bytes = input.slice();
  const archive = directory(bytes, limits), warnings = new Map();
  const warn = (code, count = 1) => { warnings.set(code, (warnings.get(code) ?? 0) + count); };
  warn('PREVIEW_ONLY'); warn('NOT_FULL_BACKUP');
  if (source === 'appflowy-markdown-csv') warn('APPFLOWY_PORTABLE_ONLY');
  const entries = [], pages = [], collections = [], links = [], matches = [], unsupported = [];
  let totalBlocks = 0, totalRows = 0, totalColumns = 0;
  for (const entry of archive.entries) {
    const content = await unpackEntry(bytes, entry, limits, inflateRaw);
    if (entry.directory) continue;
    const extension = /\.([^.\/]+)$/.exec(entry.path)?.[1].toLowerCase() ?? '';
    const kind = classifyImportEntry(entry.path, source);
    const item = { id: 'entry-' + (entries.length + 1), path: entry.path, kind, bytes: content.length };
    entries.push(item);
    if (kind === 'page' || kind === 'collection') {
      if (content.length > limits.textBytes) fail('TEXT_TOO_LARGE');
      const text = decode(content).replace(/^\ufeff/, '');
      if (text.includes('\0')) fail('INVALID_TEXT');
      if (kind === 'page') {
        const id = 'page-' + (pages.length + 1), parsed = markdown(text, id, limits.blocks - totalBlocks);
        totalBlocks += parsed.blocks.length;
        item.modelId = id;
        pages.push({ id, entryId: item.id, title: parsed.title || fileStem(item.path, source), sourceMarkdown: text,
          blocks: parsed.blocks, propertyCandidates: parsed.propertyCandidates, parentCandidateId: null });
        if (parsed.rawHtml) warn('HTML_AS_TEXT');
        warn('MARKDOWN_SUBSET');
      } else {
        const rows = csv(text, { ...limits, csvRows: limits.csvRows - totalRows }), id = 'collection-' + (collections.length + 1);
        totalRows += rows.length - 1; totalColumns += rows[0].length;
        if (totalColumns > limits.columns) fail('MODEL_LIMIT');
        item.modelId = id;
        collections.push({ id, entryId: item.id, title: fileStem(item.path, source),
          columns: rows[0].map((name, index) => ({ id: 'column-' + (index + 1), name, type: 'text', confirmed: false })),
          rows: rows.slice(1).map((cells, index) => ({ id: id + '-row-' + (index + 1), cells })) });
        if (rows[0].some(name => !name.trim()) || new Set(rows[0]).size !== rows[0].length) warn('CSV_DUPLICATE_HEADERS');
        const formulas = rows.slice(1).flat().filter(cell => /^[\s\u0000-\u001f]*[=+@-]/.test(cell)).length;
        if (formulas) warn('CSV_FORMULA_AS_TEXT', formulas);
        warn('CSV_TYPES_UNCONFIRMED');
      }
    } else if (kind === 'unsupported') { unsupported.push({ entryId: item.id, reason: 'UNSUPPORTED_' + (extension.toUpperCase() || 'FORMAT') }); warn('UNSUPPORTED_ENTRIES'); }
    else if (source !== 'appflowy-markdown-csv') warn('ATTACHMENTS_NOT_IMPORTED');
  }
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const pageStems = new Map();
  for (const page of pages) {
    const entry = entries.find(row => row.id === page.entryId);
    pageStems.set(entry.path.replace(/\.(?:md|markdown)$/i, ''), page.id);
  }
  for (const page of pages) {
    const entry = entries.find(row => row.id === page.entryId);
    const slash = entry.path.lastIndexOf('/');
    page.parentCandidateId = slash < 0 ? null : pageStems.get(entry.path.slice(0, slash)) ?? null;
    for (const block of page.blocks.filter(block => block.kind !== 'code')) {
      for (const match of scanMarkdownLinks(block.text, limits.links - links.length)) {
        const resolved = resolveImportLink(match.href, entry.path, byPath);
        if (links.length >= limits.links) fail('MODEL_LIMIT');
        links.push({ id: 'link-' + (links.length + 1), sourceId: page.id, label: match.label, image: match.image, blockId: block.id,
          start: match.start, end: match.end, labelStart: match.labelStart, labelEnd: match.labelEnd, hrefStart: match.hrefStart, hrefEnd: match.hrefEnd, rawHref: match.href, ...resolved });
        if (resolved.kind === 'unresolved') warn('UNRESOLVED_LINKS');
        if (resolved.kind === 'blocked') warn('BLOCKED_LINKS');
      }
    }
  }
  if (source === 'appflowy-markdown-csv') {
    if (!pages.length && !collections.length) fail('APPFLOWY_PORTABLE_CONTENT_REQUIRED');
    const referenced = new Set(links.filter(link => link.kind === 'attachment').map(link => link.targetId));
    for (const entry of entries) if (entry.kind === 'attachment') {
      if (referenced.has(entry.id)) warn('ATTACHMENTS_NOT_IMPORTED');
      else { entry.kind = 'unsupported'; unsupported.push({entryId: entry.id, reason: 'APPFLOWY_UNREFERENCED_FILE'}); warn('APPFLOWY_UNREFERENCED_FILES'); warn('UNSUPPORTED_ENTRIES'); }
    }
  }
  const pagesByTitle = new Map();
  for (const page of pages) {
    if (!page.title) continue;
    if (!pagesByTitle.has(page.title)) pagesByTitle.set(page.title, []);
    pagesByTitle.get(page.title).push(page);
  }
  for (const collection of collections) {
    for (const row of collection.rows) {
      const candidates = [...new Set(row.cells.flatMap(cell => pagesByTitle.get(cell) ?? []))];
      if (matches.length + candidates.length > limits.matches) fail('MODEL_LIMIT');
      if (candidates.length) {
        for (const page of candidates) matches.push({ collectionId: collection.id, rowId: row.id, pageId: page.id,
          method: 'exact-title-in-cell', confirmed: false, ambiguous: candidates.length > 1 });
        warn('ROW_MATCH_UNCONFIRMED', candidates.length);
      }
    }
  }
  const pageMatches = new Map();
  for (const match of matches) pageMatches.set(match.pageId, (pageMatches.get(match.pageId) ?? 0) + 1);
  for (const match of matches) if (pageMatches.get(match.pageId) > 1) match.ambiguous = true;
  const ambiguous = matches.filter(match => match.ambiguous).length;
  if (ambiguous) warn('AMBIGUOUS_ROW_MATCH', ambiguous);
  const warningList = [...warnings].map(([code, count]) => ({ code, message: warningMessages[code], count }));
  return { schemaVersion: 1, source, summary: {
    entries: entries.length, pages: pages.length, collections: collections.length,
    records: collections.reduce((sum, collection) => sum + collection.rows.length, 0),
    attachments: entries.filter(entry => entry.kind === 'attachment').length, links: links.length,
    unresolvedLinks: links.filter(link => link.kind === 'unresolved').length, matchingCandidates: matches.length,
    unsupported: unsupported.length, archiveBytes: bytes.length, uncompressedBytes: archive.total,
  }, warnings: warningList, entries, pages, collections, links, matches, unsupported };
}

export const previewNotionImport = (input, options) => previewMarkdownCsvImport(input, options, 'notion-markdown-csv');
async function appFlowyArchive(input, { inflateRaw, limits: overrides } = {}) {
  if (!(input instanceof Uint8Array) || (inflateRaw !== undefined && typeof inflateRaw !== 'function')) fail('INVALID_OPTIONS');
  const limits = limitsOf(overrides, APPFLOWY_IMPORT_LIMITS), bytes = input.slice(), archive = directory(bytes, limits);
  const jsonEntries = new Map(), entries = [];
  let jsonBytes = 0;
  for (const entry of archive.entries) {
    if (entry.directory) continue;
    entries.push({ id: 'entry-' + (entries.length + 1), path: entry.path, bytes: entry.uncompressed });
    if (!/\.json$/i.test(entry.path)) continue;
    jsonBytes += entry.uncompressed;
    if (entry.uncompressed > limits.textBytes || jsonBytes > 8 * 1024 * 1024) fail('APPFLOWY_JSON_LIMIT');
    jsonEntries.set(entry.path, await unpackEntry(bytes, entry, limits, inflateRaw));
  }
  return { bytes, archive, limits, entries, jsonEntries, inflateRaw };
}
export async function previewAppFlowyImport(input, options) {
  const archive = await appFlowyArchive(input, options);
  if (!isAppFlowyNativeArchive(archive.jsonEntries)) return previewMarkdownCsvImport(archive.bytes, options, 'appflowy-markdown-csv');
  return parseAppFlowyNative(archive.jsonEntries, { entries: archive.entries,
    archiveBytes: archive.bytes.length, uncompressedBytes: archive.archive.total });
}
/** Only explicitly staged files leave this pure, bounded extraction adapter. */
export async function extractAppFlowyAttachments(input, options) {
  const archive = await appFlowyArchive(input, options);
  if (!isAppFlowyNativeArchive(archive.jsonEntries)) return extractNotionAttachments(archive.bytes, options);
  const plan = await parseAppFlowyNative(archive.jsonEntries, { entries: archive.entries,
    archiveBytes: archive.bytes.length, uncompressedBytes: archive.archive.total });
  const assets = new Map(plan.entries.filter(entry => entry.kind === 'attachment').map(entry => [entry.path, entry.id]));
  const result = new Map();
  for (const entry of archive.archive.entries) if (assets.has(entry.path)) {
    result.set(assets.get(entry.path), await unpackEntry(archive.bytes, entry, archive.limits, archive.inflateRaw));
  }
  return result;
}
export const extractMarkdownCsvAttachments = extractNotionAttachments;
