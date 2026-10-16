import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors,contrastRatio} from './preferences.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';
import {createI18n,loadCatalogs,createLocaleOptions,applyLocaleDocument} from './i18n.js';
const main=document.getElementById('admin-main'),nav=document.getElementById('admin-nav'),dialog=document.getElementById('admin-confirmation');
let actor=null,preferences,i18n,brand,config=null,users=null,jobs=null,selected=null,sessions=null,view='config',busy=false,access=false,message='',mailConsent=false,pendingTestId=null;
const statuses=['queued','leased','accepted','dead','cancelled'],id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const node=(tag,attributes={},children=[])=>{
  const result=document.createElement(tag);
  for(const [key,value]of Object.entries(attributes)){if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);else if(['value','checked','disabled','type'].includes(key))result[key]=value;else result.setAttribute(key,value);}
  for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(child instanceof Node?child:document.createTextNode(String(child)));return result;
};
const t=key=>i18n?.t(key)??key;
class RequestError extends Error {constructor(code,status=0){super(code);this.code=code;this.status=status;}}
async function request(path,{method='GET',body,expected=true}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(path,{method,mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
      headers:{...(expected&&actor?{'X-Yumunio-Expected-Account':actor.id}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let data;try{data=await response.json();}catch{throw new RequestError('INVALID_RESPONSE');}
    if(!response.ok)throw new RequestError(typeof data?.error?.code==='string'?data.error.code:'REQUEST_FAILED',response.status);return data;
  }catch(error){if(error instanceof RequestError)throw error;throw new RequestError('NETWORK_UNCERTAIN');}
  finally{clearTimeout(timer);}
}
async function checkAccount(){
  const session=await request('/api/auth/get-session',{expected:false});
  if(!session?.user||session.user.id!==actor?.id||session.user.emailVerified!==true){loseAccess('accountChanged');throw new RequestError('ACCOUNT_CHANGED');}
  actor=session.user;
}
function loseAccess(reason){access=false;config=null;users=null;jobs=null;sessions=null;selected=null;mailConsent=false;message=reason;}
function applyAppearance(){
  const value=resolveAppearancePreferences(preferences.snapshot()),colors=validateCustomColors(value.themeId,value.customColors).colors??THEMES[1].colors;
  for(const [role,color]of Object.entries(colors))document.documentElement.style.setProperty('--'+role,color);
  const kind=value.customColors.canvas?(contrastRatio('#FFFFFF',colors.canvas)>contrastRatio('#102030',colors.canvas)?'dark':'light'):THEMES.find(theme=>theme.id===value.themeId).kind;
  document.documentElement.dataset.appearance=kind;document.documentElement.style.colorScheme=kind;document.documentElement.style.fontFamily=FONT_OPTIONS.find(font=>font.id===value.fontId)?.family??FONT_OPTIONS[0].family;
  i18n.setLocale(value.locale);brand.apply({kind,titleSuffix:t('title')});
}
function formatDate(value){try{return new Intl.DateTimeFormat(i18n.locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return '—';}}
function dto(value,kind){
  if(kind==='config'&&(!value||value.schemaVersion!==1||value.readonly!==true||value.source!=='environment'||!Array.isArray(value.sourceEnvironment)))throw new RequestError('INVALID_RESPONSE');
  if(kind==='users'&&(!value||!Array.isArray(value.users)||value.users.length>100||typeof value.hasMore!=='boolean'||value.users.some(user=>!id(user.id)||typeof user.name!=='string'||typeof user.email!=='string')))throw new RequestError('INVALID_RESPONSE');
  if(kind==='sessions'&&(!value||!id(value.userId)||!Array.isArray(value.sessions)||value.sessions.length>100||value.sessions.some(session=>!id(session.id)||typeof session.current!=='boolean')))throw new RequestError('INVALID_RESPONSE');
  if(kind==='jobs'&&(!value||!value.counts||statuses.some(status=>!Number.isSafeInteger(value.counts[status])||value.counts[status]<0)||!Array.isArray(value.tests)||value.tests.length>20||value.tests.some(job=>!id(job.id)||!statuses.includes(job.status))))throw new RequestError('INVALID_RESPONSE');
  return value;
}
async function loadConfig(){const next=dto(await request('/api/admin/config'),'config');config=next;access=true;}
async function loadUsers(){users=dto(await request('/api/admin/users'),'users');}
async function loadJobs(){jobs=dto(await request('/api/admin/jobs'),'jobs');}
async function run(task,focusId){
  if(busy||!access)return;busy=true;message='working';render();
  try{await checkAccount();await task();if(message==='working')message='';}
  catch(error){
    if(error.code==='ACCOUNT_CHANGED')loseAccess('accountChanged');
    else if(error.status===404)loseAccess('accessChanged');
    else message=error.status===409?'conflict':error.code==='NETWORK_UNCERTAIN'?'uncertain':error.code==='INVALID_RESPONSE'?'invalidResponse':'unavailable';
  }finally{busy=false;render();document.getElementById(focusId)?.focus();}
}
function button(key,task,{primary=false,disabled=false,id:buttonId}={}){return node('button',{type:'button',id:buttonId??'action-'+key,class:'button'+(primary?' primary':''),disabled:busy||disabled,onClick:()=>void run(task,buttonId??'action-'+key)},t(key));}
function confirmAction(title,content,confirm){
  return new Promise(resolve=>{
    let ended=false;
    const finish=value=>{if(ended)return;ended=true;dialog.removeEventListener('cancel',cancelled);dialog.removeEventListener('close',closed);dialog.close();resolve(value);};
    const cancelled=event=>{event.preventDefault();finish(false);},closed=()=>finish(false);
    dialog.replaceChildren(node('h2',{id:'admin-confirm-title'},t(title)),...content,node('div',{class:'actions'},[
      node('button',{type:'button',class:'button',onClick:()=>finish(false)},t('cancel')),
      node('button',{type:'button',class:'button primary',onClick:()=>finish(true)},t(confirm)),
    ]));
    dialog.addEventListener('cancel',cancelled);dialog.addEventListener('close',closed);dialog.showModal();
  });
}
function diagnostics(){
  const cards=node('div',{class:'diagnostic-grid'}),literal=value=>value===undefined?'—':String(value),list=value=>Array.isArray(value)&&value.length?value.join(', '):t('none');
  const enumName=value=>({disabled:t('disabled'),invalid:t('invalid'),unknown:t('unknown'),'not-applicable':t('notApplicable'),'verify-full':t('verifyFull'),https:t('https'),starttls_required:t('starttls'),implicit_tls:t('implicitTls'),disable:t('disabled'),open:t('open'),closed:t('closed'),allowlist:t('allowlist'),unrestricted:t('unrestricted')})[value]??literal(value);
  const card=(title,rows)=>{const details=node('dl');for(const [label,value]of rows)details.append(node('div',{},[node('dt',{},t(label)),node('dd',{},value)]));return node('section',{class:'diagnostic-card'},[node('h3',{},t(title)),details]);};
  cards.append(card('runtime',[['runtime',config.runtime==='worker'?'Cloudflare Workers':'Node.js']]),card('database',[['driver',enumName(config.database.driver)],['tls',enumName(config.database.tls)]]),
    card('accounts',[['registration',enumName(config.accounts.registrationMode)],['domainMode',enumName(config.accounts.domainPolicy.mode)],['allowed',list(config.accounts.domainPolicy.allowedDomains)],['blocked',list(config.accounts.domainPolicy.blockedDomains)]]),
    card('mail',[['driver',enumName(config.mail.driver)],['tls',enumName(config.mail.tls)]]),card('attachments',[['driver',enumName(config.attachments.driver)]]),
    card('branding',[['branding',config.branding.applicationName],['initialTheme',config.branding.initialTheme],['defaultLocale',config.branding.defaultLocale],['customAssets',t(config.branding.customAssets?'yes':'no')]]));
  const table=node('table',{class:'admin-table source-table'},[node('thead',{},node('tr',{},[node('th',{scope:'col'},t('sourceKey')),node('th',{scope:'col'},t('sourceState'))]))]);
  const body=node('tbody');for(const source of config.sourceEnvironment)body.append(node('tr',{},[node('td',{class:'admin-code'},source.key),node('td',{},t(source.configured?'configured':'notConfigured'))]));table.append(body);
  return node('section',{},[node('div',{class:'admin-toolbar'},[node('p',{class:'intro'},t('readonly')),button('refresh',loadConfig)]),cards,node('details',{class:'admin-source'},[node('summary',{},t('sourceEnvironment')),node('div',{class:'admin-table-wrap'},table)])]);
}
async function selectUser(user){const result=dto(await request('/api/admin/users/'+encodeURIComponent(user.id)+'/sessions'),'sessions');if(result.userId!==user.id)throw new RequestError('INVALID_RESPONSE');selected=user;sessions=result;}
function usersPanel(){
  const list=node('section',{class:'panel'},[node('div',{class:'admin-toolbar'},[node('h2',{},t('userList')),button('refresh',loadUsers)]),node('p',{class:'hint'},t('userListHint'))]);
  if(!users)list.append(node('p',{class:'admin-empty'},t('working')));
  else{
    const table=node('table',{class:'admin-table user-table'},[node('thead',{},node('tr',{},['user','verification','sessions'].map(key=>node('th',{scope:'col'},t(key)))))]);
    const body=node('tbody');
    for(const user of users.users){
      const badges=node('span');if(user.currentUser)badges.append(node('span',{class:'admin-badge'},t('currentUser')));if(user.serverAdmin)badges.append(node('span',{class:'admin-badge'},t('serverAdmin')));
      body.append(node('tr',{},[node('td',{},[node('span',{class:'user-name'},user.name),node('span',{class:'user-email'},user.email),badges]),
        node('td',{},t(user.emailVerified?'verified':'unverified')),node('td',{},button('viewSessions',()=>selectUser(user),{id:'sessions-'+user.id}))]));
    }
    table.append(body);list.append(node('div',{class:'admin-table-wrap'},table));if(users.hasMore)list.append(node('p',{class:'hint'},t('moreUsers')));
  }
  const panel=node('section',{class:'panel'},node('h2',{},t('sessions')));
  if(!selected||!sessions)panel.append(node('p',{class:'admin-empty'},t('selectUser')));
  else{
    panel.append(node('p',{class:'user-name'},selected.name),node('p',{class:'hint'},selected.email));
    if(!sessions.sessions.length)panel.append(node('p',{class:'admin-empty'},t('emptySessions')));
    const rows=node('ul',{class:'session-list'});
    for(const session of sessions.sessions){
      const revoke=node('button',{type:'button',class:'button danger',disabled:busy,onClick:async()=>{
        const approved=await confirmAction('revokeTitle',[node('p',{},selected.email),node('p',{class:'admin-code'},session.id),node('p',{},t(session.current?'revokeCurrent':'revokeHint'))],'confirmRevoke');
        if(!approved)return;
        void run(async()=>{const result=await request('/api/admin/users/'+encodeURIComponent(selected.id)+'/sessions/'+encodeURIComponent(session.id),{method:'DELETE',body:{consent:true}});
          if(result?.revoked!==true||typeof result.currentSession!=='boolean')throw new RequestError('INVALID_RESPONSE');
          if(result.currentSession)loseAccess('currentRevoked');else{
            sessions={...sessions,sessions:sessions.sessions.filter(item=>item.id!==session.id)};
            try{await selectUser(selected);}catch(error){if(error.status===404)throw error;}
            message='revoked';
          }
        });
      }},t('revoke'));
      rows.append(node('li',{class:'session-row'},[node('p',{class:'admin-code'},session.id),...(session.current?[node('span',{class:'admin-badge'},t('currentSession'))]:[]),
        node('p',{class:'session-meta'},t('createdAt')+' · '+formatDate(session.createdAt)),node('p',{class:'session-meta'},t('expiresAt')+' · '+formatDate(session.expiresAt)),revoke]));
    }
    panel.append(rows);if(sessions.hasMore)panel.append(node('p',{class:'hint'},t('moreSessions')));
  }
  return node('div',{class:'admin-grid'},[list,panel]);
}
function jobsPanel(){
  const summary=node('section',{class:'panel'},[node('div',{class:'admin-toolbar'},[node('h2',{},t('queueOverview')),button('refresh',loadJobs)]),node('p',{class:'hint'},t('queueNote'))]);
  if(jobs){
    summary.append(node('div',{class:'admin-counts'},statuses.map(status=>node('div',{class:'count-card'},[node('strong',{},jobs.counts[status]),node('span',{},t(status))]))),node('h3',{},t('ownTests')));
    const rows=node('ul',{class:'job-list'});
    if(!jobs.tests.length)rows.append(node('li',{class:'admin-empty'},t('emptyJobs')));
    for(const job of jobs.tests){
      const row=node('li',{class:'job-row'},[node('div',{class:'job-header'},[node('span',{class:'admin-code'},job.id),node('span',{class:'job-status'},t(job.status))]),
        node('p',{class:'session-meta'},t('createdAt')+' · '+formatDate(job.createdAt)),node('p',{class:'session-meta'},t('attempts')+' · '+job.attempts)]);
      if(job.nextAttemptAt)row.append(node('p',{class:'session-meta'},t('nextAttempt')+' · '+formatDate(job.nextAttemptAt)));
      if(job.canRetry&&job.status==='dead')row.append(node('button',{type:'button',class:'button',disabled:busy||config.mail.driver==='disabled',onClick:async()=>{
        if(!await confirmAction('retryTitle',[node('p',{},t('retryHint')),node('p',{class:'admin-code'},job.id)],'confirmRetry'))return;
        void run(async()=>{const result=await request('/api/admin/jobs/'+encodeURIComponent(job.id)+'/retry',{method:'POST',body:{consent:true}});
          if(result?.jobId!==job.id||result.status!=='queued')throw new RequestError('INVALID_RESPONSE');
          try{await loadJobs();}catch(error){if(error.status===404)throw error;}
          message='retryQueued';});
      }},t('retry')));
      rows.append(row);
    }
    summary.append(rows);
  }
  const test=node('section',{class:'panel'},[node('h2',{},t('testTitle')),node('p',{class:'intro'},t('testHint')),node('p',{class:'identity'},actor.email)]);
  const disabled=!['smtp','http'].includes(config.mail.driver),checkbox=node('input',{id:'test-consent',type:'checkbox',checked:mailConsent,disabled:busy||disabled,onChange:event=>{mailConsent=event.target.checked;document.getElementById('queue-test').disabled=busy||disabled||!mailConsent;}});
  test.append(node('label',{class:'consent-row'},[checkbox,t('testConsent')]));
  test.append(button('testButton',async()=>{
    pendingTestId??='admin-test-'+crypto.randomUUID();
    const result=await request('/api/admin/mail-test',{method:'POST',body:{requestId:pendingTestId,consent:true}});
    if(!id(result?.jobId)||!statuses.includes(result.status)||typeof result.replayed!=='boolean')throw new RequestError('INVALID_RESPONSE');
    pendingTestId=null;mailConsent=false;
    try{await loadJobs();}catch(error){if(error.status===404)throw error;}
    message=result.replayed?'testReplay':'testQueued';
  },{id:'queue-test',primary:true,disabled:disabled||!mailConsent}));
  if(disabled)test.append(node('p',{class:'hint'},t('mailDisabled')));
  return node('div',{class:'admin-grid'},[summary,test]);
}
function render(){
  applyLocaleDocument(document,i18n);document.querySelector('.skip-link').textContent=t('skip');nav.setAttribute('aria-label',t('navigation'));
  const language=node('select',{class:'admin-language','aria-label':t('language'),disabled:busy,onChange:async event=>{try{const code=event.target.value;if(!await i18n.switchLocale(code))return;preferences.update({locale:code});applyAppearance();render();}catch{message='unavailable';render();}}},createLocaleOptions(document,i18n,{value:i18n.requestedLocale}));language.value=i18n.locale;
  nav.replaceChildren(node('a',{href:'/workspace.html'},t('workspace')),node('a',{href:'/preferences.html'},t('preferences')),language);
  main.replaceChildren(node('div',{class:'page-heading'},[node('h1',{},t('title')),node('p',{class:'intro'},t('intro'))]),node('p',{class:'admin-boundary'},t('boundary')),
    node('p',{class:'status',role:'status','aria-live':'polite'},message?t(message):''));
  if(!access||!config){
    main.append(node('section',{class:'panel admin-access'},[node('p',{},t('denied')),node('a',{href:'/account.html',class:'button'},t('login')),
      node('button',{type:'button',class:'button',onClick:()=>location.reload()},t('reloadPage'))]));brand.apply({titleSuffix:t('title')});return;
  }
  main.append(node('p',{},node('a',{href:'/backups.html',class:'button'},t('backups'))));
  const tabs=node('div',{class:'admin-tabs',role:'tablist','aria-label':t('title')});
  for(const [key,label]of [['config','configTab'],['users','usersTab'],['jobs','jobsTab']])tabs.append(node('button',{type:'button',id:'tab-'+key,class:'admin-tab',role:'tab','aria-selected':String(view===key),'aria-controls':'admin-panel',disabled:busy,onClick:()=>void run(async()=>{
    if(key==='users'&&!users)await loadUsers();if(key==='jobs'&&!jobs)await loadJobs();view=key;
  },'tab-'+key)},t(label)));
  main.append(tabs,node('div',{id:'admin-panel',role:'tabpanel','aria-labelledby':'tab-'+view},view==='config'?diagnostics():view==='users'?usersPanel():jobsPanel()),node('p',{class:'hint boundary'},t('remaining')));
  brand.apply({titleSuffix:t('title')});
}
try{
  const [instance,catalogs]=await Promise.all([loadInstanceConfig(),loadCatalogs({namespace:'admin'})]);
  brand=createInstanceBrand(instance);
  try{const session=await request('/api/auth/get-session',{expected:false});if(session?.user?.emailVerified===true&&id(session.user.id))actor=session.user;}catch{}
  preferences=new PreferencesStore({profileId:actor?.id??'local'});applyInstanceDefaults(preferences,instance);i18n=createI18n(catalogs,preferences.snapshot().locale); await i18n.switchLocale(i18n.requestedLocale);applyAppearance();
  if(actor){try{await loadConfig();message='ready';}catch{message='denied';}}else message='denied';render();
  window.addEventListener('focus',()=>{if(access&&!busy)void checkAccount().catch(()=>{loseAccess('accountChanged');render();});});
}catch{main.replaceChildren(node('p',{class:'status',role:'status'},'管理画面を読み込めません。 / Administration is unavailable.'));}

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>brand?.apply({kind})});
