import {canonicalLocale,isLocaleTag} from './locale-code.js';
const themes=['paper','light','ocean','lavender','forest','midnight'];
const defaults={schemaVersion:1,applicationName:'Yumunio',organizationName:null,logos:{light:null,dark:null},favicons:{light:null,dark:null},brandColor:'#3D3D3A',initialTheme:'light',defaultLocale:'ja'};
const clone=value=>structuredClone(value);
const safeAsset=value=>typeof value==='string'&&value.length<=512&&/^\/brand\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png|ico)$/.test(value)&&value.split('/').every(part=>!part.includes('..'));
function object(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
const name=(value,max)=>typeof value==='string'&&value===value.trim()&&value.length>0&&Array.from(value).length<=max&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
export function validateInstanceConfig(value){
  if(!object(value,Object.keys(defaults))||value.schemaVersion!==1||!name(value.applicationName,80)||value.organizationName!==null&&!name(value.organizationName,120)||
    !/^#[A-F0-9]{6}$/.test(value.brandColor)||!themes.includes(value.initialTheme)||!isLocaleTag(value.defaultLocale))throw new TypeError('INVALID_INSTANCE');
  for(const key of ['logos','favicons'])if(!object(value[key],['light','dark'])||Object.values(value[key]).some(path=>path!==null&&!safeAsset(path)))throw new TypeError('INVALID_INSTANCE');
  return {...clone(value),defaultLocale:canonicalLocale(value.defaultLocale)};
}
/** Failure keeps a usable default UI. No arbitrary endpoint, redirects, or environment diagnostics. */
export async function loadInstanceConfig({fetcher=globalThis.fetch}={}){
  try{
    const response=await fetcher('/api/instance',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(2500)});
    if(!response.ok||!response.body)throw new Error();const reader=response.body.getReader(),parts=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192){try{await reader.cancel();}catch{}throw new Error();}parts.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    return validateInstanceConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }catch{return clone(defaults);}
}
/** First persisted preference only; an existing value, read failure or private-mode error is preserved. */
export function applyInstanceDefaults(preferences,config){
  const value=validateInstanceConfig(config);if(!preferences||preferences.error||!preferences.storage||typeof preferences.update!=='function')return false;
  try{if(preferences.storage.getItem(preferences.key)!==null)return false;preferences.update({themeId:value.initialTheme,locale:value.defaultLocale});return true;}catch{return false;}
}
function foreground(color){const linear=channel=>{const c=channel/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};const [r,g,b]=color.slice(1).match(/../g).map(part=>linear(parseInt(part,16))),l=.2126*r+.7152*g+.0722*b;return(1.05/(l+.05))>=((l+.05)/.05)?'#FFFFFF':'#000000';}
function hidden(node,value){if(!node)return;node.hidden=value;if(value)node.setAttribute('hidden','');else node.removeAttribute('hidden');}
function standardFavicon(kind){const stroke=kind==='dark'?'#EDF2FA':'#253340',background=kind==='dark'?'#131C2B':'#FFFFFF';return'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="'+background+'"/><path d="M10 5h13v23H10zM6 10h8M6 16h8M6 22h8" fill="none" stroke="'+stroke+'" stroke-width="2"/></svg>');}
/** Applies only explicitly marked brand elements; personal --accent/--on remain untouched. */
export function createInstanceBrand(config,{document=globalThis.document}={}){
  const value=validateInstanceConfig(config),failedFavicons=new Set();let last={};
  const apply=(options={})=>{
    last={...last,...options};if(!document?.documentElement)return;
    const root=document.documentElement,kind=(last.kind??root.dataset?.appearance??root.style?.colorScheme)==='dark'?'dark':'light';
    if(!document.querySelector('link[rel="manifest"]')){const manifest=document.createElement('link');manifest.setAttribute('rel','manifest');manifest.setAttribute('href','/manifest.webmanifest');document.head.append(manifest);}
    root.style.setProperty('--instance-brand-color',value.brandColor);root.style.setProperty('--instance-brand-on',foreground(value.brandColor));
    for(const node of document.querySelectorAll('[data-instance-name]'))node.textContent=value.applicationName;
    for(const node of document.querySelectorAll('[data-instance-label]'))node.setAttribute('aria-label',value.applicationName);
    for(const node of document.querySelectorAll('[data-instance-organization]')){node.textContent=value.organizationName??'';node.hidden=value.organizationName===null;}
    for(const node of document.querySelectorAll('[data-instance-brand-mark]'))node.style.color=value.brandColor;
    for(const node of document.querySelectorAll('[data-instance-primary]')){node.style.backgroundColor=value.brandColor;node.style.borderColor=value.brandColor;node.style.color=foreground(value.brandColor);}
    for(const image of document.querySelectorAll('[data-instance-logo]')){
      const fallback=image.parentElement?.querySelector('[data-instance-default-logo]'),path=value.logos[kind];image.alt=value.applicationName;image.style.objectFit='contain';
      const showFallback=()=>{image.hidden=true;hidden(fallback,false);};showFallback();
      if(!path||image.dataset.instanceFailed===path){image.removeAttribute('src');continue;}
      image.onload=()=>{if(image.getAttribute('src')===path){image.hidden=false;hidden(fallback,true);}};
      image.onerror=()=>{if(image.getAttribute('src')===path){image.dataset.instanceFailed=path;showFallback();image.removeAttribute('src');}};
      if(image.getAttribute('src')!==path){delete image.dataset.instanceFailed;image.setAttribute('src',path);}else if(image.complete&&image.naturalWidth>0)image.onload();
    }
    let favicon=document.querySelector('[data-instance-favicon]');if(!favicon){favicon=document.createElement('link');favicon.setAttribute('rel','icon');favicon.setAttribute('data-instance-favicon','');document.head.append(favicon);}
    const path=value.favicons[kind],fallback=standardFavicon(kind),href=path&&!failedFavicons.has(path)?path:fallback;
    favicon.onerror=()=>{if(path){failedFavicons.add(path);favicon.onerror=null;favicon.setAttribute('href',fallback);}};if(favicon.getAttribute('href')!==href)favicon.setAttribute('href',href);
    const suffix=last.titleSuffix??document.querySelector('title[data-instance-title]')?.getAttribute('data-instance-title');
    if(typeof suffix==='string'){const parts=last.pageTitle?[last.pageTitle,value.applicationName]:[value.applicationName];document.title=parts.join(' — ')+(suffix?' — '+suffix:'');}
  };
  return Object.freeze({config:clone(value),apply});
}
