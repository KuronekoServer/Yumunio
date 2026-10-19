import {workerPagePaths} from '../../../packages/prototype/src/web-routes.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from '../../../packages/tooling/test/fixtures/worker.mjs';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync,crc32} from 'node:zlib';
import {createPwaIcon} from '../../../packages/tooling/pwa-icons.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const origin='https://pwa.fixture.invalid',prefix='yumunio-worker-pwa-runtime-';
const secrets={YUMUNIO_AUTH_SECRET:'synthetic-pwa-private-auth-secret-2026',YUMUNIO_ACCESS_KEY:'synthetic-pwa-private-access-key-2026',YUMUNIO_SMTP_PASSWORD:'synthetic-pwa-private-smtp-password',YUMUNIO_S3_SECRET_ACCESS_KEY:'synthetic-pwa-private-blob-secret',YUMUNIO_DATABASE_URL:'mysql://synthetic:private@database.fixture.invalid/yumunio'};

// Parse and inflate independently of the PNG writer to verify actual HTTP bytes and dimensions.
function verifyPng(input,size){
  const bytes=Buffer.from(input);assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  let offset=8,ended=false,header=false;const data=[];
  while(offset<bytes.length){
    assert.ok(offset+12<=bytes.length);const length=bytes.readUInt32BE(offset),end=offset+8+length;
    assert.ok(end+4<=bytes.length);const type=bytes.toString('ascii',offset+4,offset+8),body=bytes.subarray(offset+8,end);
    assert.equal(bytes.readUInt32BE(end),crc32(bytes.subarray(offset+4,end)));
    if(type==='IHDR'){assert.equal(header,false);header=true;assert.equal(length,13);assert.equal(body.readUInt32BE(0),size);assert.equal(body.readUInt32BE(4),size);assert.deepEqual([...body.subarray(8)],[8,6,0,0,0]);}
    else if(type==='IDAT')data.push(body);
    else if(type==='IEND'){assert.equal(length,0);ended=true;assert.equal(end+4,bytes.length);}
    else assert.fail('Unexpected PNG chunk.');
    offset=end+4;
  }
  assert.ok(header&&ended&&data.length);const pixels=inflateSync(Buffer.concat(data));assert.equal(pixels.length,(size*4+1)*size);
  for(let row=0;row<size;row++)assert.equal(pixels[row*(size*4+1)],0);
}

test('actual local workerd serves a public read-only branded manifest and valid default/custom PNG assets',{timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),prefix)),assets=join(directory,'assets'),bundle=join(directory,'worker.mjs');let worker;
  t.after(async()=>{await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await mkdir(join(assets,'pwa'),{recursive:true});await mkdir(join(assets,'brand','profile'),{recursive:true});
  await writeFile(join(assets,'index.html'),'<!doctype html><title>Synthetic PWA fixture</title>');
  const icons=new Map([192,512].map(size=>[size,createPwaIcon(size)]));
  for(const[size,bytes]of icons)await writeFile(join(assets,'pwa','icon-'+size+'.png'),bytes);
  await writeFile(join(assets,'brand','profile','app-192.png'),icons.get(192));
  await build({entryPoints:[join(root,'apps/worker/worker.js')],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent'});
  const start=bindings=>new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},assets:{directory:assets,binding:'ASSETS',routerConfig:{has_user_worker:true},run_worker_first:['/api','/api/*','/health','/manifest.webmanifest']},bindings:{YUMUNIO_PUBLIC_ORIGIN:origin,...secrets,...bindings}}));
  const request=(path,options={})=>worker.dispatchFetch(origin+path,{redirect:'manual',...options});
  async function manifest(options={}){const response=await request('/manifest.webmanifest',options);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type').split(';')[0],'application/manifest+json');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');assert.deepEqual(response.headers.getSetCookie(),[]);return response.json();}
  worker=start({});await worker.ready;
  const defaults=await manifest();assert.equal(defaults.name,'Yumunio');assert.equal(defaults.start_url,'/account');assert.equal(defaults.scope,'/');assert.equal(defaults.id,'/');assert.equal(defaults.display,'standalone');assert.deepEqual(defaults.icons.map(icon=>icon.src),['/pwa/icon-192.png','/pwa/icon-512.png']);
  assert.deepEqual(Object.keys(defaults).sort(),['id','name','short_name','lang','start_url','scope','display','background_color','theme_color','icons'].sort());
  await manifest({headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}});
  const head=await request('/manifest.webmanifest',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('cache-control'),'no-store');assert.equal(await head.text(),'');
  for(const[path,options,status]of [['/manifest.webmanifest?private=1',{},400],['/manifest.webmanifest',{method:'POST'},405],['/manifest.webmanifest',{method:'PUT'},405],['/manifest.webmanifest',{headers:{Origin:'https://foreign.fixture.invalid'}},403],['/manifest.webmanifest',{headers:{'Sec-Fetch-Site':'cross-site'}},403]]){
    const response=await request(path,options);assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{error:{code:'MANIFEST_UNAVAILABLE'}});if(status===405)assert.equal(response.headers.get('allow'),'GET, HEAD');
  }
  const foreign=await worker.dispatchFetch('https://foreign.fixture.invalid/manifest.webmanifest');assert.equal(foreign.status,403);
  for(const[size,expected]of icons){
    const path='/pwa/icon-'+size+'.png',response=await request(path);assert.equal(response.status,200);assert.equal(response.headers.get('content-type').split(';')[0],'image/png');const bytes=new Uint8Array(await response.arrayBuffer());assert.deepEqual(Buffer.from(bytes),expected);verifyPng(bytes,size);
    const head=await request(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  }
  for(const secret of Object.values(secrets))assert.equal(JSON.stringify(defaults).includes(secret),false);
  await worker.dispose();worker=undefined;
  worker=start({YUMUNIO_BRAND_NAME:'架空の共有ノート',YUMUNIO_BRAND_COLOR:'#123',YUMUNIO_DEFAULT_LOCALE:'en',YUMUNIO_BRAND_PWA_ICON_192:'/brand/profile/app-192.png',YUMUNIO_BRAND_PWA_ICON_512:'/api/private.png'});await worker.ready;
  const branded=await manifest();assert.equal(branded.name,'架空の共有ノート');assert.equal(branded.short_name,'架空の共有ノート');assert.equal(branded.theme_color,'#112233');assert.equal(branded.lang,'en');assert.equal(branded.icons[0].src,'/brand/profile/app-192.png');assert.equal(branded.icons[1].src,'/pwa/icon-512.png');
  const custom=await request(branded.icons[0].src);assert.equal(custom.status,200);assert.equal(custom.headers.get('content-type').split(';')[0],'image/png');verifyPng(await custom.arrayBuffer(),192);
  for(const secret of [...Object.values(secrets),'database.fixture.invalid','/api/private.png'])assert.equal(JSON.stringify(branded).includes(secret),false);
});

