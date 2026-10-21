import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordPanel} from '../public/record-panel.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(t,extra={}){
 const f=settingsDomFixture(t),window=new EventTarget(),messages=[],navigated=[],peer={postMessage:(value,origin)=>messages.push({value,origin})},create=f.doc.createElement.bind(f.doc);
 window.location={origin:'https://local.invalid',assign:href=>navigated.push(href)};
 f.doc.createElement=tag=>{const element=create(tag);if(tag==='iframe')element.contentWindow=peer;return element;};
 const changes=[],closed=[],lifetime=new AbortController(),panel=createRecordPanel({document:f.doc,window,workspaceId:'studio',getAccountId:()=> 'owner',t:key=>key,signal:lifetime.signal,onChanged:(...args)=>changes.push(args),onClosed:row=>closed.push(row.id),...extra});t.after(()=>{lifetime.abort();});
 const message=(data,overrides={})=>{const event=new Event('message');Object.assign(event,{origin:window.location.origin,source:peer,data:{workspaceId:'studio',accountId:'owner',pageId:'page-a',...data},...overrides});window.dispatchEvent(event);};
 return{...f,window,panel,messages,closed,changes,navigated,message};
}
const record={id:'row-a',pageId:'page-a',title:'Issue A'};

test('the editor is inserted with its destination and feedback preserves that browsing context',async t=>{
 const f=fixture(t),create=f.doc.createElement,navigations=[];
 f.doc.createElement=tag=>{const element=create(tag);if(tag==='iframe'){let src;Object.defineProperty(element,'src',{get:()=>src,set:value=>{src=value;navigations.push(value);}});}if(tag==='aside'){const append=element.append.bind(element);element.append=(...nodes)=>{for(const child of nodes)if(child.nodeName==='IFRAME')assert.match(child.src,/\/workspace-detail\?/);append(...nodes);};}return element;};
 await f.panel.open(record,'tasks');const frame=f.doc.querySelector('iframe');assert.equal(navigations.length,1);
 f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:2});f.message({type:'yumunio:detail-ready',dirty:false,busy:false,revision:3});
 assert.equal(f.doc.querySelector('iframe'),frame);assert.equal(navigations.length,1);assert.equal(f.panel.state().dirty,false);
});
test('a stalled blank navigation retries once, but an initialized editor is never reloaded',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);await f.panel.open(record,'tasks');const frame=f.doc.querySelector('iframe'),url=frame.src,navigations=[];frame.contentDocument={URL:'about:blank',body:{childNodes:[]}};Object.defineProperty(frame,'src',{get:()=>url,set:value=>navigations.push(value)});
 t.mock.timers.tick(5000);assert.deepEqual(navigations,[]);assert.notEqual(f.doc.querySelector('iframe'),frame);assert.equal(frame.isConnected,false);assert.equal(f.doc.querySelector('iframe').src,url);t.mock.timers.tick(15000);assert.equal(f.doc.querySelector('[role="status"]').textContent,'detailPanel.loadFailed');assert.deepEqual(navigations,[]);
 f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:1});t.mock.timers.tick(30000);assert.deepEqual(navigations,[]);assert.equal(f.panel.state().dirty,true);
});
test('an editor that has navigated and a panel closed during loading are excluded from navigation retries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);await f.panel.open(record,'tasks');const frame=f.doc.querySelector('iframe'),url=frame.src,navigations=[];frame.contentDocument={URL:url,body:{childNodes:[]}};Object.defineProperty(frame,'src',{get:()=>url,set:value=>navigations.push(value)});
 t.mock.timers.tick(5000);assert.deepEqual(navigations,[]);await f.panel.close();t.mock.timers.tick(30000);assert.deepEqual(navigations,[]);assert.equal(f.doc.querySelector('.record-detail-panel'),null);
});
test('record detail leaves the host mounted and closes only after the current editor acknowledges saving',async t=>{
 const f=fixture(t),nodes=[...f.background.childNodes];f.background.scrollTop=420;
 assert.equal(await f.panel.open(record,'tasks'),true);const host=f.doc.querySelector('.record-detail-panel');assert.ok(host);assert.deepEqual(f.background.childNodes,nodes);
 assert.match(host.querySelector('iframe').src,/^https:\/\/local\.invalid\/workspace-detail\?/);assert.match(host.querySelector('iframe').src,/record=row-a/);
 f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:6},{origin:'https://other.invalid'});assert.equal(f.changes.length,0);
 f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:6},{source:{}});assert.equal(f.changes.length,0);
 f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:6,accountId:'other'});assert.equal(f.changes.length,0);
 f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:6});assert.equal(f.panel.state().dirty,true);assert.equal(f.changes.length,1);
 const canceled=f.panel.close();await flush();assert.ok(host.isConnected);let request=f.messages.at(-1).value;assert.equal(request.type,'yumunio:detail-prepare');
 f.message({type:'yumunio:detail-prepared',requestId:request.requestId,accepted:false});assert.equal(await canceled,false);assert.ok(host.isConnected);
 const saved=f.panel.close();await flush();request=f.messages.at(-1).value;f.message({type:'yumunio:detail-prepared',requestId:request.requestId,accepted:true});assert.equal(await saved,true);
 assert.equal(host.isConnected,false);assert.deepEqual(f.background.childNodes,nodes);assert.equal(f.background.scrollTop,420);assert.deepEqual(f.closed,['row-a']);
});
test('a lost source removes detail and a delayed preparation cannot reopen a destroyed panel',async t=>{
 const f=fixture(t);await f.panel.open(record,'tasks');f.message({type:'yumunio:detail-access-lost'});assert.equal(f.panel.state(),null);
 let resolve;const late=fixture(t,{prepare:()=>new Promise(yes=>{resolve=yes;})}),opening=late.panel.open(record,'tasks');await flush();late.panel.destroy();resolve(true);assert.equal(await opening,false);assert.equal(late.doc.querySelector('.record-detail-panel'),null);
});
test('full-page navigation waits for the same save acknowledgement and retains the canonical page URL',async t=>{
 const f=fixture(t);await f.panel.open(record,'tasks');f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:4});const closing=f.panel.close({fullPage:true});await flush();assert.deepEqual(f.navigated,[]);const request=f.messages.at(-1).value;f.message({type:'yumunio:detail-prepared',requestId:request.requestId,accepted:true});assert.equal(await closing,true);assert.deepEqual(f.navigated,['https://local.invalid/workspace?workspace=studio&page=page-a']);
});

