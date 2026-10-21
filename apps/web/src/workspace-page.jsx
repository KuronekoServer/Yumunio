'use client';
import {Fragment,memo,useCallback,useEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {motion} from 'motion/react';
import {MotionDialog,SidebarMenu,useReducedMotionPreference} from './ui-motion.jsx';
import {surfaceTransition} from '../public/ui-motion-policy.js';
import {Icon} from './icons.jsx';
import {sidebarSiblingPositions,sidebarAncestors,sidebarLayoutKey} from '../public/sidebar-model.js';
import {Button} from './components/ui/button.jsx';
import {Tooltip,TooltipTrigger,TooltipContent} from './components/ui/tooltip.jsx';

function Action({label,icon,onClick,disabled=false,className='',children,...props}){
 const button=<Button type="button" variant="ghost" size={children?'sm':'icon-sm'} className={className||'icon-button'} aria-label={label} disabled={!!disabled} onClick={onClick} {...props}>{icon&&<Icon name={icon}/>} {children}</Button>;
 return icon&&!children?<Tooltip><TooltipTrigger asChild>{button}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>:button;
}
const Sidebar=memo(function Sidebar({model,onCollapse,desktop,collapsed}){
 const reduced=useReducedMotionPreference(),hidden=desktop?collapsed:!model.state.navOpen;
 const {state:s,t,handlers:h,workspaceId,pageRows,activeTeams,collapsedTeams,expandedPages,newDisabled}=model;
 const treeLayoutKey=sidebarLayoutKey(model);
 const query='?workspace='+encodeURIComponent(workspaceId),disabled=!s.user||!!s.fatal||s.busy;
 const sections=[],sectionsByKey=new Map(),teamsById=new Map(activeTeams.map(team=>[team.id,team]));
 const siblingPositions=sidebarSiblingPositions(s.pages);
 const section=(key,label,team=null)=>{let value=sectionsByKey.get(key);if(!value){value={key,label,team,rows:[]};sectionsByKey.set(key,value);sections.push(value);}return value;};
 if(s.teamsAvailable){for(const team of activeTeams)section('team:'+team.id,team.name,team);section('personal',t('teamspaces.personalPages'));}
 for(const row of pageRows){const page=row.page,team=teamsById.get(page.teamspaceId),key=team?'team:'+team.id:page.sidebarSection==='personal'?'personal':page.sidebarSection==='shared'||page.sidebarSection==='teamspace'?'shared':'legacy';section(key,t(key==='personal'?'teamspaces.personalPages':key==='shared'?'teamspaces.sharedPages':'pages'),team||null).rows.push(row);}
 function pageRow({page,depth,hasChildren}){
  const expanded=expandedPages.includes(page.id),manageable=s.role!=='guest'&&page.capabilities.includes('manage'),movable=manageable&&!page.recordId&&!page.templateId,{index,count}=siblingPositions.get(page.id);
  return <Fragment key={page.id}><motion.li layout="position" layoutDependency={treeLayoutKey} transition={surfaceTransition('placement',reduced)} className="sidebar-page-row" style={{paddingInlineStart:depth*14,minWidth:170+depth*14}}>
   {hasChildren||manageable?<Action className="sidebar-page-disclosure" label={t(expanded?'sidebarCollapse':'sidebarExpand',{name:page.title||t('untitled')})} aria-expanded={expanded} onClick={()=>h.togglePage(page.id)}><Icon name="chevron" className={expanded?'chevron expanded':'chevron'}/></Action>:<span className="sidebar-page-spacer" aria-hidden="true"/>}
   <a href={'/workspace'+query+'&page='+encodeURIComponent(page.id)} className={'page-link'+((s.pendingPageId||s.current?.page.id)===page.id?' selected':'')} aria-current={(s.pendingPageId||s.current?.page.id)===page.id?'page':undefined} aria-disabled={s.busy||undefined}
    data-dnd-page-id={!model.room&&page.id!==s.current?.page.id&&page.capabilities.includes('editBody')?page.id:undefined}
    draggable={movable&&!s.busy}
    onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();if(!s.busy)void h.selectPage(page.id);}} onPointerEnter={()=>h.prefetchPage(page.id)} onPointerLeave={h.cancelPagePrefetch} onFocus={()=>h.prefetchPage(page.id)} onDragStart={event=>h.startPageDrag(event,page)} onDragEnd={h.endPageDrag} onDragOver={event=>h.overPageDrop(event,page.id)} onDragLeave={event=>{delete event.currentTarget.dataset.pageDrop;}} onDrop={event=>h.dropPage(event,page.id)}>
    {page.appearance?.icon?<span aria-hidden="true" translate="no">{page.appearance.icon}</span>:<Icon name={page.collectionId?'table':'page'}/>}<span translate="no" data-sidebar-page-title="">{page.title||t('untitled')}</span>
   </a>
   {manageable&&<div className="sidebar-page-actions"><Action label={t('pageTree.addChildTo',{name:page.title||t('untitled')})} icon="plus" disabled={newDisabled} onClick={()=>h.createSubpage(page.id)}/>
    <SidebarMenu compact portal className="sidebar-page-menu" label={t('pageTree.actionsFor',{name:page.title||t('untitled')})} icon={<Icon name="more"/>} disabled={disabled}>
     <Action className="nav-link" label={t('pageTree.addChild')} icon="plus" disabled={newDisabled} onClick={()=>h.createSubpage(page.id)}>{t('pageTree.addChild')}</Action>
     {movable&&<><Action className="nav-link" label={t('pageTree.moveUp')} disabled={s.busy||index<1} onClick={()=>h.moveSidebarPage(page.id,'up')}>{t('pageTree.moveUp')}</Action><Action className="nav-link" label={t('pageTree.moveDown')} disabled={s.busy||index===count-1} onClick={()=>h.moveSidebarPage(page.id,'down')}>{t('pageTree.moveDown')}</Action><Action className="nav-link" label={t('movePage')} icon="arrow" disabled={s.busy||model.room} onClick={()=>h.openSidebarPageMove(page.id)}>{t('movePage')}</Action></>}
     {movable&&<Action className="nav-link" label={t('teamspaces.movePage')} disabled={s.busy||model.room} onClick={()=>h.openSidebarTeamspaceMove(page.id)}>{t('teamspaces.movePage')}</Action>}
     <Action className="nav-link" label={t('trashPage')} icon="trash" disabled={s.busy||model.room} onClick={()=>h.openSidebarPageTrash(page.id)}>{t('trashPage')}</Action>
    </SidebarMenu></div>}
  </motion.li>{expanded&&!hasChildren&&<li className="sidebar-empty-children" style={{paddingInlineStart:(depth+1)*14+22,minWidth:170+(depth+1)*14}}>{t('pageTree.empty')}</li>}</Fragment>;
 }
 const favorites=s.pages.filter(page=>page.favorite);
 return <motion.aside id="workspace-sidebar" className="workspace-sidebar" aria-label={t('pages')} aria-hidden={hidden||undefined} inert={hidden} initial={false} animate={{x:hidden?'-100%':0}} transition={surfaceTransition('sidebar',reduced)}>
  <div className="workspace-brand"><button type="button" className="workspace-switcher" aria-label={t('workspacePicker.title')} disabled={disabled} onClick={h.openWorkspacePicker}><img data-instance-logo="" alt="" width="22" height="22" hidden/><Icon name="notebook" data-instance-default-logo=""/><span translate="no">{s.name||'Yumunio'}</span><span aria-hidden="true">⌄</span></button><Action label={t('collapseSidebar')} icon="sidebar" className="desktop-sidebar-toggle icon-button" onClick={onCollapse}/><Action label={t('closeMenu')} icon="close" className="mobile-close icon-button" onClick={()=>h.setNavigation(false)}/></div>
  <nav className="workspace-links" aria-label={t('pages')}>
   <Action className="nav-link sidebar-search" label={t('sidebarSearch')} icon="search" onClick={h.openSearch} disabled={disabled}><span>{t('sidebarSearch')}</span><kbd>Ctrl K</kbd></Action>
   <Action className="nav-link" label={t('sidebarHome')} icon="home" onClick={h.openWorkspaceHome} disabled={disabled}>{t('sidebarHome')}</Action>
   {s.user&&!s.fatal&&<a href={'/comments'+query} className="nav-link"><Icon name="inbox"/>{t('sidebarInbox')}</a>}
   <SidebarMenu label={t('sidebarLibrary')} icon={<Icon name="template"/>}><a href={'/collections'+query} className="nav-link"><Icon name="table"/>{t('collections')}</a><a href={'/forms'+query} className="nav-link"><Icon name="page"/>{t('forms')}</a>{s.role&&s.role!=='guest'&&<a href={'/templates'+query} className="nav-link"><Icon name="template"/>{t('personalTemplates')}</a>}</SidebarMenu>
  </nav>
  <div className="page-list-heading sidebar-directory-heading"><span>{t('pages')}</span><Action label={t('refreshList')} icon="refresh" disabled={!s.user||s.busy||s.listLoading||!!s.fatal} onClick={()=>h.refreshList(true)}/><Action label={t('createPage')} icon="plus" disabled={newDisabled} onClick={()=>h.openCreate()}/>
   <button type="button" className="root-drop-target" onDragOver={event=>h.overPageDrop(event,null)} onDragLeave={event=>{delete event.currentTarget.dataset.pageDrop;}} onDrop={event=>h.dropPage(event,null)}>{t('moveToRoot')}</button>
  </div>
  <div className="page-list page-directory">
   {!!favorites.length&&<section className="sidebar-page-section"><div className="page-list-heading"><span>{t('pageTools.favorites')}</span></div><ul className="sidebar-section-pages">{favorites.map(page=><li key={page.id}><button type="button" className="page-link" disabled={s.busy} onClick={()=>h.selectPage(page.id)}><span aria-hidden="true" translate="no">{page.appearance?.icon||'☆'}</span><span translate="no">{page.title||t('untitled')}</span></button></li>)}</ul></section>}
   {sections.map(({key,label,team,rows})=><section key={key} className="sidebar-page-section">
    <div className="page-list-heading">{team?<button type="button" className="teamspace-disclosure" aria-expanded={!collapsedTeams.includes(team.id)} onClick={()=>h.toggleTeam(team.id)}><Icon name="chevron" className={!collapsedTeams.includes(team.id)?'chevron expanded':'chevron'}/><span translate="no">{label}</span></button>:<span>{label}</span>}
     {team&&<>{team.capabilities.includes('createPage')&&<Action label={t('createPage')} icon="plus" disabled={newDisabled} onClick={()=>h.openCreate(team.id)}/>}<Action label={t('teamspaces.settings')+' · '+team.name} icon="more" disabled={s.busy} onClick={()=>h.openSettings('teamspaces',team.id)}/></>}
     {!team&&s.teamsAvailable&&key==='personal'&&<Action label={t('teamspaces.browse')} icon="more" disabled={disabled} onClick={()=>h.openSettings('teamspaces')}/>}
    </div><ul className="sidebar-section-pages" hidden={!!team&&collapsedTeams.includes(team.id)}>{rows.map(pageRow)}</ul>
   </section>)}
   {s.teamsAvailable&&s.role!=='guest'&&<Action className="nav-link sidebar-create-teamspace" label={t('pageTree.createTeamspace')} icon="plus" disabled={disabled} onClick={h.openCreateTeamspace}>{t('pageTree.createTeamspace')}</Action>}
  </div>
  <footer className="sidebar-footer">
   {s.user&&!s.fatal&&<a href={'/workspace-settings'+query} className="nav-link"><Icon name="settings"/>{t('sidebarSettings')}</a>}
   <SidebarMenu className="sidebar-tools" label={t('sidebarTools')} icon={<Icon name="more"/>}>
    {s.user&&!s.fatal&&<Action className="nav-link" label={t('sidebarInvite')} icon="users" onClick={()=>h.openSettings('members')} disabled={s.busy}>{t('sidebarInvite')}</Action>}
    <Action className="nav-link" label={t('trashPages')} icon="trash" onClick={h.openTrash} disabled={disabled}>{t('trashPages')}</Action><Action className="nav-link" label={t('exportWorkspace')} icon="download" onClick={h.openExport} disabled={disabled}>{t('exportWorkspace')}</Action>
    {s.user&&!s.fatal&&s.role&&s.role!=='guest'&&<a href={'/workspace-settings'+query+'&section=import'} className="nav-link"><Icon name="plus"/>{t('importContent')}</a>}
    <a href="/notes" className="nav-link"><Icon name="arrow"/>{t('deviceNotes')}</a><a href={'/integrations'+query+(s.current?'&page='+encodeURIComponent(s.current.page.id):'')} className="nav-link">{t('integrations')}</a><a href="/install" className="nav-link">{t('installApp')}</a><a href="/LICENSE.txt" className="license-link">{t('footerLicense')}</a>
   </SidebarMenu>
   <button type="button" className="profile-link" disabled={!s.user||s.busy} onClick={h.openWorkspacePicker}><span className="profile-symbol" aria-hidden="true">{Array.from(s.user?.name||'Y')[0]}</span><span translate="no">{s.user?.name||t('account')}</span></button>
  </footer>
 </motion.aside>;
});
function Toolbar({model,controls,sidebarCollapsed,onExpandSidebar}){
 const {state:s,t,handlers:h,workspaceId}=model;
 const ancestors=sidebarAncestors(s.pages,s.pendingPageId||s.current?.page.id),team=s.teamspaces.find(team=>team.id===s.current?.page.teamspaceId);
 return <header className="workspace-topbar">{sidebarCollapsed&&<Action className="desktop-sidebar-toggle icon-button" label={t('expandSidebar')} icon="sidebar" aria-expanded={false} aria-controls="workspace-sidebar" onClick={onExpandSidebar}/>}<Action className="nav-toggle icon-button" label={t('menu')} icon="menu" aria-expanded={s.navOpen} aria-controls="workspace-sidebar" onClick={()=>h.setNavigation(!s.navOpen)}/>
  <nav className="breadcrumb" aria-label={t('pageTree.breadcrumb')} title={ancestors.map(page=>page.title).join(' / ')}><span translate="no">{team?.name||s.name||t('serverWorkspace')}</span>{ancestors.length>2&&<span aria-hidden="true"> / …</span>}{ancestors.slice(-2).map(page=><Fragment key={page.id}><span className="breadcrumb-divider" aria-hidden="true">/</span><button type="button" className="breadcrumb-page" disabled={s.busy} translate="no" onClick={()=>h.selectPage(page.id)}>{page.title||t('untitled')}</button></Fragment>)}{(s.current||s.pendingPageId)&&<><span className="breadcrumb-divider" aria-hidden="true">/</span><span translate="no" data-page-crumb="">{controls.title??s.draft?.title??t('untitled')}</span></>}</nav>
  <div className="topbar-actions"><span className="save-status" role="status" aria-live="polite" hidden={!controls.status}>{controls.status||''}</span><Action label={t('undo')} icon="undo" disabled={controls.undoDisabled!==false} onClick={()=>h.applyEditorHistory('undo')}/><Action label={t('redo')} icon="redo" disabled={controls.redoDisabled!==false} onClick={()=>h.applyEditorHistory('redo')}/>
   {s.current&&<div className="collaboration-presence" data-room-presence=""/>}
   {s.current&&model.collaboration&&<span className={'connection-indicator'+(controls.collaboration?.connected?' connected':'')} role="status" aria-label={t(controls.collaboration?.connected?'realtime.connected':'realtime.connecting')} title={t(controls.collaboration?.connected?'realtime.connected':'realtime.connecting')}><span aria-hidden="true"/></span>}
   <Action className="button quiet" label={t('shareResource')} disabled={!s.current?.page.capabilities?.some(value=>['manage','invite'].includes(value))||s.busy||s.loading} onClick={h.openResourceSharing}>{t('shareResource')}</Action>
   {s.current?.page.capabilities?.includes('read')&&<a href={'/backlinks?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(s.current.page.id)} className="button toolbar-backlinks">{t('backlinks')}</a>}
   {s.current&&<Action label={t(s.current.page.favorite?'pageTools.removeFavorite':'pageTools.addFavorite')} icon="star" aria-pressed={!!s.current.page.favorite} className="icon-button toolbar-favorite" disabled={!!model.room||s.busy||s.loading||s.locked||s.collection?.dirty} onClick={h.toggleFavorite}/>}
   <Action label={t('pageActions')} icon="more" disabled={!s.current||s.busy||s.loading} onClick={h.openPageActions}/><Action label={t('reload')} icon="refresh" disabled={!s.current||s.busy||s.loading} onClick={h.reloadPage}/>
  </div>
 </header>;
}

/** The editor engine owns the content host; React owns navigation, toolbar and route lifecycle. */
export function WorkspacePage(){
 const reduced=useReducedMotionPreference(),[desktop,setDesktop]=useState(true);
 useEffect(()=>{const media=matchMedia('(min-width:761px)'),change=()=>setDesktop(media.matches);change();media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 const root=useRef(null),modal=useRef(null),content=useRef(null),lastControls=useRef(''),[model,setModel]=useState(null),[controls,setControls]=useState({}),[failed,setFailed]=useState(false),[sidebarCollapsed,setSidebarCollapsed]=useState(false);
 const collapseSidebar=useCallback(()=>{flushSync(()=>setSidebarCollapsed(true));root.current?.querySelector('.workspace-main .desktop-sidebar-toggle')?.focus({preventScroll:true});},[]),expandSidebar=useCallback(()=>{flushSync(()=>setSidebarCollapsed(false));root.current?.querySelector('.workspace-sidebar .desktop-sidebar-toggle')?.focus({preventScroll:true});},[]);
 useEffect(()=>{
  const lifetime=new AbortController();
  const version=process.env.NEXT_PUBLIC_EDITOR_VERSION,editorModule='/workspace.js'+(version?'?v='+version:'');
  import(/* webpackIgnore: true */ editorModule).then(module=>{
   if(lifetime.signal.aborted)return;
   return module.mountWorkspace({app:root.current,modal:modal.current,signal:lifetime.signal,
    renderChrome:next=>{if(lifetime.signal.aborted)return null;flushSync(()=>setModel(next));return{sidebar:root.current.querySelector('.workspace-sidebar'),mainPanel:root.current.querySelector('.workspace-main'),navButton:root.current.querySelector('.nav-toggle'),scroll:content.current};},
    updateToolbar:next=>{const signature=JSON.stringify(next);if(!lifetime.signal.aborted&&signature!==lastControls.current){lastControls.current=signature;flushSync(()=>setControls(next));}}
   });
  }).catch(error=>{if(!lifetime.signal.aborted){console.error('Workspace could not start',error);setFailed(true);}});
  return()=>lifetime.abort();
 },[]);
 return <><a className="skip-link" href="#workspace-document">本文に移動</a><motion.div id="workspace-app" ref={root} initial={false} animate={model?{gridTemplateColumns:desktop?(sidebarCollapsed?'0px minmax(0,1fr)':'256px minmax(0,1fr)'):'minmax(0,1fr)'}:undefined} transition={surfaceTransition('sidebar',reduced)} className={'workspace-shell motion-workspace'+(model?.state.navOpen?' nav-open':'')+(model?.selectionMode?' block-selection-mode':'')+(sidebarCollapsed?' sidebar-collapsed':'')}>
  {model?<><Sidebar model={model} onCollapse={collapseSidebar} desktop={desktop} collapsed={sidebarCollapsed}/><button type="button" className="nav-scrim" aria-label={model.t('closeMenu')} tabIndex={-1} onClick={()=>model.handlers.setNavigation(false)}/><main className="workspace-main"><Toolbar model={model} controls={controls} sidebarCollapsed={sidebarCollapsed} onExpandSidebar={expandSidebar}/><div className="workspace-scroll" data-locale-notice-host="" ref={content}/></main><p id="block-dnd-instructions" className="sr-only">{model.t('blockDnd.instructions')}</p><p id="block-dnd-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true"/></>:<><aside className="workspace-sidebar workspace-loading-nav"><div className="workspace-brand"><Icon name="notebook"/>Yumunio</div></aside><main className="workspace-main"><p className="startup" role={failed?'alert':'status'}>{failed?'画面を読み込めませんでした。再読み込みしてください。':'ワークスペースを確認しています…'}</p></main></>}
 </motion.div><MotionDialog id="workspace-modal" ref={modal} aria-labelledby="workspace-modal-heading"/><noscript>この画面を利用するには JavaScript を有効にしてください。</noscript></>;
}