test('actual workerd Cache API removes only retired same-origin static entries while retaining other cache content',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),prefix)),bundle=join(directory,'retired-cache-worker.mjs');let worker;
 t.after(async()=>{await worker?.dispose();const absolute=resolve(directory),rel=relative(resolve(tmpdir()),absolute);assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 // workerd exposes Cache.match/put/delete but not browser CacheStorage.keys; enumerate only fixture-owned names here.
 const entry=`import {OFFLINE_CACHE_PREFIX,RETIRED_OFFLINE_ASSET_PATHS,purgeRetiredOfflineAssets} from './apps/web/public/offline-policy.js';
 export default {async fetch(request){
  const origin=new URL(request.url).origin,names=[OFFLINE_CACHE_PREFIX+'previous',OFFLINE_CACHE_PREFIX+'current','yumunio-account-private-fixture','another-app-cache'];
  const retained=['/index.html','/app.js','/api/content/private','/workspace','/ai.js?keep=1','/ai-locales/fr.json','/ai-extra.js'];
  const payload=()=>new Response('synthetic-cache-entry',{headers:{'Cache-Control':'public, max-age=3600'}});
  for(const name of names){const cache=await caches.open(name);for(const path of [...RETIRED_OFFLINE_ASSET_PATHS,...retained])await cache.put(new Request(origin+path),payload());await cache.put(new Request('https://foreign-cache.fixture.invalid/ai.js'),payload());}
  const storage={async keys(){return names;},open:name=>caches.open(name)},removed=await purgeRetiredOfflineAssets(storage,origin),second=await purgeRetiredOfflineAssets(storage,origin);let preserved=0,retiredRemaining=0;
  for(const name of names){const cache=await caches.open(name),owned=name.startsWith(OFFLINE_CACHE_PREFIX);for(const path of RETIRED_OFFLINE_ASSET_PATHS){const found=!!await cache.match(origin+path);if(owned&&found)retiredRemaining++;if(!owned&&found)preserved++;}for(const path of retained)if(await cache.match(origin+path))preserved++;if(await cache.match('https://foreign-cache.fixture.invalid/ai.js'))preserved++;}
  return Response.json({removed,second,preserved,retiredRemaining});
 }};`;
 await build({stdin:{contents:entry,resolveDir:root,sourcefile:'retired-pwa-cache-fixture.js'},outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 worker=new Miniflare(workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',telemetry:{enabled:false},cachePersist:join(directory,'cache')}));await worker.ready;
 const response=await worker.dispatchFetch(origin+'/retired-cache-fixture');assert.equal(response.status,200);assert.deepEqual(await response.json(),{removed:10,second:0,preserved:42,retiredRemaining:0});
});
