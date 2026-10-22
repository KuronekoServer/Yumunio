'use client';
import {useEffect,useRef,useState} from 'react';
import {motion} from 'motion/react';
import {Icon} from './icons.jsx';
import {Button} from './components/ui/button.jsx';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors,contrastRatio} from '../public/preferences.js';
import {resolveAppearancePreferences} from '../public/appearance.js';
import {createI18n,loadCatalogs,applyLocaleDocument} from '../public/i18n.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from '../public/instance.js';
import {chooseWorkspace,readRecentWorkspace,workspaceMonogram,workspaceSlugSuggestion} from '../public/workspace-chooser-model.js';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const storage=()=>{try{return globalThis.localStorage??null;}catch{return null;}};

async function readJson(path,{method='GET',body,accountId}={}){
 const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),
  headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(accountId?{'X-Yumunio-Expected-Account':accountId}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let data=null;try{data=await response.json();}catch{}
 if(!response.ok)throw Object.assign(new Error('REQUEST_FAILED'),{status:response.status,code:data?.error?.code});
 return data;
}

function applyAppearance(preferences){
 const pref=resolveAppearancePreferences(preferences.snapshot());
 const theme=THEMES.find(item=>item.id===pref.themeId)??THEMES[0];
 const colors=validateCustomColors(pref.themeId,pref.customColors).colors??theme.colors;
 for(const[key,color]of Object.entries(colors))document.documentElement.style.setProperty('--'+key,color);
 const kind=pref.customColors.canvas?(contrastRatio('#FFFFFF',colors.canvas)>contrastRatio('#102030',colors.canvas)?'dark':'light'):theme.kind;
 document.documentElement.style.colorScheme=kind;document.documentElement.dataset.appearance=kind;
 document.documentElement.style.fontFamily=FONT_OPTIONS.find(item=>item.id===pref.fontId)?.family||FONT_OPTIONS[0].family;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',colors.nav);
}


