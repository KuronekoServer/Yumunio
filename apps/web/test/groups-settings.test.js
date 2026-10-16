import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mountGroupsSettings} from '../public/groups-settings.js';
import {GroupsClient} from '../public/groups-client.js';
import {validateCatalogParity,validateLocaleManifest} from '../public/i18n.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const catalogs=Object.fromEntries(await Promise.all(['ja','en'].map(async locale=>[locale,JSON.parse(await readFile(new URL('../public/groups-locales/'+locale+'.json',import.meta.url),'utf8'))]))),text=catalogs.ja,stamp='2026-10-16T00:00:00.000Z';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function detail(){return{workspaceId:'studio',revision:4,canManage:true,group:{id:'design',workspaceId:'studio',name:'Design',createdAt:stamp,updatedAt:stamp,archivedAt:null,memberCount:1},members:[{id:'group-a',accountId:'account-a',name:'Aoi',currentUser:true}],candidates:[{accountId:'account-a',name:'Aoi'},{accountId:'account-b',name:'Ren'}]};}
function fixture(t,{value=detail(),pageId=null,grants=[],handlers={},onChange}={}){
 const f=settingsDomFixture(t),root=f.doc.createElement('section');f.doc.body.append(root);let data=structuredClone(value),page={workspaceId:'studio',pageId:'page-a',revision:4,grants:structuredClone(grants)};const calls=[],clients=[],changes=[],uncertain=[];
 const clientFactory=options=>{const client={options,uncertain:false,destroyed:false,destroy(){this.destroyed=true;},async list(){calls.push({kind:'list'});if(handlers.list)return handlers.list({client,data,page});return{workspaceId:'studio',revision:data.revision,canManage:data.canManage,groups:[structuredClone(data.group)]};},async read(id){calls.push({kind:'read',id});return handlers.read?handlers.read({client,data,page,id}):structuredClone(data);},async pageGrants(id){calls.push({kind:'pageGrants',id});return handlers.pageGrants?handlers.pageGrants({client,data,page,id}):structuredClone(page);}};
  for(const method of ['create','rename','archive','member','remove','grant','revoke'])client[method]=async(...args)=>{const id=method==='create'?null:args[0],body=structuredClone(method==='create'?args[0]:args[1]);calls.push({kind:method,id,body});if(handlers[method])return handlers[method]({client,data,page,id,body});data.revision=page.revision=body.expectedRevision+1;
   if(method==='create')data={...data,group:{...data.group,id:'created-group',name:body.name,memberCount:0},members:[]};
   if(method==='rename')data.group.name=body.name;
   if(method==='archive')data.group.archivedAt=body.archived?stamp:null;
   if(method==='member')data.members.push({id:'group-b',accountId:body.accountId,name:data.candidates.find(item=>item.accountId===body.accountId).name,currentUser:false});
   if(method==='remove')data.members=data.members.filter(item=>item.id!==body.memberId);
   data.group.memberCount=data.members.length;
   if(method==='grant'){page.grants=page.grants.filter(item=>item.groupId!==body.groupId);page.grants.push({id:'grant',workspaceId:'studio',pageId:'page-a',groupId:body.groupId,groupName:data.group.name,permission:body.permission,includeDescendants:body.includeDescendants,status:'active'});}
   if(method==='revoke')page.grants=page.grants.filter(item=>item.id!==body.grantId);
   return structuredClone(['grant','revoke'].includes(method)?page:data);
  };clients.push(client);return client;
 };
 const controller=mountGroupsSettings({root,embedded:true,workspaceId:'studio',expectedAccountId:'account-a',pageId,catalogs,clientFactory,onChange:async value=>{changes.push(value);await onChange?.(value);},onPolicyMayHaveChanged:value=>uncertain.push(value)});
 const button=key=>root.querySelectorAll('button').find(item=>item.textContent===text[key]);
 const byId=id=>root.querySelectorAll('[id]').find(item=>item.id===id);
 const input=(id,value,type='input')=>{const element=byId(id);element.value=value;element.dispatch(type);return element;};
 const confirm=()=>root.querySelector('dialog').querySelectorAll('button').at(-1).dispatch('click'),cancel=()=>root.querySelector('dialog').querySelectorAll('button')[0].dispatch('click');
 const open=async()=>{root.querySelector('.group-list').querySelector('button').dispatch('click');await flush();};
 return{...f,root,controller,calls,clients,changes,uncertain,button,byId,input,confirm,cancel,open,get data(){return data;},get page(){return page;}};
}

