import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors,contrastRatio} from './preferences.js';
import {AccountPreferenceSync} from './preference-sync.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
export function preferenceDraftChanged(preferences,draft){
  if(!preferences||!draft)return false;
  try{const saved=preferences.snapshot(),value=preferences.validate(draft);return ['themeId','fontId','locale','followSystem'].some(key=>(saved[key]??false)!==(value[key]??false))||JSON.stringify(Object.entries(saved.customColors).sort())!==JSON.stringify(Object.entries(value.customColors).sort());}catch{return true;}
}
/** The same editor is mounted by the standalone page and the workspace dialog. */
export function mountPreferencesPage({root,embedded=false,expectedAccountId=null,workspaceId='',section='appearance',onNavigate,onChange}={}){
if(!root?.ownerDocument)throw new TypeError('INVALID_PREFERENCES_ROOT');
const document=root.ownerDocument,view=document.defaultView??globalThis.window;
const main=root,nav=embedded?document.createElement('nav'):document.getElementById('preferences-nav');
root.classList.add('preferences-surface');if(embedded)root.classList.add('settings-embedded');
const byId=id=>root.querySelector('#'+id);
let destroyed=false,unwatch=()=>{},media;
const lifetime=new AbortController();

const sync=new AccountPreferenceSync();
const routeQuery=new URL(embedded?'https://local.invalid/?workspace='+encodeURIComponent(workspaceId):location.href).searchParams;
const routeWorkspace=routeQuery.getAll('workspace').length===1&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(routeQuery.get('workspace'))?routeQuery.get('workspace'):'';
const workspaceReturn=routeWorkspace?'/workspace.html?workspace='+encodeURIComponent(routeWorkspace):'/account.html#account';
let preferences,draft,actor=null,i18n,brand,busy=false,blocked=false,message='',lastValid=null;
const node=(tag,attributes={},children=[])=>{
  const result=document.createElement(tag);
  for(const [key,value]of Object.entries(attributes)){
    if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);
    else if(['value','checked','disabled','hidden','type'].includes(key))result[key]=value;
    else result.setAttribute(key,value);
  }
  for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(child instanceof Node?child:document.createTextNode(String(child)));
  return result;
};
const t=key=>i18n?.t(key)??key;
const themeName=id=>t('theme'+id[0].toUpperCase()+id.slice(1));
const fontName=id=>id==='system'?t('fontSystem'):id==='monospace'?t('fontMonospace'):FONT_OPTIONS.find(font=>font.id===id)?.label??id;
const fontFamily=id=>FONT_OPTIONS.find(font=>font.id===id)?.family??FONT_OPTIONS[0].family;
async function currentSession(){
  const response=await fetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)])});
  if(!response.ok)throw new Error('sessionUnavailable');
  const result=await response.json();
  if(!result?.user)return null;
  if(typeof result.user.id!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(result.user.id)||result.user.emailVerified!==true)throw new Error('sessionUnavailable');
  return result.user;
}
function stopForAccountChange(){blocked=true;sync.setActor(null);message='sessionChanged';}
async function checkSession(){
  const current=await currentSession();
  if(destroyed)throw new Error('sessionChanged');
  if(current?.id!==actor?.id||expectedAccountId&&current?.id!==expectedAccountId){stopForAccountChange();throw new Error('sessionChanged');}
}
function applyPageAppearance(){
  const value=resolveAppearancePreferences(preferences.snapshot()),colors=validateCustomColors(value.themeId,value.customColors).colors??THEMES[1].colors;
  for(const [key,color]of Object.entries(colors))document.documentElement.style.setProperty('--'+key,color);
  const kind=value.customColors.canvas?(contrastRatio('#FFFFFF',colors.canvas)>contrastRatio('#102030',colors.canvas)?'dark':'light'):THEMES.find(theme=>theme.id===value.themeId).kind;
  document.documentElement.style.colorScheme=kind;document.documentElement.dataset.appearance=kind;document.documentElement.style.fontFamily=fontFamily(value.fontId);
  if(!embedded)brand.apply({kind,titleSuffix:t('title')});
}
function readDraft(){
  const form=byId('preference-form');if(!form)return draft;
  return {schemaVersion:1,themeId:form.querySelector('input[name=theme]:checked')?.value??draft.themeId,
    customColors:Object.fromEntries(['accent','canvas','text'].map(role=>[role,form.querySelector('#color-'+role).value]).filter(([,value])=>value!=='')),
    fontId:form.querySelector('#preference-font').value,locale:form.querySelector('#preference-locale').value,followSystem:form.querySelector('#follow-system').checked};
}
function preview(value){
  const effective=resolveAppearancePreferences(value),checked=validateCustomColors(effective.themeId,effective.customColors),colors=checked.colors??THEMES[1].colors;
  const box=node('div',{class:'preview'},[node('p',{class:'preview-title'},t('previewTitle')),node('p',{},t('previewText')),node('span',{class:'preview-accent'},t('previewAction'))]);
  for(const role of ['canvas','text','accent','on'])box.style.setProperty('--preview-'+role,colors[role]);box.style.setProperty('--preview-font',fontFamily(value.fontId));return box;
}
function refreshPreview(){
  draft=readDraft();let checked=null,error='';
  try{checked=preferences.validate(draft);lastValid=checked;}catch(reason){error=reason.message==='LOW_CONTRAST'?'invalidContrast':'invalidInput';}
  const container=byId('draft-preview');container?.replaceChildren(preview(checked??lastValid??preferences.snapshot()));
  const validation=byId('preference-validation');if(validation)validation.textContent=error?t(error):'';
  for(const role of ['accent','canvas','text'])byId('color-'+role)?.setAttribute('aria-invalid',error?'true':'false');
  for(const input of root.querySelectorAll('input[name=theme],#color-accent,#color-canvas,#color-text'))input.disabled=busy||blocked||draft.followSystem===true;
  const local=byId('save-local'),server=byId('save-account');
  for(const marker of root.querySelectorAll('[data-theme-check]'))marker.textContent=marker.dataset.themeCheck===draft.themeId?'✓':'';
  if(local)local.disabled=busy||blocked||!checked;
  if(server)server.disabled=busy||blocked||!checked||!actor||sync.revision===null;
}
function errorKey(error){
  if(['ACCOUNT_CHANGED','UNAUTHORIZED','PREFERENCES_NOT_FOUND'].includes(error.code)){stopForAccountChange();return 'sessionChanged';}
  if(error.message==='sessionChanged')return 'sessionChanged';
  if(error.message==='PREFERENCES_SAVE_FAILED')return 'localWriteError';
  if(error.status===409)return 'conflict';
  if(error.code==='PREFERENCE_NETWORK_UNCERTAIN')return 'uncertain';
  if(error.code==='INVALID_PREFERENCE_RESPONSE')return 'invalidResponse';
  if(error.message==='sessionUnavailable')return 'sessionUnavailable';
  return 'genericError';
}
async function perform(action,buttonId){
  if(destroyed||busy||blocked)return;
  draft=readDraft();busy=true;message='working';render();
  try{await action();}catch(error){message=errorKey(error);}
  finally{busy=false;if(!destroyed){render();byId(buttonId)?.focus();}}
}
const button=(id,key,action,primary=false,disabled=false)=>node('button',{id,type:'button',class:'button'+(primary?' primary':''),disabled,onClick:()=>void perform(action,id)},t(key));
function renderEditor(){
  const form=node('form',{id:'preference-form',class:'settings-form',onSubmit:event=>event.preventDefault()});
  const themes=node('fieldset',{'data-preference-section':'appearance',tabindex:'-1'},[node('legend',{},t('theme'))]),choices=node('div',{class:'themes'});
  for(const theme of THEMES){
    const input=node('input',{name:'theme',type:'radio',value:theme.id,checked:theme.id===draft.themeId,disabled:busy||blocked,onChange:refreshPreview});
    const swatch=node('span',{class:'theme-swatch','aria-hidden':'true'},[node('span',{class:'swatch-line'}),node('span',{class:'swatch-line'})]);
    for(const role of ['canvas','text','accent'])swatch.style.setProperty('--swatch-'+role,theme.colors[role]);
    const card=node('span',{class:'theme-card'},[swatch,node('span',{class:'theme-name'},[themeName(theme.id),node('span',{class:'theme-selected','data-theme-check':theme.id,'aria-hidden':'true'},theme.id===draft.themeId?'✓':'')])]);
    choices.append(node('label',{class:'theme-choice'},[input,card]));
  }
  themes.append(node('label',{class:'system-theme-choice'},[node('input',{id:'follow-system',type:'checkbox',checked:draft.followSystem===true,disabled:busy||blocked,onChange:refreshPreview}),node('span',{},t('followSystem'))]),node('p',{class:'hint'},t('followSystemHint')),choices);form.append(themes);
  const colorFields=node('div',{class:'color-fields'});
  for(const role of ['accent','canvas','text'])colorFields.append(node('label',{class:'field'},[t(role),node('input',{
    id:'color-'+role,type:'text',value:draft.customColors[role]??'',maxlength:'64',placeholder:t('colorPlaceholder'),autocomplete:'off',spellcheck:'false',
    disabled:busy||blocked,'aria-describedby':'color-hint preference-validation',onInput:refreshPreview,
  })]));
  const reset=node('button',{type:'button',class:'button link-button',disabled:busy||blocked,onClick:()=>{for(const role of ['accent','canvas','text'])byId('color-'+role).value='';refreshPreview();}},t('resetColors'));
  form.append(node('fieldset',{'data-preference-section':'colors',tabindex:'-1'},[node('legend',{},t('customColors')),colorFields,node('p',{id:'color-hint',class:'hint'},t('customHint')),reset,node('p',{id:'preference-validation',class:'validation',role:'status','aria-live':'polite'})]));
  const font=node('select',{id:'preference-font',disabled:busy||blocked,onChange:refreshPreview},FONT_OPTIONS.map(option=>node('option',{value:option.id},fontName(option.id))));font.value=draft.fontId;
  const locale=node('select',{id:'preference-locale',disabled:busy||blocked,onChange:async event=>{const code=event.target.value;if(!await i18n.switchLocale(code)||destroyed)return;draft=readDraft();draft.locale=code;render();byId('preference-locale')?.focus();}},createLocaleOptions(document,i18n,{value:i18n.requestedLocale}));locale.value=draft.locale;
  form.append(node('div',{class:'row-fields'},[node('label',{class:'field','data-preference-section':'font',tabindex:'-1'},[t('font'),font]),node('label',{class:'field','data-preference-section':'language',tabindex:'-1'},[t('locale'),locale])]),node('p',{class:'hint'},t('fontNote')));
  form.append(node('div',{},[node('div',{id:'draft-preview'}),node('p',{class:'preview-note'},t('previewNote'))]));
  form.append(node('div',{class:'actions'},[
    button('save-local','localSave',async()=>{if(actor)await checkSession();const value=preferences.update(preferences.validate(draft));draft=value;applyPageAppearance();onChange?.(value);message='localSaved';},true),
    button('restore-local','resetInputs',async()=>{if(actor)await checkSession();draft=preferences.snapshot();await i18n.switchLocale(draft.locale);message='inputsReset';},false,busy||blocked),
  ]),node('p',{class:'hint'},t('deviceBoundary')));
  return node('section',{class:'panel'},[node('div',{class:'panel-header'},[node('h2',{},t('localTitle')),node('p',{class:'intro'},t('localIntro'))]),form]);
}
function renderRemote(){
  const panel=node('section',{class:'panel remote-panel','data-preference-section':'sync',tabindex:'-1','aria-labelledby':'sync-heading'},[
    node('div',{class:'panel-header'},[node('h2',{id:'sync-heading'},t('remoteTitle')),node('p',{class:'intro'},t('syncIntro'))]),
    node('div',{class:'identity'},[node('strong',{},actor?.name??t('localProfile')),node('span',{},actor?.email??t('localProfileHint'))]),
  ]);
  if(!actor){panel.append(node('a',{href:'/account.html',class:'button'},t('loginToSync')),node('p',{class:'hint boundary'},t('syncBoundary')));return panel;}
  panel.append(button('load-account',sync.revision===null?'loadRemote':'reloadRemote',async()=>{await sync.load();message='loadSuccess';},false,busy||blocked));
  if(sync.revision===null)panel.append(node('p',{class:'hint'},t('remoteNotLoaded')));
  else if(sync.remote===null)panel.append(node('h3',{},t('remoteEmpty')),node('p',{class:'hint'},t('remoteEmptyHint')));
  else{
    const value=sync.remote,details=node('dl',{class:'remote-details'});
    for(const [key,text]of [['revision',String(sync.revision)],['theme',value.followSystem===true?t('followSystem'):themeName(value.themeId)],['font',fontName(value.fontId)],['locale',i18n.availableLocales.find(item=>item.code===value.locale)?.endonym??value.locale],['colors',Object.keys(value.customColors).length?Object.entries(value.customColors).map(([role,color])=>t(role)+' '+color).join(' / '):t('themeDefaults')]])
      details.append(node('div',{},[node('dt',{},t(key)),node('dd',{},text)]));
    panel.append(node('h3',{},t('remoteAvailable')),details,preview(value),
      button('apply-account','applyRemote',async()=>{await sync.applyRemote(preferences,{consent:true});draft=preferences.snapshot();await i18n.switchLocale(draft.locale);applyPageAppearance();onChange?.(draft);message='remoteApplied';},false,busy||blocked),
      node('p',{class:'hint'},t('applyHint')));
  }
  panel.append(button('save-account','serverSave',async()=>{await sync.save(preferences.validate(draft),{consent:true});message='remoteSaved';},true,true));
  if(sync.revision===null)panel.append(node('p',{class:'hint'},t('uploadHint')));
  panel.append(node('p',{class:'hint boundary'},t('syncBoundary')));return panel;
}
function render(){
  if(destroyed||!i18n)return;
  root.lang=i18n.locale;root.dir=i18n.dir;
  if(!embedded){applyLocaleDocument(document,i18n);const skip=document.querySelector('.skip-link');if(skip)skip.textContent=t('skip');}nav.setAttribute('aria-label',t('navigation'));
  nav.replaceChildren(node('a',{href:workspaceReturn},t('workspace')),node('a',{href:'/account.html'},t('account')));
  main.replaceChildren(node('div',{class:'page-heading'},[node('p',{class:'eyebrow'},t('eyebrow')),node('h1',{},t('title')),node('p',{class:'intro'},t('intro'))]));
  main.append(node('p',{id:'preferences-status',class:'status',role:'status','aria-live':'polite'},message?t(message):''),node('div',{class:'settings-layout'},[renderEditor(),renderRemote()]));
  refreshPreview();if(!embedded)brand.apply({titleSuffix:t('title')});
}
function focusSection(value=section){
  if(destroyed)return;section=value;
  const target=root.querySelector('[data-preference-section="'+(['appearance','colors','font','language','sync'].includes(value)?value:'appearance')+'"]');
  target?.scrollIntoView?.({block:'start',behavior:'instant'});(target?.querySelector('select,input,button')??target)?.focus?.({preventScroll:true});
}
const focused=()=>{if(!destroyed&&!busy&&!blocked)void checkSession().catch(error=>{if(!destroyed&&error.message==='sessionChanged')render();});};
const beforeUnload=event=>{if(!destroyed&&(busy||preferenceDraftChanged(preferences,readDraft()))){event.preventDefault();event.returnValue='';}};
const systemChanged=()=>{if(!destroyed&&draft?.followSystem===true&&!busy)refreshPreview();};
const ready=(async()=>{
try{
  const [instance,catalogs]=await Promise.all([loadInstanceConfig(),loadCatalogs({namespace:'preferences'})]);
  if(destroyed)return;
  brand=createInstanceBrand(instance);
  try{actor=await currentSession();}catch{if(destroyed)return;message='sessionUnavailable';}
  if(destroyed)return;
  if(expectedAccountId&&actor?.id!==expectedAccountId){blocked=true;actor=null;message='sessionChanged';}
  preferences=new PreferencesStore({profileId:actor?.id??'local'});
  if(!blocked)applyInstanceDefaults(preferences,instance);
  if(preferences.error)message='localReadError';
  draft=preferences.snapshot();i18n=createI18n(catalogs,draft.locale);await i18n.switchLocale(i18n.requestedLocale);
  if(destroyed)return;
  sync.setActor(actor);if(!embedded&&!blocked)applyPageAppearance();render();
  view?.addEventListener('focus',focused);if(!embedded)view?.addEventListener('beforeunload',beforeUnload);
  unwatch=watchSystemAppearance(()=>destroyed||blocked?null:preferences?.snapshot(),{onAppearance:({kind})=>{if(!embedded)brand?.apply({kind});}});
  try{media=globalThis.matchMedia?.('(prefers-color-scheme: dark)');media?.addEventListener('change',systemChanged);}catch{}
}catch{if(!destroyed)main.replaceChildren(node('p',{class:'status',role:'status'},'Preferences are unavailable.'));}
})();
return {ready,focusSection,canClose:()=>!busy&&!preferenceDraftChanged(preferences,readDraft()),get closeState(){return {busy,dirty:preferenceDraftChanged(preferences,readDraft())};},destroy(){if(destroyed)return;destroyed=true;lifetime.abort();sync.setActor(null);unwatch();view?.removeEventListener('focus',focused);view?.removeEventListener('beforeunload',beforeUnload);media?.removeEventListener('change',systemChanged);}};
}
if(typeof document!=='undefined'){
 const root=document.getElementById('preferences-main');if(root)mountPreferencesPage({root});
}
