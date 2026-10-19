import test from 'node:test';
import assert from 'node:assert/strict';
import {PageReadPool,workspacePageTarget,matchingPageTitles} from '../public/page-navigation.js';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const value=id=>({id,title:id});
const validate=(data,id)=>{assert.equal(data.id,id);return data;};
test('only same-origin page links in this workspace use local navigation',()=>{
 const options={origin:'https://notes.example',workspaceId:'studio'};
 assert.deepEqual(workspacePageTarget('/workspace?workspace=studio&page=page-1&view=board#block-1',options),{pageId:'page-1',viewId:'board',hash:'#block-1'});
 for(const href of ['/workspace?workspace=other&page=p','https://other.example/workspace?workspace=studio&page=p','/account?workspace=studio&page=p','/workspace?workspace=studio&page=../bad','/workspace?workspace=studio'])assert.equal(workspacePageTarget(href,options),null);
});
test('previews are cloned and every completed navigation obtains a new authorized read',async()=>{
 let calls=0,time=0;const pool=new PageReadPool({scope:()=> 'account-a',read:async id=>({...value(id),read:++calls}),validate,now:()=>time,ttl:20});
 await pool.load('one',{prefetch:true});const preview=pool.preview('one');preview.title='changed';assert.equal(pool.preview('one').title,'one');
 const current=await pool.load('one');assert.equal(current.read,2);assert.equal(calls,2);time=30;assert.equal(pool.preview('one'),null);
});
test('a navigation shares an in-flight prefetch and a cancelled subscriber does not cancel another reader',async()=>{
 const pending=deferred();let calls=0;const pool=new PageReadPool({scope:()=> 'a',read:async()=>{calls++;return pending.promise;},validate});
 const warm=pool.load('one',{prefetch:true}),controller=new AbortController(),aborted=pool.load('one',{signal:controller.signal});controller.abort();await assert.rejects(aborted,{name:'AbortError'});const selected=pool.load('one');pending.resolve(value('one'));assert.deepEqual(await warm,value('one'));assert.deepEqual(await selected,value('one'));assert.equal(calls,1);
});
test('account changes and mutation invalidation discard old previews and late reads',async()=>{
 let actor='a',pending=deferred();const pool=new PageReadPool({scope:()=>actor,read:()=>pending.promise,validate});
 const first=pool.load('one');actor='b';assert.equal(pool.preview('one'),null);pending.resolve(value('one'));await assert.rejects(first,{name:'AbortError'});
 pending=deferred();const second=pool.load('two');pool.clear();pending.resolve(value('two'));await assert.rejects(second,{name:'AbortError'});assert.equal(pool.preview('two'),null);
});
test('memory and speculative traffic are bounded',async()=>{
 const gates=new Map(['one','two','three'].map(id=>[id,deferred()]));const pool=new PageReadPool({scope:()=> 'a',read:id=>gates.get(id).promise,validate,maxEntries:1});
 const one=pool.load('one',{prefetch:true}),two=pool.load('two',{prefetch:true});assert.equal(await pool.load('three',{prefetch:true}),null);gates.get('one').resolve(value('one'));await one;gates.get('two').resolve(value('two'));await two;assert.equal(pool.preview('one'),null);assert.equal(pool.preview('two').id,'two');
});
test('instant title matching normalizes width and case without querying or interpreting markup',()=>{
 const pages=[{id:'a',title:'ＡＰＩ 設計'},{id:'b',title:'API guide'},{id:'c',title:'<script>memo</script>'}];assert.deepEqual(matchingPageTitles(pages,'api',{limit:1}).map(row=>row.page.id),['a']);assert.equal(matchingPageTitles(pages,'script')[0].page.title,'<script>memo</script>');
});
