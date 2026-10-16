import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {settingsDomFixture} from './fixtures/settings-dom.js';
import {mountSettingsDialog,settingsHrefSection} from '../public/settings-dialog.js';
import {mountPreferencesPage,preferenceDraftChanged} from '../public/preferences-page.js';
import {PreferencesStore} from '../public/preferences.js';

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
// Instance-local DOM extensions exercise lifecycle and focus contracts, not browser layout.
const fixture=settingsDomFixture;
function mounts(f,{dirty=false,busy=false}={}){
 const calls=[],state={dirty,busy};
 const make=kind=>options=>{const record={kind,options,destroyed:0,sections:[]};calls.push(record);options.root.replaceChildren(f.doc.createTextNode(kind));return{ready:Promise.resolve(),canClose:()=>!state.busy&&!state.dirty,get closeState(){return{...state};},destroy(){record.destroyed++;},focusSection(value){record.sections.push(value);}};};
 return{calls,state,value:{preferences:make('preferences'),workspace:make('workspace'),members:make('members'),teamspaces:make('teamspaces'),groups:make('groups')}};
}
const options=f=>({document:f.doc,background:f.background,workspaceId:'studio',expectedAccountId:'account-a',pageId:'page-a',labels:key=>key});

test('resource sharing exposes people and roles without workspace administration or personal preference navigation',async t=>{
 const f=fixture(t),m=mounts(f),dialog=mountSettingsDialog({...options(f),resource:{kind:'collection',title:'Synthetic tasks'},initialSection:'members',mounts:m.value});await dialog.ready;
 assert.equal(m.calls[0].kind,'members');assert.equal(m.calls[0].options.resourceOnly,true);assert.equal(m.calls[0].options.resourceKind,'collection');assert.equal(m.calls[0].options.pageId,'page-a');
 assert.deepEqual(dialog.element.querySelectorAll('[data-settings-section]').map(element=>element.getAttribute('data-settings-section')),['members','groups']);assert.equal(dialog.requestSection('appearance'),false);assert.equal(dialog.requestSection('teamspaces'),false);
 m.state.dirty=true;assert.equal(dialog.requestSection('groups'),false);assert.equal(m.calls.length,1);dialog.element.querySelector('.settings-dialog-discard').querySelectorAll('button')[0].dispatch('click');m.state.dirty=false;assert.equal(dialog.requestSection('groups'),true);await flush();assert.equal(m.calls[1].options.resourceOnly,true);assert.equal(m.calls[1].options.resourceKind,'collection');assert.equal(m.calls[0].destroyed,1);dialog.destroy();assert.equal(f.editor.textContent,'Unchanged body draft');
});

test('only the same-origin current-workspace setting URLs become dialog routes',()=>{
 const base='https://local.invalid/workspace.html?workspace=studio';
 assert.equal(settingsHrefSection('/preferences.html?workspace=studio#font','studio',base),'font');
 assert.equal(settingsHrefSection('/workspace-settings.html?workspace=studio&section=import','studio',base),'import');
 assert.equal(settingsHrefSection('/workspace-settings.html?workspace=studio&section=teamspaces','studio',base),'teamspaces');
 assert.equal(settingsHrefSection('/workspace-settings.html?workspace=studio&section=groups','studio',base),'groups');
 assert.equal(settingsHrefSection('/share.html?workspace=studio','studio',base),'members');
 for(const href of ['https://other.invalid/preferences.html','/workspace-settings.html?workspace=other','/share.html?workspace=studio&workspace=other','/preferences.html?workspace=other','/import.html?workspace=studio'])assert.equal(settingsHrefSection(href,'studio',base),null);
});

test('dialog preserves editor nodes, backward text selection and prior focus/inert/scroll state across category navigation',async t=>{
 const f=fixture(t),m=mounts(f),nodes=[...f.editor.childNodes];f.select(f.editor,2,8,'backward');f.trigger.focus();
 const dialog=mountSettingsDialog({...options(f),mounts:m.value});await dialog.ready;
 assert.equal(f.background.inert,true);assert.equal(f.doc.body.style.overflow,'hidden');
 assert.equal(dialog.requestSection('font'),true);await flush();assert.equal(m.calls.length,1);assert.deepEqual(m.calls[0].sections,['appearance','font']);
 assert.equal(m.calls[0].options.expectedAccountId,'account-a');assert.equal(m.calls[0].options.pageId,'page-a');
 dialog.requestSection('import');await flush();assert.equal(m.calls[0].destroyed,1);assert.equal(m.calls[1].kind,'workspace');
 assert.equal(dialog.requestClose(),true);assert.equal(dialog.open,false);assert.equal(m.calls[1].destroyed,1);assert.equal(f.background.inert,undefined);assert.equal(f.doc.body.style.overflow,'auto');assert.equal(f.doc.activeElement,f.trigger);
 assert.equal(f.selection.anchorOffset,8);assert.equal(f.selection.focusOffset,2);assert.deepEqual(f.editor.childNodes,nodes);assert.equal(f.editor.textContent,'Unchanged body draft');assert.equal(f.listeners.get('keydown').size,0);
});

