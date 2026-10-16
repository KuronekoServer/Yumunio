import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { previewNotionImport, extractNotionAttachments, inflateRawWeb, ImportPreviewError, IMPORT_LIMITS } from '../src/index.js';

const encoder = new TextEncoder();
const run = promisify(execFile);
function checksum(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
// Independent fixture writer: ordinary STORE/DEFLATE and optional data descriptors.
// All content is synthetic. Tests never read private exports.
function zip(files, descriptor = false) {
  const chunks = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = typeof file.text === 'string' ? encoder.encode(file.text) : file.bytes ?? new Uint8Array();
    const method = file.method ?? 8, packed = method === 8 ? deflateRawSync(content) : content;
    const flags = 0x0800 | (descriptor ? 8 : 0), crc = checksum(content);
    const local = new Uint8Array(30 + name.length + packed.length), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, flags, true); view.setUint16(8, method, true);
    if (!descriptor) { view.setUint32(14, crc, true); view.setUint32(18, packed.length, true); view.setUint32(22, content.length, true); }
    view.setUint16(26, name.length, true); local.set(name, 30); local.set(packed, 30 + name.length);
    const header = new Uint8Array(46 + name.length), centralView = new DataView(header.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 0x0314, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true); centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true); centralView.setUint32(20, packed.length, true); centralView.setUint32(24, content.length, true);
    centralView.setUint16(28, name.length, true); centralView.setUint32(42, offset, true);
    if (file.symlink) centralView.setUint32(38, 0xa1ff0000, true);
    header.set(name, 46); chunks.push(local); central.push(header); offset += local.length;
    if (descriptor) {
      const data = new Uint8Array(16), descriptorView = new DataView(data.buffer);
      descriptorView.setUint32(0, 0x08074b50, true); descriptorView.setUint32(4, crc, true);
      descriptorView.setUint32(8, packed.length, true); descriptorView.setUint32(12, content.length, true);
      chunks.push(data); offset += data.length;
    }
  }
  const centralOffset = offset;
  chunks.push(...central); offset += central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true);
  endView.setUint32(12, offset - centralOffset, true); endView.setUint32(16, centralOffset, true); chunks.push(end);
  const bytes = new Uint8Array(offset + 22);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  return bytes;
}
const inflateRaw = (bytes, { maxOutputBytes }) => inflateRawSync(bytes, { maxOutputLength: Math.max(1, maxOutputBytes) });
const preview = (bytes, options = {}) => previewNotionImport(bytes, { inflateRaw, ...options });
const rejects = (promise, code) => assert.rejects(promise, cause => cause instanceof ImportPreviewError && (!code || cause.code === code));
function edit(bytes, change) {
  const result = bytes.slice(), view = new DataView(result.buffer);
  change(view, view.getUint32(result.length - 6, true), result);
  return result;
}
const sample = () => zip([
  { name: 'Export/Page 11111111111111111111111111111111.md', text: '# Fixture page\n\n[Collection](Collection%2022222222222222222222222222222222.csv)\n' },
  { name: 'Export/Collection 22222222222222222222222222222222.csv', text: '\ufeffName,Status,Note\r\nFixture record,Review,\r\n' },
  { name: 'Export/Other folder 33333333333333333333333333333333/Fixture record 44444444444444444444444444444444.md', text: '# Fixture record\n\nStatus: Review\n' },
]);

