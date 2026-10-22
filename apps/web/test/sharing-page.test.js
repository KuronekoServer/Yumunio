import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {settingsDomFixture} from './fixtures/settings-dom.js';
import {mountSharingPage} from '../public/sharing-page.js';

const ja=JSON.parse(await readFile(new URL('../public/share-locales/ja.json',import.meta.url),'utf8'));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
function environment(t,{community=false,locale='ja'}={}){
 const f=settingsDomFixture(t),calls=[],held=new Map();let actor='account-a',revision=7;
 const preferences={schemaVersion:1,themeId:'light',customColors:{},fontId:'system',locale},storage=new Map(['account-a','account-b'].map(id=>['yumunio.preferences.v1:'+id,JSON.stringify(preferences)]));
 Object.defineProperty(globalThis,'localStorage',{value:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},configurable:true});
 const blockNext=suffix=>{const gate={...deferred(),started:deferred()};held.set(suffix,gate);return gate;};
 const fetcher=async(path,options={})=>{
  const text=String(path),method=options.method??'GET';
  if(text==='/api/instance')return new Response('{}',{status:503});
  if(text.startsWith('file:')){
   const url=new URL(path);if(community&&url.pathname.endsWith('/share-locales/fr.json'))return Response.json({title:'Partage'});
   const bytes=await readFile(url);if(community&&url.pathname.endsWith('/locale-manifest.json')){const manifest=JSON.parse(bytes);manifest.locales.push({code:'fr',endonym:'Fran\u00e7ais',dir:'ltr',fallbacks:['en'],stage:'partial'});return Response.json(manifest);}return new Response(bytes);
  }
  calls.push({path:text,options});const current=actor;
  let data;
  if(text==='/api/auth/get-session')data={user:{id:current,name:current,email:current+'@private.invalid',emailVerified:true}};
  else if(method!=='GET'){const body=options.body?JSON.parse(options.body):{};data=text.endsWith('/grants')?{revision:revision+1,grant:{id:'new-grant',workspaceId:'studio',pageId:'page-a',accountId:body.accountId,permission:body.permission,includeDescendants:body.includeDescendants===true,status:'active'}}:text.includes('/grants/')?{revision:revision+1,revoked:true}:{revision:revision+1};}
  else if(text==='/api/auth/organization/list')data=[{id:'studio',name:'Private '+current}];
  else if(text.endsWith('/pages'))data={revision,role:'owner',pages:[{id:'page-a',title:'Page '+current,capabilities:['read','manage','invite']}]};
  else if(text.endsWith('/invitations'))data={revision,invitations:[{id:'invite-a',pageId:'page-a',recipientEmail:'invited-'+current+'@private.invalid',purpose:'page-guest',role:'viewer',status:'pending',expiresAt:'2027-01-01T00:00:00.000Z'}]};
  else if(text.endsWith('/members'))data={revision,members:[{id:'membership-a',accountId:current,email:current+'@private.invalid',emailVerified:true,role:'owner',currentUser:true},{id:'membership-b',accountId:'member-b',email:'peer@private.invalid',emailVerified:true,role:'member',currentUser:false}]};
  else if(text.endsWith('/grants'))data={revision,grants:[{id:'grant-a',accountId:current,permission:'full',includeDescendants:false}]};
  else if(text.endsWith('/publication'))data={revision:9,pageId:'page-a',mode:'snapshot',active:false,needsRepublish:false,sourceVersion:null,currentSourceVersion:3,publishedAt:null,publicPath:null};
  else throw new Error('Unexpected route '+text);
  const suffix=[...held.keys()].find(value=>(method+':'+text).endsWith(value)||text===value);
  if(suffix){const gate=held.get(suffix);held.delete(suffix);gate.started.resolve();await gate.promise;}
  if(method!=='GET')revision++;
  // Deliberately ignore abort in this double: controller guards must reject late replies too.
  return Response.json(data);
 };
 Object.defineProperty(globalThis,'fetch',{value:fetcher,configurable:true});
 const root=f.doc.createElement('section');f.doc.body.append(root);
 const mount=(extra={})=>mountSharingPage({root,embedded:true,workspaceId:'studio',pageId:'page-a',expectedAccountId:actor,fetcher,...extra});
 const input=(focus,value,type='change')=>{const control=root.querySelector('[data-focus="'+focus+'"]');assert.ok(control,focus);control.value=value;control.dispatch(type);return control;};
 const listenerCount=()=>[...f.listeners.values()].reduce((count,items)=>count+items.size,0);
 return{...f,calls,root,mount,input,blockNext,listenerCount,get actor(){return actor;},set actor(value){actor=value;}};
}

