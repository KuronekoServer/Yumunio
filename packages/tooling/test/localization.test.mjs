import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {parse} from 'yaml';
import {checkLocalizations,exportCrowdinSources,localizationReportMarkdown,reportLocalizations,syncLocalizations} from '../localization.mjs';
import {createI18n,loadCatalogs} from '../../../apps/web/public/i18n.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(t){
 const parent=join(root,'.build/test-fixtures');await mkdir(parent,{recursive:true});const folder=await mkdtemp(join(parent,'yumunio-localization-'));
 t.after(async()=>{assert.equal(dirname(resolve(folder)),resolve(parent));await rm(folder,{recursive:true,force:true});});
 const manifest={schemaVersion:1,artifactKind:'runtime',messageFormat:'named-parameters-v1',sourceLocale:'ja',defaultLocale:'ja',fallbackLocale:'en',namespaces:{app:'locales',setup:'setup-locales'},locales:[{code:'ja',endonym:'日本語',dir:'ltr',fallbacks:['en'],stage:'complete'},{code:'en',endonym:'English',dir:'ltr',fallbacks:[],stage:'complete'}]};
 const put=async(path,value)=>{const target=join(folder,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value,null,2)+'\n');};
 await put('apps/web/public/locale-manifest.json',manifest);
 for(const path of Object.values(manifest.namespaces)){await put('apps/web/public/'+path+'/ja.json',{greeting:'こんにちは {name}',save:'保存'});await put('apps/web/public/'+path+'/en.json',{greeting:'Hello {name}',save:'Save'});}
 return{folder,manifest,put};
}
test('Crowdin manages only the canonical Japanese UI catalogs and keeps Chinese scripts and Portuguese variants distinct',async()=>{
 const config=parse(await readFile(join(root,'crowdin.yml'),'utf8')),manifest=JSON.parse(await readFile(join(root,'apps/web/public/locale-manifest.json'),'utf8'));
 assert.equal(String(config.project_id),'939643');assert.equal(config.api_token,undefined);assert.equal(config.api_token_env,'CROWDIN_PERSONAL_TOKEN');
 assert.equal(config.files.length,Object.keys(manifest.namespaces).length);
 for(const[namespace,path]of Object.entries(manifest.namespaces)){
  const rule=config.files.find(item=>item.source==='/apps/web/public/'+path+'/ja.json');assert.ok(rule,namespace);assert.equal(rule.translation,'/.crowdin/%two_letters_code%/'+namespace+'.json');
  assert.equal(rule.languages_mapping.two_letters_code['zh-CN'],'zh-Hans');assert.equal(rule.languages_mapping.two_letters_code['zh-TW'],'zh-Hant');assert.equal(rule.languages_mapping.two_letters_code['pt-BR'],'pt-BR');assert.equal(rule.languages_mapping.two_letters_code['pt-PT'],'pt-PT');
 }
 assert.equal(new Set(config.files.map(item=>item.translation)).size,config.files.length);
});
test('Crowdin stays disconnected unless an operator explicitly opts into a manual synchronization',async()=>{
 const workflow=parse(await readFile(join(root,'.github/workflows/translations.yaml'),'utf8'));
 assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
 assert.equal(workflow.on.workflow_dispatch.inputs.enable_sync.default,false);
 assert.match(workflow.jobs.sync.if,/github\.event_name == 'workflow_dispatch'/);
 assert.match(workflow.jobs.sync.if,/inputs\.enable_sync/);
});

