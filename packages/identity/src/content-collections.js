import {validateChartDefinition,chartInputsAvailable,aggregateChart,validateBoardOrder,orderedBoardIds,mergeVisibleBoardOrder,moveVisibleBoardRecord} from '@yumunio/domain';
import {validateRollupTargets,projectRollupValues,projectRollupProperties} from './content-rollups.js';
import {assertId,assertPlainObject,assertJsonSerializable,assertTitle,assertTimestamp,validateCollection,validatePropertyDefinitions,validatePropertyValues,validatePropertyValue,createPageAccessEvaluator,compileFormulaProperties,evaluateFormulaRow} from '@yumunio/domain';
import {handlePageLifecycle} from './content-pages.js';
import {rememberPage,trimHistory} from './content-history.js';
import {invalidateRooms} from './content-room.js';
import {handlePropertyConversion} from './content-property-conversions.js';
import {recordAssignments,pruneAssignmentNotifications} from './content-activity.js';
import {validateCollectionTemplates,readableTemplate,applyCollectionTemplate,handleCollectionTemplates} from './collection-templates.js';
export class ContentCollectionsError extends Error{constructor(code='INVALID_CONTENT',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code='INVALID_CONTENT',status=400)=>{throw new ContentCollectionsError(code,status);};
const missing=()=>fail('CONTENT_NOT_FOUND',404),conflict=()=>fail('CONTENT_CONFLICT',409);
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
function exact(value,allowed,required=allowed){assertJsonSerializable(value);assertPlainObject(value);if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail();return value;}
function revision(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('INVALID_REVISION');}
const own=(value,key)=>Object.hasOwn(value,key);
function definitions(value){if(Array.isArray(value)&&value.length>128)fail('CONTENT_TOO_LARGE',413);try{validatePropertyDefinitions(value);}catch(error){if(error?.details?.formulaCode)fail(error.details.formulaCode);if(error?.details?.rollupCode)fail(error.details.rollupCode);throw error;}if(value.length>128)fail('CONTENT_TOO_LARGE',413);for(const property of value){exact(property,property.type==='formula'?['id','name','type','required','formula']:property.type==='rollup'?['id','name','type','required','rollup']:['id','name','type','options','required'],property.type==='formula'?['id','name','type','formula']:property.type==='rollup'?['id','name','type','rollup']:['id','name','type']);if((property.options?.length??0)>128)fail('CONTENT_TOO_LARGE',413);}return value;}
function effectiveProperty(property){return ['formula','rollup'].includes(property?.type)?{id:property.id,name:property.name,type:property[property.type].resultType,required:false}:property?.type==='status'?{...property,type:'select'}:property?.type==='url'?{...property,type:'text'}:property;}
function rejectComputedWrites(properties,values){if(properties.some(property=>['formula','rollup','created_time','last_edited_time'].includes(property.type)&&own(values,property.id)))fail('COMPUTED_PROPERTY_READ_ONLY');}
const formulaPrograms=new WeakMap();
function programFor(entry,context){let entries=formulaPrograms.get(context);if(!entries){entries=new WeakMap();formulaPrograms.set(context,entries);}const existing=entries.get(entry);if(existing?.properties===entry.collection.properties)return existing.program;const program=compileFormulaProperties(entry.collection.properties);entries.set(entry,{properties:entry.collection.properties,program});return program;}
function sourceDefinitions(entry){return entry.sourceProperties??entry.collection.properties;}
function sourceValues(properties,values){exact(values,properties.map(property=>property.id));if(Object.values(values).some(value=>typeof value!=='string'))fail();}
const viewTypes=new Set(['table','board','list','gallery','calendar','timeline','chart','feed']);
const scalarGroups=new Set(['text','number','checkbox','date','select','person']);
const operators={text:['eq','neq','contains','empty','not_empty'],number:['eq','neq','lt','lte','gt','gte','empty','not_empty'],checkbox:['eq','neq','empty','not_empty'],date:['eq','neq','lt','lte','gt','gte','empty','not_empty'],select:['eq','neq','empty','not_empty'],multi_select:['contains','empty','not_empty'],person:['eq','neq','empty','not_empty'],relation:['contains','empty','not_empty']};
operators.created_time=operators.last_edited_time=operators.date;
function viewDefinition(view,properties,{hasId=true}={}){
  exact(view,['id','name','type','filters','sorts','groupBy','datePropertyId','endDatePropertyId','chart',...(hasId?['boardOrder']:[])],hasId?['id','name','type','filters','sorts','groupBy','datePropertyId','endDatePropertyId']:['name','type','filters','sorts','groupBy','datePropertyId','endDatePropertyId']);
  if(hasId)assertId(view.id);else if(own(view,'id'))fail();
  if(typeof view.name!=='string'||!view.name.trim()||view.name.length>128||!viewTypes.has(view.type)||!Array.isArray(view.filters)||view.filters.length>20||!Array.isArray(view.sorts)||view.sorts.length>5)fail();
  const byId=new Map(properties.map(property=>[property.id,property]));
  for(const filter of view.filters){exact(filter,['propertyId','operator','value'],['propertyId','operator']);const property=effectiveProperty(byId.get(filter.propertyId));if(!property||!operators[property.type].includes(filter.operator))fail();
    if(['empty','not_empty'].includes(filter.operator)){if(own(filter,'value'))fail();}
    else{if(!own(filter,'value')||filter.value===null)fail();if(property.type==='multi_select'){if(typeof filter.value!=='string'||!property.options.includes(filter.value))fail();}
      else if(property.type==='relation')assertId(filter.value);else if(['created_time','last_edited_time'].includes(property.type))assertTimestamp(filter.value);else validatePropertyValue({...property,required:false},filter.value);}}
  const sorts=new Set();for(const sort of view.sorts){exact(sort,['propertyId','direction']);if(!byId.has(sort.propertyId)||sorts.has(sort.propertyId)||!['asc','desc'].includes(sort.direction))fail();sorts.add(sort.propertyId);}
  if(view.groupBy!==null){const property=effectiveProperty(byId.get(view.groupBy));if(!property||!scalarGroups.has(property.type))fail();}
  for(const field of ['datePropertyId','endDatePropertyId'])if(view[field]!==null&&effectiveProperty(byId.get(view[field]))?.type!=='date')fail();
  if(view.type==='board'&&view.groupBy===null||view.type==='feed'&&view.groupBy!==null)fail();
  if(['calendar','timeline'].includes(view.type)){if(view.datePropertyId===null||view.type==='timeline'&&view.endDatePropertyId===null)fail();}
  else if(view.datePropertyId!==null||view.endDatePropertyId!==null)fail();
  if(view.type==='chart'){try{validateChartDefinition(view,properties);}catch{fail();}}else if(own(view,'chart'))fail();
  if(own(view,'boardOrder')){if(view.type!=='board')fail();try{validateBoardOrder(view.boardOrder);}catch{fail();}}
  return view;
}
export function validateAccountCollections(entries,pages,workspaceId){
  if(!Array.isArray(entries)||entries.length>1000)fail();const ids=new Set(),pageBindings=new Set();
  for(const entry of entries){exact(entry,['collection','pageId','recordPages','sourceHeaders','sourceProperties','views','templates'],['collection','pageId','recordPages','sourceHeaders']);
    const collection=entry.collection;exact(collection,['id','workspaceId','title','properties','records','createdAt','updatedAt']);validateCollection(collection);definitions(collection.properties);assertId(entry.pageId);
    if(collection.workspaceId!==workspaceId||ids.has(collection.id)||!pages.has(entry.pageId)||pageBindings.has(entry.pageId)||!Array.isArray(entry.recordPages)||entry.recordPages.length!==collection.records.length||!Array.isArray(entry.sourceHeaders)||entry.sourceHeaders.some(value=>typeof value!=='string'))fail();
    ids.add(collection.id);pageBindings.add(entry.pageId);
    const baseline=sourceDefinitions(entry);definitions(baseline);if(baseline.some(property=>property.type!=='text')||entry.sourceHeaders.length!==baseline.length)fail();
    const records=new Map();for(const row of collection.records){exact(row,['id','values']);records.set(row.id,row);}
    const bound=new Set();for(const row of entry.recordPages){exact(row,['recordId','pageId','sourceValues','sourceKind'],['recordId','pageId','sourceValues']);assertId(row.recordId);assertId(row.pageId);
      if(!records.has(row.recordId)||bound.has(row.recordId)||!pages.has(row.pageId)||pageBindings.has(row.pageId)||pages.get(row.pageId).page.parentId!==entry.pageId)fail();
      if(own(row,'sourceKind')&&row.sourceKind!=='manual')fail();sourceValues(row.sourceKind==='manual'?[]:baseline,row.sourceValues);bound.add(row.recordId);pageBindings.add(row.pageId);}
    if(own(entry,'views')){if(!Array.isArray(entry.views)||entry.views.length>20)fail();const views=new Set();for(const view of entry.views){viewDefinition(view,collection.properties);if(views.has(view.id)||view.boardOrder?.recordIds.some(id=>!records.has(id)))fail();views.add(view.id);}}
    validateCollectionTemplates(entry,pages,pageBindings,{exact,fail});
  }
}
function checkRollupTargets(properties,context){const error=validateRollupTargets(properties,context);if(error)fail(error.code,error.status);}
function freezeSource(entry){if(!own(entry,'sourceProperties'))entry.sourceProperties=structuredClone(entry.collection.properties);}
function requireManage(context,pageId){if(!context.access(pageId).includes('manage'))missing();}
function visibleAncestors(context,pageId){const byId=new Map(context.payload.pages.map(item=>[item.page.id,item]));let next=pageId;while(next!==null){const item=byId.get(next);if(!item||item.page.trashedAt!==null||!context.access(next).includes('read'))missing();next=item.page.parentId;}}
function knownRecords(payload){return new Set((payload.collections??[]).flatMap(entry=>entry.recordPages.map(row=>row.pageId)));}
function livePeople(context){return new Map(context.saved.principals.filter(principal=>principal.emailVerified).map(principal=>[principal.accountId,principal]));}
function checkReferences(properties,values,context){const people=livePeople(context),records=knownRecords(context.payload),guards=[];
  for(const property of properties){if(!own(values,property.id)||values[property.id]===null)continue;const value=values[property.id];
    if(property.type==='person'){const principal=people.get(value);if(!principal)missing();guards.push({id:principal.id,accountId:principal.accountId,role:principal.role});}
    if(property.type==='relation')for(const pageId of value)if(!records.has(pageId)||!context.access(pageId).includes('read'))missing();}
  return [...new Map(guards.map(guard=>[guard.id,guard])).values()];
}
function projectRecord(entry,row,context){const binding=entry.recordPages.find(item=>item.recordId===row.id),people=livePeople(context),records=knownRecords(context.payload),values=structuredClone(row.values),redacted=[];
  const page=context.payload.pages.find(item=>item.page.id===binding.pageId).page;for(const property of entry.collection.properties)if(property.type==='created_time')values[property.id]=page.createdAt;else if(property.type==='last_edited_time')values[property.id]=page.updatedAt;
  for(const property of entry.collection.properties){if(property.type==='person'&&values[property.id]!==null&&values[property.id]!==undefined&&!people.has(values[property.id])){values[property.id]=null;redacted.push(property.id);}
    if(property.type==='relation'&&Array.isArray(values[property.id])){const before=values[property.id];values[property.id]=before.filter(id=>records.has(id)&&context.access(id).includes('read'));if(values[property.id].length!==before.length)redacted.push(property.id);}}
  const rolled=projectRollupValues(entry,row,context,redacted);Object.assign(values,rolled.values);redacted.push(...rolled.redacted);const computed=evaluateFormulaRow(entry.collection.properties,values,{redactedProperties:redacted,program:programFor(entry,context)});for(const[id,error]of Object.entries(computed.errors))if(error.code==='FORMULA_REDACTED_INPUT'&&!redacted.includes(id))redacted.push(id);
  return{id:row.id,pageId:binding.pageId,title:context.payload.pages.find(item=>item.page.id===binding.pageId).page.title,values:computed.values,...(Object.keys(rolled.errors).length?{rollupErrors:rolled.errors}:{}),...(Object.keys(computed.errors).length?{formulaErrors:computed.errors}:{}),sourceValues:structuredClone(binding.sourceValues),...(binding.sourceKind?{sourceKind:binding.sourceKind}:{}),...(redacted.length?{redactedProperties:redacted}:{}),capabilities:context.access(binding.pageId)};
}
function projectView(view,entry,context){const result=structuredClone(view),people=livePeople(context),records=knownRecords(context.payload);for(const filter of result.filters){const property=entry.collection.properties.find(item=>item.id===filter.propertyId);
  if(own(filter,'value')&&(property.type==='person'&&!people.has(filter.value)||property.type==='relation'&&(!records.has(filter.value)||!context.access(filter.value).includes('read')))){filter.value=null;filter.redacted=true;}}
  if(result.boardOrder){const visible=new Set(entry.collection.records.filter(row=>{const binding=entry.recordPages.find(item=>item.recordId===row.id);return context.access(binding.pageId).includes('read');}).map(row=>projectRecord(entry,row,context)).filter(row=>view.filters.every(filter=>matches(row,filter))).map(row=>row.id));result.boardOrder.recordIds=result.boardOrder.recordIds.filter(id=>visible.has(id));}
  return result;
}
function projectTemplates(entry,context){return(entry.templates??[]).filter(template=>context.access(template.pageId).includes('read')).map(template=>{const row=projectRecord({...entry,recordPages:[{recordId:template.id,pageId:template.pageId,sourceValues:{}}]},{id:template.id,values:template.values},context);return{id:template.id,name:template.name,pageId:template.pageId,values:Object.fromEntries(entry.collection.properties.filter(property=>!['formula','rollup','created_time','last_edited_time'].includes(property.type)).map(property=>[property.id,row.values[property.id]??null])),capabilities:context.access(template.pageId),...(row.redactedProperties?.length?{redactedProperties:row.redactedProperties.filter(id=>entry.collection.properties.some(property=>property.id===id&&['person','relation'].includes(property.type)))}:{})};});}
function compareValue(a,b){if(Array.isArray(a))a=JSON.stringify(a);if(Array.isArray(b))b=JSON.stringify(b);return a===b?0:a<b?-1:1;}
const empty=value=>value===null||value===undefined||value===''||Array.isArray(value)&&value.length===0;
function matches(row,filter){const value=row.values[filter.propertyId]??null;switch(filter.operator){case'empty':return empty(value);case'not_empty':return!empty(value);case'eq':return value===filter.value;case'neq':return value!==filter.value;case'contains':return typeof value==='string'?value.toLocaleLowerCase('en').includes(String(filter.value).toLocaleLowerCase('en')):Array.isArray(value)&&value.includes(filter.value);case'lt':return!empty(value)&&compareValue(value,filter.value)<0;case'lte':return!empty(value)&&compareValue(value,filter.value)<=0;case'gt':return!empty(value)&&compareValue(value,filter.value)>0;case'gte':return!empty(value)&&compareValue(value,filter.value)>=0;default:return false;}}
function projection(entry,context,view=null){let rows=entry.collection.records.filter(row=>{const binding=entry.recordPages.find(item=>item.recordId===row.id);return context.access(binding.pageId).includes('read');}).map(row=>projectRecord(entry,row,context));
  if(view?.type==='board'&&!view.sorts.length){const order=new Map(orderedBoardIds(entry.collection.records.map(row=>row.id),view.boardOrder).map((id,index)=>[id,index]));rows.sort((a,b)=>order.get(a.id)-order.get(b.id));}
  const chartReady=view?.type==='chart'?chartInputsAvailable(rows,projectView(view,entry,context)):true;
  if(view){rows=rows.filter(row=>view.filters.every(filter=>matches(row,filter)));rows.sort((a,b)=>{for(const sort of view.sorts){const x=a.values[sort.propertyId]??null,y=b.values[sort.propertyId]??null;if(x===null&&y!==null)return 1;if(y===null&&x!==null)return-1;const result=compareValue(x,y);if(result)return sort.direction==='asc'?result:-result;}return 0;});}
  const result={revision:context.saved.revision,pageId:entry.pageId,capabilities:context.access(entry.pageId),collection:{...structuredClone(entry.collection),properties:projectRollupProperties(entry.collection.properties,context),title:context.payload.pages.find(item=>item.page.id===entry.pageId).page.title,sourceHeaders:[...entry.sourceHeaders],sourceProperties:structuredClone(sourceDefinitions(entry)),views:(entry.views??[]).map(item=>projectView(item,entry,context)),...(entry.templates?.length?{templates:projectTemplates(entry,context)}:{}),records:rows}};
  if(view?.type==='chart')result.chart=aggregateChart(rows,view,entry.collection.properties,{inputsAvailable:chartReady});
  if(view){result.view=projectView(view,entry,context);if(view.type!=='chart'&&view.groupBy!==null){const groups=new Map();for(const row of rows){const value=row.values[view.groupBy]??null,key=JSON.stringify(value);if(!groups.has(key))groups.set(key,{value,recordIds:[]});groups.get(key).recordIds.push(row.id);}result.groups=[...groups.values()];}}
  return result;
}
function mintFactory(payload,createId){const used=new Set([...payload.pages.map(item=>item.page.id),...payload.grants.map(item=>item.id),...(payload.attachments??[]).map(item=>item.id),...(payload.collections??[]).flatMap(entry=>[entry.collection.id,...entry.collection.properties.map(property=>property.id),...entry.collection.records.map(row=>row.id),...(entry.views??[]).map(view=>view.id),...(entry.templates??[]).map(template=>template.id)])]);return()=>{const id=assertId(createId());if(used.has(id))fail('CONTENT_UNAVAILABLE',503);used.add(id);return id;};}
function privatePage(context,{title,parentId,inheritPermissions,mint}){assertTitle(title);const stamp=context.now(),pageId=mint();const item={page:{id:pageId,workspaceId:context.workspaceId,title,parentId,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId,workspaceId:context.workspaceId,version:1,blocks:[],updatedAt:stamp},inheritPermissions};context.payload.pages.push(item);
  const grantId=mint();context.payload.grants.push({id:grantId,workspaceId:context.workspaceId,pageId,accountId:context.accountId,permission:'full',includeDescendants:true,status:'active'});context.payload.grantBindings.push({grantId,membershipId:context.actor.id});return item;}
function invalidateDocument(context,item,title){if(item.document.version>=Number.MAX_SAFE_INTEGER)conflict();invalidateRooms(context.payload,[item.page.id]);rememberPage(context.payload,item,{actorId:context.accountId,kind:'edit',now:context.now,createId:context.createId});const stamp=context.now();item.page.title=title;item.page.updatedAt=stamp;item.document.version++;item.document.updatedAt=stamp;trimHistory(context.payload);}
async function commit(context,{guards=[],authorizeFresh=()=>{},result,status=200}){guards=[...new Map(guards.map(guard=>[guard.id,guard])).values()];if(guards.length>16)fail('CONTENT_TOO_LARGE',413);const captured=context.validatePayload(context.payload,context.workspaceId);try{const written=await context.store.write(context.workspaceId,context.accountId,{expectedRevision:context.saved.revision,payload:captured,actorMembershipId:context.actor.id,actorRole:context.actor.role,guardMemberships:guards});return json({revision:written.revision,...result},status);}
  catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;const saved=await context.store.read(context.workspaceId,context.accountId),actor=saved?.principals.find(row=>row.accountId===context.accountId&&row.id===context.actor.id&&row.emailVerified&&row.role===context.actor.role);if(!actor)missing();const payload=context.readPayload(saved,context.workspaceId),evaluate=createPageAccessEvaluator(context.policy(payload,saved.principals,context.workspaceId)),fresh={...context,saved,payload,actor,access:pageId=>evaluate({accountId:context.accountId,workspaceId:context.workspaceId,pageId}).capabilities};authorizeFresh(fresh);conflict();}}function latestAccess(context,{includeTrash=false}={}){const state=context.policy(context.payload,context.saved.principals,context.workspaceId);if(includeTrash)state.pages=state.pages.map(page=>({...page,trashedAt:null}));const evaluate=createPageAccessEvaluator(state);return{...context,access:pageId=>evaluate({accountId:context.accountId,workspaceId:context.workspaceId,pageId}).capabilities};}