test('embedded sharing requires an explicit valid actor before startup and mismatched first sessions cannot request private lists',async t=>{
 const f=environment(t);for(const expectedAccountId of [null,'','../account'])assert.throws(()=>f.mount({expectedAccountId}),{code:'INVALID_CONTEXT'});assert.equal(f.calls.length,0);
 const controller=f.mount({expectedAccountId:'other-account'});await controller.ready;
 assert.deepEqual(f.calls.map(item=>item.path),['/api/auth/get-session']);assert.doesNotMatch(f.root.textContent,/@private.invalid|Private account/);assert.equal(controller.closeState.busy,false);controller.destroy();assert.equal(f.listenerCount(),0);
});

test('destroy while the first session is pending aborts its scope, clears the UI and removes named global listeners',async t=>{
 const f=environment(t),gate=f.blockNext('/api/auth/get-session'),controller=f.mount();await gate.started.promise;assert.ok(f.listenerCount()>0);
 controller.destroy();assert.equal(f.root.childNodes.length,0);assert.equal(f.listenerCount(),0);assert.equal(f.calls[0].options.signal.aborted,true);assert.deepEqual(controller.closeState,{busy:false,dirty:false});
 gate.resolve();await controller.ready;assert.equal(f.root.childNodes.length,0);assert.deepEqual(f.calls.map(item=>item.path),['/api/auth/get-session']);assert.equal(f.listenerCount(),0);
});

test('invitation scope, role, email, page grant and member role drafts are dirty only while changed',async t=>{
 const f=environment(t),changes=[],controller=f.mount({onChange:value=>changes.push({...value})});await controller.ready;assert.equal(controller.canClose(),true);
 f.input('invite-email','draft@invalid.test','input');assert.equal(controller.closeState.dirty,true);f.input('invite-email','','input');assert.equal(controller.closeState.dirty,false);
 f.input('invite-role','editor');assert.equal(controller.canClose(),false);f.input('invite-role','viewer');assert.equal(controller.canClose(),true);
 f.input('invite-scope','workspace-member');assert.equal(controller.closeState.dirty,true);f.input('invite-scope','page-guest');assert.equal(controller.closeState.dirty,false);
 f.input('grant-role','editor');assert.equal(controller.closeState.dirty,true);f.input('grant-role','viewer');assert.equal(controller.closeState.dirty,false);
 f.input('grant-account','member-b');assert.equal(controller.closeState.dirty,true);f.input('grant-account','');assert.equal(controller.closeState.dirty,false);
 f.input('member-membership-b','guest');assert.equal(controller.closeState.dirty,true);f.input('member-membership-b','member');assert.equal(controller.closeState.dirty,false);
 assert.ok(changes.some(value=>value.dirty));assert.equal(changes.at(-1).dirty,false);controller.destroy();assert.equal(f.listenerCount(),0);
});

test('an in-flight invitation mutation is busy and actor-bound; successful completion clears only the committed invitation draft',async t=>{
 const f=environment(t),controller=f.mount();await controller.ready;const gate=f.blockNext('POST:/api/collaboration/workspaces/studio/invitations');
 f.input('invite-email','draft@invalid.test','input');f.root.querySelector('[data-focus="invite-email"]').closest('form').dispatch('submit');await gate.started.promise;
 assert.deepEqual(controller.closeState,{busy:true,dirty:true});assert.equal(controller.canClose(),false);
 const post=f.calls.find(item=>item.options.method==='POST');assert.equal(post.options.headers['X-Yumunio-Expected-Account'],'account-a');assert.equal(JSON.parse(post.options.body).email,'draft@invalid.test');
 gate.resolve();await flush();assert.deepEqual(controller.closeState,{busy:false,dirty:false});assert.equal(f.root.querySelector('[data-focus="invite-email"]').value,'');controller.destroy();
});