test('approved partial imports preserve English, register available translations and work through the actual fallback loader',async t=>{
 const f=await fixture(t);await f.put('.crowdin/fr/app.json',{greeting:'Bonjour {name}'});await f.put('.crowdin/en/app.json',{save:'Save changes'});
 const result=await syncLocalizations(f.folder,{importCrowdin:true});assert.equal(result.locales,3);assert.equal(result.sourceMessages,4);
 assert.deepEqual(JSON.parse(await readFile(join(f.folder,'apps/web/public/locales/en.json'),'utf8')),{greeting:'Hello {name}',save:'Save changes'});
 const manifest=JSON.parse(await readFile(join(f.folder,'apps/web/public/locale-manifest.json'),'utf8'));assert.equal(manifest.locales.find(item=>item.code==='fr').stage,'partial');assert.deepEqual(JSON.parse(await readFile(join(f.folder,'apps/web/public/setup-locales/fr.json'),'utf8')),{});
 const fetcher=async url=>Response.json(JSON.parse(await readFile(join(f.folder,'apps/web/public',url.pathname.slice(1)),'utf8'))),i18n=createI18n(await loadCatalogs({namespace:'app',locale:'fr',baseUrl:new URL('https://locale.fixture.invalid/i18n.js'),fetcher}),'fr');
 assert.equal(i18n.t('greeting',{name:'Aoi'}),'Bonjour Aoi');assert.equal(i18n.t('save'),'Save changes');assert.equal(i18n.coverage.usingFallback,true);
 assert.equal((await syncLocalizations(f.folder,{importCrowdin:true})).changed,0);
});
test('complete translations and right-to-left metadata are derived without changing Japanese source text',async t=>{
 const f=await fixture(t),before=await readFile(join(f.folder,'apps/web/public/locales/ja.json'),'utf8');
 for(const namespace of Object.keys(f.manifest.namespaces))await f.put('.crowdin/ar/'+namespace+'.json',{greeting:'مرحبا {name}',save:'حفظ'});
 await syncLocalizations(f.folder,{importCrowdin:true});const manifest=JSON.parse(await readFile(join(f.folder,'apps/web/public/locale-manifest.json'),'utf8')),ar=manifest.locales.find(item=>item.code==='ar');
 assert.equal(ar.dir,'rtl');assert.equal(ar.stage,'complete');assert.equal(await readFile(join(f.folder,'apps/web/public/locales/ja.json'),'utf8'),before);
});
test('invalid placeholders, unknown keys and unexpected files reject the entire import before writing runtime data',async t=>{
 for(const bad of [{name:'setup.json',value:{greeting:'Hallo {other}'}},{name:'setup.json',value:{extra:'Untrusted'}},{name:'script.js',value:{}},{name:'setup.json',value:{save:{html:'<script>'}}}]){
  const f=await fixture(t);await f.put('.crowdin/de/app.json',{save:'Speichern'});await f.put('.crowdin/de/'+bad.name,bad.value);
  const before=await readFile(join(f.folder,'apps/web/public/locale-manifest.json'),'utf8');await assert.rejects(syncLocalizations(f.folder,{importCrowdin:true}));assert.equal(await readFile(join(f.folder,'apps/web/public/locale-manifest.json'),'utf8'),before);
  await assert.rejects(readFile(join(f.folder,'apps/web/public/locales/de.json')),{code:'ENOENT'});
 }
});
test('a Crowdin target cannot overwrite source Japanese, and incomplete English never loses fallback keys',async t=>{
 const f=await fixture(t);await f.put('.crowdin/ja/app.json',{save:'Unexpected source replacement'});await assert.rejects(syncLocalizations(f.folder,{importCrowdin:true}),/invalid Crowdin target/);
 const g=await fixture(t);await g.put('.crowdin/en/app.json',{save:'Updated English'});await syncLocalizations(g.folder,{importCrowdin:true});assert.equal((await checkLocalizations(g.folder)).locales,2);
});
test('missing namespace files and stale manifest metadata are detected and can be synchronized',async t=>{
 const f=await fixture(t);await f.put('apps/web/public/locales/ko.json',{save:'저장'});await assert.rejects(checkLocalizations(f.folder),/l10n:sync/);await syncLocalizations(f.folder);assert.equal((await checkLocalizations(f.folder)).locales,3);
});

