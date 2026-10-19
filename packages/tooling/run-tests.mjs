import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [];
async function discover(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules','integration','.next','out'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await discover(path);
    else if (/\.test\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }
}
for (const directory of ['apps', 'packages']) await discover(resolve(root, directory));
files.sort();
if (!files.length) throw new Error('No unit or integration contract tests found.');
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