test('Markdown/CSV preview preserves text, BOM CSV cells and relative links without applying data', async () => {
  const plan = await preview(sample());
  assert.equal(plan.source, 'notion-markdown-csv');
  assert.deepEqual({ pages: plan.summary.pages, collections: plan.summary.collections, records: plan.summary.records, attachments: plan.summary.attachments },
    { pages: 2, collections: 1, records: 1, attachments: 0 });
  assert.equal(plan.collections[0].columns[0].name, 'Name');
  assert.equal(plan.collections[0].columns[0].type, 'text');
  assert.deepEqual(plan.collections[0].rows[0].cells, ['Fixture record', 'Review', '']);
  assert.equal(plan.links[0].kind, 'collection');
  assert.equal(plan.links[0].targetId, plan.collections[0].id);
  assert.equal(plan.matches.length, 1);
  assert.equal(plan.matches[0].confirmed, false);
  assert.equal(plan.matches[0].method, 'exact-title-in-cell');
  assert.equal(plan.pages[1].parentCandidateId, null);
  assert.equal(plan.pages[1].propertyCandidates[0].confirmed, false);
  assert.ok(plan.warnings.some(row => row.code === 'NOT_FULL_BACKUP'));
  assert.ok(plan.warnings.every(row => !/Fixture record|Export\//.test(row.message)));
  assert.equal('snapshot' in plan, false);
});

test('STORE archives, UTF-8 paths, directories and signed data descriptors are supported', async () => {
  const stored = await previewNotionImport(zip([{ name: '資料/', method: 0 }, { name: '資料/ページ.md', text: '# 仮のページ', method: 0 }]));
  assert.equal(stored.summary.pages, 1);
  assert.equal(stored.pages[0].title, '仮のページ');
  assert.equal((await preview(zip([{ name: 'page.md', text: '# Page' }], true))).summary.pages, 1);
});

test('browser bounded deflate adapter handles actual raw deflate and rejects excess output', async () => {
  const bytes = deflateRawSync(encoder.encode('Fixture text'));
  assert.equal(new TextDecoder().decode(await inflateRawWeb(bytes, { maxOutputBytes: 100 })), 'Fixture text');
  await rejects(inflateRawWeb(bytes, { maxOutputBytes: 2 }), 'DECOMPRESSION_LIMIT');
  assert.equal((await previewNotionImport(sample(), { inflateRaw: inflateRawWeb })).summary.records, 1);
});

test('CRC, local/central method, name and size mismatches fail before data becomes a preview', async () => {
  const bytes = zip([{ name: 'page.md', text: '# Page', method: 0 }]);
  await rejects(preview(edit(bytes, (view, central, raw) => { raw[30 + 'page.md'.length] ^= 1; })), 'ZIP_CRC_MISMATCH');
  await rejects(preview(edit(bytes, view => view.setUint16(8, 8, true))), 'ZIP_HEADER_MISMATCH');
  await rejects(preview(edit(bytes, (view, central, raw) => { raw[30] ^= 1; })), 'ZIP_HEADER_MISMATCH');
  await rejects(preview(edit(bytes, view => view.setUint32(22, 1, true))), 'ZIP_HEADER_MISMATCH');
  await rejects(preview(zip([{ name: 'page.md', text: '# Page' }]), { inflateRaw: () => new Uint8Array(1) }), 'ZIP_SIZE_MISMATCH');
});

test('unsafe archive paths, symlinks, encryption and normalized collisions are rejected', async () => {
  for (const name of ['../page.md', '/page.md', 'C:/page.md', 'folder\\page.md', 'folder/../page.md', 'folder//page.md', 'file:stream.md', 'CON.md', 'folder./page.md']) {
    await rejects(preview(zip([{ name, text: '# Page' }])), 'UNSAFE_ZIP_PATH');
  }
  await rejects(preview(zip([{ name: 'link.md', text: '# Link', symlink: true }])), 'UNSAFE_ZIP_SYMLINK');
  await rejects(preview(edit(sample(), (view, central) => view.setUint16(central + 8, 0x0801, true))), 'ENCRYPTED_ZIP');
  for (const names of [['Page.md', 'page.md'], ['é.md', 'e\u0301.md'], ['Folder/a.md', 'folder/b.md']]) {
    await rejects(preview(zip(names.map(name => ({ name, text: '# Page' })))), 'DUPLICATE_ZIP_PATH');
  }
  await rejects(preview(zip([{ name: 'file.md', text: '# File' }, { name: 'file.md/page.md', text: '# Page' }])), 'UNSAFE_ZIP_PATH');
});

test('ZIP bounds reject overlapping/unlisted local records, split disks, ZIP64 and truncation', async () => {
  const bytes = zip([{ name: 'a.md', text: '# A' }, { name: 'b.md', text: '# B' }]);
  await rejects(preview(bytes.slice(0, -1)), 'INVALID_ZIP');
  await rejects(preview(edit(bytes, (view, central) => view.setUint16(bytes.length - 18, 1, true))), 'UNSUPPORTED_SPLIT_ZIP');
  await rejects(preview(edit(bytes, view => view.setUint16(bytes.length - 12, 65535, true))), 'UNSUPPORTED_ZIP64');
  await rejects(preview(edit(bytes, (view, central) => {
    const second = central + 46 + view.getUint16(central + 28, true);
    view.setUint32(second + 42, 0, true);
  })));
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
  await rejects(preview(trailing), 'INVALID_ZIP');
});

test('archive and inflated byte limits reject bombs before invoking an inflater', async () => {
  let called = false;
  const bomb = zip([{ name: 'large.md', text: 'x'.repeat(100000) }]);
  await rejects(preview(bomb, { inflateRaw: () => { called = true; return new Uint8Array(); } }), 'DECOMPRESSION_LIMIT');
  assert.equal(called, false);
  await rejects(preview(sample(), { limits: { archiveBytes: 10 } }), 'ARCHIVE_TOO_LARGE');
  await rejects(preview(sample(), { limits: { entries: 2 } }), 'TOO_MANY_ENTRIES');
  await rejects(preview(sample(), { limits: { totalBytes: 10 } }), 'DECOMPRESSION_LIMIT');
  await rejects(preview(sample(), { limits: { entryBytes: 10 } }), 'DECOMPRESSION_LIMIT');
  await rejects(preview(sample(), { limits: { archiveBytes: IMPORT_LIMITS.archiveBytes + 1 } }), 'INVALID_OPTIONS');
  const forged = edit(zip([{ name: 'small.md', text: 'x'.repeat(1000) }]), (view, central) => {
    view.setUint32(22, 1, true); view.setUint32(central + 24, 1, true);
  });
  await rejects(preview(forged), 'INVALID_DEFLATE');
});

test('invalid UTF-8, malformed CSV, inconsistent widths and CSV bounds fail closed', async () => {
  await rejects(preview(zip([{ name: 'page.md', bytes: new Uint8Array([0xff]) }])), 'INVALID_UTF8');
  for (const text of ['A,B\n"open,B', 'A,B\nx"y,z', 'A,B\n"x" tail,z']) await rejects(preview(zip([{ name: 'db.csv', text }])), 'INVALID_CSV');
  await rejects(preview(zip([{ name: 'db.csv', text: 'A,B\none' }])), 'CSV_ROW_WIDTH');
  await rejects(preview(zip([{ name: 'db.csv', text: 'A,B\none,two' }]), { limits: { csvColumns: 1 } }), 'CSV_LIMIT');
  await rejects(preview(zip([{ name: 'db.csv', text: 'A\none\ntwo' }]), { limits: { csvRows: 1 } }), 'CSV_LIMIT');
  await rejects(preview(zip([{ name: 'db.csv', text: 'A\nlong' }]), { limits: { cellChars: 3 } }), 'CSV_LIMIT');
});

test('CSV quotes, multiline cells and formula-like values are retained as strings with warnings', async () => {
  const plan = await preview(zip([{ name: 'db.csv', text: 'Name,Note\r\n"Example, row","line one\r\nline ""two"""\r\n=SUM(A1:A2), +unsafe\r\n' }]));
  assert.deepEqual(plan.collections[0].rows[0].cells, ['Example, row', 'line one\r\nline "two"']);
  assert.deepEqual(plan.collections[0].rows[1].cells, ['=SUM(A1:A2)', ' +unsafe']);
  assert.equal(plan.warnings.find(row => row.code === 'CSV_FORMULA_AS_TEXT').count, 2);
  assert.equal((await preview(zip([{ name: 'db.csv', text: 'Name,Name\none,two' }]))).warnings.some(row => row.code === 'CSV_DUPLICATE_HEADERS'), true);
});

test('HTML remains literal text; dangerous URLs and archive escapes are blocked with no network calls', async () => {
  const plan = await preview(zip([{ name: 'page.md', text: '# <img src=x onerror=alert(1)>\n\n<script>private()</script>\n[x](javascript:alert(1))\n[x](data:text/html,bad)\n[x](%2E%2E/out.md)\n[x](https://example.invalid/path)\n[x](missing.md)\n' }]));
  assert.equal(plan.pages[0].title, '<img src=x onerror=alert(1)>');
  assert.ok(plan.pages[0].sourceMarkdown.includes('<script>'));
  assert.equal(plan.links.filter(link => link.kind === 'blocked').length, 3);
  assert.equal(plan.links.filter(link => link.kind === 'external').length, 1);
  assert.equal(plan.summary.unresolvedLinks, 1);
  assert.ok(plan.warnings.some(row => row.code === 'HTML_AS_TEXT'));
});

test('relative sibling/parent links and attachment targets resolve, while HTML/nested ZIP are only reported', async () => {
  const plan = await preview(zip([
    { name: 'Root.md', text: '# Root' },
    { name: 'Root/Child.md', text: '# Child\n[Parent](../Root.md)\n![Picture](image.png)\n[Encoded](Other%20page.md)' },
    { name: 'Root/image.png', bytes: new Uint8Array([1, 2, 3]) },
    { name: 'Root/Other page.md', text: '# Other' },
    { name: 'unsupported.html', text: '<script>do not run</script>' },
    { name: 'nested.zip', bytes: new Uint8Array([80, 75]) },
  ]));
  assert.equal(plan.summary.attachments, 1);
  assert.equal(plan.summary.unsupported, 2);
  assert.equal(plan.pages[1].parentCandidateId, plan.pages[0].id);
  assert.deepEqual(plan.links.map(link => link.kind), ['page', 'attachment', 'page']);
  assert.equal('bytes' in plan.pages[0], false);
  assert.equal(plan.unsupported.length, 2);
});

test('duplicate titles remain ambiguous candidates and are never silently merged or converted to an existing snapshot', async () => {
  const plan = await preview(zip([
    { name: 'A.md', text: '# Same title' }, { name: 'B.md', text: '# Same title' },
    { name: 'db.csv', text: 'Name\nSame title\nSame title' },
  ]));
  assert.equal(plan.summary.pages, 2);
  assert.equal(plan.summary.records, 2);
  assert.equal(plan.matches.length, 4);
  assert.ok(plan.matches.every(match => match.confirmed === false && match.ambiguous));
  assert.equal(plan.warnings.find(row => row.code === 'AMBIGUOUS_ROW_MATCH').count, 4);
});

test('aggregate row/block/link/matching output limits bound preview expansion', async () => {
  await rejects(preview(zip([{ name: 'a.csv', text: 'Name\nOne' }, { name: 'b.csv', text: 'Name\nTwo' }]), { limits: { csvRows: 1 } }), 'CSV_LIMIT');
  await rejects(preview(zip([{ name: 'a.md', text: '# A\none\ntwo' }]), { limits: { blocks: 2 } }), 'MODEL_LIMIT');
  await rejects(preview(zip([{ name: 'a.md', text: '# A\n[x](missing)\n[y](missing)' }]), { limits: { links: 1 } }), 'MODEL_LIMIT');
  await rejects(preview(zip([{ name: 'a.md', text: '# Same' }, { name: 'db.csv', text: 'Name\nSame\nSame' }]), { limits: { matches: 1 } }), 'MODEL_LIMIT');
});

test('input capture is immutable across asynchronous inflation and missing adapters do not silently skip entries', async () => {
  const bytes = sample();
  let first = true;
  const plan = await preview(bytes, { inflateRaw: async (packed, options) => {
    if (first) { first = false; bytes.fill(0); await Promise.resolve(); }
    return inflateRaw(packed, options);
  } });
  assert.equal(plan.summary.pages, 2);
  await rejects(previewNotionImport(sample()), 'DEFLATE_UNAVAILABLE');
});

test('CLI defaults to counts only, requires explicit input and writes private JSON only with explicit non-overwriting output', async t => {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'yumunio-import-preview-'));
  t.after(() => {
    const target = resolve(directory);
    assert.equal(dirname(target), tempRoot);
    assert.match(basename(target), /^yumunio-import-preview-[A-Za-z0-9]+$/);
    return rm(target, { recursive: true, force: true });
  });
  const file = join(directory, 'private-fixture.zip'), output = join(directory, 'private-preview.json');
  await writeFile(file, sample());
  const script = resolve('packages/importer/cli/preview-notion.mjs');
  const ordinary = await run(process.execPath, [script, '--file', file]);
  const publicResult = JSON.parse(ordinary.stdout);
  assert.equal(publicResult.summary.pages, 2);
  assert.doesNotMatch(ordinary.stdout + ordinary.stderr, /Fixture record|Collection 2222|Export\/|private-fixture/);
  assert.deepEqual(await readdir(directory), ['private-fixture.zip']);
  const explicit = await run(process.execPath, [script, '--file', file, '--output', output]);
  assert.match(explicit.stderr, /JSON/);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).pages[1].title, 'Fixture record');
  await assert.rejects(run(process.execPath, [script, '--file', file, '--output', output]), cause =>
    cause.code === 1 && cause.stderr.includes('OUTPUT_EXISTS') && !cause.stderr.includes(output));
  await assert.rejects(run(process.execPath, [script]), cause => cause.code === 1 && cause.stderr.includes('INVALID_ARGUMENTS'));
});

