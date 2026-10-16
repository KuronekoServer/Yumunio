import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDirectory,workspaceCreationInput} from '../public/workspace-directory.js';

const actor={user:{id:'account-a',name:'Aoi',emailVerified:true}},entry={id:'studio',name:'Studio',slug:'studio'};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const errorCode=code=>failure=>failure?.code===code;
function queued(responses){const calls=[];return{calls,fetcher:async(path,options)=>{calls.push({path,options});if(!responses.length)throw new Error('unexpected request');const item=responses.shift();return typeof item==='function'?item(path,options):Response.json(await item);}};}

test('the default browser fetch is invoked without assigning the directory as its receiver for reads and creation',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'fetch'),calls=[];
 Object.defineProperty(globalThis,'fetch',{configurable:true,value:async function(path,options){assert.equal(this,undefined,'Window.fetch must not receive a WorkspaceDirectory as its receiver');calls.push({path,method:options.method});if(path.endsWith('/get-session'))return Response.json(actor);if(path.endsWith('/organization/list'))return Response.json([entry]);return Response.json({id:'created',...JSON.parse(options.body)});}});
 t.after(()=>Object.defineProperty(globalThis,'fetch',previous));const client=new WorkspaceDirectory({accountId:'account-a'});
 assert.deepEqual((await client.load()).workspaces,[entry]);assert.equal((await client.create({name:'New',slug:'new'})).id,'created');assert.equal(calls.filter(item=>item.method==='POST').length,1);client.destroy();
});

