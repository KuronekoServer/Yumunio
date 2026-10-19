import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadCatalogs,createI18n,validateLocaleManifest,languageOptions,createLocaleOptions,applyLocaleDocument,applyLocaleNotice,I18N_LIMITS} from '../public/i18n.js';
import {PreferencesStore} from '../public/preferences.js';
import {validatePreferences} from '../../../packages/identity/src/preferences-model.js';
import {readInstanceConfig} from '../../../packages/identity/src/instance.js';
import {validateInstanceConfig} from '../public/instance.js';
const fixture=new URL('./fixtures/i18n/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',fixture),'utf8'));
const fixtures=Object.fromEntries(await Promise.all(['ja','en','qaa','qab'].map(async code=>[code,JSON.parse(await readFile(new URL(code+'.json',fixture),'utf8'))])));
const copy=value=>structuredClone(value);
function fetchFixture(overrides={},calls=[]){return async(url,options)=>{calls.push({url,options});if(url.pathname.endsWith('/locale-manifest.json'))return Response.json(copy(manifest));const code=url.pathname.split('/').at(-1).replace(/\.json$/,'');return overrides[code]?overrides[code](url,options):Response.json(copy(fixtures[code]));};}

test('bundled React views load catalogs from the public asset base instead of the bundle directory',async()=>{
 const calls=[],catalogs=await loadCatalogs({namespace:'app',baseUrl:new URL('https://locale.fixture.invalid/i18n.js'),fetcher:fetchFixture({},calls)});assert.ok(catalogs.ja);assert.ok(calls.every(call=>call.url.origin==='https://locale.fixture.invalid'&&!call.url.pathname.startsWith('/shared/')));assert.equal(calls[0].url.pathname,'/locale-manifest.json');
});
class MemoryStorage{data=new Map();getItem(key){return this.data.get(key)??null;}setItem(key,value){this.data.set(key,value);}}
test('a third locale requires only fixture manifest and JSON, safely falls back and persists across client and server validation',async()=>{
 const calls=[],catalogs=await loadCatalogs({locale:'qaa',fetcher:fetchFixture({},calls)}),i18n=createI18n(catalogs,'qaa');
 assert.equal(i18n.t('greeting',{name:'<img src=x onerror=alert(1)>'}),'TEST_A <img src=x onerror=alert(1)>');assert.equal(i18n.t('details'),'Details');assert.equal(i18n.dir,'rtl');assert.equal(i18n.coverage.usingFallback,true);assert.equal(i18n.coverage.translated,1);assert.equal(languageOptions(i18n).find(item=>item.code==='qaa').endonym,'Fixture A');
 const storage=new MemoryStorage(),prefs=new PreferencesStore({storage,profileId:'fixture-user'});prefs.update({locale:'qaa',themeId:'midnight'});assert.equal(new PreferencesStore({storage,profileId:'fixture-user'}).snapshot().locale,'qaa');assert.equal(validatePreferences(prefs.snapshot()).locale,'qaa');assert.equal(storage.getItem('yumunio.local-demo.v1'),null);
 assert.ok(calls.every(call=>call.options.credentials==='omit'&&call.options.redirect==='error'&&call.options.mode==='same-origin'&&call.options.signal));assert.ok(calls.every(call=>/\/(?:locale-manifest|fixture-locales\/(?:ja|en|qaa))\.json$/.test(call.url.pathname)));
});
test('missing, corrupt, extra-key and mismatched-placeholder optional catalogs keep English fallback usable',async()=>{
 for(const response of [()=>new Response(null,{status:404}),()=>new Response('{broken'),()=>Response.json({unexpected:'x'}),()=>Response.json({greeting:'BAD {other}'})]){const i18n=createI18n(await loadCatalogs({locale:'qaa',fetcher:fetchFixture({qaa:response})}),'qaa');assert.equal(i18n.t('greeting',{name:'A'}),'Hello A');assert.equal(i18n.coverage.unavailable,true);}
});
test('JA/EN remain complete requirements while optional catalogs may omit keys',async()=>{
 await assert.rejects(loadCatalogs({manifest,fetcher:fetchFixture({en:()=>Response.json({greeting:'Hello {name}'})})}),/CATALOG_MISMATCH/);
 const complete=copy(manifest);complete.locales.find(item=>item.code==='qaa').stage='complete';const i18n=createI18n(await loadCatalogs({manifest:complete,locale:'qaa',fetcher:fetchFixture()}),'qaa');assert.equal(i18n.t('details'),'Details');assert.equal(i18n.coverage.unavailable,true);
});
test('a slow language response cannot replace a later language selection',async()=>{
 let release,started;const began=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 const catalogs=await loadCatalogs({fetcher:fetchFixture({qaa:async()=>{started();await gate;return Response.json(fixtures.qaa);}})}),i18n=createI18n(catalogs,'ja');
 const old=i18n.switchLocale('qaa');await began;assert.equal(await i18n.switchLocale('en'),true);release();assert.equal(await old,false);assert.equal(i18n.locale,'en');assert.equal(i18n.t('details'),'Details');
});
test('canonical but unavailable preferences survive and do not turn script variants into a different script',async()=>{
 const storage=new MemoryStorage(),prefs=new PreferencesStore({storage});prefs.update({locale:'zh-hant-TW',themeId:'ocean'});assert.equal(prefs.snapshot().locale,'zh-Hant-TW');const reload=new PreferencesStore({storage});assert.equal(reload.error,'');assert.equal(reload.snapshot().themeId,'ocean');
 const i18n=createI18n(await loadCatalogs({locale:reload.snapshot().locale,fetcher:fetchFixture()}),reload.snapshot().locale);assert.equal(i18n.locale,'en');assert.equal(i18n.requestedLocale,'zh-Hant-TW');assert.equal(i18n.coverage.usingFallback,true);
 const instance=readInstanceConfig({YUMUNIO_DEFAULT_LOCALE:'zh-hant-TW'});assert.equal(validateInstanceConfig(instance).defaultLocale,'zh-Hant-TW');
});
test('manifest paths, locale aliases, dangerous keys and fallback cycles fail before catalog requests',async()=>{
 const bad=[];for(const path of ['../locales','https://evil.invalid','locales?x','%2e%2e','a/b']){const value=copy(manifest);value.namespaces.app=path;bad.push(value);}const cycle=copy(manifest);cycle.locales.find(item=>item.code==='en').fallbacks=['ja'];bad.push(cycle);const alias=copy(manifest);alias.locales[2].code='qaa/../../x';bad.push(alias);const proto=copy(manifest);proto.namespaces=JSON.parse('{"__proto__":"x"}');bad.push(proto);
 for(const value of bad){let calls=0;await assert.rejects(loadCatalogs({manifest:value,fetcher:()=>{calls++;throw new Error('unexpected fetch');}}));assert.equal(calls,0);}
 assert.throws(()=>validateLocaleManifest({...manifest,messageFormat:'icu-messageformat-1'}));
});
test('catalog size, malformed UTF8 and nested values are rejected without executing text',async()=>{
 for(const response of [()=>new Response(' '.repeat(I18N_LIMITS.catalogBytes+1)),()=>new Response(new Uint8Array([0xc0,0xaf])),()=>Response.json({greeting:{html:'<script>'}}),()=>new Response('{"__proto__":"unsafe"}')])await assert.rejects(loadCatalogs({manifest,fetcher:fetchFixture({ja:response})}),/CATALOG/);
});
test('namespace selection stays fixed and language metadata remains literal DOM text',async()=>{
 let calls=0;await assert.rejects(loadCatalogs({manifest,namespace:'../account',fetcher:()=>{calls++;}}),/INVALID_NAMESPACE/);assert.equal(calls,0);
 const altered=copy(manifest);altered.locales[2].endonym='<img src=x>';const i18n=createI18n(await loadCatalogs({manifest:altered,locale:'qaa',fetcher:fetchFixture()}),'qaa');
 const nodes=[],document={createElement(tag){const node={tag,setAttribute(key,value){this[key]=value;}};nodes.push(node);return node;},documentElement:{},querySelectorAll(){return[];}};
 const options=createLocaleOptions(document,i18n);assert.equal(options.find(item=>item.value==='qaa').textContent,'<img src=x>');assert.ok(options.every(item=>!Object.hasOwn(item,'innerHTML')));applyLocaleDocument(document,i18n);assert.deepEqual(document.documentElement,{lang:'qaa',dir:'rtl'});
});

