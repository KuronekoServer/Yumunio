import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {SharingClient,SharingError,validShareId} from './share-data.js';
import {validatePublicationStatus,validatePublicationReview,readPublicationJson} from './publication-data.js';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors,contrastRatio} from './preferences.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';

/** Mount shared membership controls without replacing the background workspace. */
export function mountSharingPage({root,embedded=false,workspaceId:providedWorkspaceId,pageId:providedPageId,expectedAccountId=null,resourceOnly=false,resourceKind='page',onNavigate,onChange,onPolicyMayHaveChanged,fetcher=globalThis.fetch}={}){
 if(!root?.querySelector||!root.ownerDocument)throw new TypeError('INVALID_SHARING_ROOT');
 if(embedded&&!validShareId(expectedAccountId))throw new SharingError('INVALID_CONTEXT',400);
 const document=root.ownerDocument,view=document.defaultView??globalThis.window;
 let active=true,stopAppearance=()=>{};
 const lifecycle=new AbortController();
 const boundFetch=(path,options={})=>{if(!active||lifecycle.signal.aborted)return Promise.reject(new DOMException('Sharing controller destroyed','AbortError'));return fetcher(path,{...options,signal:options.signal?AbortSignal.any([options.signal,lifecycle.signal]):lifecycle.signal});};
 const url=new URL(location.href),workspaceId=providedWorkspaceId??url.searchParams.get('workspace')??'',pageId=providedPageId===undefined?url.searchParams.get('page'):providedPageId;
 const validContext=validShareId(workspaceId)&&(pageId===null||validShareId(pageId))&&(expectedAccountId===null||validShareId(expectedAccountId))&&(embedded||url.searchParams.getAll('workspace').length===1&&url.searchParams.getAll('page').length<=1&&Array.from(url.searchParams.keys()).every(key=>['workspace','page'].includes(key)));
 root.classList.add('sharing-page');if(embedded)root.classList.add('settings-sharing');
 if(embedded)root.replaceChildren(
  node('a',{class:'skip-link',href:'#share-main',hidden:true}),
  node('header',{class:'share-header',hidden:true},[
   node('span',{id:'share-theme-label'}),node('select',{id:'share-theme'}),
   node('span',{id:'share-language-label'}),node('select',{id:'share-language'})
  ]),
  node('div',{class:'share-shell'},[node('aside',{class:'share-sidebar',hidden:true},[node('h2',{id:'share-sidebar-title'}),node('a',{id:'share-back'}),node('a',{id:'share-account'}),node('p',{id:'share-sidebar-note'})]),node('section',{id:'share-main',class:'share-main',tabindex:'-1'})]),
  node('dialog',{id:'share-modal','aria-labelledby':'share-modal-title'})
 );
 const get=id=>root.querySelector('#'+id);
 const main=get('share-main'),modal=get('share-modal'),language=get('share-language'),themeControl=get('share-theme'),skipLink=root.querySelector('.skip-link');
 if(!main||!modal||!language||!themeControl||!skipLink)throw new TypeError('INVALID_SHARING_ROOT');
main.replaceChildren();modal.replaceChildren();
let preferences=new PreferencesStore(),i18n,brand,instanceConfig,client;
let inviteBaseline={purpose:'',role:'viewer'},grantPermissionBaseline='viewer';
let grantDescendantBaseline=false,invitationExpanded=false;
const state={model:null,loading:false,busy:false,locked:false,conflict:false,error:'',notice:'',dirty:false,tab:'share',draft:{requestId:crypto.randomUUID(),purpose:'',email:'',role:'viewer'},grant:{accountId:'',permission:'viewer',includeDescendants:false},memberRoles:new Map()};
const publication={status:null,loading:false,busy:false,uncertain:false,preview:null,consent:false,expanded:false,error:'',notice:''};
const t=(key,values)=>i18n?.t(key,values)??key;
function node(tag,attrs={},children=[]){const result=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(value===undefined||value===null||value===false)continue;if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);else if(['value','disabled','required','checked','selected'].includes(key))result[key]=value;else if(key==='class')result.className=value;else result.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined&&child!==false)result.append(child instanceof Node?child:document.createTextNode(String(child)));return result;}
const button=(key,handler,{disabled=false,primary=false,danger=false}={})=>node('button',{type:'button',class:'button'+(primary?' primary':'')+(danger?' share-danger':''),disabled,onClick:handler},t(key));
const disabled=()=>state.busy||state.loading||state.locked||state.conflict;
function applyPreferences(){if(!active)return;language.replaceChildren(...createLocaleOptions(document,i18n,{value:preferences.snapshot().locale}));if(embedded){root.lang=i18n.locale;root.dir=i18n.dir;const value=resolveAppearancePreferences(preferences.snapshot());i18n?.setLocale(value.locale);language.value=value.locale;themeControl.value=value.themeId;return;}const value=resolveAppearancePreferences(preferences.snapshot()),theme=THEMES.find(item=>item.id===value.themeId),colors=validateCustomColors(value.themeId,value.customColors).colors??THEMES[1].colors;for(const[key,color]of Object.entries(colors))document.documentElement.style.setProperty('--'+key,color);const kind=value.customColors.canvas?(contrastRatio('#FFFFFF',colors.canvas)>contrastRatio('#102030',colors.canvas)?'dark':'light'):theme.kind;document.documentElement.style.colorScheme=kind;document.documentElement.dataset.appearance=kind;document.documentElement.style.fontFamily=FONT_OPTIONS.find(item=>item.id===value.fontId).family;i18n?.setLocale(value.locale);applyLocaleDocument(document,i18n);language.value=value.locale;themeControl.value=value.themeId;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',colors.nav);brand?.apply({kind,titleSuffix:t('title')});}
function notifyPolicy(){try{Promise.resolve(onPolicyMayHaveChanged?.({workspaceId})).catch(()=>{});}catch{}}
function clearPrivate(){state.model=null;state.tab='share';publication.status=null;publication.preview=null;publication.error='';publication.notice='';publication.consent=false;publication.busy=false;publication.loading=false;state.draft={requestId:crypto.randomUUID(),purpose:'',role:'viewer',email:''};state.grant={accountId:'',permission:'viewer',includeDescendants:false};state.memberRoles.clear();inviteBaseline={purpose:'',role:'viewer'};grantPermissionBaseline='viewer';grantDescendantBaseline=false;invitationExpanded=false;state.dirty=false;if(modal.open)modal.close();modal.replaceChildren();client?.destroy();client=null;}
function classify(error){if(error.code==='ACTOR_CHANGED'){state.locked=true;clearPrivate();notifyPolicy();return'actorChanged';}if([401,403,404].includes(error.status)){state.locked=true;clearPrivate();notifyPolicy();return'forbidden';}if(error.status===409){state.conflict=true;return error.code==='LAST_WORKSPACE_OWNER'?'lastOwner':error.code==='LAST_PAGE_MANAGER'?'lastManager':'conflict';}if(error.status===400)return'invalid';state.locked=true;return'uncertain';}
function dirty(){state.dirty=!!state.draft.email.trim()||state.draft.purpose!==inviteBaseline.purpose||state.draft.role!==inviteBaseline.role||!!state.grant.accountId.trim()||state.grant.permission!==grantPermissionBaseline||state.grant.includeDescendants!==grantDescendantBaseline||state.memberRoles.size>0;onChange?.({busy:state.busy,dirty:state.dirty});}
async function reload(explicit=false){if(!active||state.loading||state.busy||!client)return;state.loading=true;state.error='';state.notice='';render();try{const model=await client.load();if(!active)return;state.model=model;state.locked=false;state.conflict=false;if(!state.draft.purpose){state.draft.purpose=model.canInvitePage?'page-guest':'workspace-member';state.draft.role=model.canInvitePage?'viewer':'member';inviteBaseline={purpose:state.draft.purpose,role:state.draft.role};}if(explicit)state.notice='reloaded';}catch(error){if(active)state.error=classify(error);}finally{state.loading=false;render();}}
async function run(task,success,after){if(!active||disabled())return;state.busy=true;state.error='';state.notice='';render();let committed=false;try{await task();if(!active)return;committed=true;after?.();dirty();state.notice=success;const model=await client.load();if(!active)return;state.model=model;}catch(error){if(!active)return;state.error=classify(error);if(committed&&!error.status)state.error='refreshFailed';if(!error.status||error.status>=500)notifyPolicy();}finally{state.busy=false;render();}}
function confirmAction(title,description,task){if(!active||disabled())return;modal.replaceChildren(node('h2',{id:'share-modal-title'},t(title)),node('p',{},description),node('div',{class:'share-actions'},[button('cancel',()=>modal.close()),button('confirm',()=>{modal.close();void task();},{primary:true})]));modal.showModal();}
function optionSelect(choices,value,change,{focus,disabled:blocked=false}={}){const select=node('select',{'data-focus':focus,required:true,disabled:blocked,onChange:event=>{if(active)change(event.target.value);}},choices.map(choice=>node('option',{value:choice.id,selected:choice.id===value},choice.label)));select.value=value;return select;}
function input(label,value,change,{type='text',max=254,pattern,focus,required=true}={}){return node('label',{},[node('span',{},t(label)),node('input',{type,value,maxlength:String(max),pattern,required,disabled:disabled(),'data-focus':focus,onInput:event=>{if(!active)return;change(event.target.value);dirty();}})]);}
const roles=ids=>ids.map(id=>({id,label:t('role_'+id)}));
function selectTab(value){
 if(!active||state.tab===value)return;
 state.tab=value;state.error='';state.notice='';render();
 if(value==='web'&&!publication.status&&!publication.loading)void loadPublication();
}
function copyShareLink(){
 if(!active||!client)return;
 const link=location.origin+'/workspace?workspace='+encodeURIComponent(workspaceId)+(pageId?'&page='+encodeURIComponent(pageId):'');
 let task;
 try{task=navigator.clipboard?.writeText?.(link);}catch{task=null;}
 if(!task){state.notice='copyFailed';render();return;}
 Promise.resolve(task).then(()=>{if(!active)return;state.notice='linkCopied';render();},()=>{if(!active)return;state.notice='copyFailed';render();});
}
function publicationRoute(suffix=''){return '/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/pages/'+encodeURIComponent(pageId)+'/publication'+suffix;}
async function publicationRequest(suffix='',{method='GET',body}={}){
 if(!active||!client)throw new SharingError('ACTOR_CHANGED',401);
 let response;
 try{
  response=await boundFetch(publicationRoute(suffix),{method,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
   headers:{'X-Yumunio-Expected-Account':client.accountId,...(body===undefined?{}:{'Content-Type':'application/json'})},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 }catch{throw new SharingError('NETWORK_FAILED');}
 const data=await readPublicationJson(response);
 if(!response.ok)throw new SharingError(typeof data?.error?.code==='string'&&/^[A-Z_]{1,80}$/.test(data.error.code)?data.error.code:'REQUEST_FAILED',response.status);
 return data;
}
function publicationError(error){
 if(error?.code==='ACTOR_CHANGED'||error?.status===401)return'actorChanged';
 if([403,404].includes(error?.status))return'forbidden';
 return error?.status===503?'publicationUnavailable':error?.status===409?'conflict':'uncertain';
}
async function loadPublication(){
 if(!active||!client||publication.loading||publication.busy||!pageId)return;
 publication.loading=true;publication.error='';publication.notice='';render();
 try{publication.status=validatePublicationStatus(await publicationRequest(),pageId);publication.uncertain=false;}
 catch(error){publication.error=publicationError(error);publication.uncertain=true;}
 finally{publication.loading=false;render();}
}
async function reviewPublication(){
 if(!active||!client||publication.busy||!publication.status)return;
 publication.busy=true;publication.error='';publication.notice='';publication.consent=false;render();
 try{
  const preview=validatePublicationReview(await publicationRequest('/review',{method:'POST',body:{expectedRevision:publication.status.revision}}),pageId);
  if(preview.revision!==publication.status.revision||preview.sourceVersion!==publication.status.currentSourceVersion)throw new SharingError('CONFLICT',409);
  publication.preview=preview;publication.expanded=true;publication.notice='reviewReady';
 }catch(error){publication.error=publicationError(error);publication.uncertain=true;}
 finally{publication.busy=false;render();}
}
async function publishPage(){
 const captured=publication.preview;
 if(!active||!client||publication.busy||!captured||!publication.consent)return;
 publication.busy=true;publication.error='';publication.notice='publishing';render();
 try{
  const status=validatePublicationStatus(await publicationRequest('',{method:'POST',body:{expectedRevision:captured.revision,reviewDigest:captured.reviewDigest,confirmPublicExposure:true}}),pageId);
  if(!status.active||status.sourceVersion!==captured.sourceVersion)throw new SharingError('INVALID_RESPONSE');
  publication.status=status;publication.uncertain=false;publication.notice='published';publication.preview=null;publication.consent=false;
 }catch(error){publication.error=publicationError(error);publication.uncertain=true;}
 finally{publication.busy=false;render();}
}
async function stopPublication(){
 if(!active||!client||publication.busy||!publication.status)return;
 publication.busy=true;publication.error='';publication.notice='stopping';render();
 try{
  const status=validatePublicationStatus(await publicationRequest('',{method:'DELETE',body:{expectedRevision:publication.status.revision}}),pageId);
  if(status.active)throw new SharingError('INVALID_RESPONSE');
  publication.status=status;publication.uncertain=false;publication.notice='stopped';publication.preview=null;publication.consent=false;
 }catch(error){publication.error=publicationError(error);publication.uncertain=true;}
 finally{publication.busy=false;render();}
}
function renderInvite(model){
  if(!model.canInvitePage&&(!model.canInviteMember||resourceOnly))return node('p',{class:'share-muted'},t('noInvitePermission'));
  const purposes=[...(model.canInvitePage?[{id:'page-guest',label:t('pageGuest')}]:[]),...(!resourceOnly&&model.canInviteMember?[{id:'workspace-member',label:t('workspaceMember')}]:[])];const guest=state.draft.purpose==='page-guest',allowed=purposes.some(item=>item.id===state.draft.purpose),allowedRoles=guest?['viewer','commenter','editor','full']:model.canInviteAdmin?['member','admin']:['member'];
  const form=node('form',{class:'share-form share-invite'},[
    node('div',{class:'share-invite-top'},[input('email',state.draft.email,value=>state.draft.email=value,{type:'email',focus:'invite-email'}),
      node('div',{class:'share-invite-submit'},node('button',{type:'submit',class:'button primary',disabled:disabled()||!allowed||!allowedRoles.includes(state.draft.role)},t('sendInvite')))]),
    node('div',{class:'share-invite-options'},[
      node('label',{},[node('span',{},t('permission')),optionSelect(roles(allowedRoles),state.draft.role,value=>{state.draft.role=value;dirty();},{focus:'invite-role',disabled:disabled()})]),
      node('label',{},[node('span',{},t('scope')),optionSelect(purposes,state.draft.purpose,value=>{state.draft.purpose=value;state.draft.role=value==='page-guest'?'viewer':'member';dirty();render();},{focus:'invite-scope',disabled:disabled()})])]),
    node('div',{class:'share-general'},[
      node('span',{class:'share-general-label'},t('generalAccess')),
      node('span',{class:'share-general-value'},t(guest?'invitedOnly':'workspaceMembersOnly')),
      node('button',{type:'button',class:'button share-copy',disabled:disabled(),onClick:()=>copyShareLink()},t('copyLink'))]),
    node('p',{class:'share-muted'},t(guest?'singlePageOnly':'memberScope')),
  ]);
  form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity()||disabled())return;const draft={...state.draft},expectedRevision=model.revision,body={expectedRevision,requestId:draft.requestId,purpose:draft.purpose,email:draft.email,role:draft.role,...(guest?{pageId,includeDescendants:false}:{})};void run(()=>client.invite(body),'queued',()=>{state.draft.email='';state.draft.requestId=crypto.randomUUID();inviteBaseline={purpose:state.draft.purpose,role:state.draft.role};});});return form;
}
function renderInvitations(model){const list=node('ul',{class:'share-list'});if(!model.invitations.length)list.append(node('li',{class:'share-muted'},t('emptyInvitations')));for(const item of model.invitations){
  const info=node('div',{class:'share-row-info'},[node('div',{class:'share-row-title',translate:'no'},item.recipientEmail),node('p',{class:'share-row-detail'},t(item.purpose==='page-guest'?'pageGuest':'workspaceMember')+' · '+t('role_'+item.role)+' · '+t('status_'+item.status)),node('p',{class:'share-row-detail'},t('expires')+' '+new Date(item.expiresAt).toLocaleString(preferences.snapshot().locale))]);
  const actions=node('div',{class:'share-actions'});if(item.status==='pending'){
    actions.append(button('resend',()=>{const rev=model.revision;confirmAction('resend',''+t('resendNote'),()=>run(()=>client.invitation(item.id,'resend',rev),'queued'));},{disabled:disabled()}),button('revokeInvite',()=>{const rev=model.revision;confirmAction('revokeInvite',t('revokeInviteNote'),()=>run(()=>client.invitation(item.id,'cancel',rev),'invitationRevoked'));},{disabled:disabled(),danger:true}));}
  list.append(node('li',{class:'share-row'},[info,actions]));}return list;}
