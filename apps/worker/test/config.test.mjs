import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {readFile} from 'node:fs/promises';
test('all shipped Worker configurations preserve explicit HTML URLs and route the root through the Worker',async()=>{
  for(const file of ['wrangler.jsonc','wrangler.d1.jsonc.example','wrangler.r2.jsonc.example','wrangler.accounts-r2.jsonc.example']){
    const config=JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8'));
    assert.equal(config.assets.html_handling,'none',file);
    for(const path of ['/','/api','/api/*','/health'])assert.ok(config.assets.run_worker_first.includes(path),file+' '+path);
  }
});
test('D1 requires an explicit origin and health follows the same key limits as the API', async () => {
  const key = 'fixture-'.repeat(8), url = 'https://workspace.example';
  for (const extra of [{ YUMUNIO_ACCESS_KEY: key }, { YUMUNIO_PUBLIC_ORIGIN: url, YUMUNIO_ACCESS_KEY: 'a'.repeat(4097) }, { YUMUNIO_PUBLIC_ORIGIN: url + '/', YUMUNIO_ACCESS_KEY: key }]) {
    const env = { DB: {}, ...extra };
    assert.equal((await worker.fetch(new Request(url + '/health'), env)).status, 503);
    const result = await worker.fetch(new Request(url + '/api/capabilities'), env);
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'SERVER_CONFIGURATION');
  }
  // A readable binding with no recovery table is a ready, backup-disabled legacy install.
  const DB={prepare(){return{bind(){return{async all(){return{success:true,results:[],meta:{}};}};}};},async batch(){return[];}};
  const env = { DB, YUMUNIO_PUBLIC_ORIGIN: url, YUMUNIO_ACCESS_KEY: key };
  assert.equal((await worker.fetch(new Request(url + '/health'), env)).status, 200);
  const head = await worker.fetch(new Request(url + '/health', { method: 'HEAD' }), env);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const post = await worker.fetch(new Request(url + '/health', { method: 'POST' }), env);
  assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD');
});