test('embedded groups keep branding and editor nodes unchanged and release lifecycle listeners',async t=>{
 const f=fixture(t),nodes=[...f.editor.childNodes];f.doc.documentElement.lang='en';f.doc.documentElement.style.fontFamily='Original';await f.controller.ready;assert.deepEqual(f.calls,[{kind:'list'}]);assert.equal(f.clients[0].options.accountId,'account-a');assert.ok(f.clients[0].options.signal instanceof AbortSignal);assert.equal(f.doc.documentElement.lang,'en');assert.equal(f.doc.documentElement.style.fontFamily,'Original');assert.deepEqual(f.editor.childNodes,nodes);assert.equal(f.controller.canClose(),true);await f.open();assert.equal(f.byId('group-name').value,'Design');f.controller.destroy();assert.equal(f.root.textContent,'');assert.equal(f.clients[0].destroyed,true);assert.equal(f.clients[0].options.signal.aborted,true);assert.equal(f.listeners.get('window:beforeunload').size,0);assert.equal(f.controller.canClose(),true);
});

test('name drafts block member, archive and page-sharing actions rather than silently discarding input',async t=>{
 const f=fixture(t,{pageId:'page-a'});await f.controller.ready;await f.open();f.byId('group-name').focus();f.input('group-name','Unsaved name');assert.equal(f.controller.closeState.dirty,true);assert.equal(f.controller.canClose(),false);assert.equal(f.button('archive').disabled,true);assert.equal(f.button('remove').disabled,true);assert.equal(f.byId('group-candidate').disabled,true);assert.equal(f.byId('group-permission').disabled,true);assert.equal(f.button('share').disabled,true);
 f.button('archive').dispatch('click');f.button('remove').dispatch('click');f.button('share').dispatch('click');assert.equal(f.root.querySelector('dialog'),null);assert.equal(f.calls.filter(item=>['archive','remove','grant'].includes(item.kind)).length,0);
 f.button('back').dispatch('click');assert.ok(f.root.querySelector('dialog').open);f.cancel();assert.equal(f.byId('group-name').value,'Unsaved name');assert.equal(f.doc.activeElement,f.byId('group-name'));f.root.querySelector('form').dispatch('submit');assert.ok(f.root.querySelector('dialog').open);f.confirm();await flush();assert.deepEqual(f.calls.find(item=>item.kind==='rename').body,{expectedRevision:4,name:'Unsaved name',confirmAccessChange:true});assert.equal(f.changes.length,1);assert.equal(f.byId('group-name').value,'Unsaved name');assert.equal(f.controller.closeState.dirty,false);f.controller.destroy();
});