test('actor drift before a mutation clears private projections and drafts without sending a write',async t=>{
 const f=environment(t),controller=f.mount();await controller.ready;f.input('invite-email','retained@invalid.test','input');f.actor='account-b';
 f.root.querySelector('[data-focus="invite-email"]').closest('form').dispatch('submit');await flush();
 assert.equal(f.calls.some(item=>item.options.method&&item.options.method!=='GET'),false);assert.doesNotMatch(f.root.textContent,/account-a@private.invalid|Private account-a|invited-account-a/);assert.deepEqual(controller.closeState,{busy:false,dirty:false});controller.destroy();
});

test('a delayed previous load cannot reinsert private content or continue private reads after the same root is remounted for another actor',async t=>{
 const f=environment(t),first=f.mount();await first.ready;assert.match(f.root.textContent,/Private account-a/);
 const gate=f.blockNext('/invitations');for(const handler of f.listeners.get('window:focus'))handler();await gate.started.promise;first.destroy();assert.equal(f.root.textContent,'');
 f.actor='account-b';const second=f.mount();await second.ready;assert.match(f.root.textContent,/Private account-b/);assert.doesNotMatch(f.root.textContent,/Private account-a/);
 const callsBefore=f.calls.length;gate.resolve();await flush();assert.equal(f.calls.length,callsBefore);assert.match(f.root.textContent,/Private account-b/);assert.doesNotMatch(f.root.textContent,/Private account-a|invited-account-a/);second.destroy();assert.equal(f.listenerCount(),0);
});

test('membership confirmation remains a native child dialog and cancel preserves the role draft without a write',async t=>{
 const f=environment(t),controller=f.mount();await controller.ready;const select=f.input('member-membership-b','guest'),row=select.closest('.share-row');
 row.querySelectorAll('button').find(button=>button.textContent===ja.apply).dispatch('click');const child=f.root.querySelector('#share-modal');assert.equal(child.open,true);assert.ok(child.querySelector('#share-modal-title'));
 child.querySelectorAll('button').find(button=>button.textContent===ja.cancel).dispatch('click');assert.equal(child.open,false);assert.equal(controller.closeState.dirty,true);assert.equal(f.calls.some(item=>item.options.method&&item.options.method!=='GET'),false);controller.destroy();
});

test('embedded community-language options come from the manifest while editor title, branding, locale and skip link remain untouched',async t=>{
 const f=environment(t,{community:true,locale:'fr'}),outside=f.doc.createElement('a');outside.className='skip-link';outside.textContent='Editor skip';f.doc.body.append(outside);f.doc.title='Editor title';f.doc.documentElement.lang='ja';f.doc.documentElement.style.setProperty('--accent','#123456');
 const controller=f.mount();await controller.ready;
 const language=f.root.querySelector('#share-language');assert.ok(language.querySelectorAll('option').some(option=>option.value==='fr'));assert.equal(language.value,'fr');assert.equal(f.root.lang,'fr');
 assert.equal(f.doc.title,'Editor title');assert.equal(f.doc.documentElement.lang,'ja');assert.equal(f.doc.documentElement.style['--accent'],'#123456');assert.equal(outside.textContent,'Editor skip');assert.equal(f.doc.querySelector('[data-instance-favicon]'),null);controller.destroy();assert.equal(f.listenerCount(),0);
});


test('collection sharing offers only resource invitations and confirms a captured individual descendant grant',async t=>{
 const f=environment(t),controller=f.mount({resourceOnly:true,resourceKind:'collection'});await controller.ready;
 assert.equal(f.root.querySelector('[data-focus="member-membership-b"]'),null);assert.deepEqual(f.root.querySelector('[data-focus="invite-scope"]').querySelectorAll('option').map(option=>option.value),['page-guest']);
 f.input('grant-account','member-b');f.input('grant-role','editor');const scope=f.root.querySelector('[data-focus="grant-descendants"]');scope.checked=true;scope.dispatch('change');assert.equal(controller.closeState.dirty,true);
 const form=f.root.querySelector('[data-focus="grant-account"]').closest('form');form.dispatch('submit');assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);assert.match(f.root.querySelector('#share-modal').textContent,/項目ページ・子ページ/);
 f.root.querySelector('#share-modal').querySelectorAll('button').at(-1).dispatch('click');await flush();const writes=f.calls.filter(call=>call.options.method==='POST');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{expectedRevision:7,accountId:'member-b',permission:'editor',includeDescendants:true});assert.equal(controller.closeState.dirty,false);controller.destroy();assert.equal(f.listenerCount(),0);
});

