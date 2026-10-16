import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let checked = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
      checked++;
    }
  }
}
for (const directory of ['apps', 'packages']) {
  try { await check(resolve(directory)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(`Syntax checked: ${checked} JavaScript files`);
