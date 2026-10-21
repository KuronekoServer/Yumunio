import { canonicalLocale } from './locale-code.js';
export const I18N_LIMITS = Object.freeze({ manifestBytes:65536, catalogBytes:131072, locales:64, namespaces:32, keys:2048, messageLength:32768, timeoutMs:5000 });
const metadata = new WeakMap(), forbidden = new Set(['__proto__','prototype','constructor']);
const placeholders = value => [...value.matchAll(/\{([A-Za-z]\w*)\}/g)].map(match=>match[1]).sort();
function plain(value) { return value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key=>typeof key==='string' && !forbidden.has(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')); }
function exact(value,keys) { return plain(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)); }
export function validateCatalogParity(source,translation) {
 const missing=Object.keys(source).filter(key=>!Object.hasOwn(translation,key)), extra=Object.keys(translation).filter(key=>!Object.hasOwn(source,key));
 const placeholderMismatches=Object.keys(source).filter(key=>typeof source[key]!=='string'||Object.hasOwn(translation,key)&&(typeof translation[key]!=='string'||JSON.stringify(placeholders(source[key]))!==JSON.stringify(placeholders(translation[key]))));
 return {valid:!missing.length&&!extra.length&&!placeholderMismatches.length,missing,extra,placeholderMismatches};
}
export function validateLocaleManifest(value) {
 if(!exact(value,['schemaVersion','artifactKind','messageFormat','sourceLocale','defaultLocale','fallbackLocale','namespaces','locales'])||value.schemaVersion!==1||value.artifactKind!=='runtime'||value.messageFormat!=='named-parameters-v1'||value.sourceLocale!=='ja'||value.fallbackLocale!=='en'||!plain(value.namespaces)||!Object.keys(value.namespaces).length||Object.keys(value.namespaces).length>I18N_LIMITS.namespaces||!Array.isArray(value.locales)||value.locales.length<2||value.locales.length>I18N_LIMITS.locales)throw new TypeError('INVALID_LOCALE_MANIFEST');
 for(const[namespace,path]of Object.entries(value.namespaces))if(!/^[a-z][a-z0-9-]{0,39}$/.test(namespace)||typeof path!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(path))throw new TypeError('INVALID_LOCALE_MANIFEST');
 const codes=new Set();
 for(const item of value.locales){if(!exact(item,['code','endonym','dir','fallbacks','stage'])||canonicalLocale(item.code)!==item.code||codes.has(item.code)||typeof item.endonym!=='string'||!item.endonym.trim()||Array.from(item.endonym).length>80||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(item.endonym)||!['ltr','rtl'].includes(item.dir)||!['complete','partial'].includes(item.stage)||!Array.isArray(item.fallbacks)||item.fallbacks.length>8||new Set(item.fallbacks).size!==item.fallbacks.length)throw new TypeError('INVALID_LOCALE_MANIFEST');codes.add(item.code);}
 if(!codes.has('ja')||!codes.has('en')||!codes.has(value.defaultLocale)||value.locales.some(item=>['ja','en'].includes(item.code)&&item.stage!=='complete'))throw new TypeError('INVALID_LOCALE_MANIFEST');
 const byCode=new Map(value.locales.map(item=>[item.code,item]));
 const visited=new Set(),visiting=new Set();
 function visit(code){if(visiting.has(code))throw new TypeError('INVALID_LOCALE_MANIFEST');if(visited.has(code))return;visiting.add(code);for(const fallback of byCode.get(code).fallbacks){if(!codes.has(fallback))throw new TypeError('INVALID_LOCALE_MANIFEST');visit(fallback);}visiting.delete(code);visited.add(code);}
 for(const code of codes)visit(code);return structuredClone(value);
}
export function validateTranslationCatalog(value){if(!plain(value)||Object.keys(value).length>I18N_LIMITS.keys||Object.entries(value).some(([key,message])=>!/^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(key)||typeof message!=='string'||!message.trim()||message.length>I18N_LIMITS.messageLength||message.includes('\0')))throw new TypeError('INVALID_CATALOG');return Object.assign(Object.create(null),value);}
async function readJson(response,limit){
 if(!response?.ok)throw new Error('CATALOG_UNAVAILABLE');if(!response.body||typeof response.body.getReader!=='function')throw new Error('INVALID_CATALOG');
 const declared=response.headers?.get('content-length');if(declared!==null&&declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('CATALOG_TOO_LARGE');
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel().catch(()=>{});throw new Error('CATALOG_TOO_LARGE');}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('INVALID_CATALOG');}
}
function resolveCode(manifest,requested){let code;try{code=canonicalLocale(requested);}catch{return manifest.defaultLocale;}if(manifest.locales.some(item=>item.code===code))return code;const parsed=new Intl.Locale(code),parent=parsed.script?parsed.language+'-'+parsed.script:parsed.language;if(manifest.locales.some(item=>item.code===parent))return parent;return manifest.fallbackLocale;}
function chainFor(manifest,code){const result=[];const add=value=>{if(result.includes(value))return;result.push(value);for(const fallback of manifest.locales.find(item=>item.code===value)?.fallbacks??[])add(fallback);};add(resolveCode(manifest,code));add(manifest.fallbackLocale);add(manifest.sourceLocale);return result;}
function defaultCatalogBase(href){const url=new URL(href);if(['https:','http:'].includes(url.protocol)){url.pathname='/i18n.js';url.search='';url.hash='';}return url.href;}
export async function loadCatalogs(options={}){
 if(typeof options==='function')options={fetcher:options};const{namespace='app',locale='ja',fetcher=globalThis.fetch,manifest:provided,initialCatalogs={},baseUrl=defaultCatalogBase(import.meta.url)}=options;if(typeof fetcher!=='function')throw new TypeError('INVALID_CATALOG_FETCHER');
 const fetchJson=async(url,limit)=>readJson(await fetcher(url,{method:'GET',mode:'same-origin',credentials:'omit',redirect:'error',cache:'no-cache',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(I18N_LIMITS.timeoutMs)}),limit);
 const manifest=validateLocaleManifest(provided??await fetchJson(new URL('./locale-manifest.json',baseUrl),I18N_LIMITS.manifestBytes));if(!Object.hasOwn(manifest.namespaces,namespace))throw new TypeError('INVALID_NAMESPACE');
 if(!plain(initialCatalogs)||Object.keys(initialCatalogs).some(code=>!manifest.locales.some(item=>item.code===code)))throw new TypeError('INVALID_CATALOG');
 const catalogs=Object.create(null),pending=new Map(),unavailable=new Set();
 const ensureOne=code=>{if(Object.hasOwn(catalogs,code))return Promise.resolve();if(pending.has(code))return pending.get(code);const task=(async()=>{try{const candidate=validateTranslationCatalog(Object.hasOwn(initialCatalogs,code)?initialCatalogs[code]:await fetchJson(new URL('./'+manifest.namespaces[namespace]+'/'+code+'.json',baseUrl),I18N_LIMITS.catalogBytes));if(code!=='ja'){await ensureOne('ja');const parity=validateCatalogParity(catalogs.ja,candidate);if(parity.extra.length||parity.placeholderMismatches.length||(manifest.locales.find(item=>item.code===code).stage==='complete'&&parity.missing.length))throw new Error('CATALOG_MISMATCH');}catalogs[code]=candidate;}catch(error){if(['ja','en'].includes(code))throw error;unavailable.add(code);catalogs[code]=Object.create(null);}})();pending.set(code,task);return task.finally(()=>pending.delete(code));};
 await Promise.all([ensureOne('ja'),ensureOne('en')]);const ensure=async requested=>{await Promise.all(chainFor(manifest,requested).map(ensureOne));};await ensure(locale);metadata.set(catalogs,{manifest,namespace,ensure,unavailable});return catalogs;
}
export function createI18n(catalogs,initialLocale='ja'){
 const context=metadata.get(catalogs),allowed=context?.manifest.locales.map(item=>item.code)??Object.keys(catalogs);let requestedLocale=initialLocale,locale=context?resolveCode(context.manifest,initialLocale):allowed.includes(initialLocale)?initialLocale:'ja',generation=0;
 const source=catalogs.ja??{},lookup=new Map(Object.entries(source).map(([key,value])=>[value,key])),patterns=[],escape=value=>value.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&');
 for(const[key,value]of Object.entries(source)){const names=[];let last=0,pattern='^';for(const match of value.matchAll(/\{([A-Za-z]\w*)\}/g)){pattern+=escape(value.slice(last,match.index))+'(.+?)';names.push(match[1]);last=match.index+match[0].length;}if(names.length)patterns.push({key,names,regex:new RegExp(pattern+escape(value.slice(last))+'$')});}
 const chain=()=>context?chainFor(context.manifest,locale):[...new Set([locale,'en','ja'])];
 function t(key,values={}){const template=chain().map(code=>catalogs[code]?.[key]).find(value=>typeof value==='string')??key;return template.replace(/\{([A-Za-z]\w*)\}/g,(match,name)=>Object.hasOwn(values,name)?String(values[name]):match);}
 function text(value){if(typeof value!=='string'||locale==='ja')return value;if(lookup.has(value))return t(lookup.get(value));for(const pattern of patterns){const match=pattern.regex.exec(value);if(match)return t(pattern.key,Object.fromEntries(pattern.names.map((name,index)=>[name,match[index+1]])));}return value;}
 return{t,text,get locale(){return locale;},get requestedLocale(){return requestedLocale;},get availableLocales(){return context?structuredClone(context.manifest.locales):allowed.map(code=>({code,endonym:code==='ja'?'日本語':code==='en'?'English':code,dir:'ltr',fallbacks:[],stage:'complete'}));},get dir(){return context?.manifest.locales.find(item=>item.code===locale)?.dir??'ltr';},get coverage(){const total=Object.keys(source).length,translated=Object.keys(catalogs[locale]??{}).length;return{translated,total,usingFallback:translated<total||requestedLocale!==locale,unavailable:context?.unavailable.has(locale)??false};},
 setLocale(value){if(!context&&!allowed.includes(value))throw new TypeError('INVALID_LOCALE');requestedLocale=value;locale=context?resolveCode(context.manifest,value):value;generation++;},
 async switchLocale(value){const ticket=++generation,code=context?resolveCode(context.manifest,value):value;if(!allowed.includes(code))throw new TypeError('INVALID_LOCALE');if(context)await context.ensure(value);if(ticket!==generation)return false;requestedLocale=value;locale=code;return true;}};
}
export function languageOptions(i18n){return i18n.availableLocales.map(({code,endonym,dir})=>({code,endonym,dir}));}
export function createLocaleOptions(document,i18n,{value=i18n.locale}={}){const choices=languageOptions(i18n),result=choices.map(item=>{const option=document.createElement('option');option.value=item.code;option.textContent=item.endonym;option.dir=item.dir;option.selected=item.code===value;return option;});if(!choices.some(item=>item.code===value)){const option=document.createElement('option');option.value=value;option.textContent=value+' → '+(choices.find(item=>item.code===i18n.locale)?.endonym??i18n.locale);option.disabled=true;option.selected=true;result.unshift(option);}return result;}
export function applyLocaleNotice(document,i18n,{additional=[]}={}){
 if(!i18n||!document.body)return;
 const usesFallback=[i18n,...additional].some(item=>item.coverage.usingFallback),host=document.querySelector('[data-locale-notice-host]');
 let notice=document.querySelector('[data-locale-fallback]');
 if(!notice&&usesFallback){notice=document.createElement('p');notice.setAttribute('data-locale-fallback','');notice.setAttribute('role','status');notice.className='locale-note';}
 if(!notice)return;
 notice.hidden=!usesFallback;notice.textContent=i18n.t('localeFallbackNotice');
 if(host){if(host.firstChild!==notice)host.prepend(notice);}
 else if(notice.parentNode!==document.body)document.body.append(notice);
}
export function applyLocaleDocument(document,i18n,{additional=[]}={}){if(!i18n)return;document.documentElement.lang=i18n.locale;document.documentElement.dir=i18n.dir;for(const select of document.querySelectorAll?.('select[data-locale-picker],select#language,select#share-language')??[])select.replaceChildren(...createLocaleOptions(document,i18n,{value:i18n.requestedLocale}));applyLocaleNotice(document,i18n,{additional});}