test('an account switch after a resource grant hides the old projection and never replays the uncertain write',async t=>{
 const f=environment(t),controller=f.mount({resourceOnly:true,resourceKind:'collection'});await controller.ready;f.input('grant-account','member-b');const gate=f.blockNext('POST:/api/content/workspaces/studio/pages/page-a/grants');f.root.querySelector('[data-focus="grant-account"]').closest('form').dispatch('submit');f.root.querySelector('#share-modal').querySelectorAll('button').at(-1).dispatch('click');await gate.started.promise;f.actor='account-b';gate.resolve();await flush();
 assert.doesNotMatch(f.root.querySelector('#share-main').textContent,/Private account-a|Page account-a|peer@private.invalid/);assert.match(f.root.querySelector('#share-main').textContent,/アカウント/);assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);assert.equal(controller.closeState.busy,false);controller.destroy();
});

test('standalone sharing keeps community choices and cleans appearance/global listeners on repeated mounts',async t=>{
 const f=environment(t,{community:true,locale:'fr'});
 const skip=f.doc.createElement('a');skip.className='skip-link';f.root.append(skip);
 for(const[tag,id]of [['span','share-theme-label'],['select','share-theme'],['span','share-language-label'],['select','share-language'],['h2','share-sidebar-title'],['a','share-back'],['a','share-account'],['p','share-sidebar-note'],['main','share-main'],['dialog','share-modal']]){const element=f.doc.createElement(tag);element.setAttribute('id',id);f.root.append(element);}
 const first=f.mount({embedded:false,expectedAccountId:null});await first.ready;
 assert.match(f.root.querySelector('#share-main').textContent,/Private account-a/);assert.equal(f.root.querySelector('#share-language').value,'fr');assert.equal(f.root.querySelector('#share-theme').querySelectorAll('option').length,6);assert.equal(f.doc.documentElement.lang,'fr');assert.ok(f.listeners.get('media:change').size>0);
 first.destroy();assert.equal(f.root.querySelector('#share-main').textContent,'');assert.equal(f.listenerCount(),0);
 const second=f.mount({embedded:false,expectedAccountId:null});await second.ready;assert.equal(f.root.querySelector('#share-theme').querySelectorAll('option').length,6);assert.match(f.root.querySelector('#share-main').textContent,/Private account-a/);second.destroy();assert.equal(f.listenerCount(),0);
});

test('losing the captured actor closes a pending sharing confirmation and purges all drafts before any reload or account return',async t=>{
 const f=environment(t),policy=[],changes=[],controller=f.mount({resourceOnly:true,resourceKind:'collection',onPolicyMayHaveChanged:value=>policy.push(value),onChange:value=>changes.push({...value})});await controller.ready;
 f.input('invite-email','old-private-draft@invalid.test','input');f.input('grant-account','member-b');f.input('grant-role','editor');const scope=f.root.querySelector('[data-focus="grant-descendants"]');scope.checked=true;scope.dispatch('change');f.root.querySelector('[data-focus="grant-account"]').closest('form').dispatch('submit');const child=f.root.querySelector('#share-modal');assert.equal(child.open,true);assert.equal(controller.closeState.dirty,true);
 f.actor='account-b';for(const listener of f.listeners.get('window:focus'))listener();await flush();assert.equal(child.open,false);assert.equal(child.textContent,'');assert.doesNotMatch(f.root.textContent,/old-private-draft|peer@private.invalid|Page account-a|Private account-a/);assert.deepEqual(controller.closeState,{busy:false,dirty:false});assert.equal(controller.canClose(),true);assert.equal(policy.length,1);assert.equal(changes.at(-1).dirty,false);
 const calls=f.calls.length;f.actor='account-a';f.root.querySelectorAll('button').find(button=>button.textContent===ja.reload).dispatch('click');for(const listener of f.listeners.get('window:focus'))listener();await flush();assert.equal(f.calls.length,calls);assert.equal(f.root.querySelector('[data-focus="grant-account"]'),null);assert.equal(f.calls.some(call=>call.options.method&&call.options.method!=='GET'),false);controller.destroy();assert.equal(f.listenerCount(),0);
});

