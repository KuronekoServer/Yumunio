import {renderCollectionProjection,captureCalendarFocus,restoreCalendarFocus} from './collection-projection.js';
import {validateCollectionEnvelope,VIEW_TYPES,FILTER_OPERATORS,effectivePropertyType,currentCalendarMonth,shiftCalendarMonth} from './collections-model.js';
import {createCollectionValueInput} from './collection-fields.js';

export function defaultDatabaseView(name='Table'){return{name,type:'table',filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null};}

export const DATABASE_QUICK_VIEWS=['table','board','calendar','timeline'];
/** Change presentation only. Filters, ordering and rows still belong to the same database. */
export function databaseViewForType(view,properties,type,previous=null){
 if(!DATABASE_QUICK_VIEWS.includes(type))return null;
 const groups=properties.filter(property=>['text','number','checkbox','date','select','person'].includes(effectivePropertyType(property))),dates=properties.filter(property=>effectivePropertyType(property)==='date');
 const pick=(candidates,...ids)=>ids.find(id=>candidates.some(property=>property.id===id))??null;
 const group=pick(groups,previous?.groupBy,view.groupBy,groups.find(property=>property.type==='status')?.id,groups.find(property=>property.type==='select')?.id,groups[0]?.id);
 const start=pick(dates,previous?.datePropertyId,view.datePropertyId,dates[0]?.id),end=pick(dates,previous?.endDatePropertyId,view.endDatePropertyId,start);
 if(type==='board'&&!group||['calendar','timeline'].includes(type)&&!start)return null;
 return{name:view.name,type,filters:structuredClone(view.filters),sorts:structuredClone(view.sorts),groupBy:type==='board'?group:null,datePropertyId:['calendar','timeline'].includes(type)?start:null,endDatePropertyId:type==='timeline'?end:null};
}
function validatePlacementQuery(value,workspaceId,collectionId,view){const result=validateCollectionEnvelope(value,{workspaceId,collectionId});if(!result.view||['name','type','filters','sorts','groupBy','datePropertyId','endDatePropertyId','chart'].some(key=>JSON.stringify(result.view[key]??null)!==JSON.stringify(view[key]??null)))throw new Error('invalidResponse');return result;}

