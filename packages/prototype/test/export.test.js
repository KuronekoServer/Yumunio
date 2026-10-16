import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { buildWorkspaceExport, MAX_EXPORT_BYTES } from '../src/export.js';
import { validateSnapshot, MAX_SNAPSHOT_BYTES } from '../src/snapshot.js';

const now = '2026-10-15T00:00:00.000Z';
const decoder = new TextDecoder('utf-8', { fatal: true });
function page(id, title, parentId = null, kind = 'document') {
  return { id, title, parentId, kind, blocks: [{ id: 'block-' + id, type: 'paragraph', text: 'Text <script>alert(1)</script> & [link](https://example.invalid) **bold**', checked: false }], deletedAt: null, createdAt: now, updatedAt: now };
}
function fixture() {
  const root = page('root', 'CON / ../ notes');
  const collection = page('collection', 'Projects', null, 'collection');
  const record = { ...page('record', '=HYPERLINK("https://example.invalid","open")\r\nnext, value', 'collection', 'record'), collectionId: 'collection', properties: { status: '準備', owner: 'Aoi', date: '2026-10-15' } };
  const trash = { ...page('trash', 'Deleted'), deletedAt: now };
  return { schemaVersion: 1, name: 'Workspace 日本語', pages: [root, collection, record, trash, page('child', 'Hidden child', 'trash'), page('grandchild', 'Hidden grandchild', 'child')], ui: { recentPageIds: ['record', 'child', 'missing'], lastRoute: '#page/child' }, updatedAt: now };
}

// Read the central directory and cross-check local records using Node's independent CRC.
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 4, true), 0);
  assert.equal(view.getUint16(end + 6, true), 0);
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count);
  const centralSize = view.getUint32(end + 12, true);
  let position = view.getUint32(end + 16, true);
  assert.equal(position + centralSize, end);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(position, true), 0x02014b50);
    assert.equal(view.getUint16(position + 8, true), 0x0800);
    assert.equal(view.getUint16(position + 10, true), 0);
    const size = view.getUint32(position + 24, true);
    assert.equal(view.getUint32(position + 20, true), size);
    const nameLength = view.getUint16(position + 28, true);
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    assert.ok(!entries.has(name));
    const local = view.getUint32(position + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 6, true), 0x0800);
    assert.equal(view.getUint16(local + 8, true), 0);
    assert.equal(view.getUint32(local + 18, true), size);
    assert.equal(view.getUint32(local + 22, true), size);
    assert.equal(view.getUint16(local + 26, true), nameLength);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)), name);
    const payload = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    assert.equal(payload.length, size);
    assert.equal(crc32(payload), view.getUint32(position + 16, true));
    assert.equal(crc32(payload), view.getUint32(local + 14, true));
    entries.set(name, decoder.decode(payload));
    position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  }
  assert.equal(position, end);
  return entries;
}

// Parse quoted RFC 4180 cells independently of the export's writer.
function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; } else quoted = false;
      } else value += character;
    } else if (character === '"') { assert.equal(value, ''); quoted = true; }
    else if (character === ',') { row.push(value); value = ''; }
    else if (character === '\r') {
      assert.equal(text[++i], '\n'); row.push(value); rows.push(row); row = []; value = '';
    } else { assert.notEqual(character, '\n'); value += character; }
  }
  assert.equal(quoted, false);
  assert.equal(row.length, 0); assert.equal(value, '');
  return rows;
}

function manifestOf(files) { return JSON.parse(files.get('manifest.json')); }

test('native JSON excludes deleted ancestors and descendants, prunes UI references, and never mutates source', async () => {
  const source = fixture(), original = structuredClone(source);
  const result = await buildWorkspaceExport(source, { format: 'native-json', now });
  const data = JSON.parse(decoder.decode(result.bytes));
  assert.deepEqual(result.summary, { pages: 3, collections: 1, records: 1, excludedTrash: 3 });
  assert.deepEqual(data.pages.map(item => item.id), ['root', 'collection', 'record']);
  assert.deepEqual(data.ui, { recentPageIds: ['record'], lastRoute: '#home' });
  assert.deepEqual(validateSnapshot(data), data);
  assert.ok(result.bytes.length <= MAX_SNAPSHOT_BYTES);
  assert.equal(result.mimeType, 'application/json');
  assert.deepEqual(source, original);
  const full = await buildWorkspaceExport(source, { format: 'native-json', includeTrash: true, now });
  const fullData = JSON.parse(decoder.decode(full.bytes));
  assert.deepEqual(fullData.pages, source.pages);
  assert.equal(fullData.pages[2].title, source.pages[2].title);
  assert.deepEqual(full.summary, { pages: 6, collections: 1, records: 1, excludedTrash: 0 });
});

