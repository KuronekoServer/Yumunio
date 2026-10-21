'use client';
import {useEffect,useRef,useState} from 'react';
import {SIDEBAR_SIZE,clampSidebarSize,sidebarSizeRange,readSidebarSize,writeSidebarSize,createSidebarResize} from '../public/sidebar-resize.js';
import {Tooltip,TooltipTrigger,TooltipContent} from './components/ui/tooltip.jsx';

export function useSidebarSize({root,workspaceId,userId,desktop,collapsed,onCollapse}){
 const handle=useRef(null),preferred=useRef(SIDEBAR_SIZE.default),current=useRef(SIDEBAR_SIZE.default),controller=useRef(null);
 const [width,setWidth]=useState(SIDEBAR_SIZE.default),[max,setMax]=useState(SIDEBAR_SIZE.max),[resizing,setResizing]=useState(false);
 const key=workspaceId&&userId?'yumunio.sidebar-size.v1:'+workspaceId+':'+userId:null;
 useEffect(()=>{
  let saved=SIDEBAR_SIZE.default;try{if(key)saved=readSidebarSize(localStorage,key);}catch{}
  preferred.current=saved;
  const update=()=>{controller.current?.cancel();const viewport=root.current?.clientWidth||innerWidth;current.current=clampSidebarSize(preferred.current,viewport);setWidth(current.current);setMax(sidebarSizeRange(viewport).max);};
  update();window.addEventListener('resize',update);return()=>window.removeEventListener('resize',update);
 },[key,root]);
 useEffect(()=>{
  if(!workspaceId||!desktop||collapsed||!handle.current)return;
  const resize=createSidebarResize({handle:handle.current,read:()=>current.current,viewport:()=>root.current?.clientWidth||innerWidth,
   preview:next=>{current.current=next;setWidth(next);},commit:next=>{preferred.current=next;try{if(key)writeSidebarSize(localStorage,key,next);}catch{}},toggle:onCollapse,onActive:setResizing});
  controller.current=resize;return()=>{resize.destroy();controller.current=null;};
 },[key,workspaceId,desktop,collapsed,onCollapse,root]);
 return{handle,width,max,resizing};
}

export function SidebarSizeHandle({sizing,t}){
 return <Tooltip><TooltipTrigger asChild><div ref={sizing.handle} className="sidebar-size-handle" role="separator" tabIndex={0} aria-label={t('pages')} aria-orientation="vertical" aria-controls="workspace-sidebar" aria-valuemin={SIDEBAR_SIZE.min} aria-valuemax={sizing.max} aria-valuenow={sizing.width} aria-valuetext={t('sidebarSize.value',{width:sizing.width})} aria-describedby="sidebar-size-instructions"/></TooltipTrigger><TooltipContent side="right">{t('sidebarSize.hint')}</TooltipContent><span id="sidebar-size-instructions" className="sr-only">{t('sidebarSize.keys')}</span></Tooltip>;
}