test('member and page-grant changes require a captured native confirmation and show current-page scope',async t=>{
 const f=fixture(t,{pageId:'page-a'});await f.controller.ready;await f.open();assert.equal(f.byId('group-descendants').checked,false);f.input('group-candidate','account-b','change');assert.equal(f.controller.closeState.dirty,true);f.button('addMember').dispatch('click');assert.ok(f.root.querySelector('dialog').open);f.cancel();assert.equal(f.byId('group-candidate').value,'account-b');f.button('addMember').dispatch('click');f.confirm();await flush();assert.deepEqual(f.calls.find(item=>item.kind==='member').body,{expectedRevision:4,accountId:'account-b',confirmAccessChange:true});assert.equal(f.controller.closeState.dirty,false);assert.equal(f.data.group.memberCount,2);
 f.input('group-permission','commenter','change');assert.equal(f.controller.closeState.dirty,true);f.button('share').dispatch('click');assert.ok(f.root.querySelector('dialog').open);f.confirm();await flush();assert.deepEqual(f.calls.find(item=>item.kind==='grant').body,{expectedRevision:5,groupId:'design',permission:'commenter',includeDescendants:false,confirmAccessChange:true});assert.equal(f.page.grants[0].permission,'commenter');assert.equal(f.controller.closeState.dirty,false);f.controller.destroy();
});

test('a verified standalone session is captured before the first group client and unverified sessions never read groups',async t=>{
 for(const verified of [true,false]){const f=settingsDomFixture(t),root=f.doc.createElement('section');f.doc.body.append(root);const calls=[];let options;
  const controller=mountGroupsSettings({root,workspaceId:'studio',catalogs,fetcher:async(path,init)=>{calls.push(path);assert.equal(init.credentials,'same-origin');assert.equal(init.mode,'same-origin');assert.equal(init.redirect,'error');return Response.json({user:{id:'account-a',emailVerified:verified}});},clientFactory:value=>{options=value;return{destroy(){},list:async()=>{calls.push('list');return{workspaceId:'studio',revision:4,canManage:true,groups:[detail().group]};}};}});
  await controller.ready;if(verified){assert.equal(options.accountId,'account-a');assert.equal(options.workspaceId,'studio');assert.deepEqual(calls,['/api/auth/get-session','list']);assert.ok(root.querySelector('a[href]'));}else{assert.equal(options,undefined);assert.deepEqual(calls,['/api/auth/get-session']);assert.equal(root.querySelector('.group-list'),null);}controller.destroy();
 }
});

test('a known successful mutation whose parent refresh fails reports saved state without repeating the command',async t=>{
 const f=fixture(t,{onChange:async()=>{throw new Error('Synthetic parent refresh failure');}});await f.controller.ready;await f.open();f.input('group-name','Saved name');f.root.querySelector('form').dispatch('submit');assert.match(f.root.querySelector('dialog').textContent,/Saved name/);f.confirm();await flush();assert.match(f.root.textContent,/保存は完了しました/);assert.deepEqual(f.uncertain,[{workspaceId:'studio'}]);assert.equal(f.calls.filter(item=>item.kind==='rename').length,1);assert.equal(f.button('save').disabled,true);f.root.querySelector('form').dispatch('submit');assert.equal(f.calls.filter(item=>item.kind==='rename').length,1);f.button('reload').dispatch('click');f.confirm();await flush();assert.equal(f.byId('group-name').value,'Saved name');assert.equal(f.controller.closeState.dirty,false);f.controller.destroy();
});