function renderMembers(model){if(!model.canManageMembers)return node('p',{class:'share-muted'},t('membersPrivate'));
  const list=node('ul',{class:'share-list'}),owners=model.members.filter(member=>member.role==='owner'&&member.emailVerified).length;
  for(const member of model.members){const editable=model.role==='owner'||!['owner','admin'].includes(member.role),selected=state.memberRoles.get(member.id)??member.role,changingLastOwner=member.role==='owner'&&member.emailVerified&&owners<2&&selected!=='owner';
    const info=node('div',{class:'share-row-info'},[node('div',{class:'share-row-title',translate:'no'},[member.email,node('span',{class:'share-badge'},t('role_'+member.role)),member.currentUser?node('span',{class:'share-badge'},t('you')):null]),node('p',{class:'share-row-detail'},t(member.emailVerified?'verified':'unverified'))]);
    const select=optionSelect(roles(model.role==='owner'?['owner','admin','member','guest']:editable?['member','guest']:[member.role]),selected,value=>{if(value===member.role)state.memberRoles.delete(member.id);else state.memberRoles.set(member.id,value);dirty();render();},{focus:'member-'+member.id,disabled:disabled()||!editable});
    const actions=node('div',{class:'share-actions'},[select,button('apply',()=>{const rev=model.revision;confirmAction('changeRole',member.email+' · '+t('role_'+selected),()=>run(()=>client.member(member.id,{expectedRevision:rev,role:selected}),'memberChanged',()=>state.memberRoles.delete(member.id)));},{disabled:disabled()||!editable||changingLastOwner||selected===member.role}),button('remove',()=>{const rev=model.revision;confirmAction('removeMember',member.email+'\n'+t('removeMemberNote'),()=>run(()=>client.member(member.id,{expectedRevision:rev,remove:true}),'memberRemoved',()=>state.memberRoles.delete(member.id)));},{disabled:disabled()||!editable||member.role==='owner'&&member.emailVerified&&owners<2,danger:true})]);list.append(node('li',{class:'share-row'},[info,actions]));}return list;}