test('long unclosed inline markup is retained without speculative link expansion', async () => {
  const text = '# Fixture\n' + '[x'.repeat(40000) + '\n' + '<a'.repeat(40000);
  const plan = await preview(zip([{ name: 'page.md', text, method: 0 }]));
  assert.equal(plan.summary.links, 0);
  assert.equal(plan.pages[0].blocks.length, 3);
  assert.equal(plan.pages[0].sourceMarkdown, text);
});

test('archive-root pages never infer a parent from a filename prefix', async () => {
  const plan = await preview(zip([
    { name: 'root.md', text: '# Root page' },
    { name: 'root.m.md', text: '# Unrelated root page' },
  ]));
  assert.deepEqual(plan.pages.map(page => page.parentCandidateId), [null, null]);
});

test('actual ZIP parsing emits exact spans used by native collection and internal-link conversion', async () => {
  const { prepareNotionImportBundle } = await import('../src/apply-plan.js');
  const source='# Page\n\nRead [Other](Other.md#part%20one) and [Database](Database.csv).\n';
  const plan=await preview(zip([
    {name:'Page.md',text:source},{name:'Other.md',text:'# Other'},
    {name:'Database.csv',text:'Name,Note\nFixture row,\n'},
  ]));
  for(const link of plan.links) {
    const block=plan.pages[0].blocks.find(block=>block.id===link.blockId);
    assert.equal(block.text.slice(link.labelStart,link.labelEnd),link.label);
    assert.equal(block.text.slice(link.hrefStart,link.hrefEnd),link.rawHref);
    assert.match(block.text.slice(link.start,link.end),/^\[[^\]]+\]\(/);
  }
  const result=prepareNotionImportBundle(plan,{expectedRevision:0,importId:'zip-native-fixture'});
  assert.equal(result.summary.nativeCollections,1);
  assert.equal(result.summary.convertedLinks,2);
  assert.equal(result.summary.unconvertedLinks,0);
  const primary=result.body.pages[1].blocks.find(block=>block.data.links);
  assert.equal(primary.data.text,'Read Other and Database.');
  assert.deepEqual(result.requiredAcknowledgements,['csvTextTypes']);
  assert.equal(result.body.pages[1].blocks.at(-1).data.text,source);
});