test('a real client with uncertain post-write account drift clears all old private UI and fences detached controls',async t=>{
 const f=settingsDomFixture(t),root=f.doc.createElement('section');f.doc.body.append(root);let posted=false,client;const changes=[],uncertain=[],requests=[],value=detail();
 const fetcher=async(path,init)=>{
  requests.push({path,method:init.method});assert.equal(init.headers['X-Yumunio-Expected-Account'],'account-a');
  if(path==='/api/auth/get-session')return Response.json({user:{id:posted?'account-b':'account-a',emailVerified:true}});
  if(path==='/api/content/workspaces/studio/groups')return Response.json({workspaceId:'studio',revision:4,canManage:true,groups:[value.group]});
  assert.equal(path,'/api/content/workspaces/studio/groups/design');if(init.method==='GET')return Response.json(value);
  assert.equal(init.method,'PATCH');const command=JSON.parse(init.body);posted=true;return Response.json({...value,revision:5,group:{...value.group,name:command.name}});
 };
 const controller=mountGroupsSettings({root,embedded:true,workspaceId:'studio',expectedAccountId:'account-a',catalogs,fetcher,clientFactory:options=>(client=new GroupsClient(options)),onChange:value=>changes.push(value),onPolicyMayHaveChanged:value=>uncertain.push(value)});
 await controller.ready;root.querySelector('.group-list').querySelector('button').dispatch('click');await flush();const oldInput=root.querySelector('#group-name'),oldArchive=root.querySelectorAll('button').find(item=>item.textContent===text.archive);oldInput.value='Private group draft';oldInput.dispatch('input');root.querySelector('form').dispatch('submit');root.querySelector('dialog').querySelectorAll('button').at(-1).dispatch('click');await flush();
 assert.equal(client.uncertain,true);assert.equal(client.destroyed,true);assert.equal(changes.length,0);assert.deepEqual(uncertain,[{workspaceId:'studio'}]);assert.equal(root.querySelector('#group-name'),null);assert.equal(root.querySelector('.group-list'),null);assert.doesNotMatch(root.textContent,/Private group draft|Design|Ren|Aoi/);assert.match(root.textContent,/アカウントが変わった/);assert.equal(controller.closeState.dirty,false);
 oldInput.value='Resurrected draft';oldInput.dispatch('input');oldArchive.dispatch('click');assert.equal(controller.closeState.dirty,false);assert.equal(root.querySelector('dialog'),null);assert.equal(requests.filter(item=>item.method==='PATCH').length,1);assert.equal(changes.length,0);controller.destroy();
});

test('uncertain unauthorized or missing post-write responses always clear private state and notify the parent',async t=>{
 for(const status of [401,403,404]){
  const f=fixture(t,{handlers:{rename:async({client})=>{client.uncertain=true;throw Object.assign(new Error('Synthetic authority loss'),{code:'CONTENT_NOT_FOUND',status});}}});await f.controller.ready;await f.open();f.input('group-name','Private draft');f.root.querySelector('form').dispatch('submit');f.confirm();await flush();assert.equal(f.clients[0].destroyed,true);assert.equal(f.byId('group-name'),undefined);assert.doesNotMatch(f.root.textContent,/Private draft|Design|Ren|Aoi/);assert.deepEqual(f.uncertain,[{workspaceId:'studio'}]);assert.equal(f.changes.length,0);assert.equal(f.controller.closeState.dirty,false);f.controller.destroy();
 }
});

test('a descendant grant preserves its selected scope and reviews descendant impact before revoke',async t=>{
 const grant={id:'existing-grant',workspaceId:'studio',pageId:'page-a',groupId:'design',groupName:'Design',permission:'editor',includeDescendants:true,status:'active'},f=fixture(t,{pageId:'page-a',grants:[grant]});await f.controller.ready;await f.open();assert.match(f.root.textContent,/子ページを含む共有/);assert.equal(f.byId('group-descendants').checked,true);assert.equal(f.byId('group-permission').value,'editor');assert.equal(f.byId('group-permission').disabled,false);assert.equal(f.controller.closeState.dirty,false);assert.equal(f.calls.filter(item=>item.kind==='grant').length,0);
 f.button('revoke').dispatch('click');assert.match(f.root.querySelector('dialog').textContent,/共有を継承する子ページにも影響/);f.cancel();assert.equal(f.calls.filter(item=>item.kind==='revoke').length,0);assert.equal(f.page.grants[0].includeDescendants,true);f.button('revoke').dispatch('click');f.confirm();await flush();assert.deepEqual(f.calls.find(item=>item.kind==='revoke').body,{expectedRevision:4,grantId:'existing-grant',confirmAccessChange:true});assert.equal(f.calls.filter(item=>item.kind==='grant').length,0);assert.equal(f.byId('group-permission').disabled,false);assert.equal(f.button('share').disabled,false);f.controller.destroy();
});