function renderGrants(model){if(!pageId)return node('p',{class:'share-muted'},t('choosePage'));if(!model.canManagePage)return node('p',{class:'share-muted'},t('noPagePermission'));
  const list=node('ul',{class:'share-list'});for(const grant of model.grants){const member=model.canManageMembers?model.members.find(item=>item.accountId===grant.accountId):null;list.append(node('li',{class:'share-row'},[node('div',{class:'share-row-info'},[node('div',{class:'share-row-title',translate:'no'},member?.email??grant.accountId),node('p',{class:'share-row-detail'},t('role_'+grant.permission)+' · '+t(grant.includeDescendants?'withDescendants':'singlePageOnly'))]),button('revokeAccess',()=>{const rev=model.revision;confirmAction('revokeAccess',[model.page?.title??'',member?.email??grant.accountId,t('role_'+grant.permission),t(grant.includeDescendants?'revokeDescendantsNote':'revokeAccessNote')].join('\n'),()=>run(()=>client.revoke(grant.id,rev),'accessChanged'));},{disabled:disabled(),danger:true})]));}
  const target=model.canManageMembers?node('label',{},[node('span',{},t('existingMember')),optionSelect([{id:'',label:t('selectMember')},...model.members.filter(item=>item.emailVerified).map(item=>({id:item.accountId,label:item.email}))],state.grant.accountId,value=>{state.grant.accountId=value;dirty();},{focus:'grant-account',disabled:disabled()})]):input('accountId',state.grant.accountId,value=>state.grant.accountId=value,{max:128,pattern:'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',focus:'grant-account'});
  const scope=node('label',{class:'share-scope'},[node('input',{type:'checkbox',checked:state.grant.includeDescendants,disabled:disabled(),'data-focus':'grant-descendants',onChange:event=>{if(active){state.grant.includeDescendants=event.target.checked;dirty();}}}),node('span',{},t(resourceKind==='collection'?'includeCollectionRecords':'includeDescendants'))]);
  const form=node('form',{class:'share-form'},[target,node('label',{},[node('span',{},t('permission')),optionSelect(roles(['viewer','commenter','editor','full','deny']),state.grant.permission,value=>{state.grant.permission=value;dirty();},{focus:'grant-role',disabled:disabled()})]),scope,node('p',{class:'share-muted'},t('descendantScopeNote')),...(!model.canManageMembers?[node('p',{class:'share-muted'},t('manualAccountNote'))]:[]),node('button',{type:'submit',class:'button primary',disabled:disabled()},t('grantAccess'))]);
  form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity()||disabled()||!validShareId(state.grant.accountId))return;const body={expectedRevision:model.revision,...state.grant};const task=()=>run(()=>client.grant(body),'accessChanged',()=>{state.grant.accountId='';grantPermissionBaseline=state.grant.permission;grantDescendantBaseline=state.grant.includeDescendants;});confirmAction(body.permission==='deny'?'denyAccess':'grantAccess',[model.page?.title??'',model.members.find(member=>member.accountId===body.accountId)?.email??body.accountId,t('role_'+body.permission),t(body.includeDescendants?'descendantGrantReview':'singlePageOnly')].join('\n'),task);});return node('div',{},[list,node('h3',{},t('addExisting')),form]);}
