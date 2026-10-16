import {validateCollectionEnvelope,monthCells,timelineRange,effectivePropertyType,isComputedProperty} from './collections-model.js';
import {collectionBoardModel,prepareBoardOrderMove} from './board-move-model.js';
import {renderRecordCollectionValue,renderCollectionValue} from './collection-fields.js';
import {renderCollectionChart} from './collections-chart.js';
import {feedWindow,FEED_WINDOW_SIZE} from './collections-feed-model.js';

export function boardProjectionError(code){return({BOARD_COMPUTED_GROUP:'boardComputed',BOARD_REFERENCE_GROUP:'boardReference',BOARD_UNSUPPORTED_GROUP:'boardUnsupported',BOARD_REDACTED_GROUP:'boardRedacted',BOARD_READ_ONLY:'boardReadOnly',BOARD_ORDER_READ_ONLY:'boardOrderReadOnly',BOARD_SORTED:'boardSorted',BOARD_ROW_UNAVAILABLE:'boardTargetUnavailable',BOARD_TARGET_UNAVAILABLE:'boardTargetUnavailable',BOARD_INVALID_RESPONSE:'invalidResponse'})[code]??'boardTargetUnavailable';}

/** Shared view DOM. Authentication, mutations and dialog ownership remain with its host. */
export function renderCollectionProjection(options){
 const {document,envelope,t,locale='ja',month=new Date().toISOString().slice(0,7),people=[],pages=[],onEdit,onOpenPage,pageHref,onSource,onTrash,onBoardMove,onMonth,tableRow,tableHeader,canTrash=()=>false,blocked=()=>false,mutationBlocked=blocked,available=()=>true,getScope=()=>envelope,onBoardDrop}=options;
 const data=validateCollectionEnvelope(envelope,{workspaceId:envelope?.collection?.workspaceId,collectionId:envelope?.collection?.id}),collection=data.collection,type=data.view?.type??'table';
 const node=(tag,attributes={},children=[])=>{const result=document.createElement(tag);for(const[key,value]of Object.entries(attributes)){if(value===undefined||value===null||value===false)continue;if(key.startsWith('on'))result.addEventListener(key.slice(2).toLowerCase(),value);else if(['disabled','checked','value'].includes(key))result[key]=value;else result.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(child?.nodeType?child:document.createTextNode(String(child)));return result;};
 const button=(key,action,{disabled=false,literal=false,className='button'}={})=>node('button',{type:'button',class:className,disabled:disabled||blocked(),onClick:()=>{if(available()&&!blocked()&&!disabled)action?.();}},literal?key:t(key));
 const value=(record,property)=>options.renderValue?.(record,property)??renderRecordCollectionValue({document,record,property,people,pages,t});
 const display=(property,input)=>renderCollectionValue({document,property,value:input,people,pages,t});
 const label=(property,input)=>input===null?t('empty'):input===''?t('emptyText'):property.type==='checkbox'?t(input?'yes':'no'):String(input);
 const pageLink=(record,{title=false,className='button'}={})=>pageHref?node('a',{class:className,href:pageHref(record)},title?record.title||t('untitled'):t('openPage')):button(title?record.title||t('untitled'):'openPage',()=>onOpenPage?.(record),{literal:title,className});
 const actions=(record,boardModel)=>node('div',{class:'record-controls'},[
  ...(boardModel&&onBoardMove?[button('boardMove',()=>onBoardMove(record,boardModel),{disabled:mutationBlocked()||!boardModel.canMove(record.id)})]:[]),
  ...(onEdit?[button('edit',()=>onEdit(record),{disabled:mutationBlocked()||!record.capabilities.some(value=>['editBody','editRecordValues'].includes(value))})]:[]),
  ...(onOpenPage||pageHref?[pageLink(record)]:[]),...(onSource?[button('sourceCells',()=>onSource(record))]:[]),
  ...(onTrash?[button('trash',()=>onTrash(record),{disabled:mutationBlocked()||!canTrash(record)})]:[])
 ]);
 function card(record,{compact=false,boardModel=null}={}){
  const result=node('article',{class:'collection-card',...(boardModel?{'data-board-dnd-card':record.id,'data-board-dnd-label':record.title||t('untitled')}:{})});
  const title=button(record.title||t('untitled'),()=>onEdit?onEdit(record):onOpenPage?.(record),{literal:true,className:'record-title'});
  if(boardModel){const handle=node('button',{type:'button',class:'board-dnd-handle','data-board-dnd-handle':'','aria-label':t('boardDndHandle',{text:record.title||t('untitled')}),title:t('boardDndInstructions'),disabled:!boardModel.canReorder(record.id)||mutationBlocked()||typeof onBoardDrop!=='function'},'\u283f');result.append(node('div',{class:'collection-card-heading'},[title,handle]));}else result.append(title);
  if(!compact)result.append(node('dl',{},collection.properties.slice(0,6).map(property=>node('div',{},[node('dt',{},property.name),node('dd',{},value(record,property))]))));
  result.append(actions(record,boardModel));if(boardModel&&!boardModel.canMove(record.id))result.append(node('p',{class:'hint board-move-reason'},t(boardProjectionError(boardModel.reasonFor(record.id)))));return result;
 }
 function table(){
  const headings=tableHeader?.()??[node('th',{scope:'col'},t('recordTitle')),...collection.properties.map(property=>node('th',{scope:'col'},[property.name,node('small',{},isComputedProperty(property)?t(property.type)+' · '+t(effectivePropertyType(property)):t(property.type))])),node('th',{scope:'col'},t('actions'))];
  const rows=collection.records.map((record,index)=>tableRow?.(record,index,{readOnly:mutationBlocked()})??node('tr',{},[node('th',{scope:'row'},button(record.title||t('untitled'),()=>onEdit?onEdit(record):onOpenPage?.(record),{literal:true,className:'record-title'})),...collection.properties.map(property=>node('td',{},value(record,property))),node('td',{},actions(record))]));
  return node('div',{class:'collection-scroll',tabindex:'0','aria-label':t('table')},node('table',{class:'typed-table collection-table'},[node('thead',{},node('tr',{},headings)),node('tbody',{},rows)]));
 }
 let board=null;
 function boardView(){
  const model=collectionBoardModel(data),targets=new Map(),outer=node('section',{class:'board-projection'}),columns=node('div',{class:'collection-board',tabindex:'0','aria-label':t('board')});
  outer.append(node('p',{class:'hint'},t(model.reason?boardProjectionError(model.reason):data.view.sorts.length?'boardSorted':!data.capabilities.includes('manage')?'boardOrderReadOnly':'boardDragHint')));
  // Moving a card may change record order; configured select columns keep their schema order.
  const optionOrder=new Map((model.property.options??[]).map((value,index)=>[value,index]));
  const groups=model.property.type==='select'?[...model.groups].sort((left,right)=>(optionOrder.get(left.value)??Number.MAX_SAFE_INTEGER)-(optionOrder.get(right.value)??Number.MAX_SAFE_INTEGER)):model.groups;
  for(const[index,group]of groups.entries()){
   const targetAllowed=model.targets.some(input=>JSON.stringify(input)===JSON.stringify(group.value)),column=node('section',{class:'collection-column','data-board-dnd-column':''},[node('h3',{},[display(model.property,group.value),node('span',{},String(group.records.length))])]);
   for(const[rowIndex,record]of group.records.entries()){const element=card(record,{boardModel:model});if(targetAllowed){const key='group-'+index+'-before-'+rowIndex;targets.set(key,{targetValue:group.value,beforeRecordId:record.id});element.setAttribute('data-board-dnd-target',key);element.setAttribute('data-board-dnd-label',t('boardDropBefore',{group:label(model.property,group.value),text:record.title||t('untitled')}));}column.append(element);}
   if(targetAllowed){const key='group-'+index+'-end';targets.set(key,{targetValue:group.value,beforeRecordId:null});column.append(node('div',{class:'board-drop-end','data-board-dnd-target':key,'data-board-dnd-label':t('boardDropEnd',{group:label(model.property,group.value)})},node('span',{},t(group.records.length?'boardAtEnd':'boardEmptyGroup'))));}else if(!group.records.length)column.append(node('p',{class:'hint board-empty-group'},t('boardEmptyGroup')));columns.append(column);
  }
  outer.append(columns);
  board={root:outer,getScope:()=>available()&&!blocked()?getScope():null,canMove:recordId=>typeof onBoardDrop==='function'&&available()&&!blocked()&&model.canReorder(recordId),canDrop:(recordId,key)=>{if(typeof onBoardDrop!=='function'||!available()||blocked()||!targets.has(key))return false;try{return!!prepareBoardOrderMove(data,{recordId,...targets.get(key)});}catch{return false;}},onCommit:({recordId,targetKey})=>available()&&!blocked()&&targets.has(targetKey)&&typeof onBoardDrop==='function'?onBoardDrop({recordId,...targets.get(targetKey)}):false,labels:(key,values)=>t('boardDnd'+key[0].toUpperCase()+key.slice(1),values)};
  return outer;
 }
 function datedView(){
  const view=data.view,property=collection.properties.find(item=>item.id===view.datePropertyId),end=collection.properties.find(item=>item.id===view.endDatePropertyId),cells=monthCells(month),outer=node('section');
  outer.append(node('div',{class:'calendar-toolbar'},[button('previousMonth',()=>onMonth?.(-1)),node('strong',{},month),button('nextMonth',()=>onMonth?.(1))]));
  if(type==='calendar'){
   const grid=node('div',{class:'collection-calendar'},[...Array.from({length:7},(_,index)=>node('div',{class:'calendar-weekday'},new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,4+index))))),...Array.from({length:cells.offset},()=>node('div',{class:'calendar-day','aria-hidden':'true'})),...cells.dates.map(date=>node('div',{class:'calendar-day'},[node('time',{datetime:date},String(Number(date.slice(8)))),...collection.records.filter(record=>record.values[property.id]===date).map(record=>button(record.title||t('untitled'),()=>onEdit?onEdit(record):onOpenPage?.(record),{literal:true,className:'record-title'}))]))]);outer.append(node('div',{class:'collection-scroll',tabindex:'0','aria-label':t('calendar')},grid));
  }else{
   const timeline=node('div',{class:'timeline'});timeline.style.setProperty('--timeline-days',String(cells.days));timeline.append(node('div',{class:'timeline-head'},[node('span',{},t('recordTitle')),...cells.dates.map(date=>node('span',{},date.slice(8)))]));
   for(const record of collection.records){const range=timelineRange(record.values[property.id],record.values[end.id],month),track=node('div',{class:'timeline-track'});if(range){const bar=node('div',{class:'timeline-bar',title:record.values[property.id]+' → '+record.values[end.id]},record.title);bar.style.gridColumn=range.start+' / '+(range.end+1);track.append(bar);}else track.append(node('span',{class:'timeline-outside'},t('outsideRange')));timeline.append(node('div',{class:'timeline-row'},[button(record.title||t('untitled'),()=>onEdit?onEdit(record):onOpenPage?.(record),{literal:true,className:'record-title timeline-label'}),track]));}outer.append(node('div',{class:'collection-scroll',tabindex:'0','aria-label':t('timeline')},timeline));
  }
  const undated=collection.records.filter(record=>!record.values[property.id]);if(undated.length)outer.append(node('section',{class:'calendar-undated'},[node('h3',{},t('undated')),...undated.map(record=>card(record,{compact:true}))]));return outer;
 }
 function feed(shown=FEED_WINDOW_SIZE){
  const window=feedWindow(collection,{shown}),section=node('section',{class:'collection-feed','aria-label':t('feed')});section.append(node('p',{class:'hint'},t('feedBoundary')));
  if(!window.cards.length)section.append(node('p',{class:'collection-empty'},t('noRecords')));
  for(const item of window.cards){const record=collection.records.find(row=>row.id===item.id),article=node('article',{class:'feed-card'},node('h3',{},pageLink(record,{title:true,className:'feed-title record-title'})));article.append(node('dl',{},item.fields.map(field=>node('div',{},[node('dt',{},field.name),node('dd',{},field.errorCode?node('span',{class:'field-error'},t(field.errorCode)):field.redacted?t('unavailableReference'):field.kind==='formula'&&field.valueType==='text'&&field.value===''?node('span',{class:'hint'},t('formulaEmptyText')):display({type:field.valueType},field.value))]))),actions(record));section.append(article);}
  section.append(node('p',{class:'feed-window-status',role:'status'},t('feedShown',{shown:window.shown,total:window.total})));
  if(window.hasMore)section.append(button('feedShowMore',()=>{const next=feed(Math.min(1000,shown+FEED_WINDOW_SIZE));section.replaceWith(next);const focus=next.querySelectorAll('.feed-card h3')[window.shown]??next.querySelector('.feed-window-status');focus?.setAttribute('tabindex','-1');focus?.focus();}));return section;
 }
 function projection(){
  if(type==='feed')return feed();
  if(type==='chart')return renderCollectionChart({chart:data.chart,view:data.view,properties:collection.properties,document,labels:{boundary:t('chartBoundary'),title:data.view.name,description:t('chartDescription'),empty:t('noRecords'),emptyGroup:t('empty'),yes:t('yes'),no:t('no'),noNumbers:t('chartNoNumbers'),donut:t('chartDonut'),zeroTotal:t('chartZeroTotal'),tableTitle:t('chartTable'),group:t('chartGroup'),value:t(data.view.chart.aggregation==='average'?'chartAverage':data.view.chart.aggregation==='sum'?'chartSum':'chartCount'),count:t('chartRowCount'),numericCount:t('chartNumericCount'),reasons:Object.fromEntries(['CHART_INPUT_UNAVAILABLE','CHART_GROUP_LIMIT','CHART_NUMBER_RANGE','CHART_NEGATIVE_DONUT'].map(code=>[code,t(code)]))}});
  if(!collection.records.length&&type!=='board'&&type!=='table')return node('p',{class:'collection-empty'},t('noRecords'));
  if(type==='table')return table();if(type==='board')return boardView();if(type==='calendar'||type==='timeline')return datedView();return node('div',{class:type==='gallery'?'collection-gallery':'collection-list'},collection.records.map(record=>card(record,{compact:type==='list'})));
 }
 const element=node('div',{class:'collection-projection','data-collection-view-type':type},projection());return{element,board};
}