test('directory checks the captured verified account around the private list and returns only literal directory fields',async()=>{
 const f=queued([actor,[{...entry,logo:'private://logo',metadata:{token:'not projected'}},{id:'legacy',name:'Legacy',slug:'Old_Slug'}],actor]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});
 const value=await client.load();assert.deepEqual(value,{user:{id:'account-a',name:'Aoi'},workspaces:[entry,{id:'legacy',name:'Legacy',slug:'Old_Slug'}]});
 assert.deepEqual(f.calls.map(call=>call.path),['/api/auth/get-session','/api/auth/organization/list','/api/auth/get-session']);
 for(const{options}of f.calls){assert.equal(options.credentials,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Yumunio-Expected-Account'],'account-a');assert.equal(options.method,'GET');assert.ok(options.signal instanceof AbortSignal);}
 assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.workspaces)&&Object.isFrozen(value.workspaces[0]));client.destroy();
});
test('missing, changed and unverified accounts cannot start private workspace reads',async()=>{
 for(const session of [null,{user:{...actor.user,id:'account-b'}},{user:{...actor.user,emailVerified:false}}]){const f=queued([session]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.load(),errorCode('ACCOUNT_CHANGED'));assert.equal(f.calls.length,1);client.destroy();}
});
test('duplicate and malformed directory records fail without returning an incomplete list',async()=>{
 for(const rows of [[entry,entry],[entry,{...entry,id:'other'}],[{...entry,id:'../bad'}],[{...entry,name:'bad\u0000name'}],[{...entry,slug:''}],{},Array(1001).fill(entry)]){const f=queued([actor,rows]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.load(),errorCode('INVALID_RESPONSE'));assert.equal(f.calls.length,2);client.destroy();}
});
test('account drift after reading a directory discards it and permanently prevents further private requests',async()=>{
 const f=queued([actor,[entry],{user:{...actor.user,id:'account-b'}}]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.load(),errorCode('ACCOUNT_CHANGED'));await assert.rejects(client.load(),errorCode('ACCOUNT_CHANGED'));assert.equal(f.calls.length,3);client.destroy();
});
test('a delayed old list cannot replace a newer directory result',async()=>{
 const pending=deferred(),f=queued([actor,()=>pending.promise,actor,[entry],actor]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});
 const first=client.load(),firstResult=assert.rejects(first,errorCode('STALE_OPERATION'));await new Promise(setImmediate);assert.equal(f.calls.length,2);
 const current=await client.load();assert.deepEqual(current.workspaces,[entry]);pending.resolve(Response.json([{id:'old',name:'Old',slug:'old'}]));await firstResult;assert.equal(f.calls.length,5);client.destroy();
});
test('creation sends only trimmed name and slug and verifies the account after its exact acknowledgement',async()=>{
 const f=queued([actor,{id:'created',name:'My space',slug:'my-space',members:[{role:'owner',userId:'account-a'}]},actor]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});
 assert.deepEqual(await client.create({name:' My space ',slug:' my-space '}),{id:'created',name:'My space',slug:'my-space'});
 const post=f.calls[1];assert.equal(post.path,'/api/auth/organization/create');assert.equal(post.options.method,'POST');assert.equal(post.options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(post.options.body),{name:'My space',slug:'my-space'});assert.equal(client.busy,false);assert.equal(client.creationUncertain,false);client.destroy();
});
test('invalid creation fields and artificial workspace types are rejected before any request',async()=>{
 assert.deepEqual(workspaceCreationInput({name:' Space ',slug:' space '}),{name:'Space',slug:'space'});
 const f=queued([]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});
 for(const value of [{name:' ',slug:'space'},{name:'x'.repeat(101),slug:'space'},{name:'Space',slug:'../space'},{name:'Space',slug:'MixedCase'},{name:'Space',slug:'space',type:'personal'},{name:'Space',slug:'space',userId:'account-b'}])await assert.rejects(client.create(value));
 assert.equal(f.calls.length,0);client.destroy();
});
test('an in-flight creation rejects duplicate creates and list loads before their first asynchronous step',async()=>{
 const pending=deferred(),f=queued([()=>pending.promise,{id:'new',name:'New',slug:'new'},actor]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});
 const result=client.create({name:'New',slug:'new'});assert.equal(client.busy,true);await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('BUSY'));await assert.rejects(client.load(),errorCode('BUSY'));assert.equal(f.calls.length,1);
 pending.resolve(Response.json(actor));assert.equal((await result).id,'new');assert.equal(f.calls.length,3);client.destroy();
});
test('account drift before creation prevents the POST entirely',async()=>{
 const f=queued([{user:{...actor.user,id:'account-b'}}]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('ACCOUNT_CHANGED'));assert.equal(f.calls.length,1);assert.equal(client.creationUncertain,false);client.destroy();
});
test('the server expected-account guard clears its old actor scope after refusing a raced list or creation',async()=>{
 for(const operation of ['list','create']){const f=queued([actor,()=>Response.json({error:{code:'ACCOUNT_CHANGED'}},{status:409})]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(operation==='list'?client.load():client.create({name:'New',slug:'new'}),errorCode('ACCOUNT_CHANGED'));assert.equal(client.creationUncertain,false);const count=f.calls.length;await assert.rejects(client.load(),errorCode('ACCOUNT_CHANGED'));await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('ACCOUNT_CHANGED'));assert.equal(f.calls.length,count);client.destroy();}
});
test('account drift after POST or a mismatched acknowledgement cannot expose a created workspace or be automatically retried',async()=>{
 for(const responses of [[actor,{id:'new',name:'New',slug:'new'},{user:{...actor.user,id:'account-b'}}],[actor,{id:'wrong',name:'Other',slug:'other'}]]){const f=queued(responses),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('CREATE_UNCONFIRMED'));const count=f.calls.length;assert.equal(client.creationUncertain,true);await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('CREATE_UNCONFIRMED'));assert.equal(f.calls.length,count);client.destroy();}
});
test('unknown POST outcomes stay locked while a known validation refusal remains retryable',async()=>{
 for(const reply of [()=>{throw new Error('lost response');},()=>Response.json({error:{}},{status:503}),()=>new Response('invalid json')]){const f=queued([actor,reply]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('CREATE_UNCONFIRMED'));assert.equal(client.creationUncertain,true);client.destroy();}
 const f=queued([actor,()=>Response.json({error:{}},{status:400}),actor,{id:'new',name:'New',slug:'new'},actor]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});await assert.rejects(client.create({name:'New',slug:'new'}),errorCode('REQUEST_FAILED'));assert.equal(client.creationUncertain,false);assert.equal((await client.create({name:'New',slug:'new'})).id,'new');client.destroy();
});
test('destroy aborts its own pending scope and never releases a late directory',async()=>{
 const pending=deferred(),f=queued([actor,()=>pending.promise]),client=new WorkspaceDirectory({accountId:'account-a',fetcher:f.fetcher});const result=client.load(),rejected=assert.rejects(result,errorCode('DESTROYED'));await new Promise(setImmediate);assert.equal(f.calls.length,2);client.destroy();assert.equal(f.calls.at(-1).options.signal.aborted,true);pending.resolve(Response.json([entry]));await rejected;assert.equal(f.calls.length,2);client.destroy();
});