/** Settings belong to the block, never to a saved view on the source collection. */
export function createDatabaseViewSettings({document,properties,view,visiblePropertyIds,people=[],pages=[],t}){
 const node=(tag,attrs={},children=[])=>{const element=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key==='value'||key==='checked')element[key]=value;else element.setAttribute(key,value);}for(const child of Array.isArray(children)?children:[children])element.append(child?.nodeType?child:document.createTextNode(String(child)));return element;};
 const field=(label,input)=>{input.setAttribute('aria-label',label);return node('label',{class:'field'},[label,input]);};
 const select=(options,value)=>{const input=node('select',{},options.map(([id,label])=>node('option',{value:id},label)));input.value=value??'';return input;};
 const state=structuredClone(view),root=node('div',{class:'database-view-settings'}),name=node('input',{type:'text',maxlength:'128',required:'',value:state.name}),type=select(VIEW_TYPES.map(id=>[id,t(id)]),state.type);
 const group=select([['',t('none')],...properties.filter(p=>!['multi_select','relation'].includes(effectivePropertyType(p))).map(p=>[p.id,p.name])],state.groupBy),dates=[['',t('none')],...properties.filter(p=>effectivePropertyType(p)==='date').map(p=>[p.id,p.name])],start=select(dates,state.datePropertyId),end=select(dates,state.endDatePropertyId);
 const chartType=select([['bar',t('chartBar')],['donut',t('chartDonut')]],state.chart?.type??'bar'),aggregation=select(['count','sum','average'].map(id=>[id,t('chart'+id[0].toUpperCase()+id.slice(1))]),state.chart?.aggregation??'count'),number=select([['',t('none')],...properties.filter(p=>effectivePropertyType(p)==='number').map(p=>[p.id,p.name])],state.chart?.valuePropertyId);
 const rules=node('div',{class:'view-rules'}),sorts=node('div',{class:'view-rules'}),columns=node('fieldset',{},node('legend',{},t('placement.visibleColumns'))),visible=new Map();
 for(const property of properties){const input=node('input',{type:'checkbox',checked:visiblePropertyIds===null||visiblePropertyIds.includes(property.id)});visible.set(property.id,input);columns.append(node('label',{class:'check-field'},[input,property.name]));}
 const action=(label,fn)=>{const button=node('button',{type:'button',class:'button'},label);button.addEventListener('click',fn);return button;};
 function paintFilters(){rules.replaceChildren();for(const filter of state.filters){const property=properties.find(p=>p.id===filter.propertyId)??properties[0];if(!property)continue;filter.propertyId=property.id;
  const prop=select(properties.map(p=>[p.id,p.name]),property.id),operator=select(FILTER_OPERATORS[effectivePropertyType(property)].map(id=>[id,t(id)]),filter.operator),row=node('section',{class:'view-rule'},[field(t('property'),prop),field(t('operator'),operator)]);
  prop.addEventListener('change',()=>{filter.propertyId=prop.value;filter.operator='empty';delete filter.value;paintFilters();});operator.addEventListener('change',()=>{filter.operator=operator.value;delete filter.value;paintFilters();});
  if(!['empty','not_empty'].includes(filter.operator)){const input=createCollectionValueInput({document,property,value:filter.value??null,people,pages,t,filter:true});filter.read=()=>input.readValue();input.addEventListener('change',()=>{try{filter.value=input.readValue();}catch{}});row.append(field(t('filterValue'),input));}else delete filter.read;
  row.append(action(t('removeRule'),()=>{state.filters=state.filters.filter(f=>f!==filter);paintFilters();}));rules.append(row);
 }}
 function paintSorts(){sorts.replaceChildren();for(const sort of state.sorts){const property=select(properties.map(p=>[p.id,p.name]),sort.propertyId),direction=select([['asc',t('asc')],['desc',t('desc')]],sort.direction);property.addEventListener('change',()=>{sort.propertyId=property.value;});direction.addEventListener('change',()=>{sort.direction=direction.value;});sorts.append(node('div',{class:'view-rule'},[field(t('property'),property),field(t('direction'),direction),action(t('removeRule'),()=>{state.sorts=state.sorts.filter(s=>s!==sort);paintSorts();})]));}}
 root.append(field(t('viewName'),name),field(t('viewType'),type),field(t('groupBy'),group),field(t('startDate'),start),field(t('endDate'),end),field(t('chartType'),chartType),field(t('chartAggregation'),aggregation),field(t('chartValueProperty'),number),node('h3',{},t('filters')),rules,action(t('addFilter'),()=>{if(properties.length&&state.filters.length<20){state.filters.push({propertyId:properties[0].id,operator:'empty'});paintFilters();}}),node('h3',{},t('sorts')),sorts,action(t('addSort'),()=>{const property=properties.find(p=>!state.sorts.some(s=>s.propertyId===p.id));if(property&&state.sorts.length<5){state.sorts.push({propertyId:property.id,direction:'asc'});paintSorts();}}),columns);
 function visibility(){group.parentElement.hidden=!['board','chart'].includes(type.value);start.parentElement.hidden=!['calendar','timeline'].includes(type.value);end.parentElement.hidden=type.value!=='timeline';for(const input of [chartType,aggregation,number])input.parentElement.hidden=type.value!=='chart';number.parentElement.hidden=type.value!=='chart'||aggregation.value==='count';}
 type.addEventListener('change',visibility);aggregation.addEventListener('change',visibility);paintFilters();paintSorts();visibility();
 return{element:root,read:()=>({view:{name:name.value.trim(),type:type.value,filters:state.filters.map(f=>({propertyId:f.propertyId,operator:f.operator,...(f.read?{value:f.read()}:{} )})),sorts:state.sorts.map(s=>({...s})),groupBy:['board','chart'].includes(type.value)?group.value||null:null,datePropertyId:['calendar','timeline'].includes(type.value)?start.value||null:null,endDatePropertyId:type.value==='timeline'?end.value||null:null,...(type.value==='chart'?{chart:{type:chartType.value,aggregation:aggregation.value,valuePropertyId:aggregation.value==='count'?null:number.value||null}}:{})},visiblePropertyIds:properties.filter(p=>visible.get(p.id).checked).map(p=>p.id)})};
}

