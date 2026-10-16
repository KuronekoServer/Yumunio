import { cp, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { createHash } from 'node:crypto';
import { createPwaIcon } from './pwa-icons.mjs';
import { offlineAssetPaths } from '../../apps/web/public/offline-policy.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const allowedExtensions = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.ico', '.txt']);

async function rejectLink(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Build paths must not be symbolic links.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Build one static artifact for Node and Workers, with canonical shared modules. */
export async function buildWeb(root = projectRoot) {
  root = await realpath(root);
  const build = resolve(root, '.build');
  const output = resolve(build, 'web');
  if (relative(root, output) !== join('.build', 'web')) throw new Error('Unexpected web build destination.');
  await rejectLink(build);
  await rejectLink(output);
  const publicRoot = resolve(root, 'apps/web/public');
  const prototypeRoot = resolve(root, 'packages/prototype/src');
  const importerRoot = resolve(root, 'packages/importer/src');
  const collaborationRoot = resolve(root, 'packages/collaboration/src');
  const domainRoot = resolve(root, 'packages/domain/src');
  await rejectLink(publicRoot);
  await rejectLink(prototypeRoot);
  await rejectLink(importerRoot);
  await rejectLink(collaborationRoot);
  await rejectLink(domainRoot);
  const files = [];
  async function collect(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Static sources must not contain symbolic links.');
      if (entry.name.startsWith('.') || name === 'shared' || name.startsWith('shared/')) throw new Error('Unexpected static source path.');
      if (entry.isDirectory()) await collect(join(path, entry.name), name);
      else if (entry.isFile() && (allowedExtensions.has(extname(entry.name)) || name === '_headers')) files.push(name);
      else throw new Error('Unexpected static source file.');
    }
  }
  await collect(publicRoot);
  const shared = new Map();
  for (const name of ['snapshot.js', 'export.js']) {
    const path = join(prototypeRoot, name);
    await rejectLink(path);
    shared.set(name, await readFile(path));
  }
  const importSource=join(domainRoot,'import-source.js');
  await rejectLink(importSource);
  shared.set('import-source.js',await readFile(importSource));
  const inlineSource=join(domainRoot,'inline.js');
  await rejectLink(inlineSource);
  shared.set('inline-text.js',await readFile(inlineSource));
  const pageLinksSource=join(domainRoot,'page-links.js');
  await rejectLink(pageLinksSource);
  shared.set('page-links.js',await readFile(pageLinksSource));
  const mentionsSource=join(domainRoot,'mentions.js');
  await rejectLink(mentionsSource);
  shared.set('mentions.js',await readFile(mentionsSource));
  const blockForestSource=join(domainRoot,'block-forest.js');
  await rejectLink(blockForestSource);
  shared.set('block-forest.js',await readFile(blockForestSource));
  const simpleTableSource=join(domainRoot,'simple-table.js');
  await rejectLink(simpleTableSource);
  shared.set('simple-table.js',await readFile(simpleTableSource));
  const localeSource=join(root,'packages/identity/src/locale-code.js');
  await rejectLink(localeSource);
  shared.set('locale-code.js',await readFile(localeSource));
  const chartsSource=join(domainRoot,'charts.js');
  await rejectLink(chartsSource);
  shared.set('chart-model.js',await readFile(chartsSource));
  const boardOrderSource=join(domainRoot,'board-order.js');
  await rejectLink(boardOrderSource);
  shared.set('board-order.js',await readFile(boardOrderSource));
  const propertyConversionSource=join(domainRoot,'property-conversion.js');
  await rejectLink(propertyConversionSource);
  shared.set('property-conversion.js',await readFile(propertyConversionSource));
  for (const name of ['index.js', 'apply-plan.js', 'appflowy-native.js', 'markdown.js']) {
    const importerSource = join(importerRoot, name);
    await rejectLink(importerSource);
    shared.set('importer/' + name, await readFile(importerSource));
  }
  const collaborationEntry = join(collaborationRoot, 'client.js');
  await rejectLink(collaborationEntry);
  const dndEntry = join(root, 'apps/web/dnd-kit-entry.js');
  await rejectLink(dndEntry);
  const bundledDependencies = new Set();
  for (const [name, entry] of [['collaboration-client.js', collaborationEntry], ['dnd-kit.js', dndEntry]]) {
    const bundled = await bundle({ entryPoints: [entry], bundle: true, write: false, absWorkingDir: root, tsconfigRaw: {},
      format: 'esm', platform: 'browser', target: ['es2022'], legalComments: 'inline',
      minify: true, logLevel: 'silent', metafile: true });
    // These entries must remain portable: Node built-ins, external imports and runtime chunks are forbidden.
    if (bundled.outputFiles.length !== 1 || Object.values(bundled.metafile.outputs).some(output => output.imports.length)) throw new Error('Browser bundles must be self-contained.');
    shared.set(name, bundled.outputFiles[0].contents);
    for (const input of Object.keys(bundled.metafile.inputs)) {
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'));
      if (match) bundledDependencies.add(match[1]);
    }
  }
  const licenseFiles = new Map([
    ...['yjs', 'lib0', 'isomorphic.js', '@dnd-kit/dom', '@dnd-kit/abstract', '@dnd-kit/collision', '@dnd-kit/geometry', '@dnd-kit/state', '@preact/signals-core'].map(name => [name, join(projectRoot, 'node_modules', name, 'LICENSE')]),
    ['tslib', join(projectRoot, 'node_modules/tslib/LICENSE.txt')],
  ]);
  const notices = [];
  for (const name of [...bundledDependencies].sort()) {
    if (!licenseFiles.has(name)) throw new Error('Browser dependency requires an explicit license notice.');
    notices.push(name + '\n\n' + await readFile(licenseFiles.get(name), 'utf8'));
  }
  if (notices.length) shared.set('THIRD_PARTY_LICENSES.txt', 'Third-party software included in the collaboration and drag-and-drop browser bundles\n\n' + notices.join('\n\n---\n\n'));
  const generated=new Map();
  const specification=join(root,'openapi.yaml');
  await rejectLink(dirname(specification));
  await rejectLink(specification);
  try{generated.set('openapi.yaml',await readFile(specification));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(files.includes('sw.js')){
    for(const size of [192,512])generated.set('pwa/icon-'+size+'.png',createPwaIcon(size));
    const digest=createHash('sha256');
    for(const name of [...files].sort())digest.update(name+'\0').update(['inline-text.js','page-links.js','mentions.js','block-forest.js','chart-model.js','board-order.js','property-conversion.js','simple-table.js','locale-code.js'].includes(name)?shared.get(name):await readFile(join(publicRoot,name)));
    for(const[name,bytes]of [...shared,...generated].sort(([a],[b])=>a.localeCompare(b)))digest.update(name+'\0').update(bytes);
    const paths=offlineAssetPaths([...files,...[...shared.keys()].map(name=>'shared/'+name),...generated.keys()]);
    const template=await readFile(join(publicRoot,'sw.js'),'utf8');
    if(!template.includes('__YUMUNIO_OFFLINE_BUILD__')||!template.includes('__YUMUNIO_OFFLINE_ASSETS__'))throw new Error('Invalid offline worker template.');
    generated.set('sw.js',template.replace('__YUMUNIO_OFFLINE_BUILD__',digest.digest('hex')).replace('__YUMUNIO_OFFLINE_ASSETS__',JSON.stringify(paths)));
  }
  const currentFiles=[...new Set([...files,...[...shared.keys()].map(name=>'shared/'+name),...generated.keys()])].sort(),current=new Set(currentFiles);
  const requiredDirectories=new Set();
  for(const name of currentFiles){const parts=name.split('/');for(let end=1;end<parts.length;end++)requiredDirectories.add(parts.slice(0,end).join('/'));}
  // Retain the checked destination directory: Windows asset servers may hold it open.
  // Write current assets first, then remove only stale generated files.
  await mkdir(output,{recursive:true});
  const previousFiles=[],previousDirectories=[];
  async function inspectOutput(prefix=''){
    for(const entry of await readdir(join(output,prefix),{withFileTypes:true})){
      const name=prefix?prefix+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())throw new Error('Build output must not contain symbolic links.');
      if(entry.isDirectory()){previousDirectories.push(name);await inspectOutput(name);}
      else if(entry.isFile()){
        if((await lstat(join(output,name))).nlink>1)throw new Error('Build output must not contain hard links.');
        previousFiles.push(name);
      }
      else throw new Error('Unexpected build output entry.');
    }
  }
  await inspectOutput();
  // Remove only verified stale shape conflicts before writing; retain the output root and other live assets.
  const becomingFiles=new Set(previousDirectories.filter(name=>current.has(name)));
  const insideBecomingFile=name=>[...becomingFiles].some(parent=>name.startsWith(parent+'/'));
  const removedFiles=new Set(),removedDirectories=new Set();
  for(const name of previousFiles){
    if(requiredDirectories.has(name)||insideBecomingFile(name)){
      if(current.has(name))throw new Error('Conflicting static asset paths.');
      await rm(join(output,name));removedFiles.add(name);
    }
  }
  for(const name of [...previousDirectories].sort((a,b)=>b.split('/').length-a.split('/').length)){
    if(becomingFiles.has(name)||insideBecomingFile(name)){await rmdir(join(output,name));removedDirectories.add(name);}
  }
  await mkdir(join(output,'shared'),{recursive:true});
  for (const name of files) {
    if(generated.has(name))continue;
    const target = join(output, name);
    await mkdir(dirname(target), { recursive: true });
    if(['inline-text.js','page-links.js','mentions.js','block-forest.js','chart-model.js','board-order.js','property-conversion.js','simple-table.js','locale-code.js'].includes(name))await writeFile(target,shared.get(name));
    else await cp(join(publicRoot, name), target);
  }
  for (const [name, content] of shared) {
    const target = join(output, 'shared', name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for(const[name,content]of generated){const target=join(output,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,content);}
  for(const name of previousFiles)if(!removedFiles.has(name)&&!current.has(name))await rm(join(output,name),{force:true});
  for(const name of previousDirectories.sort((a,b)=>b.split('/').length-a.split('/').length)){
    if(removedDirectories.has(name))continue;
    try{await rmdir(join(output,name));}catch(error){if(!['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code))throw error;}
  }
  return {output,files:currentFiles};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildWeb();
  console.log(`Built ${result.files.length} static files for Node and Workers.`);
}
