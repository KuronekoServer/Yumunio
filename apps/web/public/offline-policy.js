import {webPageRoute} from './web-routes.js';
export const OFFLINE_CACHE_PREFIX='yumunio-static-v1-';
// Retired static-file migration only; no AI runtime or user content is retained.
export const RETIRED_OFFLINE_ASSET_PATHS=Object.freeze(['/ai.js','/ai-model.js','/ai.css','/ai-locales/ja.json','/ai-locales/en.json']);
export async function purgeRetiredOfflineAssets(storage,origin){
  const url=new URL(origin);
  if(url.origin!==origin||!['http:','https:'].includes(url.protocol))throw new TypeError('INVALID_OFFLINE_ORIGIN');
  let removed=0;
  for(const name of await storage.keys()){
    if(typeof name!=='string'||!name.startsWith(OFFLINE_CACHE_PREFIX))continue;
    const cache=await storage.open(name);
    for(const path of RETIRED_OFFLINE_ASSET_PATHS)if(await cache.delete(new Request(new URL(path,origin),{credentials:'omit'})))removed++;
  }
  return removed;
}
const localPages=new Set(['/index.html','/notes.html','/offline.html','/install.html']);
export function offlineAssetPaths(files){
  if(!Array.isArray(files))throw new TypeError('INVALID_OFFLINE_ASSETS');
  return [...new Set(files.filter(name=>typeof name==='string'&&/^[A-Za-z0-9_/-]+(?:[.][A-Za-z0-9_-]+)+$/.test(name)&&!name.includes('..')&&!RETIRED_OFFLINE_ASSET_PATHS.includes('/'+name)&&name!=='sw.js'&&name!=='manifest.webmanifest'&&!/^(?:brand|api|health)(?:[./]|$)/.test(name)&&(localPages.has('/'+name)||/\.(?:js|css|json|svg|png|ico|txt)$/.test(name))).map(name=>webPageRoute('/'+name)?.redirectPath??'/'+name))].sort();
}
export function cacheableOfflineRequest(request,origin,assets){
  try{const url=new URL(request.url),localNavigation=request.mode==='navigate'&&['/','/notes'].includes(url.pathname),path=url.pathname==='/'&&localNavigation?'/notes':url.pathname;return request.method==='GET'&&url.origin===origin&&!url.search&&(!url.hash||localNavigation)&&!request.headers.has('authorization')&&!request.headers.has('x-yumunio-expected-account')&&assets.includes(path)&&!RETIRED_OFFLINE_ASSET_PATHS.includes(path)&&!/^\/(?:api(?:\/|$)|health$|manifest\.webmanifest$)/.test(url.pathname);}catch{return false;}
}