test('the runtime manifest loads every existing namespace with complete JA/EN catalogs through the common bounded loader',async()=>{
 const runtimeManifest=JSON.parse(await readFile(new URL('../public/locale-manifest.json',import.meta.url),'utf8'));
 const fetcher=async url=>new Response(await readFile(url),{headers:{'Content-Type':'application/json'}});
 for(const namespace of Object.keys(runtimeManifest.namespaces)){const catalogs=await loadCatalogs({namespace,locale:'en',fetcher});const i18n=createI18n(catalogs,'en');assert.equal(i18n.coverage.usingFallback,false,namespace);assert.ok(i18n.coverage.total>0,namespace);assert.equal(i18n.t('localeFallbackNotice'),'Some labels use English. Page names and content are not translated.',namespace);}
});

test('a secondary namespace can request one visible fallback notice without changing the primary language or direction',async()=>{
 const catalogs=await loadCatalogs({locale:'qaa',fetcher:fetchFixture()}),primary=createI18n(catalogs,'en'),secondary=createI18n(catalogs,'qaa');let notice=null,appended=0;
 const document={documentElement:{},querySelectorAll(){return[];},querySelector(selector){return selector==='[data-locale-fallback]'?notice:null;},createElement(){return{setAttribute(key,value){this[key]=value;}};},body:{append(value){notice=value;value.parentNode=this;appended++;}}};
 applyLocaleDocument(document,primary,{additional:[secondary]});assert.equal(document.documentElement.lang,'en');assert.equal(document.documentElement.dir,'ltr');assert.equal(notice.hidden,false);assert.equal(notice.textContent,'Some labels use English.');applyLocaleDocument(document,primary);assert.equal(notice.hidden,true);assert.equal(appended,1);
});