function renderTabs(){
 const list=node('div',{class:'share-tabs',role:'tablist','aria-label':t('sharingTabs')});
 for(const[value,label]of [['share','tabShare'],['web','tabWeb']]){
  const selected=state.tab===value;
  list.append(node('button',{type:'button',role:'tab',id:'share-tab-'+value,'aria-selected':String(selected),'aria-controls':'share-panel-'+value,tabIndex:selected?0:-1,
   class:'share-tab'+(selected?' is-selected':''),'data-focus':'tab-'+value,disabled:!client,onClick:()=>selectTab(value)},t(label)));
 }
 return list;
}
function copyPublicLink(url){
 let task;
 try{task=navigator.clipboard?.writeText?.(url);}catch{task=null;}
 if(!task){publication.notice='copyFailed';render();return;}
 Promise.resolve(task).then(()=>{if(!active)return;publication.notice='linkCopied';render();},()=>{if(!active)return;publication.notice='copyFailed';render();});
}
function renderWeb(){
 const status=publication.status;
 const card=node('section',{class:'share-card share-web',id:'share-panel-web',role:'tabpanel','aria-labelledby':'share-tab-web'},[node('h2',{},t('tabWeb')),node('p',{class:'share-muted'},t('webIntro'))]);
 if(publication.loading)card.append(node('p',{role:'status'},t('loading')));
 if(publication.error)card.append(node('p',{class:'share-alert',role:'alert'},t(publication.error)));
 if(publication.notice)card.append(node('p',{class:'share-alert',role:'status'},t(publication.notice)));
 if(!status){card.append(node('div',{class:'share-actions'},[button('webReload',()=>void loadPublication(),{disabled:publication.loading||publication.busy})]));return card;}
 const stateKey=status.active?'active':status.needsRepublish?'needsRepublish':'inactive';
 card.append(node('p',{class:'share-state'},[node('span',{class:'share-badge'+(status.active?' is-active':'')},t(stateKey)),node('span',{class:'share-muted'},t('currentVersion',{version:status.currentSourceVersion}))]));
 if(status.active&&status.publicPath){
  const url=new URL(status.publicPath,location.origin).href;
  card.append(node('label',{class:'share-url'},[node('span',{},t('publicUrl')),node('input',{type:'text',value:url,readOnly:true,autocomplete:'off','aria-label':t('publicUrl'),onFocus:event=>event.target.select()})]),
   node('div',{class:'share-actions'},[
    node('a',{href:status.publicPath,target:'_blank',rel:'noopener noreferrer',class:'button'},t('openPublic')),
    button('copyPublicLink',()=>copyPublicLink(url),{}),
    button('stop',()=>confirmAction('stopTitle',[node('p',{},t('stopHint'))],()=>void stopPublication()),{danger:true})]));
 }
 if(status.needsRepublish)card.append(node('p',{class:'share-muted'},t('sourceChangeStops')),node('div',{class:'share-actions'},[button('keepPrivate',()=>confirmAction('stopTitle',[node('p',{},t('stopHint'))],()=>void stopPublication()),{})]));
 card.append(node('div',{class:'share-actions'},[button('review',()=>void reviewPublication(),{primary:true,disabled:publication.busy||publication.uncertain})]));
 const preview=publication.preview;
 if(preview)card.append(node('div',{class:'share-preview'},[
  node('h3',{},t('previewTitle')),
  node('p',{class:'share-muted'},t('reviewVersion',{version:preview.sourceVersion})),
  node('p',{},t('reviewReady')),
  node('p',{class:'share-muted'},t('literalSecrets')),
  node('ul',{},preview.exclusions.map(key=>node('li',{},t('exclude_'+key)))),
  node('label',{class:'share-scope'},[node('input',{type:'checkbox',checked:publication.consent,disabled:publication.busy,onChange:event=>{publication.consent=event.target.checked;render();}}),node('span',{},t('consent'))]),
  node('div',{class:'share-actions'},[button('publish',()=>confirmAction('publishTitle',[node('p',{},t('publicWarning')),node('p',{},t('rotation'))],()=>void publishPage()),{primary:true,disabled:!publication.consent||publication.busy})])
 ]));
 return card;
}

