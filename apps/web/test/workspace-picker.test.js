import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWorkspacePicker} from '../public/workspace-picker.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';

const entry={id:'studio',name:'Studio',slug:'studio'},other={id:'notes',name:'Notes',slug:'notes'};
const model=()=>({user:{id:'account-a',name:'Aoi'},workspaces:[entry,other]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function fixture(t,{load=async()=>model(),create=async input=>({id:'created',...input}),navigate=async()=>false}={}){
 const f=settingsDomFixture(t),calls=[],client={creationUncertain:false,destroyed:0,async load(){calls.push({kind:'load'});return load();},async create(input){calls.push({kind:'create',input});return create(input);},destroy(){this.destroyed++;}},urls=[],closed=[];
 const picker=mountWorkspacePicker({document:f.doc,background:f.background,workspaceId:'studio',expectedAccountId:'account-a',labels:key=>'label:'+key,directory:client,onNavigate:async href=>{urls.push(href);return navigate(href);},onClose:()=>closed.push(true)});
 const button=label=>picker.element.querySelectorAll('button').find(item=>item.textContent==='label:'+label);
 const enter=(name,slug)=>{button('create').dispatch('click');const n=picker.element.querySelector('#workspace-picker-name'),s=picker.element.querySelector('#workspace-picker-slug');n.value=name;n.dispatch('input');s.value=slug;s.dispatch('input');return picker.element.querySelector('form');};
 return{...f,picker,client,calls,urls,closed,button,enter};
}
test('the mounted picker preserves editor DOM and restores backward selection, focus and prior state on close',async t=>{
 const f=settingsDomFixture(t),nodes=[...f.editor.childNodes];f.select(f.editor,2,8,'backward');f.trigger.focus();let destroyed=0;
 const picker=mountWorkspacePicker({document:f.doc,background:f.background,workspaceId:'studio',expectedAccountId:'account-a',labels:key=>key,onNavigate:()=>false,directory:{async load(){return model();},destroy(){destroyed++;}}});await picker.ready;
 assert.equal(f.background.inert,true);assert.equal(f.doc.body.style.overflow,'hidden');assert.equal(picker.element.querySelector('[aria-current=true]').textContent,'SStudiocurrent');assert.equal(picker.canClose(),true);
 assert.equal(picker.requestClose(),true);assert.equal(picker.open,false);assert.equal(f.background.inert,undefined);assert.equal(f.doc.body.style.overflow,'auto');assert.equal(f.doc.activeElement,f.trigger);assert.equal(f.selection.anchorOffset,8);assert.equal(f.selection.focusOffset,2);assert.deepEqual(f.editor.childNodes,nodes);assert.equal(destroyed,1);assert.equal(f.listeners.get('keydown').size,0);assert.equal(f.listeners.get('window:beforeunload').size,0);picker.destroy();assert.equal(destroyed,1);
});
test('workspace choices only delegate safe fixed URLs and a rejected outer draft transition keeps the popup open',async t=>{
 let allowed=false;const f=fixture(t,{navigate:async()=>allowed});await f.picker.ready;
 f.picker.element.querySelectorAll('.workspace-picker-option')[1].dispatch('click');await flush();assert.deepEqual(f.urls,['/workspace?workspace=notes']);assert.equal(f.picker.open,true);assert.equal(f.doc.activeElement,f.picker.element.querySelector('.workspace-picker-close'));
 allowed=true;f.picker.element.querySelectorAll('.workspace-picker-option')[1].dispatch('click');await flush();assert.equal(f.picker.open,false);assert.equal(f.closed.length,1);assert.equal(f.client.destroyed,1);
});
test('unsaved creation input guards switching and only explicit discard invokes the captured destination',async t=>{
 const f=fixture(t);await f.picker.ready;f.enter('My notes','my-notes');assert.deepEqual(f.picker.closeState,{busy:false,dirty:true});assert.equal(f.picker.canClose(),false);
 f.picker.element.querySelectorAll('.workspace-picker-option')[1].dispatch('click');assert.deepEqual(f.urls,[]);assert.ok(f.picker.element.querySelector('.workspace-picker-discard'));
 f.button('keepEditing').dispatch('click');assert.equal(f.picker.element.querySelector('#workspace-picker-name').value,'My notes');assert.equal(f.picker.open,true);
 f.picker.element.querySelectorAll('.workspace-picker-option')[1].dispatch('click');f.button('discard').dispatch('click');await flush();assert.deepEqual(f.urls,['/workspace?workspace=notes']);assert.equal(f.picker.closeState.dirty,false);assert.equal(f.picker.element.querySelector('form'),null);f.picker.destroy();
});
test('Escape and unload protect the creation draft while IME Escape does not open or dismiss confirmation',async t=>{
 const f=fixture(t);await f.picker.ready;f.enter('Draft','draft');f.picker.element.dispatch('compositionstart');assert.equal(f.keydown({key:'Escape'}).prevented,false);f.picker.element.dispatch('cancel');assert.equal(f.picker.element.querySelector('.workspace-picker-discard'),null);assert.equal(f.picker.open,true);
 f.picker.element.dispatch('compositionend');assert.equal(f.keydown({key:'Escape'}).prevented,true);assert.ok(f.picker.element.querySelector('.workspace-picker-discard'));assert.equal(f.keydown({key:'Escape'}).prevented,true);assert.equal(f.picker.element.querySelector('.workspace-picker-discard'),null);assert.equal(f.picker.element.querySelector('#workspace-picker-name').value,'Draft');
 const event={prevented:false,preventDefault(){this.prevented=true;}};for(const listener of f.listeners.get('window:beforeunload'))listener(event);assert.equal(event.prevented,true);assert.equal(event.returnValue,'');f.picker.destroy();
});
test('pending creation is non-reentrant and cannot be closed; success adds one workspace before guarded navigation',async t=>{
 const pending=deferred(),f=fixture(t,{create:()=>pending.promise});await f.picker.ready;f.enter('New','new').dispatch('submit');assert.equal(f.picker.closeState.busy,true);assert.equal(f.picker.requestClose(),false);f.picker.element.querySelector('form').dispatch('submit');assert.equal(f.calls.filter(item=>item.kind==='create').length,1);assert.equal(f.picker.element.querySelector('#workspace-picker-name').disabled,true);
 pending.resolve({id:'new',name:'New',slug:'new'});await flush();assert.deepEqual(f.urls,['/workspace?workspace=new']);assert.equal(f.picker.open,true);assert.deepEqual(f.picker.closeState,{busy:false,dirty:false});assert.equal(f.picker.element.querySelectorAll('.workspace-picker-option').length,3);assert.equal(f.picker.element.querySelector('form'),null);assert.match(f.picker.element.textContent,/label:created/);f.picker.destroy();
});
test('a known creation refusal retains the form and an uncertain result hides the private list and prevents another submission',async t=>{
 let uncertain=false;const f=fixture(t,{create:async()=>{if(uncertain){f.client.creationUncertain=true;throw Object.assign(new Error(),{code:'CREATE_UNCONFIRMED'});}throw Object.assign(new Error(),{code:'REQUEST_FAILED',status:400});}});await f.picker.ready;f.enter('New','new').dispatch('submit');await flush();assert.equal(f.picker.element.querySelector('#workspace-picker-name').value,'New');assert.equal(f.picker.element.querySelectorAll('.workspace-picker-option').length,2);assert.equal(f.urls.length,0);
 uncertain=true;f.picker.element.querySelector('form').dispatch('submit');await flush();assert.match(f.picker.element.textContent,/label:createUnconfirmed/);assert.equal(f.picker.element.querySelectorAll('.workspace-picker-option').length,0);assert.equal(f.picker.element.querySelector('form'),null);assert.equal(f.button('create'),undefined);assert.equal(f.button('reload'),undefined);assert.equal(f.calls.filter(item=>item.kind==='create').length,2);f.picker.destroy();
});
test('closing during startup destroys its scope and no late response can repopulate the detached popup',async t=>{
 const pending=deferred(),f=fixture(t,{load:()=>pending.promise});assert.equal(f.picker.canClose(),true);assert.equal(f.picker.requestClose(),true);assert.equal(f.client.destroyed,1);assert.equal(f.doc.activeElement,f.trigger);
 pending.resolve(model());await f.picker.ready;assert.equal(f.picker.element.isConnected,false);assert.equal(f.picker.element.querySelectorAll('.workspace-picker-option').length,0);assert.equal(f.calls.length,1);
});
test('revoked current membership and actor errors release no workspace entries and the account link still uses guarded navigation',async t=>{
 const f=fixture(t,{load:async()=>({...model(),workspaces:[other]})});await f.picker.ready;assert.equal(f.picker.element.querySelectorAll('.workspace-picker-option').length,0);assert.match(f.picker.element.textContent,/label:workspaceUnavailable/);
 const account=f.picker.element.querySelector('a');const event=account.dispatch('click',{button:0});assert.equal(event.prevented,true);await flush();assert.deepEqual(f.urls,['/account#account']);f.picker.destroy();
});
test('Tab wraps within the current popup or discard guard and another native modal owns its own Escape',async t=>{
 const f=fixture(t);await f.picker.ready;const choices=f.picker.element.querySelectorAll('a[href],button,input');choices.at(-1).focus();assert.equal(f.keydown({key:'Tab'}).prevented,true);assert.equal(f.doc.activeElement,choices[0]);choices[0].focus();assert.equal(f.keydown({key:'Tab',shiftKey:true}).prevented,true);assert.equal(f.doc.activeElement,choices.at(-1));
 const child=f.doc.createElement('dialog'),input=f.doc.createElement('input');child.append(input);f.doc.body.append(child);child.showModal();input.focus();assert.equal(f.keydown({key:'Escape',target:input}).prevented,false);assert.equal(f.picker.open,true);child.close();child.remove();f.picker.destroy();
});
test('another open native modal blocks mounting and literal names never become markup or navigation targets',async t=>{
 const f=fixture(t,{load:async()=>({...model(),workspaces:[{...entry,name:'<img src=x onerror=alert(1)>'},other]})});await f.picker.ready;assert.equal(f.picker.element.querySelector('img'),null);assert.match(f.picker.element.textContent,/<img src=x onerror=alert\(1\)>/);
 assert.throws(()=>mountWorkspacePicker({document:f.doc,background:f.background,workspaceId:'studio',expectedAccountId:'account-a',onNavigate:()=>false}),/MODAL_OPEN/);f.picker.destroy();
});
test('account and management links retain native modified-click behavior and dirty ordinary clicks require discard',async t=>{
 const f=fixture(t);await f.picker.ready;f.enter('Draft','draft');const links=f.picker.element.querySelectorAll('a');assert.equal(links[1].dispatch('click',{button:0,ctrlKey:true}).prevented,false);assert.equal(f.urls.length,0);
 assert.equal(links[1].dispatch('click',{button:0}).prevented,true);assert.ok(f.picker.element.querySelector('.workspace-picker-discard'));assert.equal(f.urls.length,0);f.button('discard').dispatch('click');await flush();assert.deepEqual(f.urls,['/share?workspace=studio']);f.picker.destroy();
});