function animatedSurface(document,model){
 const host=document.createElement('aside'),exit=document.createElement('button'),frame=document.createElement('iframe'),full=document.createElement('a');full.href=model.fullUrl;host.append(exit,frame,full);document.body.append(host);let finish,exits=0;
 return{host,exit,frame,full,setStatus(){},get exits(){return exits;},close(){exits++;return new Promise(resolve=>{finish=resolve;});},finish(){finish?.();},destroy(){host.remove();finish?.();}};
}
test('save acknowledgement precedes the animated exit and focus returns only when that exit completes',async t=>{
 let surface,document;const f=fixture(t,{renderSurface:model=>(surface=animatedSurface(document,model))});document=f.doc;const initial=[...f.background.childNodes];f.background.scrollTop=580;
 await f.panel.open(record,'tasks');f.message({type:'yumunio:detail-ready',dirty:true,busy:false,revision:2});const closing=f.panel.close();await flush();assert.equal(surface.exits,0);assert.equal(document.activeElement,surface.exit);
 const request=f.messages.at(-1).value;f.message({type:'yumunio:detail-prepared',requestId:request.requestId,accepted:true});await flush();assert.equal(surface.exits,1);assert.equal(document.body.classList.contains('record-panel-open'),false);assert.ok(surface.host.isConnected);assert.equal(document.activeElement,surface.exit);assert.deepEqual(f.closed,[]);
 surface.finish();assert.equal(await closing,true);assert.equal(document.activeElement,f.trigger);assert.equal(f.background.scrollTop,580);assert.deepEqual(f.background.childNodes,initial);
});
test('closing does not take focus away from a different control used during the transition',async t=>{
 let surface,document;const f=fixture(t,{renderSurface:model=>(surface=animatedSurface(document,model))});document=f.doc;await f.panel.open(record,'tasks');const closing=f.panel.close();await flush();f.editor.focus();surface.finish();assert.equal(await closing,true);assert.equal(document.activeElement,f.editor);
});

test('closing a calendar detail restores the replacement record button after a projection refresh',async t=>{
 const f=fixture(t),root=f.doc.createElement('section'),initial=f.doc.createElement('button');root.className='database-placement';initial.setAttribute('data-record-id',record.id);initial.textContent='Calendar task';root.append(initial);f.background.append(root);initial.focus();await f.panel.open(record,'tasks');
 const replacement=f.doc.createElement('button');replacement.setAttribute('data-record-id',record.id);root.replaceChildren(replacement);assert.equal(await f.panel.close(),true);assert.equal(f.doc.activeElement,replacement);
});
test('access revocation removes an exiting panel immediately and late animation completion cannot navigate',async t=>{
 let surface,document;const f=fixture(t,{renderSurface:model=>(surface=animatedSurface(document,model))});document=f.doc;await f.panel.open(record,'tasks');const closing=f.panel.close({fullPage:true});await flush();assert.equal(surface.exits,1);f.message({type:'yumunio:detail-access-lost'});assert.equal(surface.host.isConnected,false);assert.equal(f.panel.state(),null);surface.finish();assert.equal(await closing,false);assert.deepEqual(f.navigated,[]);
});
test('Escape used by an input method does not close the panel',async t=>{
 const f=fixture(t);await f.panel.open(record,'tasks');for(const extra of [{isComposing:true},{keyCode:229}]){const event=new Event('keydown',{cancelable:true});Object.assign(event,{key:'Escape',...extra});f.window.dispatchEvent(event);await flush();assert.equal(event.defaultPrevented,false);assert.ok(f.panel.state());}
 const event=new Event('keydown',{cancelable:true});Object.assign(event,{key:'Escape'});f.window.dispatchEvent(event);await flush();assert.equal(event.defaultPrevented,true);assert.equal(f.panel.state(),null);
});