function manageRows(context,entry){requireManage(context,entry.pageId);const underlying=latestAccess(context,{includeTrash:true});for(const binding of entry.recordPages)requireManage(underlying,binding.pageId);}
function entryIn(context,collectionId){const entry=context.payload.collections?.find(item=>item.collection.id===collectionId);if(!entry||!context.access(entry.pageId).includes('read'))missing();return entry;}
function guardsForViews(view,entry,context){const guards=[];for(const filter of view.filters){const property=entry.collection.properties.find(item=>item.id===filter.propertyId);if(!own(filter,'value')||!['person','relation'].includes(property.type))continue;guards.push(...checkReferences([property],{[property.id]:property.type==='relation'?[filter.value]:filter.value},context));}return[...new Map(guards.map(guard=>[guard.id,guard])).values()];}
function prepareBoardWrite(context,entry,view,move){
 exact(move,['recordId','targetValue','beforeRecordId','visibleRecordIds']);assertId(move.recordId);if(move.beforeRecordId!==null)assertId(move.beforeRecordId);
 if(view?.type!=='board')fail('BOARD_NOT_BOARD');if(view.sorts.length)fail('BOARD_SORTED',409);
 const property=entry.collection.properties.find(property=>property.id===view.groupBy);if(!property||!['text','number','checkbox','date','select','status'].includes(property.type))fail('BOARD_UNSUPPORTED_GROUP');
 validatePropertyValue(property,move.targetValue);
 const visible=projection(entry,context,view).collection.records,row=visible.find(row=>row.id===move.recordId),binding=entry.recordPages.find(item=>item.recordId===move.recordId);
 if(!row||!binding||!context.access(binding.pageId).includes('editRecordValues')||row.redactedProperties?.includes(property.id))missing();
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 if(!visible.some(row=>same(row.values[property.id],move.targetValue))&&!(['select','status'].includes(property.type)&&property.options?.some(value=>same(value,move.targetValue)))&&!(property.type==='checkbox'&&typeof move.targetValue==='boolean')&&move.targetValue!==null)missing();
 if(!Array.isArray(move.visibleRecordIds)||!same(visible.map(row=>row.id),move.visibleRecordIds))conflict();
 let desired;try{desired=moveVisibleBoardRecord(visible,{...move,groupBy:property.id});}catch{fail('INVALID_BOARD_ORDER');}
 if(same(row.values[property.id],move.targetValue)&&same(desired,move.visibleRecordIds))fail('BOARD_UNCHANGED',409);
 return{row:entry.collection.records.find(row=>row.id===move.recordId),binding,property,desired,order:mergeVisibleBoardOrder(orderedBoardIds(entry.collection.records.map(row=>row.id),view.boardOrder),move.visibleRecordIds,desired)};
}
/** Internal handler. The caller has already checked origin, verified session, expected-account and workspace membership. */
export async function handleCollectionRequest(context){
  const {request,collectionId=null,recordId=null,viewId=null,kind='collection',payload,saved,actor,workspaceId,accountId,readJson,now,createId}=context;
  if(!['collection','records','views','query','templates','formulaPreview','rollupPreview','property-conversions'].includes(kind))missing();
  if(!collectionId){
    if(kind!=='collection'||recordId||viewId)missing();
    if(request.method==='GET')return json({workspaceId,revision:saved.revision,canCreate:actor.role!=='guest',collections:(payload.collections??[]).filter(entry=>context.access(entry.pageId).includes('read')).map(entry=>({id:entry.collection.id,pageId:entry.pageId,title:payload.pages.find(item=>item.page.id===entry.pageId).page.title,propertyCount:entry.collection.properties.length,recordCount:entry.recordPages.filter(binding=>context.access(binding.pageId).includes('read')).length,capabilities:context.access(entry.pageId)}))});
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);if(actor.role==='guest')missing();const data=await readJson(request);exact(data,['expectedRevision','title','parentId','properties']);revision(data.expectedRevision);assertTitle(data.title);definitions(data.properties);checkRollupTargets(data.properties,context);if(data.parentId!==null){assertId(data.parentId);requireManage(context,data.parentId);visibleAncestors(context,data.parentId);}if(data.expectedRevision!==saved.revision)conflict();
    const mint=mintFactory(payload,createId),container=privatePage(context,{title:data.title,parentId:data.parentId,inheritPermissions:false,mint}),id=mint(),stamp=now();
    payload.collections??=[];payload.collections.push({collection:{id,workspaceId,title:data.title,properties:structuredClone(data.properties),records:[],createdAt:stamp,updatedAt:stamp},pageId:container.page.id,recordPages:[],sourceHeaders:[],sourceProperties:[],views:[]});
    return commit(context,{status:201,result:{collectionId:id,pageId:container.page.id},authorizeFresh:fresh=>{if(fresh.actor.role==='guest')missing();checkRollupTargets(data.properties,fresh);if(data.parentId!==null){requireManage(fresh,data.parentId);visibleAncestors(fresh,data.parentId);}}});
  }
  assertId(collectionId);const entry=entryIn(context,collectionId);
  if(kind==='templates')return handleCollectionTemplates(context,entry,{exact,fail,missing,conflict,revision,requireManage,mintFactory,privatePage,commit,checkReferences,entryIn,projectTemplates,json,prepareBlocks:context.prepareDocumentBlocks});
  if(kind==='query'){
    if(request.method!=='POST'||recordId||viewId)fail('METHOD_NOT_ALLOWED',405);
    const body=exact(await readJson(request),['view']);
    const view=viewDefinition(body.view,entry.collection.properties,{hasId:false});
    // A placement never persists a source view or grants access to its database.
    return json(projection(entry,context,{...structuredClone(view),id:'placement'}));
  }
  if(kind==='property-conversions'){if(context.conversionAction!==undefined&&context.conversionAction!=='preview')missing();return handlePropertyConversion({context,entry,previewOnly:context.conversionAction==='preview',manageRows,commit,freezeSource,mintFactory,fail});}
  if(['formulaPreview','rollupPreview'].includes(kind)){
    const computedType=kind==='formulaPreview'?'formula':'rollup';
    if(request.method!=='POST'||recordId||viewId)fail('METHOD_NOT_ALLOWED',405);requireManage(context,entry.pageId);const data=await readJson(request);exact(data,['expectedRevision','property','recordId'],['expectedRevision','property']);revision(data.expectedRevision);if(data.expectedRevision!==saved.revision)conflict();if(data.property?.type!==computedType)fail();
    const previous=entry.collection.properties.find(property=>property.id===data.property.id);if(previous&&previous.type!==computedType)fail('PROPERTY_TYPE_CHANGE_UNSUPPORTED',409);const properties=previous?entry.collection.properties.map(property=>property.id===data.property.id?structuredClone(data.property):property):[...entry.collection.properties,structuredClone(data.property)];definitions(properties);checkRollupTargets(properties,context);
    const result={revision:saved.revision,propertyId:data.property.id,valid:true};if(own(data,'recordId')){assertId(data.recordId);const row=entry.collection.records.find(row=>row.id===data.recordId),binding=entry.recordPages.find(binding=>binding.recordId===data.recordId);if(!row||!binding||!context.access(binding.pageId).includes('read'))missing();const projected=projectRecord({...entry,collection:{...entry.collection,properties}},row,context);result.result={recordId:row.id,value:projected.values[data.property.id],...((projected.formulaErrors?.[data.property.id]??projected.rollupErrors?.[data.property.id])?{error:projected.formulaErrors?.[data.property.id]??projected.rollupErrors[data.property.id]}:{})};}return json(result);
  }
  if(kind==='collection'){
    if(recordId||viewId)missing();if(request.method==='GET')return json(projection(entry,context));if(request.method!=='PATCH')fail('METHOD_NOT_ALLOWED',405);requireManage(context,entry.pageId);
    const data=await readJson(request);exact(data,['expectedRevision','title','properties','confirmPropertyDeletion'],['expectedRevision']);revision(data.expectedRevision);if(!own(data,'title')&&!own(data,'properties'))fail();if(own(data,'confirmPropertyDeletion')&&!own(data,'properties'))fail();if(data.expectedRevision!==saved.revision)conflict();
    const rowPageIds=entry.recordPages.map(binding=>binding.pageId);
    if(own(data,'properties')){
      manageRows(context,entry);definitions(data.properties);checkRollupTargets(data.properties,context);const before=new Map(entry.collection.properties.map(property=>[property.id,property])),afterIds=new Set(data.properties.map(property=>property.id)),removed=[...before.keys()].filter(id=>!afterIds.has(id));
      if(removed.length){if(!Array.isArray(data.confirmPropertyDeletion)||new Set(data.confirmPropertyDeletion).size!==data.confirmPropertyDeletion.length||removed.length!==data.confirmPropertyDeletion.length||removed.some(id=>!data.confirmPropertyDeletion.includes(id)))fail('PROPERTY_DELETION_CONFIRMATION_REQUIRED',409);}
      else if(own(data,'confirmPropertyDeletion')&&(!Array.isArray(data.confirmPropertyDeletion)||data.confirmPropertyDeletion.length))fail();
      for(const property of data.properties)if(before.has(property.id)&&before.get(property.id).type!==property.type)fail('PROPERTY_TYPE_CHANGE_UNSUPPORTED',409);
      freezeSource(entry);for(const row of entry.collection.records){const values={};for(const property of data.properties)Object.defineProperty(values,property.id,{value:own(row.values,property.id)?structuredClone(row.values[property.id]):null,enumerable:true,writable:true,configurable:true});row.values=values;}validateCollection({...entry.collection,properties:data.properties});
      for(const template of entry.templates??[])template.values=Object.fromEntries(Object.entries(template.values).filter(([id])=>afterIds.has(id)));
      for(const view of entry.views??[])try{viewDefinition(view,data.properties);}catch{fail('COLLECTION_VIEW_DEPENDENCY',409);}entry.collection.properties=structuredClone(data.properties);pruneAssignmentNotifications(payload,{collectionId});
    }
    if(own(data,'title')){assertTitle(data.title);const page=payload.pages.find(item=>item.page.id===entry.pageId);if(page.page.title!==data.title)invalidateDocument(context,page,data.title);entry.collection.title=data.title;}
    entry.collection.updatedAt=now();return commit(context,{result:{collectionId,pageId:entry.pageId},authorizeFresh:fresh=>{const current=entryIn(fresh,collectionId);requireManage(fresh,current.pageId);if(own(data,'properties')){checkRollupTargets(data.properties,fresh);for(const pageId of rowPageIds)requireManage(latestAccess(fresh,{includeTrash:true}),pageId);manageRows(fresh,current);}}});
  }
  if(kind==='views'){
    if(recordId)missing();if(request.method==='GET'){if(!viewId)return json({revision:saved.revision,pageId:entry.pageId,views:(entry.views??[]).map(view=>projectView(view,entry,context))});const view=entry.views?.find(item=>item.id===viewId);if(!view)missing();return json(projection(entry,context,view));}
    requireManage(context,entry.pageId);if(!['POST','PATCH','DELETE'].includes(request.method)||request.method==='POST'&&viewId||request.method!=='POST'&&!viewId)fail('METHOD_NOT_ALLOWED',405);
    const current=viewId?entry.views?.find(item=>item.id===viewId):null;if(viewId&&!current)missing();const data=await readJson(request);
    if(request.method==='PATCH'&&own(data,'boardMove')){
      exact(data,['expectedRevision','boardMove']);revision(data.expectedRevision);if(data.expectedRevision!==saved.revision)conflict();const move=prepareBoardWrite(context,entry,current,data.boardMove);
      move.row.values={...move.row.values,[move.property.id]:structuredClone(data.boardMove.targetValue)};current.boardOrder={recordIds:move.order};entry.collection.updatedAt=now();payload.pages.find(item=>item.page.id===move.binding.pageId).page.updatedAt=now();
      return commit(context,{guards:guardsForViews(current,entry,context),result:{collectionId,viewId,record:projectRecord(entry,move.row,context),boardOrder:{recordIds:move.desired}},authorizeFresh:fresh=>{const current=entryIn(fresh,collectionId);requireManage(fresh,current.pageId);prepareBoardWrite(fresh,current,current.views?.find(view=>view.id===viewId),data.boardMove);}});
    }
    exact(data,request.method==='DELETE'?['expectedRevision']:['expectedRevision','view']);revision(data.expectedRevision);if(data.expectedRevision!==saved.revision)conflict();let guards=[];
    if(request.method!=='DELETE'){viewDefinition(data.view,entry.collection.properties,{hasId:false});guards=guardsForViews(data.view,entry,context);}
    let id=viewId;if(request.method==='POST'){if((entry.views?.length??0)>=20)fail('CONTENT_TOO_LARGE',413);id=mintFactory(payload,createId)();entry.views??=[];entry.views.push({id,...structuredClone(data.view)});}
    else if(request.method==='PATCH')entry.views=entry.views.map(view=>view.id===viewId?{id:viewId,...structuredClone(data.view),...(view.boardOrder&&data.view.type==='board'&&data.view.groupBy===view.groupBy?{boardOrder:structuredClone(view.boardOrder)}:{})}:view);else entry.views=entry.views.filter(view=>view.id!==viewId);
    entry.collection.updatedAt=now();return commit(context,{status:request.method==='POST'?201:200,guards,result:{collectionId,viewId:id,...(request.method==='DELETE'?{removed:true}:{})},authorizeFresh:fresh=>{const current=entryIn(fresh,collectionId);requireManage(fresh,current.pageId);if(request.method!=='DELETE')guardsForViews(data.view,current,fresh);}});
  }
  if(viewId)missing();
  if(!recordId){
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);if(actor.role==='guest')missing();requireManage(context,entry.pageId);const data=await readJson(request);exact(data,['expectedRevision','title','values','templateId'],['expectedRevision','title','values']);revision(data.expectedRevision);assertTitle(data.title);exact(data.values,entry.collection.properties.map(property=>property.id),[]);const template=own(data,'templateId')?readableTemplate(context,entry,data.templateId,{missing}):null;const values={...(template?structuredClone(template.values):{}),...structuredClone(data.values)};rejectComputedWrites(entry.collection.properties,values);validatePropertyValues(entry.collection.properties,values);for(const property of entry.collection.properties)if(!own(values,property.id))Object.defineProperty(values,property.id,{value:null,enumerable:true,writable:true,configurable:true});const guards=checkReferences(entry.collection.properties,values,context);if(data.expectedRevision!==saved.revision)conflict();
    const mint=mintFactory(payload,createId),page=privatePage(context,{title:data.title,parentId:entry.pageId,inheritPermissions:true,mint}),id=mint(),row={id,values};entry.collection.records.push(row);entry.recordPages.push({recordId:id,pageId:page.page.id,sourceValues:{},sourceKind:'manual'});entry.collection.updatedAt=now();if(template)guards.push(...applyCollectionTemplate(context,template,page,mint));guards.push(...recordAssignments(context,entry,row,{}));
    return commit(context,{status:201,guards,result:{collectionId,record:projectRecord(entry,row,latestAccess(context))},authorizeFresh:fresh=>{const current=entryIn(fresh,collectionId);if(fresh.actor.role==='guest')missing();requireManage(fresh,current.pageId);if(template)readableTemplate(fresh,current,template.id,{missing});checkReferences(current.collection.properties,values,fresh);}});
  }
  assertId(recordId);const row=entry.collection.records.find(item=>item.id===recordId),binding=entry.recordPages.find(item=>item.recordId===recordId);if(!row||!binding||!context.access(binding.pageId).includes('read'))missing();
  if(request.method==='GET')return json({revision:saved.revision,collectionId,record:projectRecord(entry,row,context)});
  if(request.method==='DELETE')return handlePageLifecycle({...context,action:'trash',pageId:binding.pageId});
  if(request.method!=='PATCH')fail('METHOD_NOT_ALLOWED',405);const data=await readJson(request);exact(data,['expectedRevision','values','title'],['expectedRevision']);revision(data.expectedRevision);if(!own(data,'values')&&!own(data,'title'))fail();const required=[],previousValues=structuredClone(row.values);let guards=[];
  if(own(data,'values')){if(!context.access(binding.pageId).includes('editRecordValues'))missing();exact(data.values,entry.collection.properties.map(property=>property.id),[]);rejectComputedWrites(entry.collection.properties,data.values);if(!Object.keys(data.values).length)fail();row.values=validatePropertyValues(entry.collection.properties,{...row.values,...data.values});guards=checkReferences(entry.collection.properties,data.values,context);required.push('editRecordValues');}
  if(own(data,'title')){if(!context.access(binding.pageId).includes('editBody'))missing();assertTitle(data.title);required.push('editBody');}
  if(data.expectedRevision!==saved.revision)conflict();const page=payload.pages.find(item=>item.page.id===binding.pageId);if(own(data,'title')&&page.page.title!==data.title)invalidateDocument(context,page,data.title);page.page.updatedAt=now();entry.collection.updatedAt=now();if(own(data,'values'))guards.push(...recordAssignments(context,entry,row,previousValues));
  return commit(context,{guards,result:{collectionId,record:projectRecord(entry,row,context)},authorizeFresh:fresh=>{const current=entryIn(fresh,collectionId),bound=current.recordPages.find(item=>item.recordId===recordId);if(!bound||required.some(capability=>!fresh.access(bound.pageId).includes(capability)))missing();if(own(data,'values'))checkReferences(current.collection.properties,data.values,fresh);}});
}
export function projectAccountCollection(entry,context){return projection(entry,context).collection;}
