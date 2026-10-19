import { readdir,readFile } from 'node:fs/promises';
import {transform} from 'esbuild';
import {checkLocalizations} from './localization.mjs';
import {checkDocumentation} from './documentation.mjs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let checked = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if(['node_modules','.next','out'].includes(entry.name))continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if(entry.name.endsWith('.jsx')){await transform(await readFile(path,'utf8'),{loader:'jsx',jsx:'automatic',target:'es2022',sourcefile:path});checked++;}
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
console.log('Locales checked: '+JSON.stringify(await checkLocalizations()));
console.log('Documentation checked: '+JSON.stringify(await checkDocumentation()));
