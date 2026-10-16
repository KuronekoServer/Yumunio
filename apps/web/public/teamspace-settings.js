import {TeamspaceClient,TeamspaceClientError,validateTeamspaceDetail,validateTeamspaceRequests,validateTeamspaceRequestAck} from './teamspace-client.js';
import {PreferencesStore,THEMES,FONT_OPTIONS,validateCustomColors} from './preferences.js';
import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {createI18n,loadCatalogs,applyLocaleDocument} from './i18n.js';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fields=team=>({name:team.name,description:team.description,visibility:team.visibility,defaultPermission:team.defaultPermission});
const initialDraft=()=>({name:'',description:'',visibility:'closed',defaultPermission:'viewer'});
const tabs=['general','members','access'];

/** Shared settings body. The host keeps the editor mounted and owns its outer dialog. */
export function mountTeamspaceSettings({root,embedded=false,workspaceId,expectedAccountId,teamspaceId=null,section='general',onChange,onPolicyMayHaveChanged,onNavigate,clientFactory=options=>new TeamspaceClient(options),catalogs,fetcher=globalThis.fetch}={}){
 if(!root?.ownerDocument||!validId(workspaceId)||!validId(expectedAccountId)||teamspaceId!==null&&!validId(teamspaceId)||typeof clientFactory!=='function')throw new TypeError('INVALID_TEAMSPACE_SETTINGS');
 const document=root.ownerDocument,view=document.defaultView??globalThis.window,lifecycle=new AbortController();
 const preferences=new PreferencesStore({profileId:expectedAccountId});
 let active=true,generation=0,client=null,i18n=null,stopAppearance=()=>{},confirmation=null,pendingMutation=null;
 const state={loading:true,busy:false,locked:false,error:'',notice:'',list:null,detail:null,requests:null,teamspaceId,tab:tabs.includes(section)?section:'general',creating:false,duplicateSource:null,draft:initialDraft(),baseline:initialDraft(),confirmed:false,roleDrafts:new Map(),candidate:'',candidateRole:'member'};
 root.classList.add('teamspace-settings');
 const t=(key,values)=>i18n?.t(key,values)??key;
 function node(tag,attributes={},children=[]){const result=document.createElement(tag);for(const[key,value]of Object.entries(attributes)){if(value===null||value===undefined||value===false)continue;if(key==='class')result.className=value;else if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);else if(['disabled','required','checked','value','selected'].includes(key))result[key]=value;else result.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(child?.nodeType?child:document.createTextNode(String(child)));return result;}
 const action=(key,handler,attributes={})=>node('button',{type:'button',class:'button',onClick:event=>{if(active)handler(event);},...attributes},t(key));
 const dirty=()=>JSON.stringify(state.draft)!==JSON.stringify(state.baseline)||state.roleDrafts.size>0||state.candidate!==''||state.candidateRole!=='member';
 const disabled=()=>state.loading||state.busy||state.locked;
 const manager=()=>state.detail?.teamspace.role==='owner'&&state.detail.teamspace.capabilities.includes('manage');
 const paused=()=>state.detail?.teamspace.archivedAt!==null;
 const memberWritable=()=>manager()&&!paused()&&!disabled();
 function resetDraft(){state.draft=state.detail?fields(state.detail.teamspace):initialDraft();state.baseline=structuredClone(state.draft);state.confirmed=false;state.roleDrafts.clear();state.candidate='';state.candidateRole='member';}
 function applyPreferences(){
  if(!active||!i18n)return;const value=resolveAppearancePreferences(preferences.snapshot());root.lang=i18n.locale;root.dir=i18n.dir;
  if(embedded)return;const theme=THEMES.find(item=>item.id===value.themeId)||THEMES[0],colors=validateCustomColors(value.themeId,value.customColors).colors||theme.colors;
  for(const[key,color]of Object.entries(colors))document.documentElement.style.setProperty('--'+key,color);
  document.documentElement.style.fontFamily=FONT_OPTIONS.find(item=>item.id===value.fontId)?.family||FONT_OPTIONS[0].family;document.documentElement.style.colorScheme=theme.kind;applyLocaleDocument(document,i18n);
 }
 function clearConfirmation(){if(!confirmation)return;const current=confirmation;confirmation=null;if(current.open)current.close();current.remove();}
 function confirmAction(title,message,task,{discard=false}={}){
  if(!active||state.busy||state.loading||confirmation?.open)return false;
  const marker=generation,prior=document.activeElement;
  const cancel=action(discard?'keepEditing':'cancel',()=>{clearConfirmation();prior?.isConnected&&prior.focus();});
  const accept=action(discard?'discard':'continue',()=>{if(!active||marker!==generation||state.busy)return;clearConfirmation();task();},{class:'button primary'});
  confirmation=node('dialog',{class:'teamspace-confirm','aria-labelledby':'teamspace-confirm-title'},[node('h2',{id:'teamspace-confirm-title'},t(title)),node('p',{},message),node('div',{class:'teamspace-actions'},[cancel,accept])]);
  confirmation.addEventListener('cancel',event=>{event.preventDefault();clearConfirmation();prior?.isConnected&&prior.focus();});root.append(confirmation);confirmation.showModal();cancel.focus();return true;
 }
 function transition(task){if(!active||state.busy||state.loading||confirmation?.open)return false;if(dirty()){confirmAction('discardTitle',t('discardMessage'),()=>{resetDraft();task();},{discard:true});return false;}task();return true;}
 function freshClient(){client?.destroy();client=clientFactory({workspaceId,accountId:expectedAccountId,fetcher,signal:lifecycle.signal});}
 function classify(error){if(error.code==='ACCOUNT_CHANGED'||error.status===401)return'accountChanged';if(error.code==='LAST_TEAMSPACE_OWNER')return'lastOwner';if(error.code==='TEAMSPACE_ARCHIVED')return'archivedReadonly';if(error.status===409)return'conflict';if(error.status===413)return'tooLarge';if(error.status===403||error.status===404)return'forbidden';return'unavailable';}
 function clearPrivate(){state.list=null;state.detail=null;state.requests=null;state.teamspaceId=null;state.creating=false;state.duplicateSource=null;resetDraft();}
 async function load(id=state.teamspaceId,{fresh=false}={}){
  if(!active||state.busy)return;if(fresh||!client)freshClient();clearConfirmation();const marker=++generation;state.loading=true;state.locked=false;state.error='';state.notice='';state.teamspaceId=id;state.detail=null;state.requests=null;state.list=null;state.creating=false;state.duplicateSource=null;resetDraft();render();
  try{const value=id?await client.read(id):await client.list();if(!active||marker!==generation)return;if(id){const requests=validateTeamspaceRequests(await client.requests(id),workspaceId,id);if(!active||marker!==generation)return;if(requests.revision!==value.revision)throw new TeamspaceClientError('CONTENT_CONFLICT',409);state.detail=value;state.requests=requests;resetDraft();}else state.list=value;}
  catch(error){if(active&&marker===generation){state.error=classify(error);if(['accountChanged','forbidden'].includes(state.error)){clearPrivate();client.destroy();}}}
  finally{if(active&&marker===generation){state.loading=false;render();}}
 }
 async function runRequest(operation,intent){
  if(!active||disabled()||dirty())return;const marker=++generation,scope={teamspaceId:intent.teamspaceId,notified:false};pendingMutation=scope;state.busy=true;state.error=state.notice='';render();let acknowledged=false;
  try{
   const ack=validateTeamspaceRequestAck(await operation(client),{workspaceId,...intent});if(!active||marker!==generation)return;acknowledged=true;if(pendingMutation===scope)pendingMutation=null;await onChange?.(ack);if(!active||marker!==generation)return;
   const value=validateTeamspaceDetail(await client.read(intent.teamspaceId),workspaceId,intent.teamspaceId);if(!active||marker!==generation)return;const requests=validateTeamspaceRequests(await client.requests(intent.teamspaceId),workspaceId,intent.teamspaceId);if(!active||marker!==generation)return;
   if(value.revision<ack.revision||requests.revision!==value.revision)throw new TeamspaceClientError('CONTENT_CONFLICT',409);state.detail=value;state.requests=requests;resetDraft();state.notice=intent.action==='request'?'requestSent':intent.action==='approve'?'requestApproved':intent.action==='reject'?'requestRejected':'requestCanceled';
  }catch(error){if(active&&marker===generation){const authorityLost=error?.code==='ACCOUNT_CHANGED'||[401,403,404].includes(error?.status);state.error=authorityLost?classify(error):acknowledged?'refreshFailed':client.uncertain||!error?.status||error.status>=500||error.code==='INVALID_RESPONSE'?'unknownOutcome':classify(error);state.locked=true;signalPolicy(scope);if(authorityLost){clearPrivate();client.destroy();}}}
  finally{if(pendingMutation===scope)pendingMutation=null;if(active&&marker===generation){state.busy=false;render();root.querySelector('.teamspace-panel')?.focus({preventScroll:true});}}
 }
 function confirmRequest(action,request=null){
  if(disabled()||dirty()||!state.requests)return;const team=state.detail.teamspace,revision=state.detail.revision,requested=state.requests;
  if(action==='request'&&!requested.canRequest||action==='cancel'&&requested.myRequest?.id!==request?.id||['approve','reject'].includes(action)&&(!requested.canReview||team.archivedAt!==null||!requested.requests.some(row=>row.id===request?.id&&row.accountId===request?.accountId)))return;
  const intent={teamspaceId:team.id,expectedRevision:revision,accountId:request?.accountId??expectedAccountId,action,...(request?{requestId:request.id}:{})},body=action==='request'?{expectedRevision:revision,confirmRequest:true}:action==='cancel'?{expectedRevision:revision,requestId:request.id,confirmCancel:true}:{expectedRevision:revision,requestId:request.id,accountId:request.accountId,decision:action,confirmAccessChange:true};
  confirmAction('requestConfirmTitle',t('requestConfirm_'+action,{name:request?.name??team.name,permission:t(team.defaultPermission)}),()=>void runRequest(api=>action==='request'?api.requestJoin(team.id,body):action==='cancel'?api.cancelRequest(team.id,body):api.decideRequest(team.id,body),intent));
 }
 function checkedDetail(value,revision,id,check){const result=validateTeamspaceDetail(value,workspaceId,id);if(result.revision!==revision+1||!check(result))throw new TeamspaceClientError('INVALID_RESPONSE');return result;}
 function signalPolicy(scope){if(!scope||scope.notified)return;scope.notified=true;try{Promise.resolve(onPolicyMayHaveChanged?.({workspaceId,teamspaceId:scope.teamspaceId})).catch(()=>{});}catch{}}
 async function run(operation,{revision,teamId=state.teamspaceId,check=()=>true,notice='updated',retainMembers=false,returnToList=false}={}){
  if(!active||disabled())return;const marker=++generation,priorRoles=new Map(state.roleDrafts),priorCandidate=state.candidate,priorCandidateRole=state.candidateRole,scope={teamspaceId:teamId,notified:false};pendingMutation=scope;state.busy=true;state.error='';state.notice='';render();
  try{
   const value=await operation(client);if(!active||marker!==generation)return;const result=checkedDetail(value,revision,teamId,check);
   if(pendingMutation===scope)pendingMutation=null;
   state.detail=result;state.requests=null;state.teamspaceId=result.teamspace.id;state.creating=false;state.duplicateSource=null;state.notice=notice;resetDraft();
   if(retainMembers&&manager()){state.roleDrafts=new Map([...priorRoles].filter(([id,role])=>result.members.some(member=>member.id===id&&member.role!==role)));if(result.candidates?.some(item=>item.accountId===priorCandidate)&&!result.members.some(item=>item.accountId===priorCandidate)){state.candidate=priorCandidate;state.candidateRole=priorCandidateRole;}}
   if(state.list)state.list={...state.list,revision:result.revision,teamspaces:[...state.list.teamspaces.filter(item=>item.id!==result.teamspace.id),result.teamspace]};
   if(result.teamspace.visibility==='private'&&result.teamspace.role===null&&!result.teamspace.capabilities.includes('read')){clearPrivate();state.notice=notice;}
   else if(!returnToList){try{const queue=validateTeamspaceRequests(await client.requests(result.teamspace.id),workspaceId,result.teamspace.id);if(!active||marker!==generation)return;if(queue.revision!==result.revision)throw new TeamspaceClientError('CONTENT_CONFLICT',409);state.requests=queue;}catch(error){if(!active||marker!==generation)return;const lost=error?.code==='ACCOUNT_CHANGED'||[401,403,404].includes(error?.status);state.error=lost?classify(error):'refreshFailed';state.locked=true;signalPolicy(scope);if(lost){clearPrivate();client.destroy();return;}}}
   try{await onChange?.(result);}catch{if(active&&marker===generation){state.error='refreshFailed';signalPolicy(scope);}}
   if(returnToList&&active&&marker===generation){state.busy=false;await load(null);if(active){state.notice=notice;render();root.querySelector('.teamspace-panel')?.focus({preventScroll:true});}}
  }catch(error){if(active&&marker===generation){const unknown=client.uncertain||!error.status||error.status>=500||error.code==='INVALID_RESPONSE'||error.code==='REQUEST_UNCONFIRMED';state.error=unknown?'unknownOutcome':classify(error);state.locked=unknown||error.status===409;if(unknown)signalPolicy(scope);if(state.error==='accountChanged'||error.code==='ACCOUNT_CHANGED'||[401,403,404].includes(error.status)){signalPolicy(scope);clearPrivate();client.destroy();state.locked=true;}}}
  finally{if(pendingMutation===scope)pendingMutation=null;if(active&&marker===generation){state.busy=false;render();root.querySelector('.teamspace-panel')?.focus({preventScroll:true});}}
 }
 function validateDraft(){const value={...state.draft,name:state.draft.name.trim()};if(!value.name||value.name.length>100||/[\u0000-\u001f\u007f]/.test(value.name)){state.error='invalidName';render();root.querySelector('#teamspace-name')?.focus();return null;}if(value.description.length>1000||value.description.includes('\0')){state.error='invalidDescription';render();root.querySelector('#teamspace-description')?.focus();return null;}return value;}
 function saveTeam(){if(!active||disabled()||!dirty()||(!state.creating||state.duplicateSource)&&!state.confirmed)return;const value=validateDraft();if(!value)return;
  if(state.duplicateSource){const source=structuredClone(state.duplicateSource),revision=state.detail.revision,name=value.name;
   void run(api=>api.duplicate(source.id,{expectedRevision:revision,name,confirmSettingsOnly:true}),{revision,teamId:null,notice:'duplicated',check:result=>result.teamspace.id!==source.id&&result.teamspace.name===name&&['description','visibility','defaultPermission'].every(key=>result.teamspace[key]===source[key])&&result.teamspace.archivedAt===null&&result.teamspace.role==='owner'&&result.teamspace.memberCount===1&&result.members.length===1&&result.members[0].currentUser&&result.members[0].accountId===expectedAccountId&&result.members[0].role==='owner'});return;
  }
  const revision=state.creating?state.list.revision:state.detail.revision,teamId=state.creating?null:state.teamspaceId;
  void run(api=>teamId?api.update(teamId,{expectedRevision:revision,...value,confirmAccessChange:true}):api.create({expectedRevision:revision,...value}),{revision,teamId,notice:teamId?'updated':'created',check:result=>Object.entries(value).every(([key,expected])=>result.teamspace[key]===expected)&&(teamId!==null||result.teamspace.role==='owner'&&result.members.length===1&&result.members[0].currentUser&&result.members[0].accountId===expectedAccountId&&result.members[0].role==='owner')});
 }
 function selectControl(name,value,choices,onChange,attributes={}){const select=node('select',{name,id:'teamspace-'+name,disabled:disabled(),onChange:event=>onChange(event.target.value),...attributes},choices.map(key=>node('option',{value:key,selected:key===value},t(key))));select.value=value;return select;}
 function field(label,control){return node('label',{class:'teamspace-field',for:control.id??control.getAttribute('id')},[node('span',{},t(label)),control]);}
 function editField(name,{multiline=false}={}){const input=node(multiline?'textarea':'input',{id:'teamspace-'+name,name,...(!multiline?{type:'text'}:{rows:4}),maxlength:multiline?'1000':'100',required:!multiline,disabled:disabled(),value:state.draft[name],onInput:event=>{state.draft[name]=event.target.value;state.confirmed=false;updateSave();}});return field(name,input);}
 function accessFields(){return[
  field('visibility',selectControl('visibility',state.draft.visibility,['open','closed','private'],value=>{state.draft.visibility=value;state.confirmed=false;render();})),node('p',{class:'teamspace-hint'},t('visibility_'+state.draft.visibility)),
  field('defaultPermission',selectControl('defaultPermission',state.draft.defaultPermission,['viewer','commenter','editor'],value=>{state.draft.defaultPermission=value;state.confirmed=false;render();})),node('p',{class:'teamspace-hint'},t('defaultPermissionHint'))
 ];}
 function updateRequestControls(){for(const button of root.querySelectorAll('[data-teamspace-request]'))button.disabled=disabled()||dirty()||button.getAttribute('data-teamspace-request')!=='cancel'&&paused();const hint=root.querySelector('[data-teamspace-request-dirty]');if(hint)hint.hidden=!dirty();}
 function updateSave(){const button=root.querySelector('[data-teamspace-save]');if(button)button.disabled=disabled()||!dirty()||(!state.creating||state.duplicateSource)&&!state.confirmed;const checkbox=root.querySelector('#teamspace-confirm-save');if(checkbox)checkbox.checked=state.confirmed;updateRequestControls();}
 function saveForm(children){const form=node('form',{class:'teamspace-form'},children);if(!state.creating||state.duplicateSource){const checkbox=node('input',{id:'teamspace-confirm-save',type:'checkbox',checked:state.confirmed,disabled:disabled(),onChange:event=>{state.confirmed=event.target.checked;updateSave();}});form.append(node('label',{class:'teamspace-check',for:'teamspace-confirm-save'},[checkbox,node('span',{},t(state.duplicateSource?'confirmDuplicate':state.tab==='access'?'confirmAccess':'confirmSave'))]));}
  form.append(node('div',{class:'teamspace-actions'},node('button',{type:'submit',class:'button primary','data-teamspace-save':'',disabled:disabled()||!dirty()||(!state.creating||state.duplicateSource)&&!state.confirmed},t(state.busy?'working':state.duplicateSource?'duplicate':state.creating?'create':'save'))));form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())saveTeam();});return form;
 }
 function startDuplicate(){if(disabled()||!manager()||paused())return;const source=structuredClone(state.detail.teamspace),suffix=t('copySuffix');let name='';for(const char of source.name){if(name.length+char.length+suffix.length>100)break;name+=char;}state.creating=true;state.duplicateSource=source;state.draft={...fields(source),name:name+suffix};state.baseline=initialDraft();state.confirmed=false;render();root.querySelector('#teamspace-name')?.focus();}
 function duplicateFields(){const source=state.duplicateSource;return[editField('name'),node('p',{class:'teamspace-hint'},t('duplicateHint')),node('dl',{class:'teamspace-facts'},[['description',source.description||t('noDescription')],['visibility',t(source.visibility)],['defaultPermission',t(source.defaultPermission)]].map(([key,value])=>node('div',{},[node('dt',{},t(key)),node('dd',{translate:key==='description'?'no':null},value)]))),node('p',{class:'teamspace-hint'},t('visibility_'+source.visibility))];}
 function renderList(panel){
  panel.append(node('h1',{},t('title')),node('p',{class:'teamspace-intro'},t('intro')));
  if(!state.list)return;if(state.list.canCreate)panel.append(action('create',()=>{if(disabled())return;state.creating=true;state.detail=null;state.teamspaceId=null;resetDraft();render();root.querySelector('#teamspace-name')?.focus();},{class:'button primary',disabled:disabled()}));
  if(!state.list.teamspaces.length)panel.append(node('p',{class:'teamspace-hint'},t('empty')));
  const list=node('ul',{class:'teamspace-list'});
  for(const team of state.list.teamspaces)list.append(node('li',{},node('button',{type:'button',class:'teamspace-list-item',disabled:disabled(),onClick:()=>transition(()=>void load(team.id))},[node('span',{class:'teamspace-list-name',translate:'no'},team.name),node('span',{class:'teamspace-list-meta'},[t(team.visibility),t('memberCount',{count:team.memberCount}),...(team.archivedAt?[t('archived')]:[])].join(' · '))])));
  panel.append(list);
 }
 function renderMembers(panel){
  const detail=state.detail,team=detail.teamspace,writable=memberWritable(),owners=detail.members.filter(item=>item.role==='owner').length;
  panel.append(node('h2',{},t('members')),node('p',{class:'teamspace-hint'},t('memberRolesHint')));
  if(manager()&&state.requests?.canReview){const queue=node('section',{class:'teamspace-requests','aria-label':t('joinRequests')},[node('h3',{},t('joinRequests')),node('p',{class:'teamspace-hint'},t('requestAccessHint',{permission:t(team.defaultPermission)})),node('p',{class:'teamspace-hint','data-teamspace-request-dirty':'',hidden:!dirty()},t('requestDirtyHint'))]);if(!state.requests.requests.length)queue.append(node('p',{class:'teamspace-hint'},t('noJoinRequests')));else{const pending=node('ul',{class:'teamspace-members'});for(const request of state.requests.requests)pending.append(node('li',{class:'teamspace-member'},[node('strong',{translate:'no'},request.name),node('div',{class:'teamspace-member-actions'},['approve','reject'].map(kind=>action(kind,()=>confirmRequest(kind,request),{'data-teamspace-request':kind,disabled:!writable||dirty()})))]));queue.append(pending);}panel.append(queue);}
  if(!team.role){panel.append(node('p',{class:'teamspace-hint'},t('membersHidden')));return;}
  if(!detail.members.length)panel.append(node('p',{class:'teamspace-hint'},t('noMembers')));
  const list=node('ul',{class:'teamspace-members'});
  for(const member of detail.members){const selected=state.roleDrafts.get(member.id)??member.role,roleInput=selectControl('role-'+member.id,selected,['owner','member'],value=>{if(value===member.role)state.roleDrafts.delete(member.id);else state.roleDrafts.set(member.id,value);render();},{disabled:!writable,'aria-label':t('roleFor',{name:member.name||t('participant')})});
   const row=node('li',{class:'teamspace-member'},[
    node('div',{class:'teamspace-member-info'},[node('strong',{translate:'no'},member.name||t('participant')),node('span',{},t(member.role)),...(member.currentUser?[node('small',{},t('currentUser'))]:[])])
   ]);
   if(manager()||member.currentUser)row.append(node('div',{class:'teamspace-member-actions'},[
    ...(manager()?[roleInput,action('apply',()=>{const revision=detail.revision;confirmAction('confirmRoleTitle',t('confirmRoleMessage',{name:member.name||t('participant'),role:t(selected)}),()=>void run(api=>api.member(team.id,{expectedRevision:revision,accountId:member.accountId,role:selected}),{revision,notice:'membershipUpdated',retainMembers:true,check:value=>value.members.some(item=>item.id===member.id&&item.accountId===member.accountId&&item.role===selected)}));},{disabled:!writable||selected===member.role||member.role==='owner'&&owners<2&&selected!=='owner'})]:[]),
    action(member.currentUser?'leave':'remove',()=>{const revision=detail.revision;confirmAction(member.currentUser?'confirmLeaveTitle':'confirmRemoveTitle',member.currentUser?t('confirmLeaveMessage'):t('confirmRemoveMessage',{name:member.name||t('participant')}),()=>void run(api=>api.removeMember(team.id,{expectedRevision:revision,memberId:member.id}),{revision,notice:member.currentUser?'left':'memberRemoved',retainMembers:!member.currentUser,returnToList:member.currentUser,check:value=>!value.members.some(item=>item.id===member.id||item.accountId===member.accountId)&&(!member.currentUser||value.teamspace.role===null)}));},{disabled:disabled()||paused()&&!member.currentUser||!manager()&&!member.currentUser||member.role==='owner'&&owners<2,class:'button teamspace-danger'})
   ]));
   list.append(row);
  }
  panel.append(list);
  if(manager()){
   panel.append(node('p',{class:'teamspace-hint'},t('selfRemovalHint')));const candidates=(detail.candidates??[]).filter(item=>!detail.members.some(member=>member.accountId===item.accountId));
   const select=node('select',{id:'teamspace-candidate',disabled:!writable||!candidates.length,onChange:event=>{state.candidate=event.target.value;updateAdd();}},[node('option',{value:''},t('selectPerson')),...candidates.map(item=>node('option',{value:item.accountId,selected:item.accountId===state.candidate},item.name||t('participant')))]);select.value=state.candidate;
   const role=selectControl('candidate-role',state.candidateRole,['member','owner'],value=>{state.candidateRole=value;updateRequestControls();},{disabled:!writable});
   const submit=node('button',{type:'submit',class:'button primary','data-teamspace-add':'',disabled:!writable||!state.candidate},t('addMember'));
   const form=node('form',{class:'teamspace-form teamspace-add-member'},[node('h3',{},t('addMember')),field('person',select),field('role',role),submit]);form.addEventListener('submit',event=>{event.preventDefault();if(!memberWritable())return;const candidate=candidates.find(item=>item.accountId===state.candidate);if(!candidate)return;const revision=detail.revision,requestedRole=state.candidateRole;confirmAction('confirmAddTitle',t('confirmAddMessage',{name:candidate.name||t('participant'),role:t(requestedRole)}),()=>void run(api=>api.member(team.id,{expectedRevision:revision,accountId:candidate.accountId,role:requestedRole}),{revision,notice:'membershipUpdated',retainMembers:true,check:value=>value.members.some(item=>item.accountId===candidate.accountId&&item.role===requestedRole)}));});panel.append(form);
  }
 }
 function updateAdd(){const button=root.querySelector('[data-teamspace-add]');if(button)button.disabled=!memberWritable()||!state.candidate;updateRequestControls();}
 function renderDetail(panel){
  const team=state.detail.teamspace;panel.append(action('back',()=>transition(()=>void load(null)),{class:'button teamspace-back',disabled:disabled()}),node('h1',{translate:'no'},team.name),node('p',{class:'teamspace-context'},[t(team.visibility),team.role?t(team.role):t('notMember'),t('memberCount',{count:team.memberCount})].join(' · ')));
  if(team.archivedAt)panel.append(node('p',{class:'teamspace-notice'},t('archivedHint')));
  if(team.capabilities.includes('join')&&!team.archivedAt)panel.append(action('join',()=>{const revision=state.detail.revision;void run(api=>api.join(team.id,{expectedRevision:revision}),{revision,notice:'joined',check:value=>value.teamspace.role==='member'});},{class:'button primary',disabled:disabled()}));
  if(state.requests?.myRequest)panel.append(node('div',{class:'teamspace-request-status'},[node('p',{role:'status'},t('requestPending')),action('cancelRequest',()=>confirmRequest('cancel',state.requests.myRequest),{'data-teamspace-request':'cancel',disabled:disabled()||dirty()})]));
  else if(state.requests?.canRequest)panel.append(action('requestJoin',()=>confirmRequest('request'),{class:'button primary','data-teamspace-request':'request',disabled:disabled()||dirty()}));
  const nav=node('div',{class:'teamspace-tabs',role:'tablist','aria-label':t('settingsTabs')});for(const tab of tabs){const button=action(tab,()=>transition(()=>{state.tab=tab;resetDraft();render();root.querySelector('[data-teamspace-tab="'+tab+'"]')?.focus();}),{class:'teamspace-tab',role:'tab','aria-selected':String(state.tab===tab),'aria-controls':'teamspace-tab-panel','data-teamspace-tab':tab,tabindex:state.tab===tab?'0':'-1',disabled:state.busy||state.loading});button.addEventListener('keydown',event=>{const index=tabs.indexOf(tab),next=event.key==='ArrowRight'?tabs[(index+1)%tabs.length]:event.key==='ArrowLeft'?tabs[(index+tabs.length-1)%tabs.length]:event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):null;if(next){event.preventDefault();transition(()=>{state.tab=next;resetDraft();render();root.querySelector('[data-teamspace-tab="'+next+'"]')?.focus();});}});nav.append(button);}panel.append(nav);
  const body=node('section',{id:'teamspace-tab-panel',class:'teamspace-tab-panel',role:'tabpanel','aria-label':t(state.tab)});panel.append(body);
  if(state.tab==='members')renderMembers(body);
  else if(manager()&&!team.archivedAt)body.append(saveForm(state.tab==='general'?[editField('name'),editField('description',{multiline:true})]:[...accessFields(),node('p',{class:'teamspace-hint'},t('accessHint'))]));
  else{body.append(node('dl',{class:'teamspace-facts'},(state.tab==='general'?[['name',team.name],['description',team.description||t('noDescription')]]:[['visibility',t(team.visibility)],['defaultPermission',t(team.defaultPermission)]]).map(([key,value])=>node('div',{},[node('dt',{},t(key)),node('dd',{translate:state.tab==='general'?'no':null},value)]))),node('p',{class:'teamspace-hint'},t(team.archivedAt?'archivedReadonly':'readOnly')));}
  if(state.tab==='general'&&manager()){const archived=team.archivedAt!==null;body.append(node('section',{class:'teamspace-archive'},[node('h2',{},t(archived?'unarchive':'archive')),node('p',{class:'teamspace-hint'},t(archived?'unarchiveHint':'archiveHint')),action(archived?'unarchive':'archive',()=>transition(()=>{const revision=state.detail.revision;confirmAction(archived?'confirmUnarchiveTitle':'confirmArchiveTitle',t(archived?'confirmUnarchiveMessage':'confirmArchiveMessage'),()=>void run(api=>api.archive(team.id,{expectedRevision:revision,archived:!archived}),{revision,notice:archived?'restoredNotice':'archivedNotice',check:value=>(value.teamspace.archivedAt!==null)===!archived}));}),{disabled:disabled(),class:'button'+(archived?'':' teamspace-danger')})]));}
  if(state.tab==='general'&&manager()&&!team.archivedAt)body.append(node('section',{class:'teamspace-archive'},[node('h2',{},t('duplicate')),node('p',{class:'teamspace-hint'},t('duplicateHint')),action('duplicate',()=>transition(startDuplicate),{disabled:disabled()})]));
 }
 function render(){
  if(!active||!i18n)return;const focused=document.activeElement?.id,selectionStart=document.activeElement?.selectionStart,selectionEnd=document.activeElement?.selectionEnd;clearConfirmation();root.replaceChildren();root.lang=i18n.locale;root.dir=i18n.dir;
  const panel=node('section',{class:'teamspace-panel',tabindex:'-1'});root.append(panel);
  if(state.loading)panel.append(node('p',{role:'status'},t('loading')));
  if(state.error)panel.append(node('p',{class:'teamspace-notice',role:'alert'},t(state.error)));
  if(state.notice)panel.append(node('p',{class:'teamspace-notice',role:'status'},t(state.notice)));
   if(!state.loading){panel.append(node('div',{class:'teamspace-toolbar'},action('reload',()=>transition(()=>void load(state.duplicateSource&&state.error==='unknownOutcome'?null:state.teamspaceId,{fresh:true})),{disabled:state.busy})));
   if(state.creating){panel.append(action('back',()=>transition(()=>{state.creating=false;state.duplicateSource=null;resetDraft();render();}),{class:'button teamspace-back',disabled:disabled()}),node('h1',{},t(state.duplicateSource?'duplicateTitle':'createTitle')),node('p',{class:'teamspace-intro'},t(state.duplicateSource?'duplicateHint':'createHint')),saveForm(state.duplicateSource?duplicateFields():[editField('name'),editField('description',{multiline:true}),...accessFields()]));}
   else if(state.detail)renderDetail(panel);else renderList(panel);
  }
  if(!embedded)panel.append(node('p',{class:'teamspace-footer'},node('a',{href:'/workspace.html?workspace='+encodeURIComponent(workspaceId),onClick:event=>{if(!onNavigate||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();transition(()=>onNavigate({href:event.currentTarget.href}));}},t('backWorkspace'))));
   if(focused){const element=[...root.querySelectorAll('[id]')].find(item=>item.id===focused);if(element&&!element.disabled){element.focus({preventScroll:true});if(Number.isInteger(selectionStart)&&typeof element.setSelectionRange==='function')try{element.setSelectionRange(selectionStart,selectionEnd);}catch{}}}
 }
 function focusSection(value='teamspaces',options={}){
  if(!active||value===null||typeof options!=='object'||options===null)return false;const requested=typeof value==='object'?value:options,id=Object.hasOwn(requested,'teamspaceId')?requested.teamspaceId:value==='teamspaces'||typeof value==='object'&&!requested.tab?null:state.teamspaceId,tab=tabs.includes(requested.tab)?requested.tab:tabs.includes(value)?value:state.tab;
  if(id!==null&&!validId(id))return false;if(id!==state.teamspaceId||state.creating)return transition(()=>{state.tab=tab;void load(id);});
  if(tab!==state.tab)return transition(()=>{state.tab=tab;resetDraft();render();});root.querySelector('.teamspace-panel')?.focus({preventScroll:true});return true;
 }
 const beforeUnload=event=>{if(active&&(state.busy||dirty())){event.preventDefault();event.returnValue='';}};view?.addEventListener('beforeunload',beforeUnload);
 const ready=(async()=>{try{const values=catalogs??await loadCatalogs({namespace:'teamspace',locale:preferences.snapshot().locale,fetcher});if(!active)return;i18n=createI18n(values,preferences.snapshot().locale);await i18n.switchLocale(preferences.snapshot().locale);if(!active)return;applyPreferences();if(!embedded)stopAppearance=watchSystemAppearance(()=>preferences.snapshot(),{onAppearance:applyPreferences});await load(teamspaceId);}catch{if(active){state.loading=false;state.error='unavailable';if(i18n)render();else root.replaceChildren(node('p',{role:'alert'},'チームスペースを読み込めません。 / Teamspaces are unavailable.'));}}})();
 return{ready,get closeState(){return{busy:active&&state.busy,dirty:active&&dirty()};},canClose:()=>!active||!state.busy&&!dirty()&&!confirmation?.open,focusSection,destroy(){if(!active)return;signalPolicy(pendingMutation);active=false;generation++;lifecycle.abort();client?.destroy();stopAppearance();clearConfirmation();view?.removeEventListener('beforeunload',beforeUnload);root.replaceChildren();root.classList.remove('teamspace-settings');clearPrivate();}};
}
