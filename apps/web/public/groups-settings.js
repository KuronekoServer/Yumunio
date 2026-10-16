import {GroupsClient,validateGroups,validateGroupGrants} from './groups-client.js';
import {TeamspaceClientError} from './teamspace-client.js';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors} from './preferences.js';
import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {createI18n,loadCatalogs,applyLocaleDocument} from './i18n.js';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const invalid=()=>{throw new TeamspaceClientError('INVALID_RESPONSE');};

/** One controller for the editor settings dialog and the existing standalone settings URL. */
export function mountGroupsSettings({root,embedded=false,workspaceId,expectedAccountId=null,pageId=null,resourceOnly=false,resourceKind='page',resourceTitle='',onChange,onPolicyMayHaveChanged,onNavigate,clientFactory=options=>new GroupsClient(options),catalogs,fetcher=globalThis.fetch}={}){
 if(!root?.ownerDocument||!validId(workspaceId)||expectedAccountId!==null&&!validId(expectedAccountId)||embedded&&!validId(expectedAccountId)||pageId!==null&&!validId(pageId)||typeof clientFactory!=='function'||typeof fetcher!=='function')throw new TypeError('INVALID_GROUPS_SETTINGS');
 const document=root.ownerDocument,view=document.defaultView??globalThis.window,lifecycle=new AbortController(),fetchCall=(...args)=>fetcher(...args);
 let actorId=expectedAccountId,active=true,generation=0,client=null,i18n=null,confirmation=null,pending=null,composing=false,controls=[],stopAppearance=()=>{};
 const state={list:null,detail:null,page:null,groupId:null,loading:true,busy:false,locked:false,error:'',notice:'',creating:false,name:'',baseline:'',candidate:'',permission:'viewer',includeDescendants:false,permissionBaseline:'viewer',scopeBaseline:false};
 const t=(key,values)=>i18n?.t(key,values)??key,disabled=()=>state.loading||state.busy||state.locked;
 const nameDirty=()=>state.name!==state.baseline,sharingDirty=()=>state.permission!==state.permissionBaseline||state.includeDescendants!==state.scopeBaseline,dirty=()=>nameDirty()||!!state.candidate||sharingDirty();
 function node(tag,attrs={},children=[]){const element=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(value===false||value===null||value===undefined)continue;if(key==='class')element.className=value;else if(key.startsWith('on'))element.addEventListener(key.slice(2).toLowerCase(),value);else if(['disabled','checked','value','required'].includes(key))element[key]=value;else element.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)element.append(child?.nodeType?child:document.createTextNode(String(child)));return element;}
 const control=(element,blocked)=>{controls.push({element,blocked});element.disabled=Boolean(blocked());return element;};
 const button=(key,action,blocked=disabled,attrs={})=>{const marker=generation,element=node('button',{type:'button',class:'button',...attrs},t(key));element.addEventListener('click',()=>{if(active&&marker===generation&&!element.disabled&&!blocked())action();});return control(element,blocked);};
 function updateControls(){for(const{element,blocked}of controls)element.disabled=Boolean(blocked());const hint=root.querySelector('[data-group-draft-hint]');if(hint)hint.hidden=!dirty();}
 function clearPrivate(){state.list=state.detail=state.page=null;state.groupId=null;state.creating=false;state.name=state.baseline=state.candidate='';state.permission=state.permissionBaseline='viewer';state.includeDescendants=state.scopeBaseline=false;}
 function closeConfirmation(){const dialog=confirmation;confirmation=null;if(dialog?.open)dialog.close();dialog?.remove();}
 function confirm(key,action,{discard=false,description=''}={}){
  if(!active||state.busy||state.loading||confirmation?.open)return false;const marker=generation,prior=document.activeElement;
  if(resourceOnly&&resourceTitle)description=resourceTitle+'\n'+description;
  const cancel=button(discard?'keepEditing':'cancel',()=>{closeConfirmation();if(prior?.isConnected)prior.focus({preventScroll:true});},()=>false);
  let dialog;const accept=button(discard?'discardChanges':'confirm',()=>{if(!active||confirmation!==dialog||marker!==generation||state.busy||state.loading)return;closeConfirmation();action();},()=>false,{class:'button primary'});
  dialog=node('dialog',{class:'group-confirm','aria-labelledby':'group-confirm-title'},[node('h2',{id:'group-confirm-title'},t(key)),...(description?[node('p',{translate:'no'},description)]:[]),node('p',{},t(discard?'discardHint':'impact')),node('div',{class:'group-actions'},[cancel,accept])]);confirmation=dialog;
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(confirmation!==dialog)return;closeConfirmation();if(prior?.isConnected)prior.focus({preventScroll:true});});root.append(dialog);dialog.showModal();cancel.focus();return true;
 }
 function navigate(action){if(!active||state.busy||state.loading||confirmation?.open)return false;if(dirty())return confirm('discardTitle',action,{discard:true});action();return true;}
 function notify(scope){if(!scope||scope.notified)return;scope.notified=true;try{Promise.resolve(onPolicyMayHaveChanged?.({workspaceId})).catch(()=>{});}catch{}}
 function classify(error){if(error?.code==='ACCOUNT_CHANGED'||error?.status===401){clearPrivate();client?.destroy();return'actorChanged';}if([403,404].includes(error?.status)){clearPrivate();return'forbidden';}if(error?.code==='LAST_PAGE_MANAGER')return'lastManager';if(error?.code==='GROUP_ARCHIVED')return'archivedReadonly';if(error?.status===409)return'conflict';if(error?.status===400)return'invalid';if(error?.status===413)return'tooLarge';return'unavailable';}
 function newClient(){client?.destroy();client=clientFactory({workspaceId,accountId:actorId,fetcher,signal:lifecycle.signal});}
 async function load(id=null,{fresh=false}={}){
  if(!active||state.busy)return false;if(fresh||!client)newClient();closeConfirmation();const marker=++generation;clearPrivate();state.groupId=id;state.loading=true;state.error=state.notice='';state.locked=false;render();
  try{
   const list=validateGroups(await client.list(),workspaceId);if(!active||marker!==generation)return false;
   const detail=id?validateGroups(await client.read(id),workspaceId,{detail:true}):null;if(!active||marker!==generation)return false;if(detail&&detail.group.id!==id)invalid();
   let page=null;if(pageId)try{page=validateGroupGrants(await client.pageGrants(pageId),workspaceId,pageId);}catch(error){if(![403,404].includes(error?.status))throw error;}
   if(!active||marker!==generation)return false;if(detail&&(detail.revision!==list.revision||detail.canManage!==list.canManage)||page&&page.revision!==list.revision)throw new TeamspaceClientError('CONTENT_CONFLICT',409);
   state.list=list;state.detail=detail;state.page=page;state.name=state.baseline=detail?.group.name??'';const grant=page?.grants.find(row=>row.groupId===detail?.group.id);state.permission=state.permissionBaseline=grant?.permission??'viewer';state.includeDescendants=state.scopeBaseline=grant?.includeDescendants??false;return true;
  }catch(error){if(active&&marker===generation){state.error=classify(error);state.locked=true;}return false;}
  finally{if(active&&marker===generation){state.loading=false;render();}}
 }
 async function run(operation,{expectedRevision,kind='group',groupId=state.groupId,check=()=>true}={}){
  if(!active||disabled()||composing)return;const marker=++generation,scope={notified:false};pending=scope;state.busy=true;state.error=state.notice='';render();let acknowledged=false;
  try{
   const value=await operation(client);if(!active||marker!==generation)return;
   const result=kind==='page'?validateGroupGrants(value,workspaceId,pageId):validateGroups(value,workspaceId,{detail:true});
   if(result.revision!==expectedRevision+1||kind==='group'&&(groupId&&result.group.id!==groupId||!result.canManage)||!check(result))invalid();
   acknowledged=true;if(pending===scope)pending=null;await onChange?.(result);if(!active||marker!==generation)return;
   state.busy=false;const loaded=await load(kind==='group'?result.group.id:groupId);if(active&&loaded){state.notice='saved';render();root.querySelector('.groups-panel')?.focus({preventScroll:true});}
  }catch(error){if(active&&marker===generation){const lostAuthority=error?.code==='ACCOUNT_CHANGED'||[401,403,404].includes(error?.status),unknown=!acknowledged&&(client.uncertain||!error?.status||error.status>=500||['INVALID_RESPONSE','REQUEST_UNCONFIRMED'].includes(error.code));
   if(lostAuthority){state.error=classify(error);clearPrivate();client?.destroy();}else state.error=acknowledged?'refreshFailed':unknown?'unknown':classify(error);
   state.locked=true;if(lostAuthority||unknown||acknowledged||['actorChanged','forbidden'].includes(state.error))notify(scope);
  }}
  finally{if(pending===scope)pending=null;if(active&&marker===generation){state.busy=false;render();}}
 }
 function groupMutation(method,id,body,check){const captured=structuredClone(body);void run(api=>id===null?api[method](captured):api[method](id,captured),{expectedRevision:captured.expectedRevision,groupId:id,check});}
 function pageMutation(method,body,check){const captured=structuredClone(body);void run(api=>api[method](pageId,captured),{expectedRevision:captured.expectedRevision,kind:'page',check});}
 function select(label,id,value,options,change,blocked=disabled){const field=control(node('select',{id,'aria-label':t(label)},options.map(item=>node('option',{value:item.id},item.name))),blocked);field.value=value;field.addEventListener('change',()=>{if(field.disabled||!active||blocked())return;change(field.value);render();});return node('label',{class:'group-field',for:id},[node('span',{},t(label)),field]);}
 function draftHint(){return node('p',{class:'group-hint','data-group-draft-hint':'',hidden:!dirty()},t('draftHint'));}
 function renderName(panel,group){
  const paused=Boolean(group?.archivedAt),input=control(node('input',{id:'group-name',maxlength:'100',required:true,value:state.name}),()=>disabled()||paused);
  input.addEventListener('input',()=>{if(!active||input.disabled||disabled())return;state.name=input.value;updateControls();});
  const submit=control(node('button',{type:'submit',class:'button primary'},t(state.creating?'create':'save')),()=>disabled()||paused||!nameDirty()||!state.name.trim()||!!state.candidate||sharingDirty());
  const form=node('form',{class:'group-form'},[node('label',{class:'group-field',for:'group-name'},[node('span',{},t('name')),input]),submit]);
  form.addEventListener('submit',event=>{event.preventDefault();if(!active||disabled()||composing||event.isComposing||event.keyCode===229||paused||!nameDirty()||state.candidate||sharingDirty())return;const name=state.name.trim();if(!name||name.length>100||/[\u0000-\u001f\u007f]/.test(name)){state.error='invalid';render();root.querySelector('#group-name')?.focus();return;}const expectedRevision=state.list.revision;
   if(state.creating)groupMutation('create',null,{expectedRevision,name},result=>result.group.name===name&&result.group.archivedAt===null&&result.members.length===0&&result.group.memberCount===0);
   else confirm('save',()=>groupMutation('rename',group.id,{expectedRevision,name,confirmAccessChange:true},result=>result.group.name===name),{description:t('renameReview',{name})});
  });panel.append(form);
 }
 function renderMembers(panel,group){
  panel.append(node('h2',{},t('members')));if(!state.detail.members.length)panel.append(node('p',{class:'group-hint'},t('noMembers')));
  const list=node('ul',{class:'group-list'});for(const member of state.detail.members)list.append(node('li',{},[node('span',{translate:'no'},member.name||t('participant')),button('remove',()=>{const expectedRevision=state.list.revision,memberId=member.id;confirm('remove',()=>groupMutation('remove',group.id,{expectedRevision,memberId,confirmAccessChange:true},result=>!result.members.some(item=>item.id===memberId||item.accountId===member.accountId)),{description:t('removeReview',{name:member.name||t('participant')})});},()=>disabled()||Boolean(group.archivedAt)||dirty())]));panel.append(list);
  if(!group.archivedAt){const candidates=state.detail.candidates.filter(person=>!state.detail.members.some(member=>member.accountId===person.accountId));panel.append(select('addMember','group-candidate',state.candidate,[{id:'',name:t('choose')},...candidates.map(person=>({id:person.accountId,name:person.name||t('participant')}))],value=>{state.candidate=value;},()=>disabled()||nameDirty()||sharingDirty()),button('addMember',()=>{const expectedRevision=state.list.revision,accountId=state.candidate,candidate=candidates.find(person=>person.accountId===accountId);if(!candidate)return;confirm('addMember',()=>groupMutation('member',group.id,{expectedRevision,accountId,confirmAccessChange:true},result=>result.members.some(person=>person.accountId===accountId)),{description:t('addReview',{name:candidate.name||t('participant')})});},()=>disabled()||nameDirty()||sharingDirty()||!state.candidate));}
 }
 function renderPage(panel){
  if(!state.page||state.creating)return;panel.append(node('h2',{},t('pageSharing')),node('p',{class:'group-hint'},t('groupScope')));
  const list=node('ul',{class:'group-list'});for(const grant of state.page.grants)list.append(node('li',{},[node('span',{translate:'no'},grant.groupName+' · '+t(grant.permission)+' · '+t(grant.includeDescendants?'scopeDescendants':'scopePage')),button('revoke',()=>{const expectedRevision=state.page.revision,grantId=grant.id;confirm('revoke',()=>pageMutation('revoke',{expectedRevision,grantId,confirmAccessChange:true},result=>!result.grants.some(item=>item.id===grantId)),{description:t(grant.includeDescendants?'revokeDescendantsReview':'revokeReview',{name:grant.groupName})});},()=>disabled()||dirty())]));panel.append(list);
  if(state.detail&&!state.detail.group.archivedAt){const groupId=state.detail.group.id;
   const scope=control(node('input',{type:'checkbox',id:'group-descendants',checked:state.includeDescendants}),()=>disabled()||nameDirty()||!!state.candidate);scope.addEventListener('change',()=>{if(active&&!scope.disabled){state.includeDescendants=scope.checked;updateControls();}});panel.append(node('label',{class:'group-field group-scope',for:'group-descendants'},[scope,node('span',{},t(resourceKind==='collection'?'includeCollectionRecords':'includeDescendants'))]));
   panel.append(select('permission','group-permission',state.permission,['viewer','commenter','editor','full','deny'].map(id=>({id,name:t(id)})),value=>{state.permission=value;},()=>disabled()||nameDirty()||!!state.candidate),button('share',()=>{const expectedRevision=state.page.revision,permission=state.permission,includeDescendants=state.includeDescendants;confirm('share',()=>pageMutation('grant',{expectedRevision,groupId,permission,includeDescendants,confirmAccessChange:true},result=>result.grants.some(item=>item.groupId===groupId&&item.permission===permission&&item.includeDescendants===includeDescendants)),{description:t(includeDescendants?'shareDescendantsReview':'shareReview',{name:state.detail.group.name,permission:t(permission)})});},()=>disabled()||nameDirty()||!!state.candidate));
  }
 }
 function render(){
  if(!active||!i18n)return;const focused=document.activeElement?.id,start=document.activeElement?.selectionStart,end=document.activeElement?.selectionEnd,direction=document.activeElement?.selectionDirection;closeConfirmation();controls=[];root.classList.add('groups-settings');root.lang=i18n.locale;root.dir=i18n.dir;
  const panel=node('section',{class:'groups-panel',tabindex:'-1',...(embedded?{}:{id:'settings-content'})},[node('h1',{},t('title')),node('p',{class:'group-intro'},t(resourceOnly?'resourceRoleHint':'intro'))]);root.replaceChildren(panel);
  if(state.error)panel.append(node('p',{role:'alert',class:'group-message'},t(state.error)));if(state.notice)panel.append(node('p',{role:'status',class:'group-message'},t(state.notice)));
  panel.append(button('reload',()=>navigate(()=>void load(state.error==='unknown'?null:state.groupId,{fresh:true})),()=>state.busy||state.loading));
  if(state.loading)panel.append(node('p',{role:'status'},t('loading')));
  else if(state.list){
   if(state.detail||state.creating){panel.append(button('back',()=>navigate(()=>void load())));const group=state.detail?.group;if(group)panel.append(node('h2',{translate:'no'},group.name),node('p',{},t('count',{count:group.memberCount})));else panel.append(node('h2',{},t('create')));
    if(group?.archivedAt)panel.append(node('p',{class:'group-message'},t('archivedHint')));
    if(state.list.canManage&&!resourceOnly){renderName(panel,group);if(group){panel.append(button(group.archivedAt?'restore':'archive',()=>{const expectedRevision=state.list.revision,archived=group.archivedAt===null;confirm(archived?'archive':'restore',()=>groupMutation('archive',group.id,{expectedRevision,archived,confirmAccessChange:true},result=>(result.group.archivedAt!==null)===archived),{description:t(archived?'archiveReview':'restoreReview',{name:group.name})});},()=>disabled()||dirty()));renderMembers(panel,group);}}
    else if(!resourceOnly)panel.append(node('p',{class:'group-hint'},t('readOnly')));
   }else{if(state.list.canManage&&!resourceOnly)panel.append(button('create',()=>navigate(()=>{state.creating=true;state.name=state.baseline='';render();root.querySelector('#group-name')?.focus();})));if(!state.list.groups.length)panel.append(node('p',{class:'group-hint'},t('empty')));const list=node('ul',{class:'group-list'});for(const group of state.list.groups){const open=button('open',()=>navigate(()=>void load(group.id)));open.textContent=group.name+' · '+t('count',{count:group.memberCount})+(group.archivedAt?' · '+t('archived'):'');list.append(node('li',{},open));}panel.append(list);}
   panel.append(draftHint());renderPage(panel);
  }
  if(!embedded)panel.append(node('p',{class:'group-footer'},node('a',{href:'/workspace-settings.html?workspace='+encodeURIComponent(workspaceId),onClick:event=>{if(!onNavigate||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(()=>onNavigate({href:event.currentTarget.href}));}},t('backWorkspace'))));
  updateControls();if(focused){const element=[...root.querySelectorAll('[id]')].find(item=>item.id===focused);if(element&&!element.disabled){element.focus({preventScroll:true});if(Number.isInteger(start)&&typeof element.setSelectionRange==='function')try{element.setSelectionRange(start,end,direction);}catch{}}}
 }
 function focusSection(){if(!active)return false;root.querySelector('.groups-panel')?.focus({preventScroll:true});return true;}
 const beforeUnload=event=>{if(active&&(state.busy||dirty())){event.preventDefault();event.returnValue='';}};
 const compositionStart=()=>{composing=true;},compositionEnd=()=>{composing=false;};root.addEventListener('compositionstart',compositionStart);root.addEventListener('compositionend',compositionEnd);view?.addEventListener('beforeunload',beforeUnload);
 const ready=(async()=>{try{
  if(actorId===null){const response=await fetchCall('/api/auth/get-session',{credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([lifecycle.signal,AbortSignal.timeout(20000)])});const session=await response.json();if(!active)return;if(!response.ok||!validId(session?.user?.id)||session.user.emailVerified!==true)throw new TeamspaceClientError('ACCOUNT_CHANGED',401);actorId=session.user.id;}
  const preferences=new PreferencesStore({profileId:actorId});const values=catalogs??await loadCatalogs({namespace:'groups',locale:preferences.snapshot().locale,fetcher});if(!active)return;i18n=createI18n(values,preferences.snapshot().locale);await i18n.switchLocale(i18n.requestedLocale);if(!active)return;
  if(!embedded){const apply=()=>{if(!active)return;const pref=resolveAppearancePreferences(preferences.snapshot()),theme=THEMES.find(item=>item.id===pref.themeId)||THEMES[0],colors=validateCustomColors(pref.themeId,pref.customColors).colors||theme.colors;for(const[key,color]of Object.entries(colors))document.documentElement.style.setProperty('--'+key,color);document.documentElement.style.fontFamily=FONT_OPTIONS.find(item=>item.id===pref.fontId)?.family||FONT_OPTIONS[0].family;document.documentElement.style.colorScheme=theme.kind;applyLocaleDocument(document,i18n);};apply();stopAppearance=watchSystemAppearance(()=>preferences.snapshot(),{onAppearance:apply});}
  await load();
 }catch(error){if(active){clearPrivate();state.loading=false;state.locked=true;state.error=classify(error);if(i18n)render();else root.replaceChildren(node('p',{role:'alert'},'Groups are unavailable.'));}}})();
 return{ready,get closeState(){return{busy:active&&state.busy,dirty:active&&dirty()};},canClose:()=>!active||!state.busy&&!dirty()&&!confirmation?.open,focusSection,destroy(){if(!active)return;notify(pending);active=false;generation++;lifecycle.abort();client?.destroy();stopAppearance();closeConfirmation();view?.removeEventListener('beforeunload',beforeUnload);root.removeEventListener('compositionstart',compositionStart);root.removeEventListener('compositionend',compositionEnd);root.replaceChildren();root.classList.remove('groups-settings');clearPrivate();}};
}