test('a policy outcome that is unknown reaches the parent before close without being reported as confirmed',async t=>{
 const f=fixture(t),m=mounts(f),events=[];
 const dialog=mountSettingsDialog({...options(f),mounts:m.value,initialSection:'teamspaces',initialTeamspaceId:'team-a',onWorkspaceChanged:value=>events.push(value),onClose:()=>events.push('closed')});await dialog.ready;
 assert.equal(m.calls[0].kind,'teamspaces');assert.equal(m.calls[0].options.teamspaceId,'team-a');
 m.calls[0].options.onPolicyMayHaveChanged({workspaceId:'studio',teamspaceId:'team-a'});
 assert.deepEqual(events,[{status:'unconfirmed'}]);assert.equal(dialog.requestClose(),true);
 assert.deepEqual(events,[{status:'unconfirmed'},'closed']);assert.equal(f.editor.textContent,'Unchanged body draft');
});

test('group settings mount with the captured page and account and preserve host dirty guards and unknown-policy propagation',async t=>{
 const f=fixture(t),m=mounts(f),events=[],nodes=[...f.editor.childNodes],dialog=mountSettingsDialog({...options(f),mounts:m.value,initialSection:'groups',onWorkspaceChanged:value=>events.push(value)});await dialog.ready;
 assert.equal(m.calls[0].kind,'groups');assert.equal(m.calls[0].options.workspaceId,'studio');assert.equal(m.calls[0].options.expectedAccountId,'account-a');assert.equal(m.calls[0].options.pageId,'page-a');assert.equal(m.calls[0].options.embedded,true);m.state.dirty=true;assert.equal(dialog.requestSection('teamspaces'),false);assert.ok(dialog.element.querySelector('.settings-dialog-discard'));dialog.element.querySelector('.settings-dialog-discard').querySelectorAll('button')[0].dispatch('click');assert.equal(m.calls.length,1);
 m.calls[0].options.onPolicyMayHaveChanged({workspaceId:'studio'});assert.deepEqual(events,[{status:'unconfirmed'}]);m.state.dirty=false;assert.equal(dialog.requestSection('teamspaces'),true);await flush();assert.equal(m.calls[0].destroyed,1);assert.equal(m.calls[1].kind,'teamspaces');assert.deepEqual(f.editor.childNodes,nodes);dialog.destroy();
});

test('unsaved preference navigation and close require an explicit discard and Escape keeps the mounted draft',async t=>{
 const f=fixture(t),m=mounts(f,{dirty:true}),dialog=mountSettingsDialog({...options(f),mounts:m.value});await dialog.ready;
 assert.equal(dialog.requestSection('general'),false);assert.equal(m.calls.length,1);assert.ok(dialog.element.querySelector('.settings-dialog-discard'));
 const escape=f.keydown({key:'Escape'});assert.equal(escape.prevented,true);assert.equal(dialog.element.querySelector('.settings-dialog-discard'),null);assert.equal(dialog.open,true);assert.equal(m.calls[0].destroyed,0);
 dialog.requestClose();const choices=dialog.element.querySelector('.settings-dialog-discard').querySelectorAll('button');choices[0].dispatch('click');assert.equal(dialog.open,true);
 dialog.requestClose();dialog.element.querySelector('.settings-dialog-discard').querySelectorAll('button')[1].dispatch('click');assert.equal(dialog.open,false);assert.equal(m.calls[0].destroyed,1);
});

test('pending setting operations block close and focus wraps only inside the active dialog',async t=>{
 const f=fixture(t),m=mounts(f,{busy:true}),dialog=mountSettingsDialog({...options(f),mounts:m.value});await dialog.ready;
 assert.equal(dialog.requestClose(),false);assert.equal(dialog.open,true);assert.equal(dialog.element.querySelector('.settings-dialog-discard'),null);
 const buttons=dialog.element.querySelectorAll('button');buttons.at(-1).focus();assert.equal(f.keydown({key:'Tab'}).prevented,true);assert.equal(f.doc.activeElement,buttons[0]);
 buttons[0].focus();assert.equal(f.keydown({key:'Tab',shiftKey:true}).prevented,true);assert.equal(f.doc.activeElement,buttons.at(-1));
 m.state.busy=false;assert.equal(dialog.requestClose(),true);
});

