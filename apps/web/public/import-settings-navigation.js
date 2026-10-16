import { loadCatalogs, createI18n } from './i18n.js';
import { loadInstanceConfig, createInstanceBrand } from './instance.js';
import { settingsLocation, loadWorkspaceSettings } from './workspace-settings-model.js';

const shell=document.getElementById('import-settings-shell'),navigation=document.getElementById('import-settings-navigation'),main=document.getElementById('import-settings-main');
const toggle=document.getElementById('import-settings-toggle'),scrim=document.getElementById('import-settings-scrim'),back=document.getElementById('import-settings-back'),language=document.getElementById('language');
let context=null,workspaceId='',generation=0,controller,navOpen=false,i18n,branding,notice='loading';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const t=key=>i18n.t(key);
function node(tag,attributes={},children=[]){
 const element=document.createElement(tag);
 for(const[key,value]of Object.entries(attributes)){if(value===null||value===undefined||value===false)continue;if(key.startsWith('on'))element.addEventListener(key.slice(2).toLowerCase(),value);else element.setAttribute(key,String(value));}
 for(const child of Array.isArray(children)?children:[children])if(child!==undefined&&child!==null)element.append(child instanceof Node?child:document.createTextNode(String(child)));
 return element;
}
function link(key,href,current=false){return node('a',{class:'settings-link',href,...(current?{'aria-current':'page'}:{})},t(key));}
function route(section){return '/workspace-settings.html?workspace='+encodeURIComponent(workspaceId)+'&section='+section;}
function setOpen(open,restore=true){
 navOpen=open;shell.classList.toggle('nav-open',open);toggle.setAttribute('aria-expanded',String(open));
 const mobile=matchMedia('(max-width:760px)').matches;navigation.inert=mobile&&!open;main.inert=mobile&&open;
 if(restore){if(open)navigation.querySelector('.settings-mobile-close')?.focus();else toggle.focus();}
}
function render(){
 if(!i18n)return;
 const brand=node('a',{class:'settings-brand',href:context?'/workspace.html?workspace='+encodeURIComponent(workspaceId):'/account.html#account','data-instance-label':''},node('span',{'data-instance-name':''},'Yumunio'));
 navigation.replaceChildren(node('div',{},[brand,node('button',{type:'button',class:'button settings-mobile-close','aria-label':t('closeMenu'),onClick:()=>setOpen(false)},'×')]),
  node('div',{class:'settings-context'},[node('span',{},t('workspaceLabel')),node('strong',{translate:context?'no':undefined},context?.workspace.name||t(notice==='loading'?'currentWorkspace':'chooseWorkspace'))]),
  ...(context?[node('nav',{class:'settings-group','aria-label':t('workspaceGroup')},[node('h2',{},t('workspaceGroup')),link('overview',route('overview')),link('import',route('import'),true),link('members','/share.html?workspace='+encodeURIComponent(workspaceId))])]:[node('p',{class:'settings-nav-status',role:'status'},t(notice))]),
  node('nav',{class:'settings-group','aria-label':t('personalGroup')},[node('h2',{},t('personalGroup')),link('preferences','/preferences.html'),link('account','/account.html#account')]),
  node('div',{class:'settings-sidebar-footer'},[...(context?[link('backWorkspace','/workspace.html?workspace='+encodeURIComponent(workspaceId)),node('small',{translate:'no'},context.user.name)]:[]),node('a',{class:'settings-license',href:'./LICENSE.txt'},'MIT License')]));
 back.href=context?route('import'):'/account.html#account';back.textContent=t(context?'backSettings':'openAccount');
 toggle.setAttribute('aria-label',t('openMenu'));scrim.setAttribute('aria-label',t('closeMenu'));navigation.setAttribute('aria-label',t('navigation'));
 setOpen(navOpen,false);branding?.apply({kind:document.documentElement.style.colorScheme==='dark'?'dark':'light'});
}
async function request(path,{headers={}}={}){
 const response=await fetch(path,{method:'GET',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',headers,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
 if(!response.ok)throw new Error('NAVIGATION_UNAVAILABLE');return response.json();
}
async function selectWorkspace(id){
 const marker=++generation;controller?.abort();controller=new AbortController();workspaceId=validId(id)?id:'';context=null;notice=workspaceId?'loading':'chooseWorkspace';render();
 if(!workspaceId)return;
 try{const value=await loadWorkspaceSettings({workspaceId,request});if(marker!==generation)return;context=value;notice='';}
 catch(error){if(marker!==generation)return;notice=error.code==='SIGN_IN'?'signInRequired':error.code==='VERIFY_EMAIL'?'verifyRequired':error.code==='ACCOUNT_CHANGED'?'accountChanged':'workspaceUnavailable';}
 finally{if(marker===generation)render();}
}
async function translate(){
 if(!i18n)return;const value=language.value||document.documentElement.lang||'ja';
 if(await i18n.switchLocale(value))render();
}
toggle.addEventListener('click',()=>setOpen(true));scrim.addEventListener('click',()=>setOpen(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&navOpen)setOpen(false);});
matchMedia('(max-width:760px)').addEventListener('change',()=>setOpen(false,false));
document.addEventListener('change',event=>{if(event.target.id==='destination-workspace')void selectWorkspace(event.target.value);if(event.target===language)void translate();});
new MutationObserver(records=>{if(records.some(record=>record.attributeName==='lang'))void translate();else branding?.apply({kind:document.documentElement.style.colorScheme==='dark'?'dark':'light'});}).observe(document.documentElement,{attributes:true,attributeFilter:['lang','data-appearance']});
try{
 const [catalogs,instance]=await Promise.all([loadCatalogs({namespace:'workspace-settings'}),loadInstanceConfig()]);
 i18n=createI18n(catalogs,language.value||document.documentElement.lang||'ja');await i18n.switchLocale(i18n.requestedLocale);branding=createInstanceBrand(instance);
 let initial='';try{initial=settingsLocation(location.href).workspaceId;}catch{}
 const selected=document.getElementById('destination-workspace')?.value;await selectWorkspace(validId(selected)?selected:initial);
}catch{navigation.replaceChildren(node('a',{class:'settings-link',href:'/account.html#account'},'アカウント / Account'));back.href='/account.html#account';}
