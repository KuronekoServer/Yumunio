import {createLayoutResize} from './layout-resize.js';

const MIN=320,MAX=1100,DEFAULT=620;
export function recordPanelSizeRange(viewport,sidebar=0){
 const width=Number.isFinite(viewport)&&viewport>0?viewport:1280;
 return{min:Math.min(MIN,width),max:Math.max(Math.min(MIN,width),Math.min(MAX,width-(width>=1100?Math.max(0,sidebar)+360:64)))};
}
export function clampRecordPanelSize(value,viewport,sidebar=0){const {min,max}=recordPanelSizeRange(viewport,sidebar);return Math.round(Math.max(min,Math.min(max,Number.isFinite(value)?value:DEFAULT)));}
export function readRecordPanelSize(storage,key){try{const text=storage.getItem(key);if(!text||text.length>128)return DEFAULT;const value=JSON.parse(text);return value?.version===1&&Number.isFinite(value.width)?Math.max(MIN,Math.min(MAX,value.width)):DEFAULT;}catch{return DEFAULT;}}

/** Resize chrome only: the iframe, its selection and its undo history stay mounted. */
export function mountRecordPanelSize({document,host,model}){
 const win=document.defaultView;if(!win?.addEventListener)return{destroy(){}};
 const life=new AbortController(),key=model.workspaceId&&model.accountId?'yumunio.record-panel-size.v1:'+model.workspaceId+':'+model.accountId:null;
 let storage;try{storage=win.localStorage;}catch{}
 let preferred=key?readRecordPanelSize(storage,key):DEFAULT;
 const sidebar=()=>{const node=document.querySelector('.workspace-sidebar');return node?.getBoundingClientRect?.().width??0;};
 const viewport=()=>win.innerWidth;
 const clamp=value=>clampRecordPanelSize(value,viewport(),sidebar());
 const handle=document.createElement('div');handle.className='record-panel-size-handle';handle.tabIndex=0;
 host.id='record-detail-panel';handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-controls',host.id);handle.setAttribute('aria-label',model.resizeLabel);handle.title=model.resizeKeys;
 const paint=value=>{const width=viewport()<=760?viewport():clamp(value),range=recordPanelSizeRange(viewport(),sidebar());document.body.style.setProperty('--record-panel-width',width+'px');host.style.setProperty('--record-panel-width',width+'px');handle.setAttribute('aria-valuemin',String(range.min));handle.setAttribute('aria-valuemax',String(range.max));handle.setAttribute('aria-valuenow',String(width));handle.setAttribute('aria-valuetext',model.resizeValue?.(width)??String(width));};
 const save=value=>{preferred=value;try{if(key)storage?.setItem(key,JSON.stringify({version:1,width:value}));}catch{}};
 host.append(handle);
 const control=createLayoutResize({handle,read:()=>preferred,canStart:()=>host.isConnected&&!host.inert&&viewport()>760,
  project:({initial,phase,x,geometry,key,shift})=>phase==='start'?{x,width:clamp(initial)}:phase==='move'?clamp(geometry.width+geometry.x-x):clamp(key==='Home'?MIN:key==='End'?MAX:clamp(initial)+(key==='ArrowLeft'?1:-1)*(shift?32:8)),
  preview:paint,commit:save,reset:()=>clamp(DEFAULT),onActive:value=>document.body.classList.toggle('record-panel-resizing',value)
 });
 const repaint=()=>{control.cancel();paint(preferred);};win.addEventListener('resize',repaint,{signal:life.signal});
 const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(()=>{if(!control.active)paint(preferred);}):null;const shell=document.querySelector('.workspace-sidebar');if(shell)observer?.observe(shell);
 return{handle,destroy(){control.destroy();life.abort();observer?.disconnect();document.body.classList.remove('record-panel-resizing');document.body.style.removeProperty('--record-panel-width');handle.remove();}};
}
