import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialWorkspaceReads,startInitialWorkspaceReads,claimInitialWorkspaceReads} from '../public/initial-workspace-reads.js';

const href='https://workspace.example/workspace?workspace=studio&page=project&view=tasks';
const bootstrap='/api/content/workspaces/studio/bootstrap?page=project&view=tasks';
test('independent startup and editor bundles hand off one snapshot only inside the current window',async t=>{
 const previousWindow=globalThis.window,previousFetch=globalThis.fetch;globalThis.window={};let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};t.after(()=>{globalThis.window=previousWindow;globalThis.fetch=previousFetch;});
 const prepared=startInitialWorkspaceReads(href);await Promise.resolve();const editor=await import('../public/initial-workspace-reads.js?independent-editor');
 const lifetime=new AbortController(),claimed=editor.claimInitialWorkspaceReads(href,lifetime.signal);assert.equal(claimed,prepared);assert.equal(claimed.wasPrepared,true);assert.equal(calls,1);assert.equal(startInitialWorkspaceReads(href),null);
 globalThis.window={};const other=editor.claimInitialWorkspaceReads(href);await Promise.resolve();assert.equal(other.wasPrepared,false);assert.equal(calls,2);other.destroy();lifetime.abort();
});
test('a late preload script never starts duplicate reads after the editor has already mounted',async t=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};t.after(()=>{globalThis.fetch=previous;});
 const lifetime=new AbortController(),reads=claimInitialWorkspaceReads(href,lifetime.signal);await Promise.resolve();assert.equal(calls,1);assert.equal(startInitialWorkspaceReads(href),null);await Promise.resolve();assert.equal(calls,1);lifetime.abort();
 const next=claimInitialWorkspaceReads(href);await Promise.resolve();assert.equal(calls,2);next.destroy();assert.equal(reads.matches(href),false);
});
test('one initial snapshot starts before hydration and is consumed exactly once',async t=>{
 const calls=[],reads=createInitialWorkspaceReads(href,{fetcher:async(path,options)=>{calls.push({path,options});return Response.json({path});}});t.after(()=>reads.destroy());
 await Promise.resolve();assert.equal(calls.length,1);
 assert.deepEqual((await(await reads.take(bootstrap)).json()),{path:bootstrap});assert.equal(reads.take(bootstrap),null);
 for(const {options}of calls){assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);}
 assert.equal(reads.matches(href+'#heading'),true);assert.equal(reads.matches(href.replace('project','another-page')),false);assert.equal(reads.matches(href.replace('workspace.example','foreign.example')),false);
});

test('a cancelled navigation aborts its initial read and leaves no reusable private response',async()=>{
 const calls=[],reads=createInitialWorkspaceReads(href,{fetcher:(path,{signal})=>new Promise((resolve,reject)=>{calls.push({path,signal});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 await Promise.resolve();const request=reads.take(bootstrap);reads.destroy();await assert.rejects(request,error=>error.name==='AbortError');
 assert.ok(calls.every(({signal})=>signal.aborted));assert.equal(reads.take('/api/instance'),null);assert.equal(reads.matches(href),false);
});

test('early reads are confined to valid workspace routes and keep their deadline after being claimed',async()=>{
 for(const url of ['https://workspace.example/account','https://workspace.example/workspace?workspace=../private','file:///workspace?workspace=studio'])assert.equal(createInitialWorkspaceReads(url,{fetcher:()=>assert.fail('Unexpected API read')}),null);
 const reads=createInitialWorkspaceReads(href,{timeoutMs:10,fetcher:(_path,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 const requests=[reads.take(bootstrap)];
 const keepAlive=setTimeout(()=>{},100);try{const results=await Promise.allSettled(requests);assert.ok(results.every(result=>result.status==='rejected'));}finally{clearTimeout(keepAlive);reads.destroy();}
});