test('attachment extraction returns separate binary copies with exactly the preview file IDs',async()=>{
  const binary=new Uint8Array([0,255,1,254]),bytes=zip([
    {name:'Folder/',method:0},{name:'Folder/Page.md',text:'# Page'},
    {name:'Folder/Table.csv',text:'Name\nRow'},{name:'Folder/image.bin',bytes:binary},
    {name:'Folder/empty.dat',bytes:new Uint8Array(),method:0},
    {name:'Folder/unsupported.html',text:'<h1>Literal</h1>'},{name:'Folder/nested.zip',text:'Not unpacked'},
  ],true);
  const plan=await preview(bytes),result=await extractNotionAttachments(bytes,{inflateRaw});
  assert.deepEqual([...result.keys()],plan.entries.filter(entry=>entry.kind==='attachment').map(entry=>entry.id));
  assert.deepEqual([...result.get('entry-3')],[...binary]);
  assert.equal(result.get('entry-4').length,0);
  assert.equal(JSON.stringify(plan).includes('Uint8Array'),false);
  result.get('entry-3')[0]=99;
  assert.deepEqual([...((await extractNotionAttachments(bytes,{inflateRaw})).get('entry-3'))],[...binary]);
});

test('attachment extraction validates every CRC and the same archive/decompression/path limits before returning bytes',async()=>{
  const bytes=zip([{name:'Page.md',text:'# Page',method:0},{name:'file.dat',text:'Binary',method:0}]);
  const damaged=bytes.slice();damaged[30+encoder.encode('Page.md').length]^=1;
  await rejects(extractNotionAttachments(damaged),'ZIP_CRC_MISMATCH');
  await rejects(extractNotionAttachments(zip([{name:'../file.dat',text:'unsafe'}]),{inflateRaw}),'UNSAFE_ZIP_PATH');
  await rejects(extractNotionAttachments(bytes,{limits:{totalBytes:1}}),'DECOMPRESSION_LIMIT');
  await rejects(extractNotionAttachments(bytes,{limits:{archiveBytes:1}}),'ARCHIVE_TOO_LARGE');
  await rejects(extractNotionAttachments(zip([{name:'file.dat',text:'Binary'}])),'DEFLATE_UNAVAILABLE');
  await rejects(extractNotionAttachments(zip([{name:'file.dat',text:'Binary'}]),{inflateRaw:()=>new Uint8Array(100)}),'ZIP_SIZE_MISMATCH');
});

