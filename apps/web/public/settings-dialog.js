const personalSections=['appearance','colors','font','language','sync'];
const workspaceSections=['general','import','members','teamspaces','groups'];
export function settingsHrefSection(href,workspaceId,base=globalThis.location?.href??'https://local.invalid/'){
 let url;try{url=new URL(href,base);}catch{return null;}
 if(url.origin!==new URL(base).origin)return null;
 if(url.pathname==='/preferences'){
  const values=url.searchParams.getAll('workspace');if(values.length>1||values.length===1&&values[0]!==workspaceId)return null;
  return personalSections.includes(url.hash.slice(1))?url.hash.slice(1):'appearance';
 }
 if(!['/workspace-settings','/share'].includes(url.pathname)||url.searchParams.getAll('workspace').length!==1||url.searchParams.get('workspace')!==workspaceId)return null;
 return url.pathname==='/share'?'members':['import','teamspaces','groups'].includes(url.searchParams.get('section'))?url.searchParams.get('section'):'general';
}
const defaultMounts={
 preferences:async options=>(await import('./preferences-page.js')).mountPreferencesPage(options),
 workspace:async options=>(await import('./workspace-settings.js')).mountWorkspaceSettings(options),
 members:async options=>(await import('./sharing-page.js')).mountSharingPage(options),
 teamspaces:async options=>(await import('./teamspace-settings.js')).mountTeamspaceSettings(options),
 groups:async options=>(await import('./groups-settings.js')).mountGroupsSettings(options)
};
/** Independent top-layer host: the underlying editor DOM, draft and room stay mounted. */
export function mountSettingsDialog({document=globalThis.document,background,workspaceId,expectedAccountId,pageId=null,initialSection='appearance',initialTeamspaceId=null,createTeamspace=false,workspaceName='',accountName='',resource=null,labels=key=>key,onClose,onPreferencesChanged,onWorkspaceChanged,onNavigateOut,mounts=defaultMounts}={}){
 if(!document?.createElement||!background||!workspaceId||!expectedAccountId)throw new TypeError('INVALID_SETTINGS_DIALOG');
 if(resource!==null&&(!pageId||!['page','collection'].includes(resource.kind)||typeof resource.title!=='string'))throw new TypeError('INVALID_RESOURCE_SHARING');
 const personal=resource?[]:personalSections,workspace=resource?['members','groups']:workspaceSections,available=[...personal,...workspace];
 const sectionLabel=value=>labels(resource?(value==='members'?'individualSharing':value==='groups'?'roleSharing':value):value);
 const node=(tag,attributes={},children=[])=>{const result=document.createElement(tag);for(const[key,value]of Object.entries(attributes)){if(key==='class')result.className=value;else if(key==='onClick')result.addEventListener('click',value);else result.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(typeof child==='string'?document.createTextNode(child):child);return result;};
 const viewWindow=document.defaultView??globalThis.window;
 const beforeUnload=event=>{const state=view?.closeState;if(state?.busy||state?.dirty){event.preventDefault();event.returnValue='';}};
 const priorFocus=document.activeElement,priorInert=background.inert,priorOverflow=document.body.style.overflow;
 const selection=document.getSelection?.(),savedSelection=selection?.rangeCount?{range:selection.getRangeAt(0).cloneRange(),anchor:selection.anchorNode,anchorOffset:selection.anchorOffset,focus:selection.focusNode,focusOffset:selection.focusOffset}:null;
 let destroyed=false,generation=0,view=null,viewKind='',section='',guard=null,composing=false;
 const dialog=node('dialog',{class:'settings-dialog','aria-labelledby':'settings-dialog-title'});
 const title=node('h2',{id:'settings-dialog-title'},labels('title'));
 const close=node('button',{type:'button',class:'settings-dialog-close','aria-label':labels('close'),onClick:()=>requestClose()},'\u00d7');
 const panel=node('section',{class:'settings-dialog-panel',tabindex:'-1'});
 const scroll=node('div',{class:'settings-dialog-scroll'},panel);
 const main=node('div',{class:'settings-dialog-main'},[node('header',{class:'settings-dialog-header'},[title,close]),scroll]);
 const navigation=node('aside',{class:'settings-dialog-navigation','aria-label':labels('navigation')},[
  node('div',{class:'settings-dialog-account'},[node('strong',{},accountName||labels('personal')),node('span',{},labels(resource?'resourceSharing':'title'))])
 ]);
 const buttons=new Map(),groups=[];
 for(const [group,sections,name]of [['personal',personal,labels('personal')],['workspace',workspace,resource?resource.title:workspaceName||labels('workspace')]]){
  if(!sections.length)continue;
  const links=node('nav',{'aria-label':labels(group),class:'settings-dialog-nav'},node('h3',{},name));
  for(const value of sections){const button=node('button',{type:'button',class:'settings-dialog-category','data-settings-section':value,onClick:()=>requestSection(value)},sectionLabel(value));buttons.set(value,button);links.append(button);}
  groups.push({group,links});navigation.append(links);
 }
 dialog.append(node('div',{class:'settings-dialog-shell'},[navigation,main]));
 background.inert=true;document.body.style.overflow='hidden';document.body.append(dialog);
 function refreshLabels(){if(destroyed)return;title.textContent=sectionLabel(section);close.setAttribute('aria-label',labels('close'));navigation.setAttribute('aria-label',labels('navigation'));for(const[key,button]of buttons)button.textContent=sectionLabel(key);for(const{group,links}of groups){links.setAttribute('aria-label',labels(group));if(group==='personal')links.querySelector('h3').textContent=labels('personal');}navigation.querySelector('.settings-dialog-account').querySelector('span').textContent=labels(resource?'resourceSharing':'title');}
 const kindFor=value=>personalSections.includes(value)?'preferences':['members','teamspaces','groups'].includes(value)?value:'workspace';
 const childDialogOpen=()=>[...dialog.querySelectorAll('dialog')].some(child=>child.open);
 const focusable=()=>[...(guard??dialog).querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(element=>!element.disabled&&!element.hidden&&element.getAttribute('tabindex')!=='-1'&&!element.closest('[inert]')&&element.getClientRects?.().length!==0);
 function clearGuard(){guard?.remove();guard=null;}
 function guardTransition(action){
  if(destroyed||childDialogOpen())return false;
  const status=view?.closeState??{busy:false,dirty:false};
  if(status.busy)return false;
  if(view?.canClose?.()===false||status.dirty){
   clearGuard();const before=document.activeElement;
   const keep=node('button',{type:'button',class:'button',onClick:()=>{clearGuard();before?.focus?.();}},labels('keepEditing'));
   guard=node('section',{class:'settings-dialog-discard',role:'alertdialog','aria-label':labels('discardTitle')},[
    node('strong',{},labels('discardTitle')),node('p',{},labels('discardMessage')),node('div',{class:'settings-dialog-discard-actions'},[keep,node('button',{type:'button',class:'button primary',onClick:()=>{clearGuard();action();}},labels('discard'))])
   ]);main.insertBefore(guard,scroll);keep.focus();return false;
  }
  action();return true;
 }
 async function show(value){
  if(destroyed)return;
  clearGuard();const nextKind=kindFor(value);section=value;
  title.textContent=sectionLabel(value);for(const[key,button]of buttons){if(key===value)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  if(view&&viewKind===nextKind){view.focusSection?.(value);return;}
  const marker=++generation;view?.destroy?.();view=null;viewKind=nextKind;const viewRoot=node('div',{class:'settings-dialog-view'},node('p',{role:'status'},labels('loading')));panel.replaceChildren(viewRoot);scroll.scrollTop=0;
  let next;
  try{
   next=await mounts[nextKind]({root:viewRoot,embedded:true,expectedAccountId,workspaceId,pageId,resourceOnly:resource!==null,resourceKind:resource?.kind??'page',resourceTitle:resource?.title??'',section:value,teamspaceId:initialTeamspaceId,onNavigate:route=>{if(route?.section)requestSection(route.section);else if(route?.href)requestHref(route.href);},onPolicyMayHaveChanged:()=>onWorkspaceChanged?.({status:'unconfirmed'}),onChange:nextKind==='preferences'?value=>{void Promise.resolve(onPreferencesChanged?.(value)).then(refreshLabels).catch(()=>{});}:onWorkspaceChanged});
   if(destroyed||marker!==generation){next?.destroy?.();return;}
   view=next;await next.ready;
   if(destroyed||marker!==generation)return;
   next.focusSection?.(section,section==='teamspaces'?{teamspaceId:initialTeamspaceId,...(createTeamspace?{create:true}:{})}:undefined);if(section==='teamspaces')createTeamspace=false;
  }catch{if(!destroyed&&marker===generation)panel.replaceChildren(node('p',{role:'alert'},labels('unavailable')));}
 }
 function requestSection(value){
  if(!available.includes(value)||destroyed)return false;
  if(view&&viewKind===kindFor(value)){void show(value);return true;}
  return guardTransition(()=>void show(value));
 }
 function finishClose({restoreFocus=true}={}){
  if(destroyed)return;destroyed=true;generation++;view?.destroy?.();clearGuard();
  if(dialog.open)dialog.close();dialog.remove();document.removeEventListener('keydown',keydown,true);viewWindow?.removeEventListener('beforeunload',beforeUnload);
  background.inert=priorInert;document.body.style.overflow=priorOverflow;
  onClose?.();
  if(restoreFocus&&priorFocus?.isConnected!==false){try{if(savedSelection?.anchor?.isConnected!==false&&savedSelection?.focus?.isConnected!==false){const current=document.getSelection?.();if(current?.setBaseAndExtent)current.setBaseAndExtent(savedSelection.anchor,savedSelection.anchorOffset,savedSelection.focus,savedSelection.focusOffset);else if(current){current.removeAllRanges();current.addRange(savedSelection.range);}}}catch{}priorFocus?.focus?.({preventScroll:true});}
 }
 function requestClose(){return guardTransition(()=>finishClose());}
 function requestHref(href){const value=settingsHrefSection(href,workspaceId);if(value){requestSection(value);return;}guardTransition(()=>{finishClose({restoreFocus:false});onNavigateOut?.(new URL(href,globalThis.location?.href??'https://local.invalid/').href);});}

 function keydown(event){
  const focusedDialog=event.target?.closest?.('dialog')??document.activeElement?.closest?.('dialog');
  if(destroyed||focusedDialog?.open&&focusedDialog!==dialog||childDialogOpen()||event.isComposing||event.keyCode===229||composing)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(guard){clearGuard();close.focus();}else requestClose();return;}
  if(event.key!=='Tab')return;
  const choices=focusable(),first=choices[0],last=choices.at(-1);if(!first){event.preventDefault();dialog.focus();return;}
  if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}
 }
 dialog.addEventListener('compositionstart',()=>{composing=true;});
 dialog.addEventListener('compositionend',()=>{composing=false;});
 dialog.addEventListener('cancel',event=>{if(event.target!==dialog)return;event.preventDefault();if(!composing&&!childDialogOpen())requestClose();});
 dialog.addEventListener('click',event=>{
  if(event.target===dialog){requestClose();return;}
  const link=event.target.closest?.('a[href]');if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const href=link.getAttribute('href');if(!href||href.startsWith('#'))return;
  event.preventDefault();requestHref(link.href);
 });
 document.addEventListener('keydown',keydown,true);viewWindow?.addEventListener('beforeunload',beforeUnload);dialog.showModal();close.focus();
 const ready=show(available.includes(initialSection)?initialSection:available[0]);
 return {ready,requestClose,requestSection,destroy:finishClose,get open(){return !destroyed;},get element(){return dialog;}};
}
