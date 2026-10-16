import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { previewNotionImport, IMPORT_LIMITS, ImportPreviewError } from '../src/index.js';

const fail = code => { throw new ImportPreviewError(code); };
async function readArchive(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) fail('INPUT_UNAVAILABLE');
    if (info.size > IMPORT_LIMITS.archiveBytes) fail('ARCHIVE_TOO_LARGE');
    const bytes = new Uint8Array(info.size + 1);
    let size = 0;
    for (;;) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (size > info.size) fail('INPUT_CHANGED');
    }
    return bytes.slice(0, size);
  } catch (cause) {
    if (cause instanceof ImportPreviewError) throw cause;
    fail('INPUT_UNAVAILABLE');
  } finally { await handle?.close(); }
}

/** Explicit local-only preview; --output is opt-in and never overwrites a file. */
export async function main(args) {
  let file, output;
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node packages/importer/cli/preview-notion.mjs --file <zip> [--output <private-preview.json>]\n');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    if (!value || value.startsWith('--') || !['--file', '--output'].includes(option) ||
        (option === '--file' ? file !== undefined : output !== undefined)) fail('INVALID_ARGUMENTS');
    if (option === '--file') file = value; else output = value;
  }
  if (!file) fail('INVALID_ARGUMENTS');
  const plan = await previewNotionImport(await readArchive(file), {
    inflateRaw: (bytes, { maxOutputBytes }) => inflateRawSync(bytes, { maxOutputLength: Math.max(1, maxOutputBytes) }),
  });
  if (output !== undefined) {
    process.stderr.write('注意: 指定したJSONには私有の本文・タイトル・相対パスを含みます。共有やGit追加の前に内容を確認してください。\n');
    try { await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (cause) { fail(cause?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_UNAVAILABLE'); }
  }
  process.stdout.write(JSON.stringify({ summary: plan.summary, warningCodes: plan.warnings.map(row => row.code) }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (cause) {
    const code = cause instanceof ImportPreviewError ? cause.code : 'PREVIEW_UNAVAILABLE';
    process.stderr.write('Import preview failed (' + code + ').\n');
    process.exitCode = 1;
  }
}