test('a one-file GitHub proposal reports progress without writes and becomes usable after build preparation',async t=>{
 const f=await fixture(t);await f.put('apps/web/public/setup-locales/fr.json',{save:'Enregistrer'});
 const before=await readFile(join(f.folder,'apps/web/public/locale-manifest.json'),'utf8'),report=await reportLocalizations(f.folder),fr=report.locales.find(item=>item.code==='fr');
 assert.equal(fr.translated,1);assert.equal(fr.total,4);assert.equal(fr.percent,25);assert.equal(fr.stage,'partial');assert.equal(fr.namespaces.app.translated,0);
 assert.match(localizationReportMarkdown(report),/Français \(fr\).*1 \/ 4.*25%/i);
 assert.equal(await readFile(join(f.folder,'apps/web/public/locale-manifest.json'),'utf8'),before);await assert.rejects(readFile(join(f.folder,'apps/web/public/locales/fr.json')),{code:'ENOENT'});
 await syncLocalizations(f.folder);assert.equal((await checkLocalizations(f.folder)).locales,3);
 const fetcher=async url=>Response.json(JSON.parse(await readFile(join(f.folder,'apps/web/public',url.pathname.slice(1)),'utf8')));
 const i18n=createI18n(await loadCatalogs({namespace:'setup',locale:'fr',baseUrl:new URL('https://locale.fixture.invalid/i18n.js'),fetcher}),'fr');
 assert.equal(i18n.t('save'),'Enregistrer');assert.equal(i18n.t('greeting',{name:'Aoi'}),'Hello Aoi');
});

test('duplicate keys including JSON escapes cannot silently discard a community translation',async t=>{
 const f=await fixture(t),path=join(f.folder,'apps/web/public/setup-locales/fr.json');
 await writeFile(path,'{"save":"Garder","s\\u0061ve":"Enregistrer"}');await assert.rejects(syncLocalizations(f.folder),/duplicate key: save/);
 await writeFile(path,JSON.stringify({save:'Texte avec "save": et \\ une barre'}));assert.equal((await syncLocalizations(f.folder)).locales,3);
});

test('translation proposals run with read-only GitHub permissions and no external-service credentials',async()=>{
 const workflow=parse(await readFile(join(root,'.github/workflows/translation-check.yaml'),'utf8'));
 assert.deepEqual(Object.keys(workflow.on),['pull_request','workflow_dispatch']);assert.deepEqual(workflow.permissions,{contents:'read'});
 assert.ok(workflow.on.pull_request.paths.includes('apps/web/public/*-locales/*.json'));
 const job=workflow.jobs.validate;assert.equal(job.permissions,undefined);
 const steps=job.steps.filter(step=>step.run).map(step=>step.run).join('\n');assert.ok(steps.indexOf('l10n:sync')<steps.indexOf('l10n:check'));assert.match(steps,/report --markdown.*GITHUB_STEP_SUMMARY/);
 assert.doesNotMatch(JSON.stringify(workflow),/secrets\.|pull_request_target|crowdin\/|contents.*write/);
});
test('source exports contain only source dictionaries under their Crowdin paths and valid ZIP checksums',async t=>{
 const f=await fixture(t);await writeFile(join(f.folder,'.env'),'PRIVATE-ENVIRONMENT');const result=await exportCrowdinSources(f.folder),zip=await readFile(result.bundle),names=[];let offset=0;
 while(zip.readUInt32LE(offset)===0x04034b50){const size=zip.readUInt32LE(offset+18),length=zip.readUInt16LE(offset+26),start=offset+30+length,name=zip.subarray(offset+30,start).toString(),bytes=zip.subarray(start,start+size);assert.equal(crc32(bytes),zip.readUInt32LE(offset+14));assert.deepEqual(JSON.parse(bytes),{greeting:'こんにちは {name}',save:'保存'});names.push(name);offset=start+size;}
 assert.deepEqual(names,['apps/web/public/locales/ja.json','apps/web/public/setup-locales/ja.json']);assert.equal(zip.includes(Buffer.from('PRIVATE-ENVIRONMENT')),false);assert.equal(zip.readUInt32LE(offset),0x02014b50);assert.equal(relative(f.folder,result.bundle),join('.build','crowdin-sources.zip'));
});
