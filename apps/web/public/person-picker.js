const ids=value=>Array.isArray(value)?[...value]:typeof value==='string'&&value?[value]:[];
const normalized=value=>String(value).normalize('NFKC').toLocaleLowerCase('en').trim();
let sequence=0;
/** Bounded suggestions from the current page's authorized people, never a global directory. */
export function personCandidates(people,query,selected=[],limit=20){
 const term=normalized(query).replace(/^@\s*/,''),chosen=new Set(selected),seen=new Set(),matches=[];
 for(const person of people){
  if(!person?.accountId||seen.has(person.accountId)||chosen.has(person.accountId))continue;seen.add(person.accountId);
  const name=normalized(person.name||person.accountId),at=name.indexOf(term);if(at<0)continue;
  matches.push({person,rank:at===0?0:1});
 }
 matches.sort((a,b)=>a.rank-b.rank);
 return{people:matches.slice(0,limit).map(item=>item.person),total:matches.length};
}
export function personDisplayName(people,id,t=key=>key){return people.find(person=>person.accountId===id)?.name||t('savedReference');}
/** An ordinary field facade: only committed selection changes emit input/change. */
export function createPersonPicker({document,property,value,people=[],filter=false,t=key=>key,disabled=false}){
 const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 const root=make('div','collection-value-input person-picker'),chips=make('span','person-chips'),search=make('input','person-search'),popup=make('div','person-popup'),list=make('div','person-options'),status=make('p','person-status'),hint=make('p','person-hint',t(filter?'personFilterHint':'personPickerHint'));
 const index=++sequence,byId=new Map(people.map(person=>[person.accountId,person]));
 let selected=ids(value),raw=Array.isArray(value)?[...value]:value??null,options=[],active=0,composing=false,locked=false,open=false,cleanup=null;
 root.setAttribute('role','group');root.setAttribute('aria-label',property.name||t('personSearch'));
 search.type='text';search.autocomplete='off';search.spellcheck=false;search.maxLength=128;search.placeholder=t('personPlaceholder');search.setAttribute('aria-label',(property.name?property.name+' — ':'')+t('personSearch'));search.setAttribute('role','combobox');search.setAttribute('aria-autocomplete','list');search.setAttribute('aria-expanded','false');
 list.id='person-options-'+index;list.setAttribute('role','listbox');list.setAttribute('aria-label',t('personSearch'));search.setAttribute('aria-controls',list.id);
 status.setAttribute('role','status');status.setAttribute('aria-live','polite');hint.id='person-hint-'+index;search.setAttribute('aria-describedby',hint.id);
 popup.hidden=true;popup.setAttribute('popover','manual');popup.append(list,status,hint);root.append(chips,search,popup);
 const label=id=>byId.get(id)?.name||t('savedReference');
 function avatar(name){const node=make('span','person-avatar',Array.from(name)[0]||'@');node.setAttribute('aria-hidden','true');return node;}
 function close(){open=false;cleanup?.();cleanup=null;if(popup.matches?.(':popover-open'))popup.hidePopover();popup.hidden=true;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');}
 function position(){
  const rect=root.getBoundingClientRect?.(),view=document.defaultView;if(!rect||!view)return;
  const width=Math.max(0,Math.min(Math.max(rect.width,280),360,view.innerWidth-16)),height=Math.min(popup.offsetHeight||300,340,view.innerHeight-16),left=Math.max(8,Math.min(view.innerWidth-width-8,rect.left));
  popup.style.width=width+'px';popup.style.maxHeight=Math.min(340,view.innerHeight-16)+'px';popup.style.left=left+'px';popup.style.top=Math.max(8,rect.bottom+height+5<view.innerHeight?rect.bottom+5:rect.top-height-5)+'px';
 }
 function watch(){
  const outside=event=>{if(!root.contains(event.target))close();},move=()=>{if(!root.isConnected)close();else position();};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',move,true);document.defaultView?.addEventListener('resize',move);
  const Observer=document.defaultView?.MutationObserver,observer=Observer?new Observer(()=>{if(!root.isConnected)close();}):null;observer?.observe(document.documentElement,{childList:true,subtree:true});
  cleanup=()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',move,true);document.defaultView?.removeEventListener('resize',move);observer?.disconnect();};
 }
 function highlight(){
  for(const [i,node]of [...list.children].entries())node.setAttribute('aria-selected',String(i===active));
  const node=list.children[active];if(node){search.setAttribute('aria-activedescendant',node.id);node.scrollIntoView?.({block:'nearest'});}else search.removeAttribute('aria-activedescendant');
 }
 function paint(){
  if(locked||composing||!root.isConnected)return close();
  const result=personCandidates(people,search.value,selected);options=result.people;active=0;list.replaceChildren();
  for(const [i,person]of options.entries()){
   const name=person.name||t('savedReference'),option=make('div','person-option');option.id=list.id+'-'+i;option.setAttribute('role','option');option.setAttribute('aria-selected','false');option.append(avatar(name),make('span','person-option-name',name));
   option.addEventListener('mousedown',event=>event.preventDefault());option.addEventListener('click',()=>choose(person.accountId));list.append(option);
  }
  status.textContent=result.total>options.length?t('personMoreResults'):options.length?'':t('personNoResults');status.hidden=!status.textContent;
  if(!open){open=true;popup.hidden=false;if(typeof popup.showPopover==='function')popup.showPopover();watch();}
  search.setAttribute('aria-expanded','true');highlight();position();
 }
 function paintChips(){
  chips.replaceChildren();for(const id of selected){const name=label(id),chip=make('span','person-chip'),remove=make('button','person-remove','×');chip.setAttribute('translate','no');chip.append(avatar(name),make('span','person-chip-name',name));remove.type='button';remove.disabled=locked;remove.setAttribute('aria-label',t('personRemove').replace('{name}',name));remove.addEventListener('click',event=>{event.preventDefault();if(!locked&&!composing)change(selected.filter(value=>value!==id));});chip.append(remove);chips.append(chip);}
  search.placeholder=t(selected.length?'personAddPlaceholder':'personPlaceholder');
 }
 function change(next){
  if(locked||composing)return;selected=next;raw=filter?selected[0]??null:[...selected];search.value='';paintChips();search.focus({preventScroll:true});if(filter)close();else paint();
  const EventType=document.defaultView?.Event??Event;root.dispatchEvent(new EventType('input',{bubbles:true}));root.dispatchEvent(new EventType('change',{bubbles:true}));
 }
 function choose(id){if(!locked&&!composing&&!selected.includes(id)&&byId.has(id))change(filter?[id]:[...selected,id]);}
 search.addEventListener('input',event=>{event.stopPropagation();if(!composing)paint();});search.addEventListener('change',event=>event.stopPropagation());
 search.addEventListener('compositionstart',()=>{composing=true;close();});search.addEventListener('compositionend',()=>{composing=false;queueMicrotask(()=>{if(document.activeElement===search)paint();});});
 search.addEventListener('focus',paint);search.addEventListener('click',paint);
 root.addEventListener('focusout',()=>queueMicrotask(()=>{if(!root.contains(document.activeElement))close();}));
 root.addEventListener('keydown',event=>{
  if(locked||composing||event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close();search.focus({preventScroll:true});return;}
  if(event.target!==search||event.ctrlKey||event.metaKey||event.altKey)return;
  if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopPropagation();if(!open)paint();else if(options.length){active=(active+(event.key==='ArrowDown'?1:options.length-1))%options.length;highlight();}}
  else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(open&&options[active])choose(options[active].accountId);else paint();}
  else if(event.key==='Backspace'&&!search.value&&selected.length){event.preventDefault();event.stopPropagation();change(selected.slice(0,-1));}
  else if(event.key==='Tab')close();
 });
 Object.defineProperty(root,'disabled',{get:()=>locked,set:next=>{locked=Boolean(next);search.disabled=locked;root.setAttribute('aria-disabled',String(locked));paintChips();if(locked)close();}});
 root.focus=options=>search.focus(options);root.rawValue=()=>Array.isArray(raw)?[...raw]:raw;root.disabled=disabled;return root;
}