test('ZIP has valid independent CRCs, manifest, Markdown navigation and CSV row targets', async () => {
  const result = await buildWorkspaceExport(fixture(), { now });
  const files = unzip(result.bytes), manifest = manifestOf(files);
  assert.equal(result.mimeType, 'application/zip');
  assert.ok(result.bytes.length <= MAX_EXPORT_BYTES);
  assert.deepEqual(manifest.summary, result.summary);
  assert.equal(manifest.generatedAt, now);
  assert.equal(manifest.pages.length, 3);
  assert.ok(files.has('index.md'));
  for (const item of manifest.pages) {
    for (const name of item.sourceFiles) assert.ok(files.has(name));
    const body = files.get(item.sourceFiles[0]);
    assert.ok(body.includes('&lt;script&gt;'));
    assert.ok(!body.includes('<script>'));
    assert.ok(body.includes('\\*\\*bold\\*\\*'));
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) assert.ok(files.has(match[1]), match[1]);
  }
  const record = manifest.pages.find(item => item.kind === 'record');
  assert.ok(files.get(record.sourceFiles[0]).includes('Parent:'));
  const collection = manifest.pages.find(item => item.kind === 'collection');
  const csv = parseCsv(files.get(collection.sourceFiles[1]));
  assert.deepEqual(csv[0], ['Title', 'Status', 'Owner', 'Date', 'Page']);
  assert.equal(csv[1][0], "'" + fixture().pages[2].title);
  assert.equal(csv[1][1], '準備');
  assert.equal(csv[1][4], record.sourceFiles[0]);
  assert.ok(result.warnings.some(item => item.includes('完全復元')));
  assert.ok(result.warnings.some(item => item.includes('1セル')));
  assert.deepEqual(manifest.transformations.csv, [{ recordId: 'record', column: 'Title', action: 'prefix-apostrophe' }]);
  assert.deepEqual((await buildWorkspaceExport(fixture(), { now })).bytes, result.bytes);
});

test('CSV preserves multiline quotes and explicitly neutralizes formula, whitespace and control prefixes', async () => {
  const values = ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(A1)', ' =1', '\t=1', '\r=1', '\n=1', '\ufeff=1', '\u0000=1', '"plain",\nsecond line'];
  const source = fixture(); source.pages = source.pages.filter(item => item.kind !== 'record');
  for (const [index, title] of values.entries()) source.pages.push({ ...page('r' + index, title, 'collection', 'record'), collectionId: 'collection', properties: { status: '準備', owner: '未設定', date: '' } });
  const result = await buildWorkspaceExport(source, { now });
  const files = unzip(result.bytes), manifest = manifestOf(files);
  const csvFile = manifest.pages.find(item => item.kind === 'collection').sourceFiles[1];
  const rows = parseCsv(files.get(csvFile));
  assert.equal(rows.length, values.length + 1);
  for (let index = 0; index < 10; index++) assert.ok(rows[index + 1][0].startsWith("'"));
  assert.equal(rows[10][0], "'\\u0000=1");
  assert.equal(rows[11][0], values[10]);
  assert.equal(manifest.transformations.csv.filter(item => item.action === 'prefix-apostrophe').length, 10);
  assert.ok(manifest.transformations.csv.some(item => item.action === 'escape-control-character'));
  const native = JSON.parse(decoder.decode((await buildWorkspaceExport(source, { format: 'native-json', now })).bytes));
  assert.deepEqual(native.pages.filter(item => item.kind === 'record').map(item => item.title), values);
});

test('portable flat filenames resist traversal, reserved names, collisions and excessive UTF-8 paths', async () => {
  const titles = ['CON', 'CON', 'NUL', '..', 'C:\\..\\name', '/absolute', 'LPT1.', '\u202eexe', '日本語'.repeat(100)];
  const source = fixture(); source.pages = titles.map((title, index) => page('id:' + index, title));
  const files = unzip((await buildWorkspaceExport(source, { now })).bytes);
  const names = [...files.keys()];
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
  for (const name of names) {
    assert.ok(Buffer.byteLength(name, 'utf8') <= 180);
    assert.ok(!/[\\/\u0000-\u001f]/.test(name));
    assert.ok(!name.endsWith('.') && !name.endsWith(' '));
    if (name.endsWith('.md') && name !== 'index.md') assert.match(name, /^\d{4}-/);
  }
});