test('a delayed previous controller mounts only into its detached root and is destroyed without replacing the current category',async t=>{
 const f=fixture(t),pending=deferred();let oldDestroyed=0,oldRoot;
 const dialog=mountSettingsDialog({...options(f),mounts:{preferences:async options=>{oldRoot=options.root;await pending.promise;options.root.textContent='Late old response';return{ready:Promise.resolve(),destroy(){oldDestroyed++;}};},workspace:options=>{options.root.textContent='Current workspace settings';return{ready:Promise.resolve(),canClose:()=>true,destroy(){}};}}});
 dialog.requestSection('general');await flush();assert.match(dialog.element.textContent,/Current workspace settings/);
 pending.resolve();await dialog.ready;assert.equal(oldDestroyed,1);assert.equal(oldRoot.isConnected,false);assert.doesNotMatch(dialog.element.textContent,/Late old response/);dialog.destroy();
});

test('preference dirty comparison normalizes equivalent colors and treats invalid unsaved inputs as dirty',()=>{
 const store=new PreferencesStore({storage:{getItem:()=>null,setItem(){}}}),saved=store.snapshot();
 assert.equal(preferenceDraftChanged(store,{...saved,followSystem:false}),false);
 assert.equal(preferenceDraftChanged(store,{...saved,fontId:'monospace'}),true);
 assert.equal(preferenceDraftChanged(store,{...saved,customColors:{canvas:'invalid'}}),true);
 store.update({customColors:{accent:'#385772'}});assert.equal(preferenceDraftChanged(store,{...store.snapshot(),customColors:{accent:'rgb(56, 87, 114)'}}),false);
});

function preferencesEnvironment(f,{session='account-a',pendingSession}={}){
 const saved={schemaVersion:1,themeId:'light',customColors:{},fontId:'system',locale:'ja'},values=new Map([['yumunio.preferences.v1:account-a',JSON.stringify(saved)]]),writes=[];let actor=session;
 Object.defineProperty(globalThis,'localStorage',{value:{getItem:key=>values.get(key)??null,setItem(key,value){writes.push({key,value});values.set(key,value);}},configurable:true});
 Object.defineProperty(globalThis,'fetch',{value:async url=>{
  if(String(url)==='/api/instance')return new Response('{}',{status:503});
  if(String(url)==='/api/auth/get-session'){if(pendingSession)await pendingSession.promise;return Response.json({user:{id:actor,name:'Example',email:'example@invalid.test',emailVerified:true}});}
  if(new URL(url).protocol==='file:')return new Response(await readFile(url));
  throw new Error('Unexpected request '+url);
 },configurable:true});
 return{saved,values,writes,set actor(value){actor=value;}};
}

test('destroyed preference startup cannot render or install global listeners after its delayed session response',async t=>{
 const f=fixture(t),pending=deferred(),env=preferencesEnvironment(f,{pendingSession:pending}),root=f.doc.createElement('section');f.doc.body.append(root);
 const controller=mountPreferencesPage({root,embedded:true,workspaceId:'studio',expectedAccountId:'account-a'});controller.destroy();pending.resolve();await controller.ready;
 assert.equal(root.childNodes.length,0);assert.equal(env.writes.length,0);assert.equal([...f.listeners.values()].reduce((count,set)=>count+set.size,0),0);
});

test('mounted preferences use the current account store, retain unsaved changes, and reject a changed account before saving',async t=>{
 const f=fixture(t),env=preferencesEnvironment(f),root=f.doc.createElement('section');f.doc.body.append(root);let changed=0;
 const controller=mountPreferencesPage({root,embedded:true,workspaceId:'studio',expectedAccountId:'account-a',onChange:()=>changed++});await controller.ready;
 assert.ok(root.querySelector('#preference-form'));assert.equal(controller.canClose(),true);assert.equal(root.querySelectorAll('input[name=theme]').length,6);
 const font=root.querySelector('#preference-font');font.value='monospace';font.dispatch('change');assert.equal(controller.closeState.dirty,true);assert.equal(controller.canClose(),false);assert.equal(env.writes.length,0);
 env.actor='account-b';root.querySelector('#save-local').dispatch('click');await flush();assert.equal(env.writes.length,0);assert.equal(changed,0);assert.equal(root.querySelector('#save-local').disabled,true);assert.match(root.querySelector('#preferences-status').textContent,/account|\u30a2\u30ab\u30a6\u30f3\u30c8/i);
 controller.destroy();assert.equal([...f.listeners.values()].reduce((count,set)=>count+set.size,0),0);
});


