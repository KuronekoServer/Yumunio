import test from 'node:test';
import assert from 'node:assert/strict';
import {bundleBrowserControllers} from '../browser-bundles.mjs';
test('controllers share bundled code and leave optional features behind a dynamic boundary',async()=>{
 const sources=new Map([['one.js',"import {shared} from './common.js';export const run=()=>shared();export const optional=()=>import('./optional.js');"],['two.js',"import {shared} from './common.js';export const run=()=>shared();"],['common.js',"export const shared=()=> 'common fixture';"],['optional.js',"export const math=()=> 'optional fixture';"]]);
 const result=await bundleBrowserControllers(sources,['one.js','two.js']);assert.ok(result.has('one.js')&&result.has('two.js'));const text=Buffer.from(result.get('one.js')).toString();assert.match(text,/import\(/);assert.doesNotMatch(text,/optional fixture/);assert.ok([...result.keys()].some(name=>/^_assets\/[A-Za-z0-9_-]+\.js$/.test(name)));for(const name of result.keys())assert.ok(!name.startsWith('/')&&!name.includes('..'));
});
test('unknown dependencies fail instead of silently introducing external code',async()=>{await assert.rejects(bundleBrowserControllers(new Map([['one.js',"import 'https://example.invalid/external.js';"]]),['one.js']),/Unknown browser module/);});

test('the startup controller is self-contained while the editor keeps normal shared modules',async()=>{
 const sources=new Map([['workspace-preload.js',"import {read} from './read.js';read();"],['workspace.js',"import {read} from './read.js';export const run=read;"],['read.js',"export const read=()=>console.log('synthetic startup read');"]]);
 const result=await bundleBrowserControllers(sources,['workspace.js','workspace-preload.js']),startup=Buffer.from(result.get('workspace-preload.js')).toString();
 assert.match(startup,/synthetic startup read/);assert.doesNotMatch(startup,/\bimport\b|\bexport\b/);assert.ok(result.has('workspace.js'));
});