test('attachment extraction captures caller bytes across asynchronous inflation and supports the bounded Web adapter',async()=>{
  const bytes=zip([{name:'file.dat',bytes:new Uint8Array([0,1,254,255])}]);
  const original=bytes.slice();
  let callbacks=0;
  const result=await extractNotionAttachments(bytes,{inflateRaw:async(packed,options)=>{
    callbacks++;bytes.fill(0);await Promise.resolve();return inflateRaw(packed,options);
  }});
  assert.equal(callbacks,1);
  assert.deepEqual([...result.get('entry-1')],[0,1,254,255]);
  assert.deepEqual([...((await extractNotionAttachments(original,{inflateRaw:inflateRawWeb})).get('entry-1'))],[0,1,254,255]);
});


test('links inside inline code, escaped markup or HTML blocks remain literal while other exact links still convert',async()=>{
  const source='Before \u0060[Code](Other.md)\u0060 then [Real](Other.md) and \\[Escaped](Other.md)';
  const html='<div>[HTML](Other.md)</div>',comment='<!-- [Comment](Other.md) -->';
  const plan=await preview(zip([
    {name:'Page.md',text:'# Page\n'+source+'\n'+html+'\n'+comment+'\n'},
    {name:'Other.md',text:'# Other'},
  ]));
  assert.equal(plan.links.length,1);
  assert.equal(plan.links[0].label,'Real');
  const {prepareNotionImportBundle}=await import('../src/apply-plan.js');
  const result=prepareNotionImportBundle(plan,{expectedRevision:0,importId:'literal-links'});
  const blocks=result.body.pages[1].blocks;
  assert.equal(blocks[1].data.text,'Before [Code](Other.md) then Real and [Escaped](Other.md)');
  assert.deepEqual(blocks[1].data.marks,[{start:7,end:23,styles:['code']}]);
  assert.equal(blocks[2].data.text,html);
  assert.equal(blocks[3].data.text,comment);
  assert.equal(result.summary.convertedLinks,1);
});