function render(){if(!active||!i18n)return;themeControl.disabled=language.disabled=disabled()||!client;onChange?.({busy:state.busy,dirty:state.dirty});const focused=document.activeElement?.dataset?.focus;main.replaceChildren();skipLink.textContent=t('skip');get('share-theme-label').textContent=t('theme');get('share-language-label').textContent=t('language');get('share-sidebar-title').textContent=t('title');get('share-account').textContent=t('account');const back=get('share-back');back.textContent=t('back');back.href=validContext?'/workspace?workspace='+encodeURIComponent(workspaceId)+(pageId?'&page='+encodeURIComponent(pageId):''):'/account';get('share-sidebar-note').textContent=t('sidebarNote');
  main.append(node('h1',{class:'share-title'},t(resourceOnly?'resourceTitle':'title')),node('p',{class:'share-subtitle'},t(resourceOnly?'resourceIntro':'intro')),node('div',{class:'share-toolbar'},[button('reload',()=>void reload(true),{disabled:state.loading||state.busy||!client}),...(!resourceOnly?[node('a',{href:'/account'},t('account'))]:[])]));
  if(pageId)main.append(renderTabs());
  if(state.error)main.append(node('p',{class:'share-alert',role:'alert'},t(state.error)));if(state.notice)main.append(node('p',{class:'share-alert',role:'status'},t(state.notice)));if(state.loading)main.append(node('p',{role:'status'},t('loading')));
  const model=state.model;if(model){main.append(node('section',{class:'share-card'},[node('h2',{translate:'no'},model.page?.title??model.workspaceName),node('p',{class:'share-context'},[node('span',{translate:'no'},model.workspaceName),node('span',{},t('role_'+model.role)),node('span',{},t('revision')+' '+model.revision)]),node('p',{class:'share-muted',translate:'no'},model.user.email)]));
    if(pageId&&state.tab==='web'){main.append(renderWeb());}else{const invitations=node('div',{class:'share-grid'},[node('section',{class:'share-card'},[node('h2',{},t('invite')),node('p',{class:'share-muted'},t('queuedNote')),renderInvite(model)]),node('section',{class:'share-card'},[node('h2',{},t('currentInvitations')),renderInvitations(model)])]),grants=node('section',{class:'share-card'},[node('h2',{},t('pageAccess')),renderGrants(model)]);
    if(resourceOnly)main.append(grants,node('details',{class:'resource-invitations',open:invitationExpanded,onToggle:event=>{invitationExpanded=event.currentTarget.open;}},[node('summary',{},t('invite')),invitations]));else main.append(invitations,grants,node('section',{class:'share-card'},[node('h2',{},t('members')),renderMembers(model)]));}}
  if(!embedded)brand?.apply({kind:document.documentElement.dataset.appearance,titleSuffix:t('title')});if(focused)requestAnimationFrame(()=>{if(active)Array.from(main.querySelectorAll('[data-focus]')).find(item=>item.dataset.focus===focused)?.focus();});}