test('an existing current-page grant remains editable and is labeled separately from descendant sharing',async t=>{
 const grant={id:'page-grant',workspaceId:'studio',pageId:'page-a',groupId:'design',groupName:'Design',permission:'viewer',includeDescendants:false,status:'active'},f=fixture(t,{pageId:'page-a',grants:[grant]});await f.controller.ready;await f.open();assert.match(f.root.textContent,/このページのみ/);assert.equal(f.byId('group-permission').disabled,false);assert.equal(f.button('share').disabled,false);assert.equal(f.calls.filter(item=>['grant','revoke'].includes(item.kind)).length,0);f.button('revoke').dispatch('click');assert.doesNotMatch(f.root.querySelector('dialog').textContent,/子ページにも影響/);f.cancel();f.controller.destroy();
});

test('role sharing captures the explicitly selected descendant scope and protects pending scope drafts',async t=>{
 const f=fixture(t,{pageId:'page-a'});await f.controller.ready;await f.open();const scope=f.byId('group-descendants');scope.checked=true;scope.dispatch('change');assert.equal(f.controller.closeState.dirty,true);assert.equal(f.button('archive').disabled,true);
 f.button('share').dispatch('click');assert.match(f.root.querySelector('dialog').textContent,/項目ページ・子ページ/);f.cancel();assert.equal(f.byId('group-descendants').checked,true);assert.equal(f.calls.some(call=>call.kind==='grant'),false);
 f.button('share').dispatch('click');f.confirm();await flush();assert.equal(f.calls.find(call=>call.kind==='grant').body.includeDescendants,true);assert.equal(f.page.grants[0].includeDescendants,true);assert.equal(f.byId('group-descendants').checked,true);assert.equal(f.controller.closeState.dirty,false);f.controller.destroy();
});

test('readonly group viewers cannot manage members but authorized page managers can grant a current group',async t=>{
 const value=detail();value.canManage=false;value.members=[];value.candidates=[];const f=fixture(t,{value,pageId:'page-a'});await f.controller.ready;await f.open();assert.equal(f.byId('group-name'),undefined);assert.equal(f.button('archive'),undefined);assert.equal(f.byId('group-candidate'),undefined);assert.ok(f.button('share'));f.button('share').dispatch('click');f.confirm();await flush();assert.equal(f.calls.filter(item=>item.kind==='grant').length,1);assert.equal(f.changes.length,1);f.controller.destroy();
});

test('unknown mutation ACKs lock writes, retain drafts and refresh the directory only after discard consent',async t=>{
 const f=fixture(t,{handlers:{rename:async({data})=>structuredClone(data)}});await f.controller.ready;await f.open();f.input('group-name','Proposed');f.root.querySelector('form').dispatch('submit');f.confirm();await flush();assert.match(f.root.textContent,/保存結果を確認できません/);assert.equal(f.byId('group-name').value,'Proposed');assert.equal(f.button('save').disabled,true);assert.equal(f.changes.length,0);assert.deepEqual(f.uncertain,[{workspaceId:'studio'}]);f.root.querySelector('form').dispatch('submit');assert.equal(f.calls.filter(item=>item.kind==='rename').length,1);f.button('reload').dispatch('click');f.cancel();assert.equal(f.byId('group-name').value,'Proposed');f.button('reload').dispatch('click');f.confirm();await flush();assert.equal(f.calls.at(-1).kind,'list');assert.equal(f.clients.length,2);assert.equal(f.clients[0].destroyed,true);assert.equal(f.byId('group-name'),undefined);f.controller.destroy();assert.equal(f.uncertain.length,1);
});

