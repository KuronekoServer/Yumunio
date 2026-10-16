import {captureInlineSelection,getInlineEditorState,insertInlineMention} from './inline-editor.js';
import {mentionQuery,mentionCandidates,validMentionDate} from './mention-picker-model.js';
let nextId=0;
/** Suggestions only use ACL-filtered data supplied by the current page's controller. */
export function createMentionPicker(element,{load,getContext=()=>'',labels={}}={}){
 if(typeof load!=='function')throw new TypeError('INVALID_MENTION_PICKER');
 const doc=element.ownerDocument,popup=doc.createElement('div'),list=doc.createElement('div'),status=doc.createElement('p'),hint=doc.createElement('p');
 const text=name=>labels[name]||({label:'Mention a person, page or date',loading:'Loading suggestions',empty:'No matching results',error:'Suggestions could not be loaded',person:'Person',page:'Page',date:'Date',today:'Today',tomorrow:'Tomorrow',hint:'Use arrows and Enter to select. Mentions are references; email and reminders are not sent.',chooseDate:'Choose a date',insertDate:'Insert date'})[name];
 popup.className='mention-picker';popup.hidden=true;popup.setAttribute('role','group');popup.setAttribute('aria-label',text('label'));
 list.id='mention-options-'+(++nextId);list.className='mention-options';list.setAttribute('role','listbox');list.setAttribute('aria-label',text('label'));
 status.className='mention-status';status.setAttribute('role','status');hint.className='mention-hint';hint.textContent=text('hint');
 const dateLabel=doc.createElement('label'),date=doc.createElement('input'),dateButton=doc.createElement('button');
 dateLabel.textContent=text('chooseDate');date.type='date';date.setAttribute('aria-label',text('chooseDate'));dateLabel.append(date);dateButton.type='button';dateButton.textContent=text('insertDate');dateButton.disabled=true;
 const dateRow=doc.createElement('div');dateRow.className='mention-date';dateRow.append(dateLabel,dateButton);popup.append(status,list,dateRow,hint);
 let current=null,options=[],selected=0,cache=null,cacheContext=null,loading=null,generation=0,dismissed=null;
 function close(){popup.hidden=true;current=null;options=[];element.removeAttribute('aria-controls');element.removeAttribute('aria-activedescendant');element.removeAttribute('aria-expanded');}
 function position(){
  const selection=doc.getSelection();let rect=element.getBoundingClientRect();
  if(selection?.rangeCount){const range=selection.getRangeAt(0).cloneRange();range.collapse(false);const caret=range.getBoundingClientRect();if(caret.width||caret.height)rect=caret;}
  const view=doc.defaultView,width=Math.min(340,view.innerWidth-24),height=Math.min(popup.offsetHeight,340);
  popup.style.width=width+'px';popup.style.left=Math.max(12,Math.min(view.innerWidth-width-12,rect.left))+'px';popup.style.top=Math.max(12,rect.bottom+8+height<view.innerHeight?rect.bottom+8:rect.top-height-8)+'px';
 }
 function highlight(){
  const children=[...list.children];children.forEach((item,index)=>item.setAttribute('aria-selected',String(index===selected)));
  if(children[selected]){element.setAttribute('aria-activedescendant',children[selected].id);children[selected].scrollIntoView({block:'nearest'});}else element.removeAttribute('aria-activedescendant');
 }
 function pick(option){
  const saved=current,context=getContext(),state=getInlineEditorState(element),focused=doc.activeElement;
  const query=focused===element&&state&&!state.composing?mentionQuery(state.text,captureInlineSelection(element),state.mentions):null;
  const sameSelection=query&&query.start===saved?.start&&query.end===saved?.end&&query.query===saved?.query;
  if(!saved||context!==saved.context||state?.text!==saved.expectedText||state?.composing||focused!==element&&!popup.contains(focused)||focused===element&&!sameSelection){close();return;}
  close();insertInlineMention(element,{...saved,text:option.text,target:option.target});
 }
 function paint(){
  if(!current)return;list.replaceChildren();selected=0;options=mentionCandidates(cache||[],current.query,{today:text('today'),tomorrow:text('tomorrow')});
  status.textContent=loading?text('loading'):options.length?'':text('empty');
  options.forEach((option,index)=>{const button=doc.createElement('button');button.type='button';button.id=list.id+'-'+index;button.className='mention-option';button.setAttribute('role','option');const label=doc.createElement('span'),kind=doc.createElement('small');label.textContent=option.label;label.setAttribute('translate','no');kind.textContent=text(option.target.kind);button.append(label,kind);button.addEventListener('mousedown',event=>event.preventDefault());button.addEventListener('click',()=>pick(option));list.append(button);});
  popup.hidden=false;element.setAttribute('aria-controls',list.id);element.setAttribute('aria-expanded','true');highlight();position();
 }
 function update(){
  const state=getInlineEditorState(element);if(!element.isConnected||!state||state.readOnly||state.composing||state.pendingEdit){close();return;}
  const query=mentionQuery(state.text,captureInlineSelection(element),state.mentions),context=getContext();
  if(!query||context===null){close();return;}const key=JSON.stringify([context,query]);if(key===dismissed)return;
  current={...query,context};dateButton.disabled=!validMentionDate(date.value);
  if(cacheContext!==context){cache=null;cacheContext=context;loading=null;generation++;}
  paint();if(cache||loading)return;
  const marker=++generation;loading=Promise.resolve().then(()=>load());
  loading.then(value=>{if(generation!==marker||getContext()!==context||!element.isConnected)return;mentionCandidates(value,'');cache=value;loading=null;if(current)paint();}).catch(()=>{if(generation!==marker||getContext()!==context)return;loading=null;cache=[];if(current){paint();status.textContent=text('error');}});
 }
 element.addEventListener('input',()=>queueMicrotask(update));element.addEventListener('compositionend',()=>queueMicrotask(update));
 element.addEventListener('compositionstart',close);
 element.addEventListener('keyup',event=>{if(!['Enter','Escape','ArrowUp','ArrowDown'].includes(event.key))update();});
 element.addEventListener('click',update);
 element.addEventListener('pointerup',update);
 element.addEventListener('focus',()=>queueMicrotask(update));
 element.addEventListener('keydown',event=>{
  if(popup.hidden||!current||event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'){dismissed=JSON.stringify([current.context,{start:current.start,end:current.end,query:current.query,expectedText:current.expectedText}]);close();event.preventDefault();event.stopImmediatePropagation();}
  else if(['ArrowUp','ArrowDown'].includes(event.key)&&options.length){selected=(selected+(event.key==='ArrowDown'?1:options.length-1))%options.length;highlight();event.preventDefault();event.stopImmediatePropagation();}
  else if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopImmediatePropagation();if(options[selected])pick(options[selected]);}
  else if(event.key==='Tab')close();
 },true);
 element.addEventListener('blur',()=>queueMicrotask(()=>{if(!popup.contains(doc.activeElement))close();}));
 popup.addEventListener('focusout',()=>queueMicrotask(()=>{if(!popup.contains(doc.activeElement)&&doc.activeElement!==element)close();}));
 popup.addEventListener('keydown',event=>{if(event.key==='Escape'){if(current)dismissed=JSON.stringify([current.context,{start:current.start,end:current.end,query:current.query,expectedText:current.expectedText}]);close();element.focus({preventScroll:true});event.preventDefault();event.stopPropagation();}});
 date.addEventListener('input',()=>{dateButton.disabled=!validMentionDate(date.value);});
 dateButton.addEventListener('click',()=>{if(validMentionDate(date.value))pick({text:'@'+date.value,target:{kind:'date',date:date.value}});});
 return popup;
}
