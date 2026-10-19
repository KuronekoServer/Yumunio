import {WorkspaceDirectory,validWorkspaceDirectoryId} from './workspace-directory.js';

/** Native, mounted popup. Navigation is always delegated to the editor's draft guard. */
export function mountWorkspacePicker({document=globalThis.document,background,workspaceId,expectedAccountId,labels=key=>key,onNavigate,onClose,fetcher=globalThis.fetch,directory}={}){
 if(!document?.createElement||!background||!validWorkspaceDirectoryId(workspaceId)||!validWorkspaceDirectoryId(expectedAccountId)||typeof onNavigate!=='function')throw new TypeError('INVALID_WORKSPACE_PICKER');
 if([...document.querySelectorAll('dialog')].some(item=>item.open))throw new TypeError('WORKSPACE_PICKER_MODAL_OPEN');
 const client=directory??new WorkspaceDirectory({accountId:expectedAccountId,fetcher});
 const node=(tag,attributes={},children=[])=>{const result=document.createElement(tag);for(const[key,value]of Object.entries(attributes)){if(value===null||value===undefined||value===false)continue;if(key==='class')result.className=value;else if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);else if(['disabled','required','value'].includes(key))result[key]=value;else result.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(typeof child==='string'?document.createTextNode(child):child);return result;};
 const view=document.defaultView??globalThis.window,priorFocus=document.activeElement,priorInert=background.inert,priorOverflow=document.body.style.overflow;
 const selection=document.getSelection?.(),savedSelection=selection?.rangeCount?{anchor:selection.anchorNode,anchorOffset:selection.anchorOffset,focus:selection.focusNode,focusOffset:selection.focusOffset}:null;
 let destroyed=false,generation=0,loading=false,busy=false,composing=false,creating=false,error='',notice='',guard=null,model=null;
 const draft={name:'',slug:''},dirty=()=>draft.name!==''||draft.slug!=='';
 const dialog=node('dialog',{class:'workspace-picker','aria-labelledby':'workspace-picker-title'}),main=node('div',{class:'workspace-picker-content'});
 const close=node('button',{type:'button',class:'workspace-picker-close','aria-label':labels('close'),onClick:()=>requestClose()},'\u00d7');
 dialog.append(node('header',{class:'workspace-picker-header'},[node('h2',{id:'workspace-picker-title'},labels('title')),close]),main);
 background.inert=true;document.body.style.overflow='hidden';document.body.append(dialog);
 const unavailable=code=>({ACCOUNT_CHANGED:'accountChanged',ACCOUNT_UNAVAILABLE:'accountChanged',INVALID_CONTEXT:'unavailable',INVALID_RESPONSE:'invalidResponse',INVALID_NAME:'invalidName',INVALID_SLUG:'invalidSlug',RATE_LIMITED:'rateLimited',CREATE_UNCONFIRMED:'createUnconfirmed',WORKSPACE_UNAVAILABLE:'workspaceUnavailable'})[code]??'unavailable';
 const button=(key,handler,attributes={})=>node('button',{type:'button',onClick:handler,...attributes},labels(key));
 function clearGuard(){guard?.remove();guard=null;}
 function guardTransition(action){
  if(destroyed||busy||composing)return false;
  if(dirty()){
   clearGuard();const before=document.activeElement;
   const keep=button('keepEditing',()=>{clearGuard();before?.focus?.();});
   guard=node('section',{class:'workspace-picker-discard',role:'alertdialog','aria-label':labels('discardTitle')},[node('strong',{},labels('discardTitle')),node('p',{},labels('discardMessage')),node('div',{},[keep,button('discard',()=>{draft.name='';draft.slug='';creating=false;clearGuard();action();})])]);
   dialog.insertBefore(guard,main);keep.focus();return false;
  }
  action();return true;
 }
 function finish({restoreFocus=true}={}){
  if(destroyed)return;destroyed=true;generation++;client.destroy();clearGuard();
  if(dialog.open)dialog.close();dialog.remove();document.removeEventListener('keydown',keydown,true);view?.removeEventListener('beforeunload',beforeUnload);
  background.inert=priorInert;document.body.style.overflow=priorOverflow;onClose?.();
  if(restoreFocus&&priorFocus?.isConnected!==false){try{if(savedSelection?.anchor?.isConnected!==false&&savedSelection?.focus?.isConnected!==false)document.getSelection?.()?.setBaseAndExtent?.(savedSelection.anchor,savedSelection.anchorOffset,savedSelection.focus,savedSelection.focusOffset);}catch{}priorFocus?.focus?.({preventScroll:true});}
 }
 function requestClose(){return guardTransition(()=>finish());}
 async function navigate(href){
  if(destroyed||busy||loading)return;
  busy=true;render();
  try{if(await onNavigate(href)!==false&&!destroyed)finish({restoreFocus:false});}
  catch{if(!destroyed){error='unavailable';render();}}
  finally{if(!destroyed){busy=false;render();close.focus();}}
 }
 const requestNavigate=href=>guardTransition(()=>void navigate(href));
 async function load(){
  if(destroyed||busy||loading)return;const marker=++generation;loading=true;error='';model=null;render();
  try{const value=await client.load();if(destroyed||marker!==generation)return;if(!value.workspaces.some(item=>item.id===workspaceId))throw Object.assign(new Error(),{code:'WORKSPACE_UNAVAILABLE'});model=value;}
  catch(failure){if(!destroyed&&marker===generation){model=null;error=unavailable(failure.code);}}
  finally{if(!destroyed&&marker===generation){loading=false;render();}}
 }
 async function create(){
  if(destroyed||busy||loading||client.creationUncertain||!model)return;
  const marker=++generation;busy=true;error='';notice='';render();
  try{
   const workspace=await client.create({...draft});if(destroyed||marker!==generation)return;
   model={...model,workspaces:[...model.workspaces.filter(item=>item.id!==workspace.id),workspace]};draft.name='';draft.slug='';creating=false;notice='created';
   busy=false;await navigate('/workspace?workspace='+encodeURIComponent(workspace.id));
  }catch(failure){if(!destroyed&&marker===generation){error=unavailable(failure.code);if(['ACCOUNT_CHANGED','ACCOUNT_UNAVAILABLE','CREATE_UNCONFIRMED'].includes(failure.code))model=null;}}
  finally{if(!destroyed&&marker===generation){busy=false;render();const input=error==='invalidName'?'#workspace-picker-name':error==='invalidSlug'?'#workspace-picker-slug':null;if(input)main.querySelector(input)?.focus();else close.focus();}}
 }
 function render(){
  if(destroyed)return;const focusedId=main.contains(document.activeElement)?document.activeElement?.id:null;main.replaceChildren();close.disabled=busy;
  if(loading)main.append(node('p',{role:'status'},labels('loading')));
  if(error)main.append(node('p',{class:'workspace-picker-message',role:'alert'},labels(error)));
  if(notice)main.append(node('p',{class:'workspace-picker-message',role:'status'},labels(notice)));
  if(model){
   const list=node('ul',{class:'workspace-picker-list','aria-label':labels('workspaces')});
   for(const item of model.workspaces){const current=item.id===workspaceId;list.append(node('li',{},node('button',{type:'button',class:'workspace-picker-option',disabled:busy||loading,...(current?{'aria-current':'true'}:{}),onClick:()=>{if(current)requestClose();else requestNavigate('/workspace?workspace='+encodeURIComponent(item.id));}},[node('span',{class:'workspace-picker-symbol','aria-hidden':'true'},Array.from(item.name)[0]),node('span',{class:'workspace-picker-name',translate:'no'},item.name),...(current?[node('span',{class:'workspace-picker-current'},labels('current'))]:[])])));}
   main.append(list);
   if(creating){
    const name=node('input',{id:'workspace-picker-name',name:'name',type:'text',autocomplete:'off',required:true,maxlength:'100',value:draft.name,disabled:busy||client.creationUncertain,onInput:event=>{draft.name=event.target.value;}});
    const slug=node('input',{id:'workspace-picker-slug',name:'slug',type:'text',autocomplete:'off',autocapitalize:'none',spellcheck:'false',required:true,maxlength:'100',pattern:'[a-z0-9]+(?:-[a-z0-9]+)*',value:draft.slug,disabled:busy||client.creationUncertain,onInput:event=>{draft.slug=event.target.value;}});
    const form=node('form',{class:'workspace-picker-form'},[node('h3',{},labels('createTitle')),node('p',{},labels('createHint')),node('label',{for:'workspace-picker-name'},[labels('name'),name]),node('label',{for:'workspace-picker-slug'},[labels('slug'),slug]),node('p',{class:'workspace-picker-hint'},labels('slugHint')),node('div',{class:'workspace-picker-actions'},[button('cancel',()=>guardTransition(()=>{creating=false;render();close.focus();}),{disabled:busy}),node('button',{type:'submit',disabled:busy||client.creationUncertain},labels(busy?'working':'create'))])]);
    form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity()||composing)return;void create();});main.append(form);
   }else main.append(button('create',()=>{if(busy)return;creating=true;render();main.querySelector('#workspace-picker-name')?.focus();},{class:'workspace-picker-create',disabled:busy||client.creationUncertain}));
  }
  if(!loading&&!model&&!client.creationUncertain)main.append(button('reload',()=>void load(),{disabled:busy}));
  main.append(node('nav',{class:'workspace-picker-footer','aria-label':labels('account')},[
   node('a',{href:'/account#account',onClick:event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();requestNavigate('/account#account');}},labels('account')),
   ...(model?[node('a',{href:'/share?workspace='+encodeURIComponent(workspaceId),onClick:event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();requestNavigate('/share?workspace='+encodeURIComponent(workspaceId));}},labels('manage'))]:[])
  ]));
  if(focusedId)main.querySelector('#'+focusedId)?.focus({preventScroll:true});
 }
 const beforeUnload=event=>{if(!destroyed&&(busy||dirty())){event.preventDefault();event.returnValue='';}};
 const focusable=()=>[...(guard??dialog).querySelectorAll('a[href],button,input,[tabindex]')].filter(item=>!item.disabled&&!item.hidden&&item.getAttribute('tabindex')!=='-1'&&item.getClientRects?.().length!==0);
 function keydown(event){
  if(destroyed||event.isComposing||event.keyCode===229||composing)return;
  const focusedDialog=event.target?.closest?.('dialog')??document.activeElement?.closest?.('dialog');
  const nested=[...dialog.querySelectorAll('dialog')].some(item=>item.open);if(nested||focusedDialog?.open&&focusedDialog!==dialog)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(guard){clearGuard();close.focus();}else requestClose();return;}
  if(event.key!=='Tab')return;const choices=focusable(),first=choices[0],last=choices.at(-1);if(!first){event.preventDefault();dialog.focus();return;}
  if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}
 }
 dialog.addEventListener('compositionstart',()=>{composing=true;});dialog.addEventListener('compositionend',()=>{composing=false;});
 dialog.addEventListener('cancel',event=>{if(event.target!==dialog)return;event.preventDefault();requestClose();});
 dialog.addEventListener('click',event=>{if(event.target===dialog)requestClose();});
 document.addEventListener('keydown',keydown,true);view?.addEventListener('beforeunload',beforeUnload);dialog.showModal();close.focus();
 const ready=load();
 return{ready,element:dialog,get open(){return !destroyed;},get closeState(){return{busy,dirty:dirty()};},canClose:()=>destroyed||!busy&&!dirty(),requestClose,destroy:finish};
}
