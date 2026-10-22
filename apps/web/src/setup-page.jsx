'use client';
import {useEffect,useRef,useState} from 'react';
import {createI18n,loadCatalogs} from '../public/i18n.js';
import {setupRequest,setupSettings} from './setup-client.js';

function Field({name,label,value='',type='text',required=false,options,secret=false,wide=false,help,minLength=0,maxLength=4096,autocomplete='off',saved=false,onChange,controlled=false}){
 const inputValue=controlled?{value,onChange}:{defaultValue:secret?'':value,onChange};
 return <label htmlFor={name} className={'field'+(wide?' wide':'')}>{label}{options?<select id={name} name={name} {...inputValue}>{options.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>:<input id={name} name={name} type={secret?'password':type} required={required} minLength={minLength} maxLength={maxLength} autoComplete={autocomplete} spellCheck={false} {...inputValue} placeholder={secret&&saved?saved:undefined}/>} {help&&<small>{help}</small>}</label>;
}
function Group({title,open=false,children}){return open?<fieldset><legend>{title}</legend><div className="grid">{children}</div></fieldset>:<details><summary>{title}</summary><div className="grid">{children}</div></details>;}

function MailSettings({runtime,configuration,t,settingsField}){
 const settings=configuration?.settings??{},[driver,setDriver]=useState(settings.YUMUNIO_MAIL_DRIVER||'disabled'),[host,setHost]=useState(settings.YUMUNIO_SMTP_HOST||''),[port,setPort]=useState(settings.YUMUNIO_SMTP_PORT||'587'),[tls,setTls]=useState(settings.YUMUNIO_SMTP_TLS||'starttls_required'),[user,setUser]=useState(settings.YUMUNIO_SMTP_USER||'');
 const cloudflareSmtp=()=>{setHost('smtp.mx.cloudflare.net');setPort('465');setTls('implicit_tls');setUser('api_token');};
 const setEncryption=event=>{const next=event.target.value;setTls(next);if(['465','587'].includes(port))setPort(next==='implicit_tls'?'465':'587');};
 return <Group title={t('mail')}>
  {settingsField('MAIL_DRIVER',t('mailDriver'),{value:driver,controlled:true,onChange:event=>setDriver(event.target.value),wide:true,options:(runtime==='worker'?['disabled','cloudflare','smtp','http']:['disabled','smtp','http']).map(value=>[value,t(value)])})}
  {runtime==='worker'&&<aside className="mail-guide wide"><p>{t('workerMailChoice')} <a href="https://developers.cloudflare.com/email-service/get-started/send-emails/" target="_blank" rel="noopener noreferrer">{t('cloudflareGuide')}</a></p></aside>}

  {driver==='cloudflare'&&<aside className="mail-guide wide"><p>{t('cloudflareIntro')}</p><ol><li>{t('cloudflareDomain')}</li><li>{t('cloudflareBinding')}</li><li>{t('cloudflareSave')}</li></ol><p className="mail-connection-status">{t(configuration?.mailCapabilities?.cloudflare?'cloudflareConnected':'cloudflareNotConnected')}</p><a href="https://developers.cloudflare.com/email-service/get-started/send-emails/" target="_blank" rel="noopener noreferrer">{t('cloudflareGuide')}</a></aside>}
  {driver!=='disabled'&&<>{settingsField('SMTP_FROM',t('from'),{type:'email',required:true})}{settingsField('SMTP_REPLY_TO',t('replyTo'),{type:'email'})}</>}
  {driver==='smtp'&&<><aside className="mail-guide wide"><p>{t(runtime==='worker'?'workerSmtpHelp':'smtpHelp')}</p><button type="button" className="button quiet" onClick={cloudflareSmtp}>{t('cloudflareSmtpPreset')}</button><p>{t('cloudflareSmtpHelp')} <a href="https://developers.cloudflare.com/email-service/api/send-emails/smtp/" target="_blank" rel="noopener noreferrer">{t('cloudflareSmtpGuide')}</a></p></aside><Field name="YUMUNIO_SMTP_HOST" label={t('smtpHost')} value={host} controlled onChange={event=>setHost(event.target.value)} required/><Field name="YUMUNIO_SMTP_PORT" label={t('smtpPort')} value={port} controlled onChange={event=>setPort(event.target.value)} type="number" required/><Field name="YUMUNIO_SMTP_TLS" label={t('smtpTls')} value={tls} controlled onChange={setEncryption} options={['starttls_required','implicit_tls'].map(value=>[value,t(value)])}/><Field name="YUMUNIO_SMTP_USER" label={t('smtpUser')} value={user} controlled onChange={event=>setUser(event.target.value)}/>{settingsField('SMTP_PASSWORD',t('smtpPassword'),{secret:true})}</>}
  {driver==='http'&&<>{settingsField('MAIL_HTTP_ENDPOINT',t('relayEndpoint'),{type:'url',required:true})}{settingsField('MAIL_HTTP_TOKEN',t('relayToken'),{secret:true})}</>}
  {driver!=='disabled'&&<p className="wide mail-test-help">{t('mailTestHelp')} <a href="/admin">{t('mailTestLink')}</a></p>}
 </Group>;
}

export function SetupPage({initialAuthorization=''}){
 const [i18n,setI18n]=useState(null),[locale,setLocale]=useState('ja'),[state,setState]=useState(null),[actor,setActor]=useState(null),[configuration,setConfiguration]=useState(null),[stage,setStage]=useState(0),[busy,setBusy]=useState(false),[languageBusy,setLanguageBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false),[loadError,setLoadError]=useState(false);
 const draft=useRef({}),authorization=useRef(initialAuthorization),main=useRef(null),form=useRef(null),t=key=>i18n?.t(key)??key;
 useEffect(()=>{const controller=new AbortController();let live=true;(async()=>{
  const preferred=navigator.language||'ja';
  const catalog=createI18n(await loadCatalogs({namespace:'setup',locale:preferred,baseUrl:new URL('/i18n.js',location.href)}),preferred),setup=await setupRequest('/api/setup',{signal:controller.signal});let session=null,settings=null;
  if(setup.enabled&&!setup.required){try{session=(await setupRequest('/api/auth/get-session',{signal:controller.signal}))?.user;if(session)settings=await setupRequest('/api/admin/settings',{accountId:session.id,signal:controller.signal});}catch{settings=null;}}
  if(live){setLocale(catalog.locale);setI18n(catalog);setState(setup);setActor(session);setConfiguration(settings);}
 })().catch(()=>{if(live)setLoadError(true);});return()=>{live=false;controller.abort();draft.current={};authorization.current='';};},[]);
 useEffect(()=>{if(i18n){document.documentElement.lang=i18n.locale;document.documentElement.dir=i18n.dir;document.title='Yumunio — '+t(state?.required?stage===0?'title':stage===2?'complete':'workspaceTitle':'settingsTitle');}},[i18n,locale,state,stage]);
 const changeLanguage=async event=>{if(busy||languageBusy||!i18n)return;const next=event.target.value;setLanguageBusy(true);try{if(await i18n.switchLocale(next))setLocale(i18n.locale);}catch{setMessage(t('error'));setFailed(true);}finally{setLanguageBusy(false);}};
 const choices=(values,translate=false)=>values.map(value=>[value,translate?t(value):value]);
 const settingsField=(name,label,options={})=><Field key={name} name={'YUMUNIO_'+name} label={label} {...options} value={options.controlled?options.value:configuration?.settings?.['YUMUNIO_'+name]??options.value??''} saved={configuration?.secrets?.['YUMUNIO_'+name]?t('savedSecret'):false}/>;
 async function submit(event){
  event.preventDefault();if(busy)return;const data=new FormData(event.currentTarget);
  if(state.required&&stage===0){draft.current={name:data.get('name'),email:data.get('email'),password:data.get('password')};setStage(1);setMessage('');main.current?.focus();return;}
  setBusy(true);setMessage(t('saving'));setFailed(false);
  try{
   const settings=setupSettings(data,{initial:state.required});
   if(state.required){await setupRequest('/api/setup',{method:'POST',authorization:authorization.current,body:{...draft.current,settings}});draft.current={};authorization.current='';setStage(2);setMessage('');}
   else{await setupRequest('/api/admin/settings',{method:'PUT',accountId:actor.id,body:{revision:configuration.revision,settings}});setConfiguration(await setupRequest('/api/admin/settings',{accountId:actor.id}));form.current?.querySelectorAll('input[type=password]').forEach(input=>{input.value='';});setMessage(t('saved'));}
  }catch(error){setFailed(true);setMessage(error.message==='SETUP_CONFLICT'?t('conflict'):t(error.message)===error.message?t('error'):t(error.message));}finally{setBusy(false);}
 }
 let content;
 if(loadError)content=<p role="alert">設定を読み込めませんでした。再読み込みしてください。 / Unable to load setup. Please reload.</p>;
 else if(!state||!i18n)content=<p role="status">読み込んでいます… / Loading…</p>;
 else if(!state.enabled)content=<p>{t('setupDisabled')}</p>;
 else if(state.required&&!authorization.current&&stage!==2)content=<p>{t('openInitialLink')}</p>;
 else if(!state.required&&!configuration)content=<><p>{t('loginRequired')}</p><a className="button" href="/account">{t('signIn')}</a></>;
 else if(stage===2)content=<><p className="eyebrow">Yumunio</p><h1>{t('complete')}</h1><p>{t('completeHelp')}</p><a className="button primary" href="/account">{t('signIn')}</a></>;
 else content=<><p className="eyebrow">{t(state.required?'welcome':'admin')}</p><h1>{t(state.required?stage===0?'title':'workspaceTitle':'settingsTitle')}</h1><p className="setup-intro">{t(state.required?stage===0?'intro':'workspaceIntro':'settingsIntro')}</p><form ref={form} onSubmit={submit} key={state.required?stage:'settings'}><fieldset disabled={busy} className="setup-form-fields">
  {state.required&&stage===0&&<Group title={t('owner')} open><Field name="name" label={t('name')} value={draft.current.name} required maxLength={120} autocomplete="name" wide/><Field name="email" label={t('email')} value={draft.current.email} type="email" required maxLength={254} autocomplete="username" wide/><Field name="password" label={t('password')} value={draft.current.password} type="password" required minLength={12} maxLength={128} autocomplete="new-password" help={t('passwordHelp')}/></Group>}
  {(!state.required||stage===1)&&<Group title={t('appearance')} open>{settingsField('BRAND_NAME',t(state.required?'brand':'siteName'),{value:'Yumunio',required:true,maxLength:80})}{settingsField('BRAND_ORGANIZATION',t('organization'),{maxLength:120})}{settingsField('DEFAULT_LOCALE',t('locale'),{value:locale,options:i18n.availableLocales.map(({code,endonym})=>[code,endonym])})}{settingsField('DEFAULT_THEME',t('theme'),{value:'light',options:['paper','light','ocean','lavender','forest','midnight'].map(value=>[value,t('theme_'+value)])})}</Group>}
  {!state.required&&<>
   <Group title={t('registration')}>{settingsField('REGISTRATION_MODE',t('registrationMode'),{value:'closed',options:choices(['closed','open'],true),help:t('registrationHelp')})}{settingsField('EMAIL_DOMAIN_MODE',t('domainMode'),{value:'unrestricted',options:choices(['unrestricted','allowlist'],true)})}{settingsField('EMAIL_ALLOWED_DOMAINS',t('allowedDomains'))}{settingsField('EMAIL_BLOCKED_DOMAINS',t('blockedDomains'))}{settingsField('EMAIL_ALLOW_SUBDOMAINS',t('allowSubdomains'),{value:'false',options:[['false',t('no')],['true',t('yes')]]})}{settingsField('EMAIL_BLOCK_SUBDOMAINS',t('blockSubdomains'),{value:'true',options:[['true',t('yes')],['false',t('no')]]})}</Group>
   <MailSettings runtime={state.runtime} configuration={configuration} t={t} settingsField={settingsField}/>
   <Group title={t('oauth')}>{['GOOGLE','GITHUB','DISCORD'].map(provider=><div className="provider-fields" key={provider}><Field name={'provider_'+provider} label={provider+' '+t('enabled')} value={configuration?.settings?.['YUMUNIO_OAUTH_'+provider+'_CLIENT_ID']?'true':'false'} options={[["false",t('no')],["true",t('yes')]]} wide/>{settingsField('OAUTH_'+provider+'_CLIENT_ID',provider+' '+t('clientId'))}{settingsField('OAUTH_'+provider+'_CLIENT_SECRET',provider+' '+t('clientSecret'),{secret:true,help:location.origin+'/api/auth/callback/'+provider.toLowerCase()})}</div>)}</Group>
   <Group title="OpenID Connect">{settingsField('OIDC_ENABLED',t('enabled'),{value:'false',options:[['false',t('no')],['true',t('yes')]]})}{settingsField('OIDC_DISPLAY_NAME',t('oidcName'),{value:'SSO'})}{settingsField('OIDC_ISSUER',t('issuer'),{type:'url'})}{settingsField('OIDC_CLIENT_ID',t('clientId'))}{settingsField('OIDC_CLIENT_SECRET',t('clientSecret'),{secret:true,help:location.origin+'/api/auth/callback/oidc'})}</Group>
   <p className="notice">{t('infrastructure')}</p>
  </>}
  <div className="actions"><button type="submit" className="button primary">{t(state.required?stage===0?'next':'create':'save')}</button>{state.required&&stage===1&&<button type="button" className="button quiet" onClick={()=>{setStage(0);setMessage('');}}>{t('back')}</button>}{!state.required&&<a href="/admin">{t('admin')}</a>}</div>
  </fieldset><p role="status" aria-live="polite" className={'status'+(failed?' error':'')} id="setup-status">{message}</p></form></>;
 return <><aside className="setup-sidebar"><a className="brand" href="/"><span className="setup-mark" aria-hidden="true">Y</span>Yumunio</a><ol id="setup-progress">{state&&i18n&&(state.required?['accountStep','workspaceStep','doneStep']:['settingsTitle']).map((key,index)=><li key={key} className={index===stage?'current':''} aria-current={index===stage?'step':undefined}><span className="step-number">{index+1}</span>{t(key)}</li>)}</ol></aside><div className="setup-content"><header className="setup-header"><a className="brand setup-mobile-brand" href="/">Yumunio</a><label className="language"><span>Language</span><select id="language" aria-label="Language" value={locale} disabled={busy||languageBusy||!i18n} onChange={changeLanguage}>{(i18n?.availableLocales??[{code:'ja',endonym:'日本語'},{code:'en',endonym:'English'}]).map(item=><option key={item.code} value={item.code} dir={item.dir}>{item.endonym}</option>)}</select></label></header><main id="setup-main" ref={main} tabIndex={-1}>{content}</main><footer><a href="/LICENSE.txt">MIT License</a></footer></div></>;
}
