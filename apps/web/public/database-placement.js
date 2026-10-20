import {renderCollectionProjection} from './collection-projection.js';
import {validateCollectionEnvelope,VIEW_TYPES,FILTER_OPERATORS,effectivePropertyType} from './collections-model.js';
import {createCollectionValueInput} from './collection-fields.js';

export function defaultDatabaseView(name='Table'){return{name,type:'table',filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null};}

/** Settings belong to the block, never to a saved view on the source collection. */
export function createDatabaseViewSettings({document,properties,view,visiblePropertyIds,people=[],pages=[],t}){
 const node=(tag,attrs={},children=[])=>{const element=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key==='value'||key==='checked')element[key]=value;else element.setAttribute(key,value);}for(const child of Array.isArray(children)?children:[children])element.append(child?.nodeType?child:document.createTextNode(String(child)));return element;};
 const field=(label,input)=>node('label',{class:'field'},[label,input]);
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
export function mountDatabasePlacement({root,getBlock,workspaceId,request,isCurrent,canConfigure,t,fieldT,onConfigure,onNewRecord,onOpenRecord,onRevision,onAccessLost,signal}){
 const document=root.ownerDocument,lifetime=new AbortController();let envelope=null,people=[],generation=0,busy=false,selected=null,month=new Date().toISOString().slice(0,7),signature='',timer;
 const current=()=>!lifetime.signal.aborted&&root.isConnected&&isCurrent();
 const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
 const heading=node('div','database-placement-toolbar'),title=node('strong'),status=node('span','hint'),tools=node('div','database-placement-actions'),body=node('div','database-placement-body');
 const action=(label,fn)=>{const button=node('button','button quiet',label);button.type='button';button.addEventListener('click',()=>{if(current())void fn();});tools.append(button);return button;};
 const settings=action(t('inlineDatabase.settings'),()=>onConfigure(envelope));const add=action(t('inlineDatabase.newRecord'),()=>onNewRecord(envelope));action(t('inlineDatabase.refresh'),()=>refresh(true));heading.append(title,tools);root.append(heading,status,body);
 function paint(){
  if(!envelope)return;const block=getBlock();if(!block)return;
  title.textContent=envelope.collection.title;settings.disabled=!canConfigure();add.disabled=!envelope.capabilities.includes('manage');
  const positions=[...body.querySelectorAll('.collection-scroll,.collection-board')].map(el=>[el.scrollLeft,el.scrollTop]),focus=document.activeElement?.closest?.('[data-record-id]')?.dataset.recordId;
  const options={document,envelope,t:fieldT,people,month,visiblePropertyIds:block.data.visiblePropertyIds,selectedRecordId:selected,onOpenRecord:record=>{selected=record.id;mark();void onOpenRecord(record,envelope.collection.id);},onOpenPage:record=>onOpenRecord(record,envelope.collection.id),pageHref:record=>'/workspace?'+new URLSearchParams({workspace:workspaceId,page:record.pageId}),onMonth:offset=>{const date=new Date(month+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);month=date.toISOString().slice(0,7);paint();}};
  body.replaceChildren(renderCollectionProjection(options).element);[...body.querySelectorAll('.collection-scroll,.collection-board')].forEach((el,i)=>{el.scrollLeft=positions[i]?.[0]??0;el.scrollTop=positions[i]?.[1]??0;});mark();if(focus)body.querySelector('[data-record-id="'+focus+'"] .record-title')?.focus({preventScroll:true});
 }
 function mark(){for(const row of body.querySelectorAll('[data-record-id]')){row.classList.toggle('record-selected',row.dataset.recordId===selected);row.setAttribute('aria-selected',String(row.dataset.recordId===selected));}}
 async function refresh(force=false){
  if(!current()||busy||document.hidden&&!force)return;const block=getBlock();if(!block)return;busy=true;const marker=++generation;
  try{const value=validateCollectionEnvelope(await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/collections/'+encodeURIComponent(block.data.collectionId)+'/query',{method:'POST',body:{view:block.data.view},signal:lifetime.signal}),{workspaceId,collectionId:block.data.collectionId});if(!current()||marker!==generation||getBlock()!==block)return;
   if(value.collection.properties.some(property=>property.type==='person')){const result=await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/pages/'+encodeURIComponent(value.pageId)+'/people',{signal:lifetime.signal});people=result.people??[];}
   if(!current()||marker!==generation||getBlock()!==block)return;const next=JSON.stringify([value.collection,value.view,value.chart,people,block.data.visiblePropertyIds]);envelope=value;status.textContent=fieldT(value.view.type);if(force||next!==signature){signature=next;paint();}await onRevision?.(value.revision);
  }catch(error){if(!current()||marker!==generation)return;if([400,401,403,404].includes(error.status)){envelope=null;people=[];signature='';body.replaceChildren();title.textContent=t('inlineDatabase.title');add.disabled=true;settings.disabled=!canConfigure();if(error.status!==400)onAccessLost?.();}status.textContent=t(error.status===400?'inlineDatabase.configurationChanged':'inlineDatabase.unavailable');}
  finally{busy=false;}
 }
 const wake=()=>void refresh();globalThis.window.addEventListener('focus',wake,{signal:lifetime.signal});globalThis.window.addEventListener('yumunio:content-changed',wake,{signal:lifetime.signal});
 timer=setInterval(wake,10000);const destroy=()=>{clearInterval(timer);lifetime.abort();generation++;};signal?.addEventListener('abort',destroy,{once:true});const ready=refresh(true);
 return{ready,refresh,destroy,get envelope(){return envelope;}};
}
