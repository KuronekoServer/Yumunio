import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

test('worker reports prototype boundaries and forwards asset requests', async () => {
  const calls = [];
  const env = { ASSETS: { fetch: request => { calls.push(request.url); return new Response('asset'); } } };
  const status = await worker.fetch(new Request('https://example.test/health'), env);
  assert.equal((await status.json()).storage, 'browser-local');
  const api = await worker.fetch(new Request('https://example.test/api/pages'), env);
  assert.equal(api.status, 501);
  assert.equal(calls.length, 0);
  const asset = await worker.fetch(new Request('https://example.test/app.js'), env);
  assert.equal(await asset.text(), 'asset');
  assert.deepEqual(calls, ['https://example.test/app.js']);
});

test('only the root is rewritten to index.html, preserving query, method and request headers',async()=>{
  const calls=[],env={ASSETS:{fetch(request){calls.push(request);return new Response(null,{status:200});}}};
  const root=new Request('https://example.test/?source=fixture',{method:'HEAD',headers:{Cookie:'synthetic=value','X-Fixture':'retained'}});
  const response=await worker.fetch(root,env);assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
  assert.equal(calls[0].url,'https://example.test/index.html?source=fixture');assert.equal(calls[0].method,'HEAD');assert.equal(calls[0].headers.get('cookie'),'synthetic=value');assert.equal(calls[0].headers.get('x-fixture'),'retained');
  for(const path of ['/workspace.html','/index.html','/app.js']){const request=new Request('https://example.test'+path);await worker.fetch(request,env);assert.equal(calls.at(-1),request);}
  const count=calls.length;await worker.fetch(new Request('https://example.test/health'),env);await worker.fetch(new Request('https://example.test/api/capabilities'),env);assert.equal(calls.length,count);
});
