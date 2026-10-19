import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Miniflare} from 'miniflare';
import {workerFixtureOptions} from './fixtures/worker.mjs';

test('a temporary bundled worker starts outside the checkout without a parent traversal module name', {timeout:30000},async t=>{
 const parent=resolve(tmpdir()),directory=await mkdtemp(join(parent,'yumunio-fixture-root-')),bundle=join(directory,'worker.mjs');let worker;
 t.after(async()=>{await worker?.dispose();assert.equal(dirname(resolve(directory)),parent);assert.ok(directory.startsWith(join(parent,'yumunio-fixture-root-')));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 await writeFile(bundle,'export default {fetch(){return new Response("portable-fixture");}};');
 const options=workerFixtureOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',telemetry:{enabled:false}});
 assert.equal(options.workers[0].config.manifest.mainModule,'worker.mjs');
 worker=new Miniflare(options);await worker.ready;const response=await worker.dispatchFetch('https://fixture.example.invalid');assert.equal(response.status,200);assert.equal(await response.text(),'portable-fixture');
});