themeControl.replaceChildren(...THEMES.map(theme=>node('option',{value:theme.id},theme.name)));
const preferenceHandlers=new Map();
for(const [control,key]of [[language,'locale'],[themeControl,'themeId']]){
 const changed=async()=>{if(!active||!i18n||!client||disabled())return;try{if(client)await client.verifyActor();if(!active)return;if(key==='locale'&&!await i18n.switchLocale(control.value))return;if(!active)return;preferences.update({[key]:control.value,...(key==='themeId'?{customColors:{}}:{})});applyPreferences();render();}catch(error){if(active){state.error=error.code==='ACTOR_CHANGED'||[401,403,404].includes(error.status)?classify(error):'preferencesFailed';render();}}};
 preferenceHandlers.set(control,changed);control.addEventListener('change',changed);
}
const beforeUnload=event=>{if(active&&(state.dirty||state.busy)){event.preventDefault();event.returnValue='';}};
const focused=()=>{if(active&&!disabled())void reload();};
const clicked=event=>{const link=event.target.closest?.('a[href]');if(!active||!link||!root.contains(link)||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;event.preventDefault();onNavigate?.({href:link.href});};
view?.addEventListener('beforeunload',beforeUnload);view?.addEventListener('focus',focused);
if(embedded)root.addEventListener('click',clicked);
const ready=(async()=>{try{
  const [catalogs,config]=await Promise.all([loadCatalogs({namespace:'share'}),loadInstanceConfig()]);
  if(!active)return;
  instanceConfig=config;brand=createInstanceBrand(config);i18n=createI18n(catalogs,preferences.snapshot().locale); await i18n.switchLocale(i18n.requestedLocale);if(!active)return;applyPreferences();render();
  if(!validContext||resourceOnly&&!pageId||!['page','collection'].includes(resourceKind))throw new SharingError('INVALID_CONTEXT',400);const response=await boundFetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)}),session=await response.json();if(!response.ok||!validShareId(session?.user?.id)||session.user.emailVerified!==true)throw new SharingError('UNVERIFIED',401);
  if(!active)return;if(expectedAccountId!==null&&session.user.id!==expectedAccountId)throw new SharingError('ACTOR_CHANGED',401);
  preferences=new PreferencesStore({profileId:session.user.id});applyInstanceDefaults(preferences,instanceConfig);await i18n.switchLocale(preferences.snapshot().locale);if(!active)return;applyPreferences();client=new SharingClient({workspaceId,pageId,accountId:session.user.id,fetcher:boundFetch});await reload();
}catch(error){if(!active)return;state.error=classify(error);if(i18n)render();else main.replaceChildren(node('p',{role:'alert'},'共有画面を読み込めません。 / Sharing is unavailable.'));}
if(active&&!embedded)stopAppearance=watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>brand?.apply({kind})});
})();

 return {
  ready,
  get closeState(){return {busy:active&&state.busy,dirty:active&&state.dirty};},
  canClose(){return !active||!state.busy&&!state.dirty;},
  focusSection(){if(active)main.focus({preventScroll:true});},
  destroy(){if(!active)return;active=false;lifecycle.abort();clearPrivate();stopAppearance();view?.removeEventListener('beforeunload',beforeUnload);view?.removeEventListener('focus',focused);root.removeEventListener('click',clicked);for(const[control,changed]of preferenceHandlers)control.removeEventListener('change',changed);if(modal.open)modal.close();modal.replaceChildren();main.replaceChildren();state.model=null;state.draft={requestId:'',purpose:'',email:'',role:'viewer'};state.grant={accountId:'',permission:'viewer'};state.memberRoles.clear();state.tab='share';publication.status=null;publication.preview=null;publication.error='';publication.notice='';publication.consent=false;publication.busy=false;publication.loading=false;state.dirty=false;state.busy=false;state.loading=false;client=null;if(embedded)root.replaceChildren();root.classList.remove('sharing-page','settings-sharing');}
 };
}
