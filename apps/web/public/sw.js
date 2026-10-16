import {OFFLINE_CACHE_PREFIX,cacheableOfflineRequest,purgeRetiredOfflineAssets} from './offline-policy.js';
const BUILD='__YUMUNIO_OFFLINE_BUILD__';
const ASSETS=__YUMUNIO_OFFLINE_ASSETS__;
const CACHE=OFFLINE_CACHE_PREFIX+BUILD;
self.addEventListener('install',event=>event.waitUntil((async()=>{
  await purgeRetiredOfflineAssets(caches,self.location.origin);
  const cache=await caches.open(CACHE);
  try{for(const path of ASSETS){const request=new Request(new URL(path,self.location.origin),{credentials:'omit',cache:'reload',redirect:'error'}),response=await fetch(request);if(!response.ok||response.type!=='basic'||response.redirected)throw new Error('STATIC_CACHE_UNAVAILABLE');await cache.put(request,response);}}
  catch(error){await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith(OFFLINE_CACHE_PREFIX)&&name!==CACHE)await caches.delete(name);
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||/^\/(?:api(?:\/|$)|health$|manifest\.webmanifest$)/.test(url.pathname))return;
  if(cacheableOfflineRequest(request,self.location.origin,ASSETS)){
    event.respondWith((async()=>{try{return await fetch(request);}catch{const cache=await caches.open(CACHE);return await cache.match(new URL(url.pathname==='/'?'/index.html':url.pathname,self.location.origin).href)??Response.error();}})());
  }else if(request.mode==='navigate'){
    event.respondWith((async()=>{try{return await fetch(request);}catch{return await(await caches.open(CACHE)).match(new URL('/offline.html',self.location.origin).href)??Response.error();}})());
  }
});