test('post-write actor loss purges sibling invitation drafts and notifies policy without replaying a resource grant',async t=>{
 const f=environment(t),policy=[],controller=f.mount({resourceOnly:true,resourceKind:'collection',onPolicyMayHaveChanged:value=>policy.push(value)});await controller.ready;f.input('invite-email','private-sibling@invalid.test','input');f.input('grant-account','member-b');const gate=f.blockNext('POST:/api/content/workspaces/studio/pages/page-a/grants');f.root.querySelector('[data-focus="grant-account"]').closest('form').dispatch('submit');f.root.querySelector('#share-modal').querySelectorAll('button').at(-1).dispatch('click');await gate.started.promise;f.actor='account-b';gate.resolve();await flush();assert.deepEqual(controller.closeState,{busy:false,dirty:false});assert.equal(controller.canClose(),true);assert.equal(policy.length,1);assert.doesNotMatch(f.root.textContent,/private-sibling|peer@private.invalid|Page account-a/);assert.equal(f.root.querySelector('#share-modal').textContent,'');assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);controller.destroy();
});

test('individual grant and revoke confirmations name the captured resource, recipient, permission and scope',async t=>{
 const f=environment(t),controller=f.mount({resourceOnly:true,resourceKind:'collection'});await controller.ready;f.input('grant-account','member-b');f.input('grant-role','editor');const scope=f.root.querySelector('[data-focus="grant-descendants"]');scope.checked=true;scope.dispatch('change');f.root.querySelector('[data-focus="grant-account"]').closest('form').dispatch('submit');const child=f.root.querySelector('#share-modal');assert.ok(child.textContent.includes('Page account-a'));assert.ok(child.textContent.includes('peer@private.invalid'));assert.ok(child.textContent.includes(ja.role_editor));assert.ok(child.textContent.includes(ja.descendantGrantReview));child.querySelectorAll('button')[0].dispatch('click');assert.equal(controller.closeState.dirty,true);assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
 f.root.querySelectorAll('button').find(button=>button.textContent===ja.revokeAccess).dispatch('click');assert.ok(child.textContent.includes('Page account-a'));assert.ok(child.textContent.includes('account-a@private.invalid'));assert.ok(child.textContent.includes(ja.role_full));assert.ok(child.textContent.includes(ja.revokeAccessNote));child.querySelectorAll('button')[0].dispatch('click');controller.destroy();
});

test('the sharing tabs switch between membership controls and the web publication panel',async t=>{
 const f=environment(t),controller=f.mount();await controller.ready;
 assert.equal(f.root.querySelector('[data-focus="tab-web"]').getAttribute('aria-selected'),'false');
 assert.ok(f.root.querySelector('[data-focus="invite-email"]'));
 f.root.querySelector('[data-focus="tab-web"]').dispatch('click');await flush();
 assert.equal(f.root.querySelector('[data-focus="tab-web"]').getAttribute('aria-selected'),'true');
 assert.equal(f.root.querySelector('[data-focus="invite-email"]'),null);
 assert.ok(f.calls.some(call=>call.path.endsWith('/publication')));
 assert.ok(f.root.textContent.includes(ja.inactive));
 assert.ok(f.root.textContent.includes(ja.webIntro));
 assert.ok(f.root.querySelector('[data-focus="tab-share"]'));
 f.root.querySelector('[data-focus="tab-share"]').dispatch('click');await flush();
 assert.ok(f.root.querySelector('[data-focus="invite-email"]'));
 controller.destroy();assert.equal(f.listenerCount(),0);
});