test('IME Escape does not close settings and external import navigation reaches the outer draft guard only after discard',async t=>{
 const f=fixture(t),m=mounts(f,{dirty:true}),destinations=[],dialog=mountSettingsDialog({...options(f),mounts:m.value,onNavigateOut:href=>destinations.push(href)});await dialog.ready;
 const event=f.keydown({key:'Escape',isComposing:true});assert.equal(event.prevented,false);assert.equal(dialog.open,true);assert.equal(dialog.element.querySelector('.settings-dialog-discard'),null);
 const link=f.doc.createElement('a');link.setAttribute('href','/import.html?workspace=studio&source=notion');dialog.element.querySelector('.settings-dialog-panel').append(link);
 const click=dialog.element.dispatch('click',{target:link,button:0});assert.equal(click.prevented,true);assert.deepEqual(destinations,[]);assert.ok(dialog.element.querySelector('.settings-dialog-discard'));
 dialog.element.querySelector('.settings-dialog-discard').querySelectorAll('button')[1].dispatch('click');assert.deepEqual(destinations,['https://local.invalid/import.html?workspace=studio&source=notion']);assert.equal(dialog.open,false);assert.equal(f.editor.textContent,'Unchanged body draft');
});

test('unsaved settings protect browser unload and remove the protection after the dialog closes',async t=>{
 const f=fixture(t),m=mounts(f,{dirty:true}),dialog=mountSettingsDialog({...options(f),mounts:m.value});await dialog.ready;
 const event={prevented:false,preventDefault(){this.prevented=true;}};for(const fn of f.listeners.get('window:beforeunload'))fn(event);
 assert.equal(event.prevented,true);assert.equal(event.returnValue,'');dialog.destroy();assert.equal(f.listeners.get('window:beforeunload').size,0);
});

test('saving mounted preferences persists the matching profile and clears the unsaved close guard without changing the body',async t=>{
 const f=fixture(t),env=preferencesEnvironment(f),root=f.doc.createElement('section');f.doc.body.append(root);let changed=0;
 const controller=mountPreferencesPage({root,embedded:true,workspaceId:'studio',expectedAccountId:'account-a',onChange:()=>changed++});await controller.ready;
 const nodes=[...f.editor.childNodes],font=root.querySelector('#preference-font');font.value='monospace';font.dispatch('change');assert.equal(controller.canClose(),false);
 root.querySelector('#save-local').dispatch('click');await flush();assert.equal(changed,1);assert.equal(env.writes.length,1);assert.equal(env.writes[0].key,'yumunio.preferences.v1:account-a');assert.equal(JSON.parse(env.writes[0].value).fontId,'monospace');assert.equal(controller.canClose(),true);assert.deepEqual(f.editor.childNodes,nodes);controller.destroy();
});


test('a native child confirmation dialog owns Escape and Tab until it closes',async t=>{
 const f=fixture(t),m=mounts(f),dialog=mountSettingsDialog({...options(f),mounts:m.value});await dialog.ready;
 const child=f.doc.createElement('dialog');dialog.element.querySelector('.settings-dialog-panel').append(child);child.showModal();
 assert.equal(f.keydown({key:'Escape'}).prevented,false);assert.equal(f.keydown({key:'Tab'}).prevented,false);assert.equal(f.keydown({key:'Tab',shiftKey:true}).prevented,false);assert.equal(dialog.requestClose(),false);assert.equal(dialog.open,true);
 assert.equal(dialog.element.dispatch('cancel',{target:child}).prevented,false);assert.equal(dialog.open,true);
 child.close();const sibling=f.doc.createElement('dialog'),siblingButton=f.doc.createElement('button');sibling.append(siblingButton);f.doc.body.append(sibling);sibling.showModal();siblingButton.focus();
 assert.equal(f.keydown({key:'Escape',target:siblingButton}).prevented,false);assert.equal(f.keydown({key:'Tab'}).prevented,false);assert.equal(dialog.open,true);
 sibling.close();assert.equal(f.keydown({key:'Escape'}).prevented,true);assert.equal(dialog.open,false);
});
