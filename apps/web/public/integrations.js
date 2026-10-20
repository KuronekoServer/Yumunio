import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors} from './preferences.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
import {integrationId,validateIntegrationsStatus,validateTokenMetadata,readIntegrationsJson,ApiTokenIntent,createIntegrationScopes,readMcpAvailability,validateIntegrationGrant,integrationEndpoints} from './integrations-model.js';
const app=document.getElementById('integrations-main'),nav=document.getElementById('integrations-nav'),dialog=document.getElementById('integrations-confirm'),query=new URL(location.href).searchParams;
const state={actor:null,data:null,workspaces:[],workspace:integrationId(query.get('workspace'))?query.get('workspace'):'',pages:[],page:integrationId(query.get('page'))?query.get('page'):'',name:'',document:false,write:false,mcp:false,mcpStatus:null,mcpUnavailable:false,days:'7',intent:null,secret:null,secretId:null,reveal:false,busy:false,stopped:false,journalError:false,message:'loading',error:false};
let preferences=new PreferencesStore(),i18n,brand;
const t=(key,values)=>i18n.t(key,values);
function node(tag,attrs={},children=[]){const element=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(value===null||value===undefined||value===false)continue;if(key.startsWith('on'))element.addEventListener(key.slice(2).toLowerCase(),value);else if(['disabled','checked','readOnly','value','required'].includes(key))element[key]=value;else element.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)element.append(child instanceof Node?child:document.createTextNode(String(child)));return element;}
function button(key,action,{disabled=false,primary=false}={}){return node('button',{type:'button',class:'button'+(primary?' primary':''),disabled:state.busy||disabled,onClick:()=>void action()},t(key));}
function field(label,input,hint){return node('label',{class:'field'},[node('span',{},t(label)),input,...(hint?[node('span',{class:'hint'},t(hint))]:[])]);}
async function request(path,{method='GET',body,headers={},accountId=state.actor?.id,maxBytes=131072}={}){let response;try{response=await fetch(path,{method,mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000),headers:{...(accountId?{'X-Yumunio-Expected-Account':accountId}:{}),...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw Object.assign(new Error('NETWORK_UNCERTAIN'),{code:'NETWORK_UNCERTAIN'});}if(!response.ok){let code;try{const value=await readIntegrationsJson(response);if(typeof value?.error?.code==='string'&&/^[A-Z_]{1,80}$/.test(value.error.code))code=value.error.code;}catch{}throw Object.assign(new Error('TOKEN_REQUEST_FAILED'),{status:response.status,code});}return readIntegrationsJson(response,{maxBytes});}
async function sameAccount(){const session=await request('/api/auth/get-session',{accountId:null});if(session?.user?.emailVerified!==true||session.user.id!==state.actor?.id)throw Object.assign(new Error('ACCOUNT_CHANGED'),{status:401});}
function errorKey(error){if(error?.status===401){state.stopped=true;state.secret=null;state.secretId=null;state.data=null;return'accountChanged';}if(error?.code==='INTEGRATION_ACCESS_CHANGED')return'accessChanged';if(error?.code==='MCP_UNAVAILABLE')return'mcpStatusUnavailable';if(error?.status===403||error?.status===404)return'denied';if(error?.status===409)return'conflict';if(error?.status===429)return'quota';if(['TOKEN_JOURNAL_INVALID','TOKEN_JOURNAL_UNAVAILABLE'].includes(error?.code)){state.journalError=true;return'journalError';}return'unavailable';}
function applyAppearance(){const pref=resolveAppearancePreferences(preferences.snapshot()),theme=THEMES.find(item=>item.id===pref.themeId),colors=validateCustomColors(pref.themeId,pref.customColors).colors;for(const[role,value]of Object.entries(colors))document.documentElement.style.setProperty('--'+role,value);document.documentElement.style.fontFamily=FONT_OPTIONS.find(font=>font.id===pref.fontId)?.family;document.documentElement.style.colorScheme=theme.kind;applyLocaleDocument(document,i18n);i18n.setLocale(pref.locale);document.querySelector('.skip-link').textContent=t('skip');document.getElementById('integrations-account').textContent=t('account');nav.setAttribute('aria-label',t('navigation'));nav.replaceChildren(node('a',{href:'/account#account'},t('account')),node('a',{href:'/preferences'},t('preferences')));const language=node('select',{'aria-label':t('language'),disabled:state.busy,onChange:async event=>{const code=event.target.value;if(!await i18n.switchLocale(code))return;preferences.update({locale:code});applyAppearance();render();}},createLocaleOptions(document,i18n,{value:i18n.requestedLocale}));language.replaceChildren(...createLocaleOptions(document,i18n,{value:pref.locale})); language.value=pref.locale;nav.append(language);brand?.apply({kind:theme.kind,titleSuffix:t('title')});}
const formatDate=value=>new Intl.DateTimeFormat(i18n.locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
function confirmAction(key,content,action,{consent=false,confirmKey='close'}={}){if(state.busy||dialog.open)return;const confirm=button(confirmKey,()=>{dialog.close();void action();},{primary:true,disabled:consent});dialog.replaceChildren(node('h2',{id:'integrations-confirm-title',tabindex:'-1'},t(key)),...content,...(consent?[node('label',{class:'integration-consent'},[node('input',{type:'checkbox',onChange:event=>{confirm.disabled=!event.target.checked;}}),node('span',{},t('consent'))])]:[]),node('div',{class:'integration-actions'},[button('cancel',()=>dialog.close()),confirm]));dialog.showModal();dialog.querySelector('h2').focus();dialog.scrollTop=0;}
function updateReviewButton(){const control=app.querySelector('[data-review]');if(control)control.disabled=state.busy||!state.data?.enabled||state.stopped||!!state.intent||!!state.secret||state.journalError||!state.workspace||!state.page||!state.name.trim();}
function scopeContent(scopes){const keys={'page:read':'pageScope','document:read':'documentScope','document:write':'writeScope','mcp:connect':'mcpScope'};return scopes.flatMap((scope,index)=>[...(index?[node('br')]:[]),node('code',{},scope),' - ',t(keys[scope])]);}
function currentPage(){return state.pages.find(page=>page.id===state.page);}
async function readMcpStatus(){state.mcpStatus=null;state.mcpUnavailable=false;const value=await readMcpAvailability(()=>request('/api/integrations/mcp'));state.mcpStatus=value.status;state.mcpUnavailable=value.unavailable;if(!state.mcpStatus?.enabled)state.mcp=false;return state.mcpStatus;}
function updateMetadata(metadata){if(!state.data)return;state.data.tokens=[metadata,...state.data.tokens.filter(row=>row.id!==metadata.id)].slice(0,state.data.limits.maxMetadata);}
async function readStatus(){const value=validateIntegrationsStatus(await request('/api/integrations/tokens'));state.data=value;if(state.intent&&state.intent.snapshot().phase!=='issued'){const snapshot=state.intent.review(value,{accountId:state.actor.id});if(snapshot.phase==='revoked')state.intent=null;}await readMcpStatus();return value;}
async function refreshStatus(){if(state.busy||!state.actor||state.stopped)return;state.busy=true;state.message='loading';state.error=false;render();try{await sameAccount();await readStatus();state.message=state.intent?.snapshot().phase==='secret-unavailable'?'secretUnavailable':'loaded';}catch(error){state.message=errorKey(error);state.error=true;}finally{state.busy=false;render();}}
function pagesFrom(value,workspaceId){if(value?.workspaceId!==workspaceId||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.pages)||value.pages.some(page=>!integrationId(page.id)||typeof page.title!=='string'||page.title.length>240||!Array.isArray(page.capabilities)||!page.capabilities.includes('read')))throw new Error('INVALID_PAGE_LIST');return value;}
async function readPages(workspaceId){return pagesFrom(await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/pages',{maxBytes:2097152}),workspaceId);}
async function changeWorkspace(value){if(state.busy||state.intent||state.secret||state.stopped)return;state.workspace=value;state.pages=[];state.page='';state.write=false;state.busy=true;state.message='loading';render();try{await sameAccount();state.pages=(await readPages(value)).pages;state.message='';}catch(error){state.message=errorKey(error);state.error=true;}finally{state.busy=false;render();}}
function reviewContent(body,page,workspace){return[node('p',{class:'integration-target',translate:'no'},page.title),node('p',{class:'hint',translate:'no'},workspace?.name??''),node('dl',{class:'integration-details'},[node('dt',{},t('name')),node('dd',{translate:'no'},body.name),node('dt',{},t('scopes')),node('dd',{},scopeContent(body.scopes)),node('dt',{},t('expiresAt')),node('dd',{},formatDate(body.expiresAt))]),node('p',{},t('reviewHint')),...(body.scopes.includes('document:write')?[node('p',{},t('writeReviewHint'))]:[]),...(body.scopes.includes('mcp:connect')?[node('p',{},t('mcpReviewHint'))]:[]),node('p',{class:'hint'},t('scopeBoundary'))];}
async function prepareReview(){if(state.busy||state.intent||state.secret||state.stopped||state.journalError||!state.workspace||!state.page||!state.name.trim())return;const selected={workspaceId:state.workspace,pageId:state.page,name:state.name.trim(),scopes:createIntegrationScopes({document:state.document,write:state.write,mcp:state.mcp}),days:Number(state.days)};state.busy=true;state.message='loading';state.error=false;render();try{await sameAccount();const status=await readStatus();if(!status.enabled)throw new Error();const pages=await readPages(selected.workspaceId),page=pages.pages.find(page=>page.id===selected.pageId);if(!page)throw Object.assign(new Error(),{status:404});state.pages=pages.pages;if(!page.capabilities.includes('editBody'))state.write=false;const scopes=validateIntegrationGrant(selected.scopes,{page,mcpStatus:state.mcpStatus});const requestBody={requestId:crypto.randomUUID(),expectedRevision:pages.revision,workspaceId:selected.workspaceId,pageId:selected.pageId,name:selected.name,scopes,expiresAt:new Date(Date.parse(status.serverTime)+selected.days*86400000).toISOString(),confirmPageAccess:true};const intent=new ApiTokenIntent({accountId:state.actor.id,requestBody,storage:sessionStorage});state.busy=false;state.message='';render();confirmAction('reviewTitle',reviewContent(requestBody,page,state.workspaces.find(row=>row.id===selected.workspaceId)),()=>{state.intent=intent;return submitIntent(false);},{consent:true,confirmKey:'confirmCreate'});}catch(error){state.message=errorKey(error);state.error=true;}finally{state.busy=false;render();}}
async function submitIntent(retry){if(state.busy||!state.intent||state.stopped)return;state.busy=true;state.message='loading';state.error=false;render();try{await sameAccount();const result=await state.intent.submit((path,options)=>request(path,options),{accountId:state.actor.id,confirmRetry:retry});updateMetadata(result.metadata);if(result.secretAvailable){state.secret=result.token;state.secretId=result.metadata.id;state.reveal=false;state.message='created';}else state.message='secretUnavailable';}catch(error){const key=errorKey(error);state.message=key==='unavailable'?'unknown':key;state.error=true;}finally{state.busy=false;render();document.getElementById('integration-secret-heading')?.focus();}}
async function reviewRetry(){if(state.busy||!state.intent||state.stopped)return;state.busy=true;state.message='loading';state.error=false;render();try{await sameAccount();await readStatus();if(!state.intent||state.intent.snapshot().phase!=='uncertain'){state.message=state.intent?'secretUnavailable':'loaded';return;}const body=state.intent.snapshot().body,pages=await readPages(body.workspaceId),page=pages.pages.find(row=>row.id===body.pageId);if(!page)throw Object.assign(new Error(),{status:404});validateIntegrationGrant(body.scopes,{page,mcpStatus:state.mcpStatus});state.busy=false;render();confirmAction('retryTitle',[node('p',{},t('retryHint')),...reviewContent(body,page,state.workspaces.find(row=>row.id===body.workspaceId))],()=>submitIntent(true),{consent:true,confirmKey:'retry'});}catch(error){state.message=errorKey(error);state.error=true;}finally{state.busy=false;render();}}
async function revoke(row){if(state.busy||state.stopped)return;state.busy=true;state.message='loading';state.error=false;render();try{await sameAccount();const result=await request('/api/integrations/tokens/'+row.id,{method:'DELETE',body:{expectedVersion:row.version}});if(!result||Object.keys(result).length!==1)throw new Error();const metadata=validateTokenMetadata(result.metadata);if(metadata.id!==row.id||metadata.revokedAt===null)throw new Error();updateMetadata(metadata);if(state.secretId===row.id){state.secret=null;state.secretId=null;state.reveal=false;}if(state.intent&&state.intent.snapshot().body.requestId===metadata.requestId){state.intent.review(state.data,{accountId:state.actor.id});if(state.intent.snapshot().phase==='revoked')state.intent=null;}state.message='revoked';}catch(error){state.message=errorKey(error);state.error=true;}finally{state.busy=false;render();}}
function render(){
 if(!i18n)return;
 let webhookLink=nav.querySelector('[data-webhook-link]');
 if(!webhookLink){webhookLink=node('a',{'data-webhook-link':'',href:'/webhooks'});nav.insertBefore(webhookLink,nav.querySelector('select'));}
 webhookLink.textContent=t('webhooks');webhookLink.href='/webhooks'+(state.workspace?'?workspace='+encodeURIComponent(state.workspace)+(state.page?'&page='+encodeURIComponent(state.page):''):'');
 app.setAttribute('aria-busy',String(state.busy));nav.querySelector('select').disabled=state.busy;
 const root=node('div',{},[
  node('div',{class:'integration-toolbar'},[node('h1',{},t('title')),button('refresh',refreshStatus,{disabled:!state.actor||state.stopped})]),
  node('p',{class:'hint'},t('intro')),node('p',{class:'hint'},t('scopeBoundary')),node('p',{class:'hint'},t('liveBoundary'))
 ]);
 if(state.message)root.append(node('p',{class:'integration-message',role:state.error?'alert':'status'},t(state.message)));
 if(state.journalError)root.append(node('p',{role:'alert'},t('journalError')));
 if(!state.actor||state.stopped){root.append(node('a',{href:'/account#account'},t('account')));app.replaceChildren(root);return;}
 if(state.data){
  root.append(node('p',{class:'integration-availability'},t(state.data.enabled?'enabled':'disabled')),node('p',{class:'hint'},t(state.mcpUnavailable?'mcpStatusUnavailable':state.mcpStatus?.enabled?'mcpEnabled':'mcpDisabled')),node('p',{class:'hint'},t('environment')));
  if(state.secret){
   const input=node('input',{type:state.reveal?'text':'password',value:state.secret,readOnly:true,autocomplete:'off','aria-label':t('secretHeading'),spellcheck:'false',onFocus:event=>event.target.select()});
   root.append(node('section',{class:'integration-card integration-secret'},[
    node('h2',{id:'integration-secret-heading',tabindex:'-1'},t('secretHeading')),node('p',{class:'hint'},t('secretHint')),input,
    node('div',{class:'integration-actions'},[
     button(state.reveal?'hideSecret':'showSecret',()=>{state.reveal=!state.reveal;render();}),
     button('copy',async()=>{try{await navigator.clipboard.writeText(state.secret);state.message='copied';}catch{state.message='copyUnavailable';}render();}),
     button('finishSecret',()=>confirmAction('finishTitle',[node('p',{},t('finishHint'))],()=>{state.secret=null;state.secretId=null;state.reveal=false;if(state.intent?.snapshot().phase==='issued')state.intent=null;state.message='';render();}))
    ])
   ]));
  }
  const intent=state.intent?.snapshot();
  if(intent&&intent.phase!=='issued')root.append(node('section',{class:'integration-card'},[
   node('h2',{},t('pendingHeading')),node('p',{translate:'no'},intent.body.name),node('p',{class:'hint'},t('pendingHint')),
   node('p',{},t(['prepared','submitting'].includes(intent.phase)?'loading':intent.phase==='secret-unavailable'?'secretUnavailable':intent.phase==='rejected'?'rejected':'unknown')),
   ...(intent.phase==='uncertain'?[button('retry',reviewRetry,{disabled:!intent.reviewed})]:intent.phase==='rejected'?[button('editRequest',()=>{state.intent=null;state.message='';render();})]:[])
  ]));
  if(state.data.enabled){
   const locked=state.busy||!!state.intent||!!state.secret||state.journalError;
   const workspace=node('select',{disabled:locked,'aria-label':t('workspace'),onChange:event=>void changeWorkspace(event.target.value)},[
    node('option',{value:''},t('chooseWorkspace')),...state.workspaces.map(row=>node('option',{value:row.id},row.name))
   ]);workspace.value=state.workspace;
   const page=node('select',{disabled:locked||!state.workspace,'aria-label':t('page'),onChange:event=>{state.page=event.target.value;if(!currentPage()?.capabilities.includes('editBody'))state.write=false;render();}},[
    node('option',{value:''},t('choosePage')),...state.pages.map(row=>node('option',{value:row.id,disabled:state.write&&!row.capabilities.includes('editBody')},row.title))
   ]);page.value=state.page;
   const name=node('input',{type:'text',maxlength:'80',value:state.name,disabled:locked,onInput:event=>{state.name=event.target.value;updateReviewButton();}});
   const days=node('select',{disabled:locked,onChange:event=>{state.days=event.target.value;}},[1,7,30].filter(days=>days<=state.data.limits.maxLifetimeDays).map(days=>node('option',{value:String(days)},t(days===1?'oneDay':'days',{days}))));days.value=state.days;
   const readControl=node('input',{type:'checkbox',checked:state.document||state.write,disabled:locked||state.write,onChange:event=>{state.document=event.target.checked;}});
   const writeControl=node('input',{type:'checkbox',checked:state.write,disabled:locked||!currentPage()?.capabilities.includes('editBody'),onChange:event=>{state.write=event.target.checked;if(state.write)state.document=true;render();}});
   const review=button('review',prepareReview,{primary:true});review.setAttribute('data-review','');
   root.append(node('section',{class:'integration-card'},[
    node('h2',{},t('createHeading')),field('workspace',workspace),field('page',page),field('name',name,'nameHint'),
    node('p',{class:'hint'},scopeContent(['page:read'])),
    node('label',{class:'integration-consent'},[readControl,node('span',{},scopeContent(['document:read']))]),
    node('label',{class:'integration-consent'},[writeControl,node('span',{},scopeContent(['document:write']))]),
    node('p',{class:'hint'},t('writeHint')),
    ...(state.mcpStatus?.enabled?[node('label',{class:'integration-consent'},[
     node('input',{type:'checkbox',checked:state.mcp,disabled:locked,onChange:event=>{state.mcp=event.target.checked;}}),node('span',{},scopeContent(['mcp:connect']))
    ])]:[]),
    field('expiry',days),node('p',{class:'hint'},t('limitHint',{active:state.data.limits.maxActive,metadata:state.data.limits.maxMetadata})),review,node('p',{class:'hint'},t('retained'))
   ]));
  }
  const section=node('section',{'aria-labelledby':'integration-list-heading'},[node('h2',{id:'integration-list-heading'},t('listHeading'))]);
  if(!state.data.tokens.length)section.append(node('p',{class:'hint'},t('empty')));
  else{
   const list=node('ul',{class:'integration-list'});
   for(const row of state.data.tokens){
    const card=node('li',{class:'integration-card'},[
     node('div',{class:'integration-row-heading'},[node('h3',{translate:'no'},row.name),node('span',{class:'integration-state'},t('status_'+row.status))]),
     node('p',{class:'integration-target',translate:'no'},row.target?.title??t('targetUnavailable')),
     node('dl',{class:'integration-details'},[
      node('dt',{},t('scopes')),node('dd',{},scopeContent(row.scopes)),node('dt',{},t('createdAt')),node('dd',{},formatDate(row.createdAt)),node('dt',{},t('expiresAt')),node('dd',{},formatDate(row.expiresAt))
     ])
    ]);
    if(row.target){
     const examples=integrationEndpoints(row);
     card.append(node('a',{href:'/workspace?workspace='+encodeURIComponent(row.target.workspaceId)+'&page='+encodeURIComponent(row.target.pageId)},t('openPage')),node('details',{class:'integration-endpoints'},[
      node('summary',{},t('endpoints')),...examples.flatMap(endpoint=>[node('code',{},endpoint),node('br')]),node('code',{},'Authorization: Bearer <token>'),
      ...(row.scopes.includes('document:write')?[node('p',{class:'hint'},t('writeRequestHint'))]:[]),
      ...(row.scopes.includes('mcp:connect')?[node('p',{class:'hint'},t('mcpRequestHint'))]:[])
     ]));
    }
    if(row.revokedAt===null&&state.data.enabled)card.append(button('revoke',()=>confirmAction('revokeTitle',[node('p',{translate:'no'},row.name),node('p',{},t('revokeHint'))],()=>revoke(row),{confirmKey:'confirmRevoke'})));
    list.append(card);
   }
   section.append(list);
  }
  root.append(section);
 }
 app.replaceChildren(root);updateReviewButton();brand?.apply({titleSuffix:t('title')});
}
window.addEventListener('beforeunload',event=>{if(state.busy||state.secret||state.intent&&state.intent.snapshot().phase!=='issued'){event.preventDefault();event.returnValue='';}});
try{const catalogs=await loadCatalogs({namespace:'integrations'});const instance=await loadInstanceConfig();brand=createInstanceBrand(instance);const config=await request('/api/auth/config',{accountId:null}),session=config?.enabled?await request('/api/auth/get-session',{accountId:null}):null;state.actor=session?.user?.emailVerified===true&&integrationId(session.user.id)?session.user:null;preferences=new PreferencesStore({profileId:state.actor?.id||'local'});applyInstanceDefaults(preferences,instance);i18n=createI18n(catalogs,preferences.snapshot().locale); await i18n.switchLocale(i18n.requestedLocale);applyAppearance();if(!state.actor){state.message=config?.enabled?'signIn':'accountsDisabled';render();}else if(config.workspaceContent===false){state.message='contentDisabled';render();}else{state.busy=true;render();try{state.intent=ApiTokenIntent.restore({accountId:state.actor.id,storage:sessionStorage});}catch{state.journalError=true;}await sameAccount();await readStatus();const workspaces=await request('/api/auth/organization/list',{accountId:null,maxBytes:2097152});if(!Array.isArray(workspaces)||workspaces.length>1000||workspaces.some(row=>!integrationId(row.id)||typeof row.name!=='string'||row.name.length>240))throw new Error();state.workspaces=workspaces;if(state.workspace&&workspaces.some(row=>row.id===state.workspace)){state.pages=(await readPages(state.workspace)).pages;if(!state.pages.some(row=>row.id===state.page))state.page='';}else{state.workspace='';state.page='';}state.message=state.intent?state.intent.snapshot().phase==='secret-unavailable'?'secretUnavailable':'restored':'loaded';state.busy=false;render();}}
catch(error){state.busy=false;if(i18n){state.message=errorKey(error);state.error=true;render();}else app.replaceChildren(node('p',{role:'alert'},'外部APIを確認できません。 / External API tokens are unavailable.'));}

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>brand?.apply({kind})});