function noticeDocumentFixture(){
 const make=tag=>({tag,childNodes:[],parentNode:null,attributes:{},mutations:0,setAttribute(key,value){this.attributes[key]=value;},get firstChild(){return this.childNodes[0]??null;},place(child,first){if(child.parentNode){const prior=child.parentNode.childNodes;prior.splice(prior.indexOf(child),1);}child.parentNode=this;if(first)this.childNodes.unshift(child);else this.childNodes.push(child);this.mutations++;},append(child){this.place(child,false);},prepend(child){this.place(child,true);},replaceChildren(...children){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];for(const child of children)this.append(child);}});
 const body=make('body'),host=make('main'),content=make('input'),picker={value:'ja',mutations:0,replaceChildren(){this.mutations++;}},find=(node,key)=>Object.hasOwn(node.attributes,key)?node:node.childNodes.map(child=>find(child,key)).find(Boolean)??null;
 host.setAttribute('data-locale-notice-host','');host.append(content);body.append(host);
 const document={body,documentElement:{lang:'en',dir:'ltr'},activeElement:content,pickerReads:0,querySelector(selector){return find(body,selector.slice(1,-1));},querySelectorAll(){this.pickerReads++;return[picker];},createElement:make};return{document,host,content,picker};
}
test('the standalone notice helper moves an existing notice to the host top without touching the pending language choice, direction or focus',()=>{
 const primary=createI18n({ja:{localeFallbackNotice:'JA'},en:{localeFallbackNotice:'English fallback'}},'en'),secondary={coverage:{usingFallback:true}},fixture=noticeDocumentFixture(),{document,host,content,picker}=fixture;
 const existing=document.createElement('p');existing.setAttribute('data-locale-fallback','');document.body.append(existing);
 applyLocaleNotice(document,primary,{additional:[secondary]});assert.equal(host.firstChild,existing);assert.equal(host.childNodes[1],content);assert.equal(existing.textContent,'English fallback');assert.equal(existing.hidden,false);assert.equal(picker.value,'ja');assert.equal(picker.mutations,0);assert.equal(document.pickerReads,0);assert.deepEqual(document.documentElement,{lang:'en',dir:'ltr'});assert.equal(document.activeElement,content);
 const mutations=host.mutations;applyLocaleNotice(document,primary,{additional:[secondary]});assert.equal(host.mutations,mutations);assert.equal(host.childNodes.filter(node=>node===existing).length,1);
 applyLocaleNotice(document,primary);assert.equal(existing.hidden,true);assert.equal(host.firstChild,existing);
});
test('host rerenders recreate one notice, while pages without an opted-in host keep the legacy body placement',()=>{
 const i18n=createI18n({ja:{localeFallbackNotice:'JA'},en:{}},'en'),{document,host,content}=noticeDocumentFixture();
 applyLocaleNotice(document,i18n);const original=host.firstChild;assert.equal(original.attributes.role,'status');assert.equal(original.className,'locale-note');
 host.replaceChildren(content);assert.equal(original.parentNode,null);applyLocaleNotice(document,i18n);const replacement=host.firstChild;assert.notEqual(replacement,original);assert.equal(replacement.textContent,'JA');assert.equal(host.childNodes.length,2);assert.equal(document.activeElement,content);
 document.body.replaceChildren();applyLocaleNotice(document,i18n);const legacy=document.body.childNodes.at(-1);assert.equal(legacy.attributes['data-locale-fallback'],'');const mutations=document.body.mutations;applyLocaleNotice(document,i18n);assert.equal(document.body.mutations,mutations);assert.equal(document.body.childNodes.length,1);
});
