import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {createAppServer} from '../server.mjs';
import {createPwaIcon} from '../../../packages/tooling/pwa-icons.mjs';
test('Node HTTP serves a public branded install manifest and real sized PNGs without requiring or exposing account data',async t=>{
  const parent=resolve('.build/test-fixtures');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'pwa-http-'));await mkdir(join(root,'pwa'));
  for(const size of [192,512])await writeFile(join(root,'pwa','icon-'+size+'.png'),createPwaIcon(size));
  const env={YUMUNIO_BRAND_NAME:'Synthetic install fixture'};Object.defineProperty(env,'YUMUNIO_AUTH_SECRET',{get(){throw new Error('No private settings.');}});
  const server=createAppServer({root,instanceEnvironment:env});
  t.after(async()=>{if(server.listening)await new Promise(done=>server.close(done));if(dirname(root)!==parent||!basename(root).startsWith('pwa-http-'))throw new Error('Invalid fixture cleanup.');await rm(root,{recursive:true,force:true});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const response=await fetch(origin+'/manifest.webmanifest');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^application\/manifest\+json/);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/default-src 'self'/);
  const manifest=await response.json();assert.equal(manifest.name,'Synthetic install fixture');assert.equal(manifest.start_url,'/account.html');
  for(const icon of manifest.icons){const result=await fetch(origin+icon.src);assert.equal(result.headers.get('content-type'),'image/png');const bytes=Buffer.from(await result.arrayBuffer()),size=Number(icon.sizes.split('x')[0]);assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
  assert.equal(await(await fetch(origin+'/manifest.webmanifest',{method:'HEAD'})).text(),'');assert.equal((await fetch(origin+'/manifest.webmanifest',{method:'POST'})).status,405);
  assert.equal((await fetch(origin+'/manifest.webmanifest?token=synthetic')).status,400);
});