test('busy mutation prevents reentry and destruction cannot apply a late success or private DOM',async t=>{
 const pending=deferred(),f=fixture(t,{handlers:{rename:()=>pending.promise}});await f.controller.ready;await f.open();f.input('group-name','Pending');f.root.querySelector('form').dispatch('submit');f.confirm();assert.equal(f.controller.closeState.busy,true);assert.equal(f.controller.canClose(),false);f.root.querySelector('form').dispatch('submit');assert.equal(f.calls.filter(item=>item.kind==='rename').length,1);f.controller.destroy();assert.deepEqual(f.uncertain,[{workspaceId:'studio'}]);pending.resolve({...detail(),revision:5,group:{...detail().group,name:'Pending'}});await flush();assert.equal(f.root.textContent,'');assert.equal(f.changes.length,0);assert.equal(f.controller.canClose(),true);assert.equal(f.uncertain.length,1);
});

test('destroyed startup stops later reads and a changed actor clears private lists, drafts and candidates',async t=>{
 const pending=deferred(),f=fixture(t,{handlers:{list:()=>pending.promise}});await flush();f.controller.destroy();pending.resolve({workspaceId:'studio',revision:4,canManage:true,groups:[detail().group]});await f.controller.ready;assert.equal(f.calls.some(item=>item.kind==='read'),false);assert.equal(f.root.textContent,'');
 const g=fixture(t,{handlers:{rename:async()=>{throw Object.assign(new Error(),{code:'ACCOUNT_CHANGED',status:409});}}});await g.controller.ready;await g.open();g.input('group-name','Private draft');g.root.querySelector('form').dispatch('submit');g.confirm();await flush();assert.equal(g.byId('group-name'),undefined);assert.doesNotMatch(g.root.textContent,/Private draft|Design|Ren/);assert.equal(g.changes.length,0);assert.equal(g.clients[0].destroyed,true);assert.deepEqual(g.uncertain,[{workspaceId:'studio'}]);g.controller.destroy();
});

test('confirmation callbacks are fenced after cancellation and IME submission sends no command',async t=>{
 const f=fixture(t);await f.controller.ready;await f.open();f.input('group-name','Reviewed');f.root.querySelector('form').dispatch('submit');const stale=f.root.querySelector('dialog').querySelectorAll('button').at(-1);f.cancel();stale.dispatch('click');assert.equal(f.calls.filter(item=>item.kind==='rename').length,0);f.root.dispatch('compositionstart');f.root.querySelector('form').dispatch('submit');assert.equal(f.root.querySelector('dialog'),null);f.root.dispatch('compositionend');f.root.querySelector('form').dispatch('submit');assert.ok(f.root.querySelector('dialog').open);f.cancel();f.controller.destroy();
});

test('standalone startup captures a verified actor before group reads, and destroy during session leaves no content',async t=>{
 const f=settingsDomFixture(t),root=f.doc.createElement('section');f.doc.body.append(root);const pending=deferred();let clients=0;const controller=mountGroupsSettings({root,workspaceId:'studio',catalogs,fetcher:()=>pending.promise,clientFactory:()=>{clients++;throw new Error('Unexpected content client');}});controller.destroy();pending.resolve(Response.json({user:{id:'account-a',emailVerified:true}}));await controller.ready;assert.equal(clients,0);assert.equal(root.textContent,'');assert.throws(()=>mountGroupsSettings({root,embedded:true,workspaceId:'studio',expectedAccountId:null,catalogs}),/INVALID_GROUPS_SETTINGS/);
});

test('literal names never create markup and both catalogs remain discoverable with canonical fallback notices',async t=>{
 const value=detail();value.group.name='<img src=x onerror=alert(1)>';const f=fixture(t,{value});await f.controller.ready;assert.equal(f.root.querySelector('img'),null);assert.match(f.root.textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(validateCatalogParity(catalogs.ja,catalogs.en).valid,true);const manifest=validateLocaleManifest(JSON.parse(await readFile(new URL('../public/locale-manifest.json',import.meta.url),'utf8')));assert.equal(manifest.namespaces.groups,'groups-locales');assert.equal(catalogs.en.localeFallbackNotice,'Some labels use English. Page names and content are not translated.');f.controller.destroy();
});
