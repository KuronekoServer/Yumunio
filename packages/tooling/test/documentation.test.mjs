import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkDocumentation,documentationAnchors} from '../documentation.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(t){
 const parent=join(root,'.build/test-fixtures');await mkdir(parent,{recursive:true});const folder=await mkdtemp(join(parent,'yumunio-documentation-'));
 t.after(async()=>{assert.equal(dirname(resolve(folder)),resolve(parent));await rm(folder,{recursive:true,force:true});});await mkdir(join(folder,'docs'));return folder;
}

test('documentation links support Japanese headings, duplicate sections, escaped filenames and normal GitHub navigation',async t=>{
 const folder=await fixture(t);
 await writeFile(join(folder,'README.md'),'# Guide\n\n[導入](docs/setup.md#初期設定)\n[English](docs/setup.md#setup-1)\n[File](<docs/my file.json>)\n[External](https://example.invalid/not-fetched)\n');
 await writeFile(join(folder,'docs/setup.md'),'# 初期設定\n\n[Home](../README.md#guide)\n[Same page](#setup-1)\n## Setup\n## Setup\n');await writeFile(join(folder,'docs/my file.json'),'{}');
 assert.deepEqual(await checkDocumentation(folder),{files:2,localLinks:5,externalLinksChecked:false});
});

test('broken files and missing headings report actionable source lines',async t=>{
 const folder=await fixture(t);await writeFile(join(folder,'README.md'),'# Guide\n\n[Missing](docs/missing.md)\n[Wrong heading](#absent)\n');
 await assert.rejects(checkDocumentation(folder),error=>{assert.match(error.message,/README\.md:3.*missing file/);assert.match(error.message,/README\.md:4.*missing heading #absent/);return true;});
});

test('documentation examples inside nested code fences are ignored without hiding later prose',async t=>{
 const folder=await fixture(t);await writeFile(join(folder,'README.md'),'# Guide\n\n````markdown\n```sh\n[Example](not-a-real-file.md)\n```\n# Not a heading\n````\n\n[Home](#guide)\n');
 assert.deepEqual([...documentationAnchors('# Guide\n````md\n```\n# Hidden\n```\n````\n## Visible')],['guide','visible']);
 assert.equal((await checkDocumentation(folder)).localLinks,1);
 await writeFile(join(folder,'README.md'),'# Guide\n\n[Still checked](missing.md)\n');await assert.rejects(checkDocumentation(folder),/missing file/);
});

test('local documentation targets cannot escape the repository',async t=>{
 const folder=await fixture(t);await writeFile(join(folder,'README.md'),'# Guide\n[Outside](../)\n');await assert.rejects(checkDocumentation(folder),/target leaves the repository/);
});
