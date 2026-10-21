import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {settingsDomFixture} from './fixtures/settings-dom.js';
import {createPageCreator,capturePageCreatorFocus,pageCreationDestinations} from '../public/page-creator.js';
const messages=JSON.parse(await readFile(new URL('../public/workspace-locales/ja.json',import.meta.url),'utf8'));
const translate=key=>{assert.ok(Object.hasOwn(messages,key),key);return messages[key];};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const list=(templates=[])=>({revision:4,scope:'personal-copy',templates,limits:{templates:50,snapshotBytes:32768,blocks:200}});
const stamp='2026-10-20T00:00:00.000Z',meta=id=>({id,name:id,createdAt:stamp,sourceTitle:id,blocks:1});
function setup(t,options={}){
  const fixture=settingsDomFixture(t),calls=[];
  const create=fixture.doc.createElement;fixture.doc.createElement=tag=>{const el=create(tag);el.setCustomValidity=value=>{el.validationMessage=value;};return el;};
  const creator=createPageCreator({document:fixture.doc,t:translate,destinations:[{id:'private',name:'Private',hint:'Private only'},{id:'team:staff',name:'Staff',teamspaceId:'staff',hint:'Staff members'},{id:'page:parent',name:'Parent',parentId:'parent',hint:'Inherits from parent'}],initialDestination:'private',personalHref:'/templates?workspace=studio',loadPersonalList:async()=>list(),loadPersonalItem:async()=>{throw Error();},onCreate:async value=>{calls.push(value);},...options});
  fixture.doc.body.append(creator.root);return{...fixture,creator,calls,root:creator.root};
}
const card=(root,id)=>root.querySelectorAll('[data-page-template]').find(row=>row.getAttribute('data-page-template')===id);
test('destinations preserve manageable record and template parents and omit unavailable pages and teamspaces',()=>{
  const rows=pageCreationDestinations({t:translate,canManage:item=>item.capabilities.includes('manage'),pages:[{id:'normal',title:'Page',capabilities:['manage']},{id:'record',title:'Issue',recordId:'record-a',capabilities:['manage']},{id:'template',title:'Template',templateId:'template-a',capabilities:['manage']},{id:'viewer',title:'Read only',capabilities:['read']}],teamspaces:[{id:'staff',name:'Staff',capabilities:['createPage']},{id:'archived',name:'Archived',archivedAt:stamp,capabilities:['createPage']},{id:'readers',name:'Readers',capabilities:['read']}]});
  assert.deepEqual(rows.map(row=>row.id),['private','team:staff','page:normal','page:record','page:template']);assert.equal(rows.find(row=>row.id==='page:record').parentId,'record');
});
test('choosing a starter previews content and creates only on explicit submit at the chosen destination',async t=>{
  const f=setup(t,{initialDestination:'page:parent'});await f.creator.ready;card(f.root,'starter:issue').focus();card(f.root,'starter:issue').dispatch('click');
  assert.match(f.root.querySelector('.page-template-document').textContent,/再現手順/);assert.equal(f.calls.length,0);assert.equal(f.doc.activeElement.getAttribute('data-page-template'),'starter:issue');
  f.root.dispatch('submit');await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].parentId,'parent');assert.equal(f.calls[0].teamspaceId,null);assert.equal(f.calls[0].title,'課題報告');assert.equal(f.calls[0].observedRevision,4);
  const destination=f.root.querySelector('select');destination.value='team:staff';destination.dispatch('change');assert.equal(f.root.querySelector('.page-create-destination-hint').textContent,'Staff members');
  f.root.dispatch('submit');await flush();assert.equal(f.calls[1].teamspaceId,'staff');assert.equal(f.calls[1].parentId,null);assert.equal(f.editor.textContent,'Unchanged body draft');
});
test('custom title survives template selection, search has no create side effects, arrow keys keep keyboard focus',async t=>{
  const f=setup(t);await f.creator.ready;const title=f.root.querySelector('#new-page-title');title.value='自分のページ';title.dispatch('input');card(f.root,'starter:meeting').dispatch('click');assert.equal(title.value,'自分のページ');
  card(f.root,'starter:meeting').dispatch('keydown',{key:'ArrowRight'});assert.equal(f.doc.activeElement.getAttribute('data-page-template'),'starter:project');
  const search=f.root.querySelector('input[type="search"]');search.value='手順書';search.dispatch('input');assert.equal(f.root.querySelectorAll('[data-page-template]').length,1);assert.equal(f.root.querySelector('[data-page-template]').getAttribute('data-page-template'),'starter:guide');
  assert.equal(search.dispatch('keydown',{key:'Enter'}).prevented,true);assert.equal(f.calls.length,0);
  search.value='見つからない';search.dispatch('input');assert.match(f.root.querySelector('.page-template-gallery').textContent,/一致するテンプレートがありません/);
});
test('late personal reads cannot replace a new selection and errors leave builtin templates usable',async t=>{
  const read=deferred(),f=setup(t,{loadPersonalList:async()=>list([meta('mine')]),loadPersonalItem:()=>read.promise});await f.creator.ready;card(f.root,'personal:mine').dispatch('click');assert.equal(f.root.querySelector('button[type="submit"]').disabled,true);
  card(f.root,'starter:guide').dispatch('click');read.resolve({revision:4,template:{...meta('mine'),snapshot:{title:'mine',blocks:[{type:'paragraph',data:{text:'Late private content'}}]}},copySemantics:'independent'});await flush();
  assert.doesNotMatch(f.root.querySelector('.page-template-document').textContent,/Late private content/);assert.equal(f.root.querySelector('button[type="submit"]').disabled,false);
  const g=setup(t,{loadPersonalList:async()=>{throw Error('offline');}});await g.creator.ready;assert.match(g.root.querySelector('.page-template-list-status').textContent,/用意されたテンプレートは利用できます/);g.root.dispatch('submit');await flush();assert.equal(g.calls.length,1);
});
test('personal content is literal, cannot submit until validated, and closing ignores an in-flight read',async t=>{
  const read=deferred(),f=setup(t,{loadPersonalList:async()=>list([meta('mine')]),loadPersonalItem:()=>read.promise});await f.creator.ready;card(f.root,'personal:mine').dispatch('click');f.root.dispatch('submit');assert.equal(f.calls.length,0);
  read.resolve({revision:7,template:{...meta('mine'),snapshot:{title:'mine',blocks:[{type:'paragraph',data:{text:'<img src=x onerror=alert(1)>',marks:[{start:0,end:4,styles:['bold']}]} }]}},copySemantics:'independent'});await flush();assert.match(f.root.querySelector('.page-template-document').textContent,/<img/);assert.equal(f.root.querySelectorAll('img').length,0);f.root.dispatch('submit');await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].observedRevision,7);
  const late=deferred(),g=setup(t,{loadPersonalList:()=>late.promise});g.creator.destroy();const before=g.root.textContent;late.resolve(list([meta('hidden')]));await g.creator.ready;assert.equal(g.root.textContent,before);
});
test('IME, duplicate submissions and unknown write outcomes cannot create extra pages',async t=>{
  const write=deferred(),f=setup(t,{onCreate:value=>{f.calls.push(value);return write.promise;}});await f.creator.ready;
  f.root.dispatch('compositionstart');f.root.dispatch('submit');assert.equal(f.calls.length,0);f.root.dispatch('compositionend');
  f.root.dispatch('submit');f.root.dispatch('submit');assert.equal(f.calls.length,1);write.resolve({blocked:true});await flush();assert.ok(f.root.querySelectorAll('input,select,button').every(control=>control.disabled));f.root.dispatch('submit');assert.equal(f.calls.length,1);
});
test('dialog cancellation returns focus to a replaced opener without stealing it from an active editor',t=>{
  const f=settingsDomFixture(t);f.trigger.setAttribute('aria-label','子ページを追加');const restore=capturePageCreatorFocus({document:f.doc,root:f.background});
  const next=f.doc.createElement('button');next.setAttribute('aria-label','子ページを追加');f.background.append(next);f.trigger.remove();f.doc.body.focus();
  const dialog=f.doc.createElement('dialog');restore(dialog);assert.equal(f.doc.activeElement,next);
  f.editor.focus();restore(dialog);assert.equal(f.doc.activeElement,f.editor);
  const menu=f.doc.createElement('button');menu.setAttribute('id','row-menu');f.background.append(menu);const action=f.doc.createElement('button');action.setAttribute('data-menu-trigger-id','row-menu');action.textContent='Add child';f.background.append(action);action.focus();
  const fromMenu=capturePageCreatorFocus({document:f.doc,root:f.background});action.remove();f.doc.body.focus();fromMenu(dialog);assert.equal(f.doc.activeElement,menu);
});

test('kanban and table previews submit reference-free recipes only after explicit creation',async t=>{
 const f=setup(t);await f.creator.ready;
 for(const[id,type]of [['kanban','board'],['taskTable','table'],['simpleTable','simple-table']]){
  card(f.root,'starter:'+id).dispatch('click');const preview=f.root.querySelector('.page-template-document');
  if(type==='board'){assert.equal(preview.querySelectorAll('.page-template-board-column').length,3);assert.match(preview.textContent,/未着手.*進行中.*完了/);}
  else assert.equal(preview.querySelectorAll('table').length,1);
  assert.equal(f.calls.length,['kanban','taskTable','simpleTable'].indexOf(id));f.root.dispatch('submit');await flush();
  const value=f.calls.at(-1);assert.equal(value.starter.type,type);assert.deepEqual(Object.keys(value.starter),['type','labels']);assert.deepEqual(value.snapshot.blocks,[]);
 }
 const search=f.root.querySelector('input[type="search"]');search.value='表';search.dispatch('input');assert.deepEqual(f.root.querySelectorAll('[data-page-template]').map(row=>row.getAttribute('data-page-template')),['starter:taskTable','starter:simpleTable']);
 assert.equal(f.editor.textContent,'Unchanged body draft');
});
