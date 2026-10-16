import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateCatalogParity,validateLocaleManifest,validateTranslationCatalog} from '../public/i18n.js';
const manifest=validateLocaleManifest(JSON.parse(await readFile(new URL('../public/locale-manifest.json',import.meta.url),'utf8')));
for(const[namespace,directory]of Object.entries(manifest.namespaces))test(namespace+' runtime community catalogs preserve source keys and named placeholders',async()=>{
 const source=validateTranslationCatalog(JSON.parse(await readFile(new URL('../public/'+directory+'/ja.json',import.meta.url),'utf8')));
 for(const locale of manifest.locales){let data;try{data=await readFile(new URL('../public/'+directory+'/'+locale.code+'.json',import.meta.url),'utf8');}catch(error){if(error.code==='ENOENT'&&locale.stage==='partial')continue;throw error;}const translated=validateTranslationCatalog(JSON.parse(data)),parity=validateCatalogParity(source,translated);assert.deepEqual(parity.extra,[],locale.code);assert.deepEqual(parity.placeholderMismatches,[],locale.code);if(locale.stage==='complete')assert.deepEqual(parity.missing,[],locale.code);}
});