/** Refresh one projection without remounting its surrounding page or other placements. */
export function mountDatabasePlacement({root,getBlock,workspaceId,request,isCurrent,canConfigure,t,fieldT,onConfigure,onChangeView,onActions,onNewRecord,onOpenRecord,onRevision,onAccessLost,signal,initialRead,initialState}){
 const document=root.ownerDocument,lifetime=new AbortController();let envelope=null,people=[],generation=0,busy=false,selected=initialState?.selected??null,month=initialState?.month??currentCalendarMonth(),signature='',timer,refreshPending=false,previewView=null,previewBaseline=null,paintedType=null,queuedView=null;
 const viewMemory=new Map(),scrollMemory=new Map(initialState?.scrollMemory??[]),viewButtons=new Map();let paintedConfig=null;
 const config=block=>JSON.stringify([block?.data.collectionId,block?.data.view,block?.data.visiblePropertyIds]);
 const viewForBlock=()=>{const saved=getBlock()?.data.view;if(previewView&&JSON.stringify(saved)!==previewBaseline)previewView=null;return previewView??saved;};
 const current=()=>!lifetime.signal.aborted&&root.isConnected&&isCurrent();
 const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
 const heading=node('div','database-placement-toolbar'),title=node('strong'),status=node('span','hint'),tools=node('div','database-placement-actions'),body=node('div','database-placement-body');
 const action=(label,fn)=>{const button=node('button','button quiet',label);button.type='button';button.addEventListener('click',()=>{if(current())void fn();});tools.append(button);return button;};
 const settings=action(t('inlineDatabase.settings'),()=>onConfigure(envelope));const add=action(t('inlineDatabase.newRecord'),()=>onNewRecord(envelope));add.classList.add('primary');action(t('inlineDatabase.refresh'),()=>refresh(true));
 if(onActions){const more=action('⋯',()=>onActions(envelope));more.classList.add('database-placement-more');more.setAttribute('aria-label',t('layout.databaseActions'));more.title=t('layout.databaseActions');}
 const views=node('nav','database-placement-views');views.setAttribute('aria-label',t('inlineDatabase.views'));
 for(const type of DATABASE_QUICK_VIEWS){const button=node('button','database-view-tab',fieldT(type));button.type='button';button.addEventListener('click',()=>void switchView(type));views.append(button);viewButtons.set(type,button);}
 heading.append(title,tools);root.append(heading,views,status,body);
 const previousView=type=>viewMemory.get(type)??envelope?.collection.views.find(view=>view.type===type);
 function controls(){for(const[type,button]of viewButtons){const possible=envelope&&databaseViewForType(viewForBlock(),envelope.collection.properties,type,previousView(type));button.disabled=busy||!possible;button.setAttribute('aria-pressed',String(envelope?.view.type===type));button.title=possible?'':t(type==='board'?'inlineDatabase.groupRequired':'inlineDatabase.dateRequired');}settings.disabled=busy||!canConfigure();add.disabled=busy||!envelope?.capabilities.includes('manage');}
 function updatePresentation(){const data=getBlock()?.data.presentation??{};title.hidden=data.showTitle===false;title.textContent=(data.icon?data.icon+' ':'')+(data.title?.trim()||envelope?.collection.title||t('inlineDatabase.title'));root.style.setProperty('--database-height',(data.height??480)+'px');}
 function paint(){
  if(!envelope)return;const block=getBlock();if(!block)return;
  updatePresentation();controls();paintedConfig=config(block);
  if(paintedType)scrollMemory.set(paintedType,[...body.querySelectorAll('.collection-scroll,.collection-board')].map(el=>[el.scrollLeft,el.scrollTop]));
  const positions=scrollMemory.get(envelope.view.type)??[],focus=document.activeElement?.closest?.('[data-record-id]')?.dataset.recordId,calendarFocus=captureCalendarFocus(document,body);
  const options={document,envelope,t:fieldT,locale:document.documentElement.lang||'ja',people,month,visiblePropertyIds:block.data.visiblePropertyIds,selectedRecordId:selected,onOpenRecord:record=>{selected=record.id;mark();void onOpenRecord(record,envelope.collection.id);},onOpenPage:record=>onOpenRecord(record,envelope.collection.id),pageHref:record=>'/workspace?'+new URLSearchParams({workspace:workspaceId,page:record.pageId}),onMonth:offset=>{const next=shiftCalendarMonth(month,offset);if(next){month=next;paint();}},onSelectMonth:value=>{month=value;paint();}};
  body.replaceChildren(renderCollectionProjection(options).element);paintedType=envelope.view.type;[...body.querySelectorAll('.collection-scroll,.collection-board')].forEach((el,i)=>{el.scrollLeft=positions[i]?.[0]??0;el.scrollTop=positions[i]?.[1]??0;});mark();if(focus){const row=[...body.querySelectorAll('[data-record-id]')].find(row=>row.dataset.recordId===focus);(row?.nodeName==='BUTTON'?row:row?.querySelector('.record-title'))?.focus({preventScroll:true});}restoreCalendarFocus(document,body,calendarFocus);
 }
 function mark(){for(const row of body.querySelectorAll('[data-record-id]')){row.classList.toggle('record-selected',row.dataset.recordId===selected);row.setAttribute('aria-selected',String(row.dataset.recordId===selected));}}
 function drainView(){if(refreshPending&&!queuedView){refreshPending=false;queueMicrotask(()=>void refresh());}const queued=queuedView;queuedView=null;if(queued)void switchView(queued.type).then(queued.resolve);}
 async function refresh(force=false,seed=null){
  if(!current()||document.hidden&&!force)return;if(busy){refreshPending=true;return;}const block=getBlock();if(!block)return;busy=true;const marker=++generation;
  try{if(seed?.error)throw Object.assign(Error(seed.error.code),{status:seed.error.status});const view=structuredClone(viewForBlock()),value=validatePlacementQuery(seed??await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/collections/'+encodeURIComponent(block.data.collectionId)+'/query',{method:'POST',body:{view},signal:lifetime.signal}),workspaceId,block.data.collectionId,view);if(!current()||marker!==generation||getBlock()!==block||JSON.stringify(viewForBlock())!==JSON.stringify(view))return;
   if(value.collection.properties.some(property=>property.type==='person')){if(Array.isArray(value.people))people=value.people;else{const result=await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/pages/'+encodeURIComponent(value.pageId)+'/people',{signal:lifetime.signal});people=result.people??[];}}
   if(!current()||marker!==generation||getBlock()!==block)return;const next=JSON.stringify([value.collection,value.view,value.chart,people,block.data.visiblePropertyIds]);envelope=value;viewMemory.set(value.view.type,value.view);status.textContent=fieldT(value.view.type);if(force||next!==signature){signature=next;paint();}await onRevision?.(value.revision);
  }catch(error){if(!current()||marker!==generation)return;if([400,401,403,404].includes(error.status)){envelope=null;people=[];signature='';body.replaceChildren();title.textContent=t('inlineDatabase.title');add.disabled=true;settings.disabled=!canConfigure();if(error.status!==400)onAccessLost?.();}status.textContent=t(error.status===400?'inlineDatabase.configurationChanged':'inlineDatabase.unavailable');}
  finally{busy=false;if(current())controls();drainView();}
 }
 async function switchView(type){
  if(!current()||!envelope||!DATABASE_QUICK_VIEWS.includes(type))return false;if(busy){queuedView?.resolve(false);return new Promise(resolve=>{queuedView={type,resolve};});}if(envelope.view.type===type)return false;const block=getBlock(),before=JSON.stringify(block.data.view),view=databaseViewForType(viewForBlock(),envelope.collection.properties,type,previousView(type)),focus=document.activeElement;if(!view)return false;
  busy=true;controls();const marker=++generation;
  try{const value=validatePlacementQuery(await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/collections/'+encodeURIComponent(block.data.collectionId)+'/query',{method:'POST',body:{view},signal:lifetime.signal}),workspaceId,block.data.collectionId,view);if(!current()||marker!==generation||getBlock()!==block||JSON.stringify(block.data.view)!==before)return false;
   await onRevision?.(value.revision);if(!current()||marker!==generation||getBlock()!==block||JSON.stringify(block.data.view)!==before)return false;
   if(canConfigure()&&onChangeView){if(await onChangeView(view,value.revision)===false)return false;previewView=null;}else{previewView=view;previewBaseline=before;}
   if(!current()||marker!==generation||getBlock()!==block)return false;envelope=value;viewMemory.set(type,view);signature='';status.textContent=fieldT(type);paint();return true;
  }catch(error){if(current()&&marker===generation){if([401,403,404].includes(error.status)){envelope=null;body.replaceChildren();title.textContent=t('inlineDatabase.title');onAccessLost?.();}status.textContent=t('inlineDatabase.switchFailed');}return false;}
  finally{busy=false;if(current()){controls();if(focus===viewButtons.get(type)&&(!document.activeElement||document.activeElement===document.body||!document.activeElement.isConnected))focus.focus({preventScroll:true});}drainView();}
 }
 const wake=event=>{if(event?.detail&&event.detail.workspaceId!==workspaceId)return;void refresh();};globalThis.window.addEventListener('yumunio:content-changed',wake,{signal:lifetime.signal});
 timer=setInterval(wake,10000);const destroy=()=>{clearInterval(timer);lifetime.abort();generation++;queuedView?.resolve(false);queuedView=null;};signal?.addEventListener('abort',destroy,{once:true});const ready=refresh(true,initialRead);
 return{root,ready,refresh,switchView,destroy,matchesBlock:block=>block?.type==='database'&&paintedConfig===config(block),updatePresentation(){updatePresentation();controls();},captureState(){if(paintedType)scrollMemory.set(paintedType,[...body.querySelectorAll('.collection-scroll,.collection-board')].map(el=>[el.scrollLeft,el.scrollTop]));return structuredClone({month,selected,scrollMemory:[...scrollMemory]});},get envelope(){return envelope;}};
}