export function WorkspaceChooser(){
 const[startup,setStartup]=useState('loading');
 const[user,setUser]=useState(null);
 const[workspaces,setWorkspaces]=useState([]);
 const[creating,setCreating]=useState(false);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState('');
 const[preferences]=useState(()=>new PreferencesStore());
 const[i18n,setI18n]=useState(null);
 const brand=useRef(null),nameValue=useRef(null),slugValue=useRef(null);
 const t=key=>i18n?.t(key)??key;

 useEffect(()=>{
  const lifetime=new AbortController();
  (async()=>{
   try{
    const[catalogs,instance]=await Promise.all([loadCatalogs({namespace:'account'}),loadInstanceConfig()]);
    if(lifetime.signal.aborted)return;
    applyInstanceDefaults(preferences,instance);
    const next=createI18n(catalogs,preferences.snapshot().locale);
    await next.switchLocale(next.requestedLocale);
    if(lifetime.signal.aborted)return;
    setI18n(next);
    brand.current=createInstanceBrand(instance);
    applyAppearance(preferences);applyLocaleDocument(document,next);
    brand.current.apply({kind:document.documentElement.dataset.appearance,titleSuffix:next.t('chooserTitle')});
    const config=await readJson('/api/auth/config');
    if(lifetime.signal.aborted)return;
    if(!config?.enabled)throw new Error('disabled');
    const session=await readJson('/api/auth/get-session');
    if(lifetime.signal.aborted)return;
    if(!validId(session?.user?.id)){location.replace('/account#login');return;}
    if(session.user.emailVerified!==true){location.replace('/account#account');return;}
    const list=await readJson('/api/auth/organization/list');
    if(lifetime.signal.aborted)return;
    const decision=chooseWorkspace({workspaces:list,recentId:readRecentWorkspace(storage(),session.user.id)});
    if(decision.mode==='open'){setStartup('opening');location.replace('/workspace?workspace='+encodeURIComponent(decision.workspace.id));return;}
    setUser({id:session.user.id,name:session.user.name,email:session.user.email});
    setWorkspaces(Array.isArray(list)?list.filter(item=>validId(item?.id)):[]);
    setStartup(decision.mode);
   }catch(caught){if(lifetime.signal.aborted)return;setError(caught.message==='disabled'?'disabled':'chooserError');setStartup('error');}
  })();
  return()=>lifetime.abort();
 },[preferences]);

 async function create(event){
  event.preventDefault();
  const name=nameValue.current?.value.trim()??'',slug=slugValue.current?.value.trim()??'';
  if(busy||!name||!slug)return;
  setBusy(true);setError('');
  try{
   const workspace=await readJson('/api/auth/organization/create',{method:'POST',accountId:user?.id,body:{name,slug}});
   if(!validId(workspace?.id))throw new Error('INVALID_RESPONSE');
   location.assign('/workspace?workspace='+encodeURIComponent(workspace.id));
  }catch{setError('chooserCreateFailed');setBusy(false);}
 }

 if(startup==='loading'||startup==='opening')return <div className="workspace-chooser" aria-busy="true">
  <p className="workspace-chooser-status" role="status">{t(startup==='opening'?'chooserOpening':'chooserLoading')}</p>
 </div>;
 return <ChooserShell t={t}>
  {startup==='error'?<section className="workspace-chooser-empty" role="alert">
   <h1>{t(error==='disabled'?'disabled':'chooserError')}</h1>
   <Button type="button" variant="outline" onClick={()=>location.reload()}>{t('chooserRetry')}</Button>
  </section>:<>
   <h1 className="workspace-chooser-title">{t('chooserTitle')}</h1>
   <p className="workspace-chooser-intro">{t('chooserIntro')}</p>
   <section className="workspace-chooser-list-card" aria-label={t('chooserWorkspaces')}>
    <p className="workspace-chooser-account" translate="no">{user?.email}</p>
    {startup==='empty'?<p className="workspace-chooser-note">{t('chooserEmpty')}</p>
     :<ul className="workspace-chooser-list">{workspaces.map(workspace=><li key={workspace.id} className="workspace-chooser-row">
      <span className="workspace-chooser-tile" aria-hidden="true" translate="no">{workspaceMonogram(workspace.name)}</span>
      <span className="workspace-chooser-identity"><strong translate="no">{workspace.name}</strong><span className="workspace-chooser-slug" translate="no">{workspace.slug}</span></span>
      <a className="workspace-chooser-open" href={'/workspace?workspace='+encodeURIComponent(workspace.id)}>{t('chooserOpen')}</a>
     </li>)}</ul>}
   </section>
   <section className="workspace-chooser-switch">
    <p>{t('chooserSwitch')}</p>
    <Button type="button" variant="outline" aria-expanded={creating} onClick={()=>{setError('');setCreating(value=>!value);}}>{t('chooserCreate')}</Button>
   </section>

   {creating&&<form className="workspace-chooser-form" onSubmit={create}>
    <h2>{t('chooserCreateTitle')}</h2>
    <p className="workspace-chooser-note">{t('chooserCreateHint')}</p>
    <label className="workspace-chooser-field"><span>{t('workspaceName')}</span>
     <input ref={nameValue} type="text" maxLength={100} required autoFocus autoComplete="off"
      onChange={event=>{if(slugValue.current&&!slugValue.current.dataset.touched)slugValue.current.value=workspaceSlugSuggestion(event.target.value);}}/>
    </label>
    <label className="workspace-chooser-field"><span>{t('workspaceSlug')}</span>
     <input ref={slugValue} type="text" maxLength={100} required autoComplete="off" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" aria-describedby="workspace-chooser-slug-hint" onInput={event=>{event.currentTarget.dataset.touched='1';}}/>
    </label>
    <p id="workspace-chooser-slug-hint" className="workspace-chooser-note">{t('chooserSlugHint')}</p>
    {error&&<p className="workspace-chooser-error" role="alert">{t(error)}</p>}
    <div className="workspace-chooser-actions">
     <Button type="button" variant="ghost" onClick={()=>setCreating(false)} disabled={busy}>{t('chooserCancel')}</Button>
     <Button type="submit" disabled={busy}>{t(busy?'chooserWorking':'chooserCreateSubmit')}</Button>
    </div>
   </form>}
   <p className="workspace-chooser-footer">{t('chooserMissing')} <a href="/account#account">{t('chooserAccount')}</a></p>
  </>}
 </ChooserShell>;
}

function ChooserShell({t,children}){
 return <div className="workspace-chooser">
  <a className="skip-link" href="#chooser-main">{t('skip')}</a>
  <header className="workspace-chooser-brand"><Icon name="notebook"/><span translate="no">Yumunio</span></header>
  <motion.main id="chooser-main" className="workspace-chooser-main" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.24,ease:[0.2,0,0,1]}}>
   {children}
  </motion.main>
 </div>;
}

