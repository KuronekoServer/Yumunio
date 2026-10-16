import {inlineDomFixture} from './inline-dom.js';

// Test-local DOM contracts only: no browser layout or native dialog behavior.
export function settingsDomFixture(t){
 const f=inlineDomFixture(t),doc=f.document,create=doc.createElement.bind(doc),listeners=new Map();
 const visit=root=>[root,...(root.childNodes??[]).flatMap(visit)];
 const matches=(element,selector)=>{
  if(element.nodeType!==1)return false;
  selector=selector.trim();if(selector==='[inert]')return element.inert===true;
  if(selector.includes(':checked')&&!element.checked)return false;
  if(selector.includes(':not([disabled])')&&element.disabled)return false;
  selector=selector.replace(':checked','').replace(':not([disabled])','');
  const tag=selector.match(/^[a-z]+/i)?.[0];if(tag&&element.nodeName.toLowerCase()!==tag.toLowerCase())return false;
  const id=selector.match(/#([\w-]+)/)?.[1];if(id&&element.getAttribute('id')!==id)return false;
  const cls=selector.match(/\.([\w-]+)/)?.[1];if(cls&&!element.className?.split(' ').includes(cls))return false;
  for(const [,key,value]of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)){const actual=element.getAttribute(key);if(actual===null||value!==undefined&&actual!==value)return false;}
  return true;
 };
 doc.createElement=tag=>{
  const element=create(tag);element.className='';element.style={setProperty(key,value){this[key]=value;}};element.dataset={};element.value='';element.checked=false;
  element.classList={add(...names){element.className=[...new Set([...element.className.split(' ').filter(Boolean),...names])].join(' ');},remove(...names){element.className=element.className.split(' ').filter(name=>!names.includes(name)).join(' ');},contains:name=>element.className.split(' ').includes(name)};
  const set=element.setAttribute.bind(element);element.setAttribute=(key,value)=>{set(key,value);if(key==='class')element.className=String(value);if(key==='id')element.id=String(value);if(key.startsWith('data-'))element.dataset[key.slice(5).replace(/-([a-z])/g,(_,char)=>char.toUpperCase())]=String(value);};
  element.querySelectorAll=selector=>visit(element).slice(1).filter(item=>selector.split(',').some(part=>matches(item,part)));
  element.querySelector=selector=>element.querySelectorAll(selector)[0]??null;
  element.closest=selector=>{let item=element;while(item){if(matches(item,selector))return item;item=item.parentElement;}return null;};
  element.insertBefore=(child,before)=>{child.remove?.();const at=element.childNodes.indexOf(before);child.parentElement=element;element.childNodes.splice(at<0?element.childNodes.length:at,0,child);};
  element.remove=()=>{if(element.parentElement){const parent=element.parentElement;parent.childNodes=parent.childNodes.filter(item=>item!==element);element.parentElement=null;}};
  element.removeEventListener=(name,fn)=>element.listeners.set(name,(element.listeners.get(name)??[]).filter(item=>item!==fn));
  element.getClientRects=()=>element.hidden?[]:[{}];element.reportValidity=()=>true;
  Object.defineProperty(element,'href',{get:()=>new URL(element.getAttribute('href')??'',location.href).href,set:value=>element.setAttribute('href',value)});
  Object.defineProperty(element,'isConnected',{get:()=>element===doc.documentElement||!!element.parentElement?.isConnected,configurable:true});
  if(tag==='dialog'){element.open=false;element.showModal=()=>{element.open=true;};element.close=()=>{element.open=false;};}
  return element;
 };
 doc.createElementNS=(namespace,tag)=>{const element=doc.createElement(tag);element.namespaceURI=namespace;return element;};
 doc.documentElement=doc.createElement('html');doc.head=doc.createElement('head');doc.body=doc.createElement('body');doc.documentElement.append(doc.head,doc.body);doc.body.style.overflow='auto';
 doc.querySelectorAll=selector=>doc.documentElement.querySelectorAll(selector);doc.querySelector=selector=>doc.querySelectorAll(selector)[0]??null;doc.getElementById=id=>doc.querySelector('#'+id);
 doc.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);};doc.removeEventListener=(name,fn)=>listeners.get(name)?.delete(fn);
 const view={addEventListener:(name,fn)=>doc.addEventListener('window:'+name,fn),removeEventListener:(name,fn)=>doc.removeEventListener('window:'+name,fn)};doc.defaultView=view;
 const media={matches:false,addEventListener:(name,fn)=>doc.addEventListener('media:'+name,fn),removeEventListener:(name,fn)=>doc.removeEventListener('media:'+name,fn)};
 const previous=new Map(['location','window','matchMedia','fetch','localStorage','Node'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 Object.defineProperties(globalThis,{location:{value:{href:'https://local.invalid/workspace.html?workspace=studio'},configurable:true},window:{value:view,configurable:true},matchMedia:{value:()=>media,configurable:true},Node:{value:class{static[Symbol.hasInstance](value){return value?.nodeType===1||value?.nodeType===3;}},configurable:true}});
 t.after(()=>{for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 const background=doc.createElement('main'),editor=doc.createElement('div'),trigger=doc.createElement('button');editor.textContent='Unchanged body draft';background.append(editor,trigger);doc.body.append(background);trigger.focus();
 return{...f,doc,background,editor,trigger,listeners,keydown(properties){const event={prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){},...properties};for(const fn of listeners.get('keydown')??[])fn(event);return event;}};
}
