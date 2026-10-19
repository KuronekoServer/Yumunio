import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors } from './preferences.js';
import { createI18n, loadCatalogs, createLocaleOptions, applyLocaleDocument, applyLocaleNotice } from './i18n.js';
import { loadInstanceConfig, applyInstanceDefaults, createInstanceBrand } from './instance.js';
import { settingsLocation, importHref, loadWorkspaceSettings } from './workspace-settings-model.js';

/** Shared standalone/embedded workspace settings controller. */
export function mountWorkspaceSettings({root,embedded=false,expectedAccountId=null,workspaceId='',section='general',onNavigate,onChange}={}){
if(!root?.ownerDocument)throw new TypeError('INVALID_SETTINGS_ROOT');
const document=root.ownerDocument,view=document.defaultView??globalThis.window,app=root;
let destroyed=false,unwatch=()=>{},media;

const state={context:null,error:'',loading:true,navOpen:false,section:'overview',workspaceId:'',generation:0};
let preferences=new PreferencesStore(),i18n,branding,instance,controller,focusAfterRender=false;
const t=(key,values)=>i18n.t(key,values);
function node(tag,attributes={},children=[]){
 const result=document.createElement(tag);
 for(const[key,value]of Object.entries(attributes)){
  if(value===null||value===undefined||value===false)continue;
  if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);
  else if(['disabled','value'].includes(key))result[key]=value;
  else result.setAttribute(key,String(value));
 }
 for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(child instanceof Node?child:document.createTextNode(String(child)));
 return result;
}
function icon(name){
 const paths={back:'M15 6l-6 6 6 6',menu:'M4 6h16 M4 12h16 M4 18h16',close:'M6 6l12 12 M18 6L6 18',settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',import:'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',people:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',page:'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',book:'M4 4h6l2 2 2-2h6v16h-6l-2 2-2-2H4z M12 6v16'};
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 for(const[key,value]of Object.entries({viewBox:'0 0 24 24',width:20,height:20,fill:'none',stroke:'currentColor','stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,String(value));
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]||paths.page);svg.append(path);return svg;
}
function action(key,onClick,attributes={}){return node('button',{type:'button',class:'button',onClick,...attributes},t(key));}
function link(key,href,name='page'){return node('a',{class:'settings-link',href},[icon(name),t(key)]);}
function workspaceHref(){return '/workspace?workspace='+encodeURIComponent(state.workspaceId);}
function sectionLink(section,key,name){
 const href='/workspace-settings?workspace='+encodeURIComponent(state.workspaceId)+'&section='+section;
 return node('a',{class:'settings-link',href,...(state.section===section?{'aria-current':'page'}:{}),onClick:event=>{
  if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();state.section=section;state.navOpen=false;if(!embedded)history.replaceState(null,'',href);focusAfterRender=true;render();
 }},[icon(name),t(key)]);
}
function applyPreferences(){
 const pref=resolveAppearancePreferences(preferences.snapshot()),theme=THEMES.find(item=>item.id===pref.themeId)||THEMES[0],colors=validateCustomColors(pref.themeId,pref.customColors).colors||theme.colors;
 for(const[key,value]of Object.entries(colors))document.documentElement.style.setProperty('--'+key,value);
 document.documentElement.style.fontFamily=FONT_OPTIONS.find(item=>item.id===pref.fontId)?.family||FONT_OPTIONS[0].family;
 document.documentElement.style.colorScheme=theme.kind;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',colors.nav);
 if(!embedded){const skip=document.querySelector('.skip-link');if(skip)skip.textContent=t('skip');applyLocaleDocument(document,i18n);}
}
function setNavigation(open){
 state.navOpen=open;render();
 if(open)app.querySelector('.settings-mobile-close')?.focus();else app.querySelector('.settings-mobile-toggle')?.focus();
}
function sidebar(){
 const brand=node('a',{class:'settings-brand',href:state.context?workspaceHref():'/account','data-instance-label':''},[node('img',{'data-instance-logo':'',hidden:true,alt:''}),icon('book'),node('span',{'data-instance-name':''},'Yumunio')]);
 brand.querySelector('svg').setAttribute('data-instance-default-logo','');
 const side=node('aside',{class:'settings-sidebar',id:'settings-sidebar','aria-label':t('navigation')},[
  node('div',{},[brand,node('button',{type:'button',class:'button icon-button settings-mobile-close','aria-label':t('closeMenu'),onClick:()=>setNavigation(false)},icon('close'))]),
  node('div',{class:'settings-context'},[node('span',{},t('workspaceLabel')),node('strong',{translate:'no'},state.context?.workspace.name||t('currentWorkspace'))]),
  node('nav',{class:'settings-group','aria-label':t('workspaceGroup')},[node('h2',{},t('workspaceGroup')),sectionLink('overview','overview','settings'),sectionLink('import','import','import'),...(state.context?[link('members','/share?workspace='+encodeURIComponent(state.workspaceId),'people'),link('groups','/workspace-settings?workspace='+encodeURIComponent(state.workspaceId)+'&section=groups','people')]:[])]),
  node('nav',{class:'settings-group','aria-label':t('personalGroup')},[node('h2',{},t('personalGroup')),link('preferences','/preferences','settings'),link('account','/account#account','people')]),
  node('div',{class:'settings-sidebar-footer'},[...(state.context?[link('backWorkspace',workspaceHref(),'back'),node('small',{translate:'no'},state.context.user.name)]:[]),node('a',{class:'settings-license',href:'./LICENSE.txt'},'MIT License')])
 ]);
 return side;
}
function overview(){
 const context=state.context;
 const facts=node('dl',{class:'settings-facts'},[
  node('div',{},[node('dt',{},t('workspaceName')),node('dd',{translate:'no'},context.workspace.name)]),
  node('div',{},[node('dt',{},t('yourRole')),node('dd',{},t('role_'+context.role))])
 ]);
 return [
  node('section',{class:'settings-section'},[node('h2',{},t('general')),facts]),
  node('section',{class:'settings-section'},[node('h2',{},t('content')),node('div',{class:'settings-action-row'},[node('div',{},[node('h3',{},t('import')),node('p',{},t('importSummary'))]),node('a',{class:'button',href:'/workspace-settings?workspace='+encodeURIComponent(state.workspaceId)+'&section=import',onClick:event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();if(embedded){onNavigate?.({section:'import'});return;}state.section='import';if(!embedded)history.replaceState(null,'',event.currentTarget.href);focusAfterRender=true;render();}},t('chooseSource'))])]),
  node('section',{class:'settings-section'},[node('h2',{},t('access')),node('div',{class:'settings-action-row'},[node('div',{},[node('h3',{},t('members')),node('p',{},t('membersHint'))]),node('a',{class:'button',href:'/share?workspace='+encodeURIComponent(state.workspaceId)},t('openMembers'))])]),
  node('p',{class:'settings-transfer-note'},t('settingsBoundary'))
 ];
}
function importSection(){
 const context=state.context;
 const providers=node('div',{class:'import-provider-list'},['notion','appflowy'].map(source=>
  node('section',{class:'import-provider'},[node('div',{class:'provider-symbol'},icon('import')),node('div',{},[node('h2',{},source==='notion'?'Notion':'AppFlowy'),node('p',{},t(source+'Description')),node('p',{class:'provider-limit'},t(source+'Limit'))]),context.canImport?node('a',{class:'button',href:importHref(state.workspaceId,source)},t('continue')):node('span',{class:'hint'},t('memberRequired'))])
 ));
 return [
  node('div',{class:'import-destination'},[node('span',{},t('destination')),node('strong',{translate:'no'},context.workspace.name),node('span',{},t('privateDestination'))]),
  ...(!context.canImport?[node('p',{class:'settings-status',role:'status'},t('guestHint'))]:[]),
  providers,
  node('p',{class:'settings-transfer-note'},t('transferBoundary')),
  node('p',{class:'hint'},t('accountBoundary'))
 ];
}
function failure(){
 const key=({INVALID_WORKSPACE:'invalidWorkspace',ACCOUNTS_DISABLED:'accountsDisabled',SIGN_IN:'signInRequired',VERIFY_EMAIL:'verifyRequired',CONTENT_DISABLED:'contentDisabled',WORKSPACE_UNAVAILABLE:'workspaceUnavailable',ACCOUNT_CHANGED:'accountChanged',INVALID_RESPONSE:'unavailable'})[state.error]||'unavailable';
 return node('section',{class:'settings-status',role:'alert'},[node('p',{},t(key)),node('div',{class:'settings-actions'},[node('a',{class:'button',href:'/account#account'},t('openAccount')),action('retry',()=>void load())])]);
}
function render(){
 if(destroyed||!i18n)return;
 const side=sidebar(),heading=node('h1',{id:'settings-heading',tabindex:'-1'},t(state.section==='import'?'import':'title'));
 const content=node('main',{class:'settings-content',id:'settings-content',tabindex:'-1','aria-labelledby':'settings-heading','aria-busy':String(state.loading)},[
  node('div',{class:'settings-heading'},[heading,node('p',{class:'settings-intro'},t(state.section==='import'?'importIntro':'intro'))]),
  ...(state.loading?[node('p',{role:'status'},t('loading'))]:state.error?[failure()]:state.context?(state.section==='import'?importSection():overview()):[])
 ]);
 const language=node('select',{id:'settings-language','aria-label':t('language'),disabled:state.loading,onChange:async event=>{
  const value=event.target.value;event.target.disabled=true;
  try{if(!await i18n.switchLocale(value)||destroyed)return;preferences.update({locale:value});applyPreferences();onChange?.(preferences.snapshot());render();}catch{event.target.value=preferences.snapshot().locale;}finally{event.target.disabled=false;}
 }},createLocaleOptions(document,i18n,{value:preferences.snapshot().locale}));
 language.value=preferences.snapshot().locale;
 const main=node('div',{class:'settings-main'},[
  node('header',{class:'settings-topbar'},[node('button',{class:'button icon-button settings-mobile-toggle',type:'button','aria-label':t('openMenu'),'aria-controls':'settings-sidebar','aria-expanded':String(state.navOpen),onClick:()=>setNavigation(true)},icon('menu')),node('div',{class:'settings-crumb'},t('settingsCrumb')),node('label',{class:'settings-language'},[node('span',{},t('language')),language])]),
  node('div',{class:'settings-scroll','data-locale-notice-host':''},content)
 ]);
 if(embedded){app.replaceChildren(content);app.lang=i18n.locale;if(focusAfterRender){focusAfterRender=false;heading.focus({preventScroll:true});content.scrollIntoView?.({block:'start'});}return;}
 app.replaceChildren(node('div',{class:'settings-shell'+(state.navOpen?' nav-open':'')},[side,node('button',{class:'settings-scrim',type:'button','aria-label':t('closeMenu'),tabindex:'-1',onClick:()=>setNavigation(false)}),main]));
 const mobile=matchMedia('(max-width:760px)').matches;side.inert=mobile&&!state.navOpen;main.inert=mobile&&state.navOpen;
 applyLocaleNotice(document,i18n);
 branding?.apply({kind:(THEMES.find(item=>item.id===resolveAppearancePreferences(preferences.snapshot()).themeId)||THEMES[0]).kind,titleSuffix:t('title')});
 if(focusAfterRender){focusAfterRender=false;heading.focus({preventScroll:true});app.querySelector('.settings-scroll').scrollTop=0;}
}
async function request(path,{headers={}}={}){
 const response=await fetch(path,{method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',headers,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
 if(destroyed)throw new Error('SETTINGS_UNAVAILABLE');
 if(!response.ok)throw new Error('SETTINGS_UNAVAILABLE');
 return response.json();
}
async function load(){
 if(destroyed)return;
 const generation=++state.generation;controller?.abort();controller=new AbortController();state.loading=true;state.error='';state.context=null;render();
 try{
  const context=await loadWorkspaceSettings({workspaceId:state.workspaceId,expectedAccountId,request});
  if(destroyed||generation!==state.generation)return;
  const nextPreferences=new PreferencesStore({profileId:context.user.id});applyInstanceDefaults(nextPreferences,instance);
  if(!await i18n.switchLocale(nextPreferences.snapshot().locale)||destroyed||generation!==state.generation)return;
  preferences=nextPreferences;state.context=context;applyPreferences();
 }catch(error){if(!destroyed&&generation===state.generation)state.error=error.code||'UNAVAILABLE';}
 finally{if(!destroyed&&generation===state.generation){state.loading=false;render();}}
}
function focusSection(value=section){if(destroyed)return;section=value;state.section=value==='import'?'import':'overview';focusAfterRender=true;render();}
const keydown=event=>{if(event.key==='Escape'&&state.navOpen)setNavigation(false);};
const resized=()=>{if(!destroyed){state.navOpen=false;render();}};
const focused=()=>{if(destroyed||!state.context||state.loading)return;const actorId=state.context.user.id;void request('/api/auth/get-session').then(session=>{if(!destroyed&&state.context?.user.id===actorId&&(session?.user?.id!==actorId||session.user.emailVerified!==true)){state.context=null;state.error='ACCOUNT_CHANGED';render();}}).catch(()=>{if(!destroyed&&state.context?.user.id===actorId){state.context=null;state.error='UNAVAILABLE';render();}});};
const clicked=event=>{if(!embedded||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;const link=event.target.closest?.('a[href]');if(!link)return;const url=new URL(link.href,location.href);if(url.pathname==='/share'){event.preventDefault();onNavigate?.({section:'members'});}else if(url.pathname==='/workspace-settings'&&url.searchParams.get('workspace')===state.workspaceId&&url.searchParams.get('section')==='groups'){event.preventDefault();onNavigate?.({section:'groups'});}};
const ready=(async()=>{
try{
 const [config,catalogs]=await Promise.all([loadInstanceConfig(),loadCatalogs({namespace:'workspace-settings'})]);
 if(destroyed)return;
 instance=config;branding=createInstanceBrand(instance);if(!embedded)applyInstanceDefaults(preferences,instance);
 i18n=createI18n(catalogs,preferences.snapshot().locale);await i18n.switchLocale(i18n.requestedLocale);if(destroyed)return;if(!embedded)applyPreferences();
 try{Object.assign(state,embedded?settingsLocation('https://local.invalid/?workspace='+encodeURIComponent(workspaceId)+'&section='+(section==='import'?'import':'overview')):settingsLocation(location.href));}catch(error){state.error=error.code;state.loading=false;render();}
 if(!state.error)await load();
 if(destroyed)return;
 view?.addEventListener('keydown',keydown);view?.addEventListener('focus',focused);app.addEventListener('click',clicked);
 media=globalThis.matchMedia?.('(max-width:760px)');media?.addEventListener('change',resized);
 unwatch=watchSystemAppearance(()=>destroyed?null:preferences?.snapshot(),{onAppearance:({kind})=>{if(!embedded)branding?.apply({kind});}});
}catch{if(!destroyed)app.replaceChildren(node('p',{class:'startup',role:'alert'},'Workspace settings are unavailable.'));}
})();
return {ready,focusSection,canClose:()=>true,get closeState(){return {busy:false,dirty:false};},destroy(){if(destroyed)return;destroyed=true;state.generation++;controller?.abort();unwatch();view?.removeEventListener('keydown',keydown);view?.removeEventListener('focus',focused);media?.removeEventListener('change',resized);app.removeEventListener('click',clicked);}};
}
if(typeof document!=='undefined'){
 const root=document.getElementById('settings-app');if(root){
  if(new URL(location.href).searchParams.get('section')==='groups'){
   try{const {workspaceId}=settingsLocation(location.href);void import('./groups-settings.js').then(({mountGroupsSettings})=>{if(root.isConnected)mountGroupsSettings({root,workspaceId});}).catch(()=>{if(root.isConnected)root.textContent='Groups are unavailable.';});}
   catch{root.textContent='Workspace settings are unavailable.';}
  }else mountWorkspaceSettings({root});
 }
}
