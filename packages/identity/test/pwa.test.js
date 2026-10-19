import test from 'node:test';
import assert from 'node:assert/strict';
import {readPwaManifest,createPwaManifestApi} from '../src/pwa.js';
const origin='https://pwa.fixture.invalid';
test('install manifest reads only public branding, with a valid account chooser and sized PNG defaults',()=>{
  const env={YUMUNIO_BRAND_NAME:'架空ノート',YUMUNIO_BRAND_COLOR:'#123',YUMUNIO_DEFAULT_LOCALE:'en',YUMUNIO_BRAND_PWA_ICON_192:'/brand/app-192.png'};
  for(const key of ['YUMUNIO_AUTH_SECRET','YUMUNIO_BACKUP_ENCRYPTION_KEY','YUMUNIO_S3_SECRET_ACCESS_KEY'])Object.defineProperty(env,key,{get(){throw new Error('Private configuration was read.');}});
  const manifest=readPwaManifest(env);assert.equal(manifest.name,'架空ノート');assert.equal(manifest.theme_color,'#112233');assert.equal(manifest.lang,'en');assert.equal(manifest.start_url,'/account');assert.equal(manifest.icons[0].src,'/brand/app-192.png');assert.equal(manifest.icons[1].src,'/pwa/icon-512.png');assert.equal(manifest.scope,'/');
  for(const path of ['https://foreign.invalid/icon.png','/api/private.png','/brand/../private.png','/brand/icon.svg','/brand/icon.png?token=secret'])assert.equal(readPwaManifest({YUMUNIO_BRAND_PWA_ICON_512:path}).icons[1].src,'/pwa/icon-512.png');
});
test('manifest endpoint is public and read-only, rejects cross-origin/query requests and handles HEAD without a body',async()=>{
  const api=createPwaManifestApi({origin});
  const result=await api(new Request(origin+'/manifest.webmanifest'));assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/^application\/manifest\+json/);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(await(await api(new Request(origin+'/manifest.webmanifest',{method:'HEAD'}))).text(),'');
  for(const [path,options,status]of [['/manifest.webmanifest?private=1',{},400],['/manifest.webmanifest',{method:'POST'},405],['/manifest.webmanifest',{headers:{Origin:'https://foreign.invalid'}},403],['/manifest.webmanifest',{headers:{'Sec-Fetch-Site':'cross-site'}},403]])assert.equal((await api(new Request(origin+path,options))).status,status);
});
