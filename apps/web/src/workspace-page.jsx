'use client';
import {memo,useCallback,useEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {Icon} from './icons.jsx';

function Action({label,icon,onClick,disabled=false,className='',children,...props}){
 return <button type="button" className={className||'icon-button'} aria-label={label} title={label} disabled={!!disabled} onClick={onClick} {...props}>{icon&&<Icon name={icon}/>} {children}</button>;
}
const Sidebar=memo(function Sidebar({model,onCollapse}){
 const {state:s,t,handlers:h,workspaceId,pageRows,activeTeams,collapsedTeams,expandedPages,newDisabled}=model;
 const query='?workspace='+encodeURIComponent(workspaceId),disabled=!s.user||!!s.fatal||s.busy;
 const sections=[];
 const section=(key,label,team=null)=>{let value=sections.find(item=>item.key===key);if(!value){value={key,label,team,rows:[]};sections.push(value);}return value;};
 if(s.teamsAvailable){section('personal',t('teamspaces.personalPages'));for(const team of activeTeams)section('team:'+team.id,team.name,team);}
 for(const row of pageRows){const page=row.page,team=page.teamspaceId&&activeTeams.find(item=>item.id===page.teamspaceId),key=team?'team:'+team.id:page.sidebarSection==='personal'?'personal':page.sidebarSection==='shared'||page.sidebarSection==='teamspace'?'shared':'legacy';section(key,t(key==='personal'?'teamspaces.personalPages':key==='shared'?'teamspaces.sharedPages':'pages'),team||null).rows.push(row);}
 function pageRow({page,depth,hasChildren}){
  const expanded=expandedPages.includes(page.id);
  return <li key={page.id} className="sidebar-page-row" style={{paddingInlineStart:depth*14}}>
   {hasChildren?<Action className="sidebar-page-disclosure" label={t(expanded?'sidebarCollapse':'sidebarExpand',{name:page.title||t('untitled')})} aria-expanded={expanded} onClick={()=>h.togglePage(page.id)}><Icon name="chevron" className={expanded?'chevron expanded':'chevron'}/></Action>:<span className="sidebar-page-spacer" aria-hidden="true"/>}
   <a href={'/workspace'+query+'&page='+encodeURIComponent(page.id)} className={'page-link'+((s.pendingPageId||s.current?.page.id)===page.id?' selected':'')} aria-current={(s.pendingPageId||s.current?.page.id)===page.id?'page':undefined} aria-disabled={s.busy||undefined}
    data-dnd-page-id={!model.room&&page.id!==s.current?.page.id&&page.capabilities.includes('editBody')?page.id:undefined}
    draggable={!model.room&&s.role!=='guest'&&page.capabilities.includes('manage')&&!page.recordId&&!s.busy}
    onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();if(!s.busy)void h.selectPage(page.id);}} onPointerEnter={()=>h.prefetchPage(page.id)} onPointerLeave={h.cancelPagePrefetch} onFocus={()=>h.prefetchPage(page.id)} onDragStart={event=>h.startPageDrag(event,page)} onDragEnd={h.endPageDrag} onDragOver={event=>h.overPageDrop(event,page.id)} onDragLeave={event=>event.currentTarget.classList.remove('drop-target')} onDrop={event=>h.dropPage(event,page.id)}>
    {page.appearance?.icon?<span aria-hidden="true" translate="no">{page.appearance.icon}</span>:<Icon name={page.collectionId?'table':'page'}/>}<span translate="no" data-sidebar-page-title="">{page.title||t('untitled')}</span>
   </a>
  </li>;
 }
 const favorites=s.pages.filter(page=>page.favorite);
 return <aside id="workspace-sidebar" className="workspace-sidebar" aria-label={t('pages')}>
  <div className="workspace-brand"><button type="button" className="workspace-switcher" aria-label={t('workspacePicker.title')} disabled={disabled} onClick={h.openWorkspacePicker}><img data-instance-logo="" alt="" width="22" height="22" hidden/><Icon name="notebook" data-instance-default-logo=""/><span translate="no">{s.name||'Yumunio'}</span><span aria-hidden="true">⌄</span></button><Action label={t('collapseSidebar')} icon="sidebar" className="desktop-sidebar-toggle icon-button" onClick={onCollapse}/><Action label={t('closeMenu')} icon="close" className="mobile-close icon-button" onClick={()=>h.setNavigation(false)}/></div>
  <nav className="workspace-links" aria-label={t('pages')}>
   <Action className="nav-link sidebar-search" label={t('sidebarSearch')} icon="search" onClick={h.openSearch} disabled={disabled}><span>{t('sidebarSearch')}</span><kbd>Ctrl K</kbd></Action>
   <Action className="nav-link" label={t('sidebarHome')} icon="home" onClick={h.openWorkspaceHome} disabled={disabled}>{t('sidebarHome')}</Action>
   {s.user&&!s.fatal&&<a href={'/comments'+query} className="nav-link"><Icon name="inbox"/>{t('sidebarInbox')}</a>}
   <details className="sidebar-library"><summary><Icon name="template"/>{t('sidebarLibrary')}</summary><div className="sidebar-library-links"><a href={'/collections'+query} className="nav-link"><Icon name="table"/>{t('collections')}</a><a href={'/forms'+query} className="nav-link"><Icon name="page"/>{t('forms')}</a>{s.role&&s.role!=='guest'&&<a href={'/templates'+query} className="nav-link"><Icon name="template"/>{t('personalTemplates')}</a>}</div></details>
  </nav>
  <div className="page-list-heading"><span>{t('pages')}</span><Action label={t('refreshList')} icon="refresh" disabled={!s.user||s.busy||s.listLoading||!!s.fatal} onClick={()=>h.refreshList(true)}/><Action label={t('createPage')} icon="plus" disabled={newDisabled} onClick={()=>h.openCreate()}/></div>
  <button type="button" className="root-drop-target" onDragOver={event=>h.overPageDrop(event,null)} onDragLeave={event=>event.currentTarget.classList.remove('drop-target')} onDrop={event=>h.dropPage(event,null)}>{t('moveToRoot')}</button>
  <div className="page-list page-directory">
   {!!favorites.length&&<section className="sidebar-page-section"><div className="page-list-heading"><span>{t('pageTools.favorites')}</span></div><ul className="sidebar-section-pages">{favorites.map(page=><li key={page.id}><button type="button" className="page-link" disabled={s.busy} onClick={()=>h.selectPage(page.id)}><span aria-hidden="true" translate="no">{page.appearance?.icon||'☆'}</span><span translate="no">{page.title||t('untitled')}</span></button></li>)}</ul></section>}
   {sections.map(({key,label,team,rows})=><section key={key} className="sidebar-page-section">
    <div className="page-list-heading">{team?<button type="button" className="teamspace-disclosure" aria-expanded={!collapsedTeams.includes(team.id)} onClick={()=>h.toggleTeam(team.id)}><Icon name="chevron" className={!collapsedTeams.includes(team.id)?'chevron expanded':'chevron'}/><span translate="no">{label}</span></button>:<span>{label}</span>}
     {team&&<>{team.capabilities.includes('createPage')&&<Action label={t('createPage')} icon="plus" disabled={newDisabled} onClick={()=>h.openCreate(team.id)}/>}<Action label={t('teamspaces.settings')+' · '+team.name} icon="more" disabled={s.busy} onClick={()=>h.openSettings('teamspaces',team.id)}/></>}
     {!team&&s.teamsAvailable&&key==='personal'&&<Action label={t('teamspaces.browse')} icon="more" disabled={disabled} onClick={()=>h.openSettings('teamspaces')}/>}
    </div><ul className="sidebar-section-pages" hidden={!!team&&collapsedTeams.includes(team.id)}>{rows.map(pageRow)}</ul>
   </section>)}
  </div>
  <footer className="sidebar-footer">
   {s.user&&!s.fatal&&<a href={'/workspace-settings'+query} className="nav-link"><Icon name="settings"/>{t('sidebarSettings')}</a>}
   <details className="sidebar-library sidebar-tools"><summary><Icon name="more"/>{t('sidebarTools')}</summary><div className="sidebar-library-links">
    {s.user&&!s.fatal&&<Action className="nav-link" label={t('sidebarInvite')} icon="users" onClick={()=>h.openSettings('members')} disabled={s.busy}>{t('sidebarInvite')}</Action>}
    <Action className="nav-link" label={t('trashPages')} icon="trash" onClick={h.openTrash} disabled={disabled}>{t('trashPages')}</Action><Action className="nav-link" label={t('exportWorkspace')} icon="download" onClick={h.openExport} disabled={disabled}>{t('exportWorkspace')}</Action>
    {s.user&&!s.fatal&&s.role&&s.role!=='guest'&&<a href={'/workspace-settings'+query+'&section=import'} className="nav-link"><Icon name="plus"/>{t('importContent')}</a>}
    <a href="/notes" className="nav-link"><Icon name="arrow"/>{t('deviceNotes')}</a><a href={'/integrations'+query+(s.current?'&page='+encodeURIComponent(s.current.page.id):'')} className="nav-link">{t('integrations')}</a><a href="/install" className="nav-link">{t('installApp')}</a><a href="/LICENSE.txt" className="license-link">{t('footerLicense')}</a>
   </div></details>
   <button type="button" className="profile-link" disabled={!s.user||s.busy} onClick={h.openWorkspacePicker}><span className="profile-symbol" aria-hidden="true">{Array.from(s.user?.name||'Y')[0]}</span><span translate="no">{s.user?.name||t('account')}</span></button>
  </footer>
 </aside>;
});
function Toolbar({model,controls,sidebarCollapsed,onExpandSidebar}){
 const {state:s,t,handlers:h,workspaceId}=model;
 return <header className="workspace-topbar">{sidebarCollapsed&&<Action className="desktop-sidebar-toggle icon-button" label={t('expandSidebar')} icon="sidebar" aria-expanded={false} aria-controls="workspace-sidebar" onClick={onExpandSidebar}/>}<Action className="nav-toggle icon-button" label={t('menu')} icon="menu" aria-expanded={s.navOpen} aria-controls="workspace-sidebar" onClick={()=>h.setNavigation(!s.navOpen)}/>
  <div className="breadcrumb"><span translate="no">{s.name||t('serverWorkspace')}</span>{(s.current||s.pendingPageId)&&<><span className="breadcrumb-divider" aria-hidden="true">/</span><span translate="no" data-page-crumb="">{controls.title??s.draft?.title??t('untitled')}</span></>}</div>
  <div className="topbar-actions"><span className="save-status" role="status" aria-live="polite">{controls.status||''}</span><Action label={t('undo')} icon="undo" disabled={controls.undoDisabled!==false} onClick={()=>h.applyEditorHistory('undo')}/><Action label={t('redo')} icon="redo" disabled={controls.redoDisabled!==false} onClick={()=>h.applyEditorHistory('redo')}/>
   {s.current&&!model.room&&<Action label={t('roomStart')} icon="users" disabled={s.busy||s.loading||s.listLoading} onClick={h.showRoomStart}/>}
   <Action className="button quiet" label={t('shareResource')} disabled={!s.current?.page.capabilities?.some(value=>['manage','invite'].includes(value))||s.busy||s.loading} onClick={h.openResourceSharing}>{t('shareResource')}</Action>
   {s.current?.page.capabilities?.includes('read')&&<a href={'/backlinks?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(s.current.page.id)} className="button toolbar-backlinks">{t('backlinks')}</a>}
   {s.current&&<Action label={t(s.current.page.favorite?'pageTools.removeFavorite':'pageTools.addFavorite')} icon="star" aria-pressed={!!s.current.page.favorite} className="icon-button toolbar-favorite" disabled={!!model.room||s.busy||s.loading||s.locked||s.collection?.dirty} onClick={h.toggleFavorite}/>}
   <Action label={t('pageActions')} icon="more" disabled={!s.current||s.busy||s.loading} onClick={h.openPageActions}/><Action label={t('reload')} icon="refresh" disabled={!s.current||s.busy||s.loading} onClick={h.reloadPage}/><Action className="button toolbar-save" label={t('save')} disabled={controls.saveDisabled!==false} onClick={h.savePage}>{t('save')}</Action>
  </div>
 </header>;
}

/** The editor engine owns the content host; React owns navigation, toolbar and route lifecycle. */
export function WorkspacePage(){
 const root=useRef(null),modal=useRef(null),content=useRef(null),lastControls=useRef(''),[model,setModel]=useState(null),[controls,setControls]=useState({}),[failed,setFailed]=useState(false),[sidebarCollapsed,setSidebarCollapsed]=useState(false);
 const collapseSidebar=useCallback(()=>setSidebarCollapsed(true),[]),expandSidebar=useCallback(()=>setSidebarCollapsed(false),[]);
 useEffect(()=>{
  const lifetime=new AbortController();
  import(/* webpackIgnore: true */ '/workspace.js').then(module=>{
   if(lifetime.signal.aborted)return;
   return module.mountWorkspace({app:root.current,modal:modal.current,signal:lifetime.signal,
    renderChrome:next=>{if(lifetime.signal.aborted)return null;flushSync(()=>setModel(next));return{sidebar:root.current.querySelector('.workspace-sidebar'),mainPanel:root.current.querySelector('.workspace-main'),navButton:root.current.querySelector('.nav-toggle'),scroll:content.current};},
    updateToolbar:next=>{const signature=JSON.stringify(next);if(!lifetime.signal.aborted&&signature!==lastControls.current){lastControls.current=signature;flushSync(()=>setControls(next));}}
   });
  }).catch(error=>{if(!lifetime.signal.aborted){console.error('Workspace could not start',error);setFailed(true);}});
  return()=>lifetime.abort();
 },[]);
 return <><a className="skip-link" href="#workspace-document">本文に移動</a><div id="workspace-app" ref={root} className={'workspace-shell'+(model?.state.navOpen?' nav-open':'')+(model?.selectionMode?' block-selection-mode':'')+(sidebarCollapsed?' sidebar-collapsed':'')}>
  {model?<><Sidebar model={model} onCollapse={collapseSidebar}/><button type="button" className="nav-scrim" aria-label={model.t('closeMenu')} tabIndex={-1} onClick={()=>model.handlers.setNavigation(false)}/><main className="workspace-main"><Toolbar model={model} controls={controls} sidebarCollapsed={sidebarCollapsed} onExpandSidebar={expandSidebar}/><div className="workspace-scroll" data-locale-notice-host="" ref={content}/></main><p id="block-dnd-instructions" className="sr-only">{model.t('blockDnd.instructions')}</p><p id="block-dnd-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true"/></>:<><aside className="workspace-sidebar workspace-loading-nav"><div className="workspace-brand"><Icon name="notebook"/>Yumunio</div></aside><main className="workspace-main"><p className="startup" role={failed?'alert':'status'}>{failed?'画面を読み込めませんでした。再読み込みしてください。':'ワークスペースを確認しています…'}</p></main></>}
 </div><dialog id="workspace-modal" ref={modal} aria-labelledby="workspace-modal-heading"/><noscript>この画面を利用するには JavaScript を有効にしてください。</noscript></>;
}
