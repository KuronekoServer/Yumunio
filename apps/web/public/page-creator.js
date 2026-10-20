import {pageStarters,matchingPageStarters} from './page-starters.js';
import {validateTemplatesList,validateTemplateItem} from './templates-model.js';

export function pageCreationDestinations({pages,teamspaces,t,canManage}){
  return[{id:'private',name:t('pageTemplates.private'),hint:t('privateDefault')},
    ...teamspaces.filter(item=>!item.archivedAt&&item.capabilities.includes('createPage')).map(item=>({id:'team:'+item.id,name:t('pageTemplates.teamDestination',{name:item.name}),teamspaceId:item.id,hint:t('teamspaces.createPageHint',{name:item.name})})),
    ...pages.filter(canManage).map(item=>({id:'page:'+item.id,name:t('pageTemplates.childDestination',{name:item.title||t('untitled')}),parentId:item.id,hint:t('pageTemplates.childHint',{name:item.title||t('untitled')})}))];
}

const iconPaths={
  page:'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
  people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  flag:'M4 21V3 M4 4h14l-3 5 3 5H4',
  issue:'M12 8v5 M12 16h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  check:'M9 5h12 M9 12h12 M9 19h12 M2 5l2 2 3-4 M2 12l2 2 3-4 M2 19l2 2 3-4',
  book:'M12 5v16 M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z',
  calendar:'M3 5h18v16H3z M3 10h18 M7 3v4 M17 3v4 M7 14h3 M14 14h3 M7 17h3'
};
function templateIcon(document,name){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const[key,value]of Object.entries({viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',iconPaths[name]??iconPaths.page);svg.append(path);return svg;
}

/** Autosave may replace a trigger before the native dialog captures focus. */
export function capturePageCreatorFocus({document,root,trigger=document.activeElement}){
  const control=['BUTTON','A'].includes(trigger?.nodeName)?trigger:null;
  const id=control?.id,label=control?.getAttribute('aria-label'),text=control?.textContent.trim();
  const menuId=control?.closest('[data-menu-trigger-id]')?.getAttribute('data-menu-trigger-id');
  return dialog=>{
    const active=document.activeElement;
    if(active!==document.body&&active!==document.documentElement&&active?.isConnected&&!dialog.contains(active))return;
    const usable=el=>el?.isConnected&&!el.disabled&&!el.closest('[inert]')&&el.getClientRects().length>0;
    const options=[control,id?document.getElementById(id):null,menuId?document.getElementById(menuId):null,...root.querySelectorAll('button,a')];
    const target=options.find(el=>usable(el)&&(el===control||(id&&el.id===id)||(menuId&&el.id===menuId)||(label?el.getAttribute('aria-label')===label:!!text&&el.textContent.trim()===text)));
    target?.focus({preventScroll:true});
  };
}

/** A dialog widget: the mounted page editor and its undo/selection state remain untouched. */
export function createPageCreator({document,t,destinations,initialDestination,onCreate,loadPersonalList,loadPersonalItem,personalHref}){
  const node=(tag,attrs={},children=[])=>{const el=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(key.startsWith('on'))el.addEventListener(key.slice(2).toLowerCase(),value);else if(['value','disabled','maxLength'].includes(key))el[key]=value;else el.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])el.append(typeof child==='string'?document.createTextNode(child):child);return el;};
  const text=key=>t('pageTemplates.'+key);
  let rows=pageStarters(t),selected=rows[0],snapshot=selected.snapshot,revision=null,disposed=false,generation=0,pending=false,busy=false,blocked=false,customTitle=false,composing=false;
  const root=node('form',{class:'create-form page-creator'}),destination=node('select',{'aria-label':text('destination'),id:'new-page-destination'});
  for(const item of destinations)destination.append(node('option',{value:item.id},item.name));destination.value=initialDestination;
  const destinationHint=node('p',{class:'hint page-create-destination-hint'});
  const search=node('input',{type:'search',maxLength:120,'aria-label':text('search'),placeholder:text('search'),autocomplete:'off',onInput:()=>renderCards(),onKeydown:event=>{if(event.key==='Enter')event.preventDefault();}});
  const title=node('input',{type:'text',id:'new-page-title',maxLength:240,value:t('newPage'),required:'',autocomplete:'off',onInput:()=>{customTitle=true;title.setCustomValidity('');}});
  const gallery=node('div',{class:'page-template-gallery'}),preview=node('section',{class:'page-template-preview','aria-labelledby':'page-template-preview-heading'});
  const listStatus=node('p',{class:'hint page-template-list-status',role:'status'},text('loadingPersonal'));
  const feedback=node('p',{class:'hint create-feedback',role:'status','aria-live':'polite'});
  const submit=node('button',{type:'submit',class:'button primary'},text('create'));
  const previewHeading=node('h3',{id:'page-template-preview-heading'},text('preview'));
  const previewContent=node('div',{class:'page-template-document',translate:'no'});
  const previewDescription=node('p',{class:'hint'});
  preview.append(previewHeading,previewDescription,previewContent);
  const manage=node('a',{href:personalHref,class:'page-template-manage'},text('managePersonal'));
  const updateDestination=()=>{const item=destinations.find(item=>item.id===destination.value);destinationHint.textContent=item?.hint??'';};
  destination.addEventListener('change',updateDestination);updateDestination();
  root.append(node('div',{class:'page-create-toolbar'},[node('label',{class:'field',for:'new-page-destination'},[node('span',{},text('destination')),destination]),node('label',{class:'page-template-search'},[search])]),destinationHint,
    node('div',{class:'page-template-layout'},[node('div',{class:'page-template-picker'},[gallery,listStatus,manage]),preview]),
    node('div',{class:'page-create-footer'},[node('label',{class:'field',for:'new-page-title'},[node('span',{},t('pageTitle')),title]),submit]),feedback);
  root.addEventListener('compositionstart',()=>{composing=true;});root.addEventListener('compositionend',()=>{composing=false;});
  root.addEventListener('submit',async event=>{
    event.preventDefault();if(disposed||busy||blocked||pending||composing||event.isComposing||!snapshot)return;
    if(!title.value.trim()){title.setCustomValidity(t('titleRequired'));title.reportValidity();return;}
    const target=destinations.find(item=>item.id===destination.value);if(!target)return;
    busy=true;setDisabled(true);feedback.textContent='';
    try{const result=await onCreate({title:title.value.trim(),snapshot:structuredClone(snapshot),observedRevision:revision,teamspaceId:target.teamspaceId??null,parentId:target.parentId??null});blocked=result?.blocked===true;}
    catch{blocked=true;feedback.textContent=t('teamspaces.createUnknown');feedback.setAttribute('role','alert');}
    finally{if(!disposed){busy=false;setDisabled(blocked);}}
  });
  function setDisabled(value){for(const control of root.querySelectorAll('input,select,button'))control.disabled=value;submit.disabled=value||pending||!snapshot;}
  function renderPreview(){
    previewHeading.textContent=selected.name;previewDescription.textContent=selected.description;previewContent.replaceChildren();
    if(pending){previewContent.append(node('p',{class:'hint',role:'status'},text('loadingPreview')));return;}
    if(!snapshot)return;
    if(!snapshot.blocks.length||selected.id==='starter:blank'){previewContent.append(node('p',{class:'hint'},text('blankPreview')));return;}
    const visit=(blocks,parent)=>{for(const block of blocks){if(block.type==='divider')parent.append(node('hr'));else{const tag=block.type.startsWith('heading')?'h4':block.type==='quote'?'blockquote':block.type==='code'?'pre':'p';
      const line=node(tag,{class:'page-template-block'+(block.type==='checklist'?' page-template-check':'')});
      if(['checklist','bulleted-list','numbered-list'].includes(block.type))line.append(node('span',{'aria-hidden':'true',class:'page-template-marker'},block.type==='checklist'?(block.data.checked?'☑':'☐'):block.type==='bulleted-list'?'•':'1.'));
      const value=block.data?.text??'';let offset=0;for(const mark of block.data?.marks??[]){line.append(document.createTextNode(value.slice(offset,mark.start)));let span=document.createTextNode(value.slice(mark.start,mark.end));for(const style of mark.styles){const wrapper=node({bold:'strong',italic:'em',strike:'s',underline:'u',code:'code'}[style]);wrapper.append(span);span=wrapper;}line.append(span);offset=mark.end;}line.append(document.createTextNode(value.slice(offset)));
      if(!value)line.append(node('span',{class:'page-template-placeholder','aria-hidden':'true'},text('writeHere')));
      parent.append(line);}if(block.children?.length){const nested=node('div',{class:'page-template-nested'});visit(block.children,nested);parent.append(nested);}
    }};visit(snapshot.blocks,previewContent);
  }
  async function choose(item){
    if(disposed||busy||blocked)return;selected=item;snapshot=item.snapshot??null;pending=!snapshot;const marker=++generation;
    if(!customTitle)title.value=item.id==='starter:blank'?t('newPage'):item.name;
    feedback.textContent='';renderCards();renderPreview();submit.disabled=pending;
    if(!pending)return;
    try{const result=validateTemplateItem(await loadPersonalItem(item.templateId),item.templateId);if(disposed||marker!==generation)return;snapshot=result.template.snapshot;revision=Math.max(revision??0,result.revision);}
    catch{if(disposed||marker!==generation)return;feedback.textContent=text('previewFailed');}
    finally{if(!disposed&&marker===generation){pending=false;renderPreview();submit.disabled=!snapshot;}}
  }
  function renderCards(){
    const focused=document.activeElement?.getAttribute?.('data-page-template');const visible=matchingPageStarters(rows,search.value),sections=[['starter',text('starters')],['personal',text('personal')]];gallery.replaceChildren();
    if(!visible.length)gallery.append(node('p',{class:'hint',role:'status'},text('noResults')));
    for(const[prefix,label]of sections){const items=visible.filter(item=>item.id.startsWith(prefix+':'));if(!items.length)continue;
      const grid=node('div',{class:'page-template-grid'});gallery.append(node('h3',{class:'page-template-group'},label),grid);
      for(const item of items){
        const card=node('button',{type:'button',class:'page-template-card',disabled:busy||blocked,'aria-pressed':String(item.id===selected.id),'data-page-template':item.id,onClick:()=>void choose(item)},[node('span',{class:'page-template-card-icon','aria-hidden':'true'},templateIcon(document,item.icon)),node('strong',{},item.name),node('span',{class:'page-template-card-description'},item.description)]);
        card.addEventListener('keydown',event=>{if(composing||event.isComposing||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const cards=[...gallery.querySelectorAll('button')],index=cards.indexOf(card),direction=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;cards[(index+direction+cards.length)%cards.length]?.focus();});grid.append(card);
      }
    }
    if(focused)gallery.querySelectorAll('button').forEach(button=>{if(button.getAttribute('data-page-template')===focused)button.focus({preventScroll:true});});
  }
  renderCards();renderPreview();
  const ready=(async()=>{try{const result=validateTemplatesList(await loadPersonalList());if(disposed)return;revision=Math.max(revision??0,result.revision);rows.push(...result.templates.map(item=>({id:'personal:'+item.id,templateId:item.id,icon:'page',name:item.name,description:text('personalDescription')})));listStatus.textContent=result.templates.length?'':text('noPersonal');renderCards();}
    catch{if(!disposed)listStatus.textContent=text('personalUnavailable');}})();
  return{root,ready,focus:()=>search.focus(),destroy(){disposed=true;generation++;}};
}