test('empty workspaces export valid JSON and a readable ZIP with zero counts', async () => {
  const source = fixture(); source.pages = []; source.ui.lastRoute = '#trash';
  const result = await buildWorkspaceExport(source, { now });
  const files = unzip(result.bytes);
  assert.deepEqual([...files.keys()], ['index.md', 'manifest.json']);
  assert.deepEqual(result.summary, { pages: 0, collections: 0, records: 0, excludedTrash: 0 });
  const native = JSON.parse(decoder.decode((await buildWorkspaceExport(source, { format: 'native-json', now })).bytes));
  assert.equal(native.ui.lastRoute, '#home');
  assert.deepEqual(native.ui.recentPageIds, []);
});

test('large valid exports remain bounded and invalid snapshots/options are rejected before output', async () => {
  const source = fixture(); source.pages = [page('large', 'Large')];
  source.pages[0].blocks = Array.from({ length: 6 }, (_, index) => ({ id: 'large-' + index, type: 'paragraph', text: '<'.repeat(100000), checked: false }));
  const result = await buildWorkspaceExport(source, { now });
  assert.ok(result.bytes.length > 2_000_000 && result.bytes.length < MAX_EXPORT_BYTES);
  unzip(result.bytes);
  const tooLarge = structuredClone(source);
  tooLarge.pages[0].blocks.push(...Array.from({ length: 3 }, (_, index) => ({ id: 'extra-' + index, type: 'paragraph', text: 'x'.repeat(100000), checked: false })));
  await assert.rejects(buildWorkspaceExport(tooLarge, { now }), { code: 'PAYLOAD_TOO_LARGE' });
  const credential = fixture(); credential.accessKey = 'not-a-real-secret';
  await assert.rejects(buildWorkspaceExport(credential, { now }), { code: 'INVALID_SNAPSHOT' });
  const cycle = fixture(); cycle.pages[0].parentId = 'root';
  await assert.rejects(buildWorkspaceExport(cycle, { now }), { code: 'INVALID_SNAPSHOT' });
  for (const options of [null, { format: 'html' }, { includeTrash: 'false' }, { now: '2026-02-30T00:00:00.000Z' }, { now, secret: 'ignored' }]) await assert.rejects(buildWorkspaceExport(fixture(), options), { code: 'INVALID_EXPORT_OPTIONS' });
});

test('flat Markdown types export list continuation, quotes, heading three and code fences without letting payload close the code block',async()=>{
 const source=fixture();source.pages=[page('markdown','Markdown')];source.ui={recentPageIds:[],lastRoute:'#page/markdown'};
 const code='const ticks = "```";\n<script>literal</script>\n```outside';
 source.pages[0].blocks=[
  {id:'h3',type:'heading3',text:'Detail',checked:false},
  {id:'bullet',type:'bulleted-list',text:'A\nB',checked:false},
  {id:'ordered',type:'numbered-list',text:'C\nD',checked:false,start:37},
  {id:'quote',type:'quote',text:'<literal>\nnext',checked:false},
  {id:'divider',type:'divider',text:'',checked:false},
  {id:'code',type:'code',text:code,checked:false,language:'javascript'},
  {id:'after',type:'paragraph',text:'<after> **literal**',checked:false}
 ];
 const files=unzip((await buildWorkspaceExport(source,{now})).bytes),body=files.get('0001-Markdown.md');
 assert.ok(body.includes('#### Detail\n'));assert.ok(body.includes('- A\n  B\n'));assert.ok(body.includes('37. C\n    D\n'));
 assert.ok(body.includes('> &lt;literal&gt;\n> next\n'));assert.ok(body.includes('\n---\n'));
 assert.ok(body.includes('````javascript\n'+code+'\n````\n'));
 assert.ok(body.includes('&lt;after&gt; \\*\\*literal\\*\\*'));
 const native=JSON.parse(decoder.decode((await buildWorkspaceExport(source,{format:'native-json',now})).bytes));
 assert.deepEqual(native.pages[0].blocks,source.pages[0].blocks);
});
