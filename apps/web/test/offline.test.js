import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {OFFLINE_CACHE_PREFIX,offlineAssetPaths,cacheableOfflineRequest,RETIRED_OFFLINE_ASSET_PATHS,purgeRetiredOfflineAssets} from '../public/offline-policy.js';
const origin='https://offline.fixture.invalid';
const assets=offlineAssetPaths(['index.html','install.html','offline.html','workspace.html','account.html','site.html','app.js','styles.css','locales/ja.json','brand/private.png','api/private.json','health.json','sw.js','manifest.webmanifest','../secrets.json','_headers']);
test('offline whitelist contains only public programs, locales and local navigation shells',()=>{
  assert.deepEqual(assets,['/app.js','/install','/locales/ja.json','/notes','/offline','/styles.css']);
  const request=(path,options={})=>new Request(origin+path,options);
  assert.equal(cacheableOfflineRequest(request('/app.js'),origin,assets),true);
  for(const path of ['/app.js?account=1','/api/content','/api/auth/get-session','/health','/manifest.webmanifest','/workspace','/site','/brand/private.png'])assert.equal(cacheableOfflineRequest(request(path),origin,assets),false,path);
  assert.equal(cacheableOfflineRequest(request('/app.js',{headers:{Authorization:'Bearer synthetic'}}),origin,assets),false);
  assert.equal(cacheableOfflineRequest(request('/app.js',{headers:{'X-Yumunio-Expected-Account':'synthetic'}}),origin,assets),false);
  assert.equal(cacheableOfflineRequest(new Request('https://foreign.invalid/app.js'),origin,assets),false);
  assert.equal(cacheableOfflineRequest({url:origin+'/',method:'GET',mode:'navigate',headers:new Headers()},origin,assets),true);
  assert.equal(cacheableOfflineRequest({url:origin+'/notes#page/private-local-route',method:'GET',mode:'navigate',headers:new Headers()},origin,assets),true);
  assert.equal(cacheableOfflineRequest(request('/app.js#private'),origin,assets),false);
});
async function worker({failInstall=false,failPurge=false}={}){
  const handlers={},data=new Map(),requests=[];let failNetwork=false;
  const storage={async open(name){if(!data.has(name))data.set(name,new Map());const cache=data.get(name);return{async put(request,response){cache.set(typeof request==='string'?request:request.url,response.clone());},async match(key){return cache.get(typeof key==='string'?key:key.url)?.clone();},async delete(key){const url=typeof key==='string'?key:key.url;if(failPurge&&url===origin+'/ai.js')throw new Error('Synthetic deletion denied');return cache.delete(url);}};},async keys(){return [...data.keys()];},async delete(name){return data.delete(name);}};
  const fetcher=async request=>{requests.push({url:request.url,credentials:request.credentials});if(failNetwork||failInstall&&request.url.endsWith('app.js'))throw new Error('Synthetic offline');const response=new Response(request.url.endsWith('/offline')?'generic-offline':request.url.endsWith('/notes')?'local-editor':'public-static');Object.defineProperty(response,'type',{value:'basic'});return response;};
  const source=(await readFile(new URL('../public/sw.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'').replace('__YUMUNIO_OFFLINE_BUILD__','fixture').replace('__YUMUNIO_OFFLINE_ASSETS__',JSON.stringify(assets));
  runInNewContext(source,{self:{location:{origin},addEventListener:(name,handler)=>{handlers[name]=handler;}},caches:storage,fetch:fetcher,Request,Response,URL,OFFLINE_CACHE_PREFIX,cacheableOfflineRequest,purgeRetiredOfflineAssets});
  return{data,requests,storage,offline(){failNetwork=true;},async lifecycle(name){let task;handlers[name]({waitUntil(value){task=value;}});return task;},async route(path,{mode,method='GET',headers={}}={}){let task;handlers.fetch({request:{url:origin+path,mode,method,headers:new Headers(headers)},respondWith(value){task=value;}});return task?await task:null;}};
}
test('opt-in worker precaches without credentials, passes APIs through and uses a generic fallback for private navigation',async()=>{
  const fixture=await worker();await fixture.lifecycle('install');assert.equal(fixture.requests.length,assets.length);assert.equal(fixture.requests.every(item=>item.credentials==='omit'),true);
  fixture.offline();assert.equal(await(await fixture.route('/',{mode:'navigate'})).text(),'local-editor');assert.equal(await(await fixture.route('/app.js')).text(),'public-static');
  assert.equal(await(await fixture.route('/notes#page/page-spec',{mode:'navigate'})).text(),'local-editor');assert.equal(await(await fixture.route('/#page/page-spec',{mode:'navigate'})).text(),'local-editor');
  assert.equal(await(await fixture.route('/workspace?workspace=private&page=private',{mode:'navigate'})).text(),'generic-offline');
  for(const path of ['/api/auth/get-session','/api/content/private','/health','/manifest.webmanifest'])assert.equal(await fixture.route(path),null);
  assert.equal(await fixture.route('/app.js?token=private'),null);assert.equal(await fixture.route('/app.js',{method:'POST'}),null);
  const cached=[...fixture.data.values()].flatMap(map=>[...map.keys()]);assert.equal(cached.some(url=>url.includes('/api/')||url.includes('?')||url.includes('workspace.html')),false);
});
test('failed installation removes partial static cache and activation deletes only this app’s old static versions',async()=>{
  const failed=await worker({failInstall:true});await assert.rejects(failed.lifecycle('install'));assert.equal(failed.data.size,0);
  const fixture=await worker();await fixture.lifecycle('install');await fixture.storage.open(OFFLINE_CACHE_PREFIX+'old');await fixture.storage.open('unrelated-cache');await fixture.lifecycle('activate');assert.deepEqual([...fixture.data.keys()].sort(),['unrelated-cache',OFFLINE_CACHE_PREFIX+'fixture'].sort());
});
test('install catalogs have matching keys and placeholders',async()=>{const {validateCatalogParity}=await import('../public/i18n.js');const catalogs=await Promise.all(['ja','en'].map(async locale=>JSON.parse(await readFile(new URL('../public/install-locales/'+locale+'.json',import.meta.url),'utf8'))));assert.equal(validateCatalogParity(...catalogs).valid,true);});

test('retired static paths are excluded even from a stale asset whitelist',()=>{
 assert.deepEqual(RETIRED_OFFLINE_ASSET_PATHS,['/ai.js','/ai-model.js','/ai.css','/ai-locales/ja.json','/ai-locales/en.json']);
 const stale=[...RETIRED_OFFLINE_ASSET_PATHS,'/app.js'];assert.deepEqual(offlineAssetPaths(stale.map(path=>path.slice(1))),['/app.js']);
 for(const path of RETIRED_OFFLINE_ASSET_PATHS)assert.equal(cacheableOfflineRequest(new Request(origin+path),origin,stale),false);
 assert.equal(cacheableOfflineRequest(new Request(origin+'/app.js'),origin,stale),true);
});
test('install purges only five exact same-origin retired URLs from owned static caches before activation',async()=>{
 const fixture=await worker(),owned=await fixture.storage.open(OFFLINE_CACHE_PREFIX+'old'),account=await fixture.storage.open('yumunio-account-private'),foreign=await fixture.storage.open('other-static-v1');
 for(const path of RETIRED_OFFLINE_ASSET_PATHS){await owned.put(new Request(origin+path),new Response('retired'));await account.put(new Request(origin+path),new Response('private-account-cache'));await foreign.put(new Request(origin+path),new Response('other-app'));}
 const retained=[origin+'/index.html',origin+'/app.js',origin+'/api/content/private',origin+'/workspace',origin+'/ai.js?review=1','https://another-origin.invalid/ai.js',origin+'/ai-locales/fr.json',origin+'/ai-extra.js'];for(const url of retained)await owned.put(new Request(url),new Response('retained'));
 await fixture.lifecycle('install');assert.ok(fixture.data.has(OFFLINE_CACHE_PREFIX+'old'),'old cache remains before activate');assert.ok(fixture.data.has('yumunio-account-private'));assert.ok(fixture.data.has('other-static-v1'));
 for(const path of RETIRED_OFFLINE_ASSET_PATHS){assert.equal(await owned.match(origin+path),undefined);assert.equal(await(await account.match(origin+path)).text(),'private-account-cache');assert.equal(await(await foreign.match(origin+path)).text(),'other-app');}
 for(const url of retained)assert.equal(await(await owned.match(url)).text(),'retained');assert.equal(await purgeRetiredOfflineAssets(fixture.storage,origin),0,'migration is idempotent');
});
test('retired migration validates origin before touching caches and refuses a failed deletion without activating',async()=>{
 let calls=0;await assert.rejects(purgeRetiredOfflineAssets({async keys(){calls++;return[];}},origin+'/private'),/INVALID_OFFLINE_ORIGIN/);assert.equal(calls,0);
 const fixture=await worker({failPurge:true}),owned=await fixture.storage.open(OFFLINE_CACHE_PREFIX+'old');await owned.put(new Request(origin+'/ai.js'),new Response('retired'));await owned.put(new Request(origin+'/index.html'),new Response('retained'));await assert.rejects(fixture.lifecycle('install'),/Synthetic deletion denied/);assert.equal(fixture.requests.length,0);assert.equal(await(await owned.match(origin+'/index.html')).text(),'retained');assert.ok(fixture.data.has(OFFLINE_CACHE_PREFIX+'old'));
});
