import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {crc32} from 'node:zlib';
import {I18N_LIMITS,validateCatalogParity,validateLocaleManifest,validateTranslationCatalog} from '../../apps/web/public/i18n.js';
import {canonicalLocale} from '../identity/src/locale-code.js';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const fail=(file,reason)=>{throw new Error(file+': '+reason);};
async function directory(path,{optional=false}={}){
 let stat;try{stat=await lstat(path);}catch(error){if(optional&&error.code==='ENOENT')return false;throw error;}
 if(stat.isSymbolicLink()||!stat.isDirectory())fail(path,'expected a directory without symbolic links');return true;
}
async function json(path,limit=I18N_LIMITS.catalogBytes,{uniqueKeys=false}={}){
 const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>limit)fail(path,'invalid catalog file');
 let source,value;try{source=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path));value=JSON.parse(source);}catch{fail(path,'invalid UTF-8 JSON');}
 if(uniqueKeys){
  const keys=new Set();for(const token of source.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)){
   if(!/^\s*:/.test(source.slice(token.index+token[0].length)))continue;
   const key=JSON.parse(token[0]);if(keys.has(key))fail(path,'duplicate key: '+key);keys.add(key);
  }
 }
 return value;
}
const catalog=async path=>{try{return validateTranslationCatalog(await json(path,I18N_LIMITS.catalogBytes,{uniqueKeys:true}));}catch(error){fail(path,error.message);}};
async function context(root){
 const web=join(root,'apps/web/public');await directory(web);const manifest=validateLocaleManifest(await json(join(web,'locale-manifest.json'),I18N_LIMITS.manifestBytes));
 const sources=new Map();for(const[namespace,path]of Object.entries(manifest.namespaces)){await directory(join(web,path));sources.set(namespace,await catalog(join(web,path,'ja.json')));}
 return{web,manifest,sources};
}
function parity(source,translation,file,{complete=false}={}){
 const result=validateCatalogParity(source,translation);
 if(result.extra.length)fail(file,'unknown keys: '+result.extra.join(', '));
 if(result.placeholderMismatches.length)fail(file,'changed placeholders: '+result.placeholderMismatches.join(', '));
 if(complete&&result.missing.length)fail(file,'missing keys: '+result.missing.join(', '));
}
async function installed(ctx){
 const values=new Map();
 for(const[namespace,path]of Object.entries(ctx.manifest.namespaces))for(const entry of await readdir(join(ctx.web,path),{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.json'))fail(join(path,entry.name),'unexpected catalog entry');
  const locale=entry.name.slice(0,-5);if(canonicalLocale(locale)!==locale)fail(entry.name,'use a canonical locale code');
  const file=join(ctx.web,path,entry.name),value=await catalog(file);parity(ctx.sources.get(namespace),value,file,{complete:['ja','en'].includes(locale)});
  if(!values.has(locale))values.set(locale,new Map());values.get(locale).set(namespace,value);
 }
 for(const locale of ['ja','en'])if(values.get(locale)?.size!==ctx.sources.size)fail(locale,'every namespace needs a complete Japanese and English catalog');
 return values;
}
function describeLocale(code){
 const language=new Intl.Locale(code),endonym=new Intl.DisplayNames([code],{type:'language'}).of(code);
 const dir=typeof language.getTextInfo==='function'?language.getTextInfo().direction:language.textInfo?.direction??(['ar','fa','he','ur','ps','dv','yi'].includes(language.language)?'rtl':'ltr');
 return{code,endonym,dir,fallbacks:['en'],stage:'partial'};
}
function nextManifest(ctx,values){
 const existing=new Map(ctx.manifest.locales.map(item=>[item.code,item])),total=[...ctx.sources.values()].reduce((sum,value)=>sum+Object.keys(value).length,0);
 const locales=[...values].filter(([code,catalogs])=>['ja','en'].includes(code)||existing.has(code)||[...catalogs.values()].some(value=>Object.keys(value).length)).sort(([a],[b])=>['ja','en'].includes(a)||['ja','en'].includes(b)?['ja','en'].indexOf(a)===-1?1:['ja','en'].indexOf(b)===-1?-1:['ja','en'].indexOf(a)-['ja','en'].indexOf(b):a.localeCompare(b)).map(([code,catalogs])=>({...existing.get(code)??describeLocale(code),stage:[...catalogs.values()].reduce((sum,value)=>sum+Object.keys(value).length,0)===total?'complete':'partial'}));
 return validateLocaleManifest({...ctx.manifest,locales});
}
async function writeChanged(file,value){
 const bytes=JSON.stringify(value,null,2)+'\n';try{if(JSON.stringify(JSON.parse(await readFile(file,'utf8')))===JSON.stringify(value))return false;}catch(error){if(error.code!=='ENOENT')throw error;}
 await writeFile(file,bytes);return true;
}
export async function checkLocalizations(root=projectRoot){
 const ctx=await context(root),values=await installed(ctx),expected=nextManifest(ctx,values);
 if(JSON.stringify(expected)!==JSON.stringify(ctx.manifest))fail('locale-manifest.json','run npm run l10n:sync to register translations and update coverage');
 for(const item of expected.locales)if(values.get(item.code)?.size!==ctx.sources.size)fail(item.code,'run npm run l10n:sync to fill missing namespace files');
 return{namespaces:ctx.sources.size,locales:expected.locales.length,sourceMessages:[...ctx.sources.values()].reduce((sum,value)=>sum+Object.keys(value).length,0)};
}
/** Read-only progress for a one-file GitHub proposal, including locales not registered yet. */
export async function reportLocalizations(root=projectRoot){
 const ctx=await context(root),values=await installed(ctx),manifest=nextManifest(ctx,values),total=[...ctx.sources.values()].reduce((sum,value)=>sum+Object.keys(value).length,0);
 return{sourceLocale:manifest.sourceLocale,fallbackLocale:manifest.fallbackLocale,sourceMessages:total,namespaces:ctx.sources.size,locales:manifest.locales.map(locale=>{
  const namespaces=Object.fromEntries([...ctx.sources].map(([name,source])=>[name,{translated:Object.keys(values.get(locale.code)?.get(name)??{}).length,total:Object.keys(source).length}])),translated=Object.values(namespaces).reduce((sum,value)=>sum+value.translated,0);
  return{code:locale.code,endonym:locale.endonym,dir:locale.dir,stage:locale.stage,translated,total,percent:total?Math.round(translated/total*10000)/100:100,namespaces};
 })};
}
export function localizationReportMarkdown(report){
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
 return['## Community translations','','Source: Japanese. Missing translations fall back to English.','', '| Language | Translated | Progress | Stage |','| --- | ---: | ---: | --- |',...report.locales.map(locale=>`| ${escape(locale.endonym)} (${escape(locale.code)}) | ${locale.translated} / ${locale.total} | ${locale.percent}% | ${locale.stage} |`),'','Only UI dictionaries are counted. Page content and attachments are excluded.',''].join('\n');
}
export async function syncLocalizations(root=projectRoot,{importCrowdin=false}={}){
 const ctx=await context(root),values=await installed(ctx),incoming=join(root,'.crowdin');
 if(importCrowdin&&await directory(incoming,{optional:true}))for(const entry of await readdir(incoming,{withFileTypes:true})){
  if(entry.isSymbolicLink()||!entry.isDirectory()||canonicalLocale(entry.name)!==entry.name||entry.name==='ja')fail(entry.name,'invalid Crowdin target language');
  const folder=join(incoming,entry.name);await directory(folder);if(!values.has(entry.name))values.set(entry.name,new Map());
  for(const file of await readdir(folder,{withFileTypes:true})){
   const namespace=file.name.slice(0,-5);if(!file.isFile()||!file.name.endsWith('.json')||!ctx.sources.has(namespace))fail(file.name,'unexpected Crowdin file');
   const path=join(folder,file.name),translation=await catalog(path);parity(ctx.sources.get(namespace),translation,path);
   values.get(entry.name).set(namespace,{...values.get(entry.name).get(namespace),...translation});
  }
 }
 const manifest=nextManifest(ctx,values),plan=[];
 for(const item of manifest.locales)for(const[namespace,path]of Object.entries(manifest.namespaces))plan.push([join(ctx.web,path,item.code+'.json'),values.get(item.code).get(namespace)??{}]);
 for(const[file,value]of plan)parity(ctx.sources.get(Object.entries(manifest.namespaces).find(([,path])=>dirname(file)===join(ctx.web,path))[0]),value,file,{complete:['ja','en'].includes(file.split(/[\\/]/).at(-1).slice(0,-5))});
 let changed=0;for(const[file,value]of plan)if(await writeChanged(file,value))changed++;if(await writeChanged(join(ctx.web,'locale-manifest.json'),manifest))changed++;
 return{changed,...await checkLocalizations(root)};
}
export async function exportCrowdinSources(root=projectRoot){
 const ctx=await context(root);await checkLocalizations(root);const destination=join(root,'.build/crowdin-sources');await mkdir(destination,{recursive:true});
 const local=[],central=[];let offset=0;
 for(const[namespace,value]of ctx.sources){
  const path=ctx.manifest.namespaces[namespace],folder=join(destination,'apps/web/public',path);await mkdir(folder,{recursive:true});await writeChanged(join(folder,'ja.json'),value);
  const name=Buffer.from('apps/web/public/'+path+'/ja.json'),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),checksum=crc32(bytes),header=Buffer.alloc(30),index=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
  index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x800,8);index.writeUInt16LE(33,14);index.writeUInt32LE(checksum,16);index.writeUInt32LE(bytes.length,20);index.writeUInt32LE(bytes.length,24);index.writeUInt16LE(name.length,28);index.writeUInt32LE(offset,42);
  local.push(header,name,bytes);central.push(index,name);offset+=header.length+name.length+bytes.length;
 }
 const table=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(ctx.sources.size,8);end.writeUInt16LE(ctx.sources.size,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);const bundle=join(root,'.build/crowdin-sources.zip');await writeFile(bundle,Buffer.concat([...local,table,end]));
 const seed=join(root,'.crowdin/en');await mkdir(seed,{recursive:true});for(const[namespace,path]of Object.entries(ctx.manifest.namespaces))await writeChanged(join(seed,namespace+'.json'),await catalog(join(ctx.web,path,'en.json')));
 return{destination,bundle,namespaces:ctx.sources.size};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const command=process.argv[2]??'check';if(process.argv.length>3&&!(command==='report'&&process.argv.length===4&&process.argv[3]==='--markdown'))throw Error('Unexpected localization arguments.');const result=command==='check'?await checkLocalizations():command==='sync'?await syncLocalizations():command==='report'?await reportLocalizations():command==='import'?await syncLocalizations(projectRoot,{importCrowdin:true}):command==='export'?await exportCrowdinSources():(()=>{throw new Error('Expected check, sync, report, import or export');})();console.log(command==='report'&&process.argv[3]==='--markdown'?localizationReportMarkdown(result):JSON.stringify(result));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
