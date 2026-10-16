import {validateChartDefinition,validateChartResult} from './chart-model.js';
import {validateBoardOrder} from './board-order.js';
export const PROPERTY_TYPES=['text','number','checkbox','date','select','multi_select','person','relation','formula','rollup'];
export const VIEW_TYPES=['table','board','list','gallery','calendar','timeline','chart','feed'];
export const FILTER_OPERATORS={text:['eq','neq','contains','empty','not_empty'],number:['eq','neq','lt','lte','gt','gte','empty','not_empty'],date:['eq','neq','lt','lte','gt','gte','empty','not_empty'],checkbox:['eq','neq','empty','not_empty'],select:['eq','neq','empty','not_empty'],multi_select:['contains','empty','not_empty'],person:['eq','neq','empty','not_empty'],relation:['contains','empty','not_empty']};
export const FORMULA_RESULT_TYPES=['number','text','checkbox','date'];
export const FORMULA_RUNTIME_ERRORS=['FORMULA_DIVISION_BY_ZERO','FORMULA_NUMBER_RANGE','FORMULA_NUMBER_FORMAT','FORMULA_DATE','FORMULA_STRING_LIMIT','FORMULA_INPUT_TYPE','FORMULA_RESULT_TYPE','FORMULA_REDACTED_INPUT','FORMULA_STEP_LIMIT','FORMULA_UNAVAILABLE'];
export function effectivePropertyType(property){return ['formula','rollup'].includes(property?.type)?property[property.type]?.resultType:property?.type;}
export const ROLLUP_OPERATIONS=['count','sum','min','max'];
export const ROLLUP_RUNTIME_ERRORS=['ROLLUP_REDACTED_INPUT','ROLLUP_SOURCE_UNAVAILABLE','ROLLUP_LIMIT','ROLLUP_NUMBER_RANGE','ROLLUP_UNAVAILABLE'];
export const isComputedProperty=property=>['formula','rollup'].includes(property?.type);
export const isRedactedRollup=property=>property?.type==='rollup'&&property.rollup?.redacted===true;
export function rollupErrorCode(error){return ROLLUP_RUNTIME_ERRORS.includes(error?.code)?error.code:'ROLLUP_UNAVAILABLE';}
export function rollupRelationCandidates(properties){return properties.filter(property=>property.type==='relation').map(({id,name})=>({id,name}));}
export function rollupTargetCandidates(properties,operation){return operation==='count'?[]:properties.filter(property=>property.type==='number'||operation!=='sum'&&property.type==='date').map(({id,name,type})=>({id,name,type}));}
export function formulaErrorCode(error){return FORMULA_RUNTIME_ERRORS.includes(error?.code)?error.code:'FORMULA_UNAVAILABLE';}
export function formulaFieldCandidates(properties,formulaId){return properties.filter(property=>property.id!==formulaId&&!['person','relation','rollup'].includes(property.type)).map(property=>({id:property.id,name:property.name,type:effectivePropertyType(property),reference:'field('+JSON.stringify(property.id)+')'}));}
const exact=(value,required,optional=[])=>object(value)&&Object.keys(value).every(key=>[...required,...optional].includes(key))&&required.every(key=>Object.hasOwn(value,key));
function validFormula(property){const formula=property.formula;return property.type==='formula'&&exact(formula,['version','expression','resultType'])&&formula.version===1&&typeof formula.expression==='string'&&formula.expression.trim().length>0&&formula.expression.length<=2000&&FORMULA_RESULT_TYPES.includes(formula.resultType)&&property.required!==true&&property.options===undefined;}

function validRollup(property,{allowRedacted=true}={}){const rollup=property.rollup;if(property.type!=='rollup'||!exact(rollup,['version','relationPropertyId','targetCollectionId','targetPropertyId','operation','resultType'],['redacted'])||rollup.version!==1||!id(rollup.relationPropertyId)||!ROLLUP_OPERATIONS.includes(rollup.operation)||!['number','date'].includes(rollup.resultType)||property.required===true||property.options!==undefined)return false;if(rollup.operation==='count'&&rollup.resultType!=='number'||rollup.operation==='sum'&&rollup.resultType!=='number')return false;if(Object.hasOwn(rollup,'redacted'))return allowRedacted&&rollup.redacted===true&&rollup.targetCollectionId===null&&rollup.targetPropertyId===null;return id(rollup.targetCollectionId)&&(rollup.operation==='count'?rollup.targetPropertyId===null:id(rollup.targetPropertyId));}
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function parseCollectionValue(property,raw,{filter=false,computed=false}={}){
  if(isComputedProperty(property)){if(!filter&&!computed)throw new Error('computedReadOnly');if(property.type==='formula'?!validFormula(property):!validRollup(property))throw new Error('invalidValue');if(computed&&effectivePropertyType(property)==='text'&&raw==='')return '';return parseCollectionValue({...property,type:effectivePropertyType(property)},raw,{filter});}
  if(raw===null||raw===undefined)return null;
  if(raw==='')return property.type==='text'&&!filter?'':null;
  if(property.type==='number'){const text=String(raw).trim();if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)||!Number.isFinite(Number(text)))throw new Error('invalidNumber');return Number(text);}
  if(property.type==='checkbox'){if(raw===true||raw==='true')return true;if(raw===false||raw==='false')return false;throw new Error('invalidValue');}
  if(property.type==='date'){const value=String(raw);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)!==value)throw new Error('invalidDate');return value;}
  if(property.type==='person'||property.type==='relation'&&filter){if(!id(raw))throw new Error('invalidReference');return raw;}
  if(property.type==='select'||property.type==='multi_select'&&filter){if(!property.options?.includes(raw))throw new Error('invalidValue');return raw;}
  if(property.type==='multi_select'||property.type==='relation'){const values=Array.isArray(raw)?raw:String(raw).split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(new Set(values).size!==values.length||values.some(value=>property.type==='relation'?!id(value):!property.options?.includes(value)))throw new Error('invalidReference');return values;}
  if(typeof raw!=='string'||raw.length>100000)throw new Error('invalidValue');return raw;
}
/** Validates already typed DTO values without applying editable-input coercion. */
export function validateCollectionValue(property,value){
  if(value===null)return null;
  const type=effectivePropertyType(property);
  if(type==='number'){if(typeof value!=='number'||!Number.isFinite(value))throw new Error('invalidResponse');}
  else if(type==='checkbox'){if(typeof value!=='boolean')throw new Error('invalidResponse');}
  else if(type==='text'){if(typeof value!=='string'||value.length>100000)throw new Error('invalidResponse');}
  else if(type==='date'){try{if(typeof value!=='string'||parseCollectionValue({type:'date'},value)!==value)throw new Error();}catch{throw new Error('invalidResponse');}}
  else if(type==='person'){if(!id(value))throw new Error('invalidResponse');}
  else if(type==='select'){if(typeof value!=='string'||!(property.options??[]).includes(value))throw new Error('invalidResponse');}
  else if(type==='multi_select'||type==='relation'){
    if(!Array.isArray(value)||value.length>1000||new Set(value).size!==value.length||value.some(item=>type==='relation'?!id(item):typeof item!=='string'||!(property.options??[]).includes(item)))throw new Error('invalidResponse');
  }else throw new Error('invalidResponse');
  return structuredClone(value);
}
export function validateCollectionEnvelope(value,{workspaceId,collectionId}={}){
  const collection=value?.collection;
  if(!object(value)||!Number.isSafeInteger(value.revision)||value.revision<0||!id(value.pageId)||!Array.isArray(value.capabilities)||!value.capabilities.includes('read')||!object(collection)||collection.id!==collectionId||collection.workspaceId!==workspaceId||typeof collection.title!=='string'||!Array.isArray(collection.properties)||collection.properties.length>128||!Array.isArray(collection.records)||collection.records.length>1000||!Array.isArray(collection.views))throw new Error('invalidResponse');
  const properties=new Set(),records=new Set();
  for(const property of collection.properties){if(!id(property.id)||properties.has(property.id)||typeof property.name!=='string'||!property.name.trim()||!PROPERTY_TYPES.includes(property.type)||['select','multi_select'].includes(property.type)&&property.options!==undefined&&(!Array.isArray(property.options)||property.options.some(option=>typeof option!=='string')||new Set(property.options).size!==property.options.length))throw new Error('invalidResponse');if(property.type==='formula'&&!validFormula(property)||property.type!=='formula'&&property.formula!==undefined||property.type==='rollup'&&!validRollup(property)||property.type!=='rollup'&&property.rollup!==undefined)throw new Error('invalidResponse');properties.add(property.id);}
  for(const row of collection.records){if(!id(row.id)||records.has(row.id)||!id(row.pageId)||typeof row.title!=='string'||!object(row.values)||!object(row.sourceValues)||!Array.isArray(row.capabilities)||!row.capabilities.includes('read')||Object.values(row.sourceValues).some(cell=>typeof cell!=='string')||Object.keys(row.values).some(key=>!properties.has(key)))throw new Error('invalidResponse');
    if(row.redactedProperties!==undefined&&(!Array.isArray(row.redactedProperties)||new Set(row.redactedProperties).size!==row.redactedProperties.length||row.redactedProperties.some(key=>!collection.properties.some(property=>property.id===key&&(property.type==='person'&&row.values[key]===null||property.type==='relation'&&Array.isArray(row.values[key])&&row.values[key].length===0||property.type==='formula'&&Object.hasOwn(row.formulaErrors??{},key)&&row.formulaErrors[key]?.code==='FORMULA_REDACTED_INPUT'&&row.values[key]===null||property.type==='rollup'&&row.rollupErrors?.[key]?.code==='ROLLUP_REDACTED_INPUT'&&row.values[key]===null)))))throw new Error('invalidResponse');
    if(row.formulaErrors!==undefined&&(!object(row.formulaErrors)||Object.entries(row.formulaErrors).some(([key,error])=>!collection.properties.some(property=>property.id===key&&property.type==='formula')||!exact(error,['code'])||typeof error.code!=='string'||!/^FORMULA_[A-Z0-9_]{1,64}$/.test(error.code)||row.values[key]!==null)))throw new Error('invalidResponse');
    if(row.rollupErrors!==undefined&&(!object(row.rollupErrors)||Object.entries(row.rollupErrors).some(([key,error])=>!collection.properties.some(property=>property.id===key&&property.type==='rollup')||!exact(error,['code'])||typeof error.code!=='string'||!/^ROLLUP_[A-Z0-9_]{1,64}$/.test(error.code)||row.values[key]!==null)))throw new Error('invalidResponse');
    if(collection.properties.some(property=>isRedactedRollup(property)&&(row.values[property.id]!==null||row.rollupErrors?.[property.id]?.code!=='ROLLUP_REDACTED_INPUT')))throw new Error('invalidResponse');
    records.add(row.id);for(const property of collection.properties){if(!Object.hasOwn(row.values,property.id))throw new Error('invalidResponse');validateCollectionValue(property,row.values[property.id]);}}
  const views=new Set();for(const view of [...collection.views,...(value.view?[value.view]:[])]){if(!id(view.id)||typeof view.name!=='string'||!VIEW_TYPES.includes(view.type)||!Array.isArray(view.filters)||!Array.isArray(view.sorts)||view.filters.length>20||view.sorts.length>5)throw new Error('invalidResponse');if(view.type==='board'&&!collection.properties.some(property=>property.id===view.groupBy&&!['relation','multi_select'].includes(effectivePropertyType(property))))throw new Error('invalidResponse');for(const key of view.type==='timeline'?['datePropertyId','endDatePropertyId']:view.type==='calendar'?['datePropertyId']:[])if(!collection.properties.some(property=>property.id===view[key]&&effectivePropertyType(property)==='date'))throw new Error('invalidResponse');if(view.type==='feed'&&[view.groupBy,view.datePropertyId,view.endDatePropertyId].some(value=>value!==null))throw new Error('invalidResponse');if(view.type==='chart')validateChartDefinition(view,collection.properties);else if(Object.hasOwn(view,'chart'))throw new Error('invalidResponse');views.add(view.id);}
  for(const view of [...collection.views,...(value.view?[value.view]:[])])if(Object.hasOwn(view,'boardOrder')){if(view.type!=='board')throw new Error('invalidResponse');validateBoardOrder(view.boardOrder);}
  if(value.view?.type==='chart')validateChartResult(value.chart,value.view,collection.properties);else if(Object.hasOwn(value,'chart'))throw new Error('invalidResponse');
  return structuredClone(value);
}
export function validateRecordSaveResponse(value,{envelope,recordId=null,values={},title}){
 const collection=envelope?.collection,previous=collection?.records.find(record=>record.id===recordId),row=value?.record;
 if(!collection||value?.collectionId!==collection.id||!Number.isSafeInteger(value.revision)||value.revision<=envelope.revision||!object(row)||!id(row.id)||!id(row.pageId)||typeof title!=='string'||row.title!==title||!object(values))throw new Error('invalidResponse');
 if(recordId!==null){if(!previous||row.id!==recordId||row.pageId!==previous.pageId||row.sourceKind!==previous.sourceKind||JSON.stringify(row.sourceValues)!==JSON.stringify(previous.sourceValues))throw new Error('invalidResponse');}
 else if(collection.records.some(record=>record.id===row.id||record.pageId===row.pageId)||row.sourceKind!=='manual'||!object(row.sourceValues)||Object.keys(row.sourceValues).length)throw new Error('invalidResponse');
 validateCollectionEnvelope({revision:value.revision,pageId:envelope.pageId,capabilities:envelope.capabilities,collection:{...collection,records:[row]}},{workspaceId:collection.workspaceId,collectionId:collection.id});
 if(Object.entries(values).some(([key,expected])=>!Object.hasOwn(row.values,key)||JSON.stringify(expected)!==JSON.stringify(row.values[key])))throw new Error('invalidResponse');
 return structuredClone(value);
}
export function collectionGroups(records,property){const groups=new Map();for(const record of records){const value=property?record.values[property.id]??null:null,key=JSON.stringify(value);if(!groups.has(key))groups.set(key,{value,records:[]});groups.get(key).records.push(record);}return [...groups.values()];}
export function recordPatch(record,{expectedRevision,title,values,dirtyPropertyIds,properties=[]}){
  if(!record||!Array.isArray(record.capabilities)||!Array.isArray(dirtyPropertyIds)||!object(values)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error('invalidValue');
  const body={expectedRevision};
  if(record.capabilities.includes('editBody')&&title!==undefined&&title!==record.title){if(typeof title!=='string'||!title.trim()||title.length>240)throw new Error('invalidValue');body.title=title;}
  const changed={};
  if(record.capabilities.includes('editRecordValues'))for(const key of new Set(dirtyPropertyIds)){
    if(properties.some(property=>property.id===key&&isComputedProperty(property)))throw new Error('computedReadOnly');
    if(!Object.hasOwn(record.values,key)||!Object.hasOwn(values,key))throw new Error('invalidValue');
    if(!record.redactedProperties?.includes(key)&&JSON.stringify(values[key])!==JSON.stringify(record.values[key]))Object.defineProperty(changed,key,{value:values[key],enumerable:true});
  }
  if(Object.keys(changed).length)body.values=changed;
  return Object.keys(body).length===1?null:body;
}
export function monthCells(month){if(!/^\d{4}-\d{2}$/.test(month))throw new Error('invalidDate');const first=new Date(month+'-01T00:00:00.000Z');if(!Number.isFinite(first.getTime())||first.toISOString().slice(0,7)!==month)throw new Error('invalidDate');const days=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();return{offset:first.getUTCDay(),days,dates:Array.from({length:days},(_,index)=>month+'-'+String(index+1).padStart(2,'0'))};}
export function timelineRange(start,end,month){if(typeof start!=='string'||typeof end!=='string'||start>end)return null;const{days}=monthCells(month),first=month+'-01',last=month+'-'+days;if(end<first||start>last)return null;return{start:start<first?1:Number(start.slice(8)),end:end>last?days:Number(end.slice(8))};}

export function validateFormulaPreview(value,{revision,property,recordId=null}) {
  if(!id(property?.id)||typeof property.name!=='string'||!property.name.trim()||!validFormula(property)||!exact(value,['revision','propertyId','valid'],['result'])||value.revision!==revision||!Number.isSafeInteger(value.revision)||value.revision<0||value.propertyId!==property.id||value.valid!==true||Object.hasOwn(value,'result')!==(recordId!==null))throw new Error('invalidResponse');
  if(recordId!==null){const result=value.result;if(!exact(result,['recordId','value'],['error'])||result.recordId!==recordId||!id(result.recordId))throw new Error('invalidResponse');if(result.error!==undefined&&(!exact(result.error,['code'])||typeof result.error.code!=='string'||!/^FORMULA_[A-Z0-9_]{1,64}$/.test(result.error.code)||result.value!==null))throw new Error('invalidResponse');if(result.value!==null&&JSON.stringify(parseCollectionValue(property,result.value,{computed:true}))!==JSON.stringify(result.value))throw new Error('invalidResponse');}
  return structuredClone(value);
}

export function validateRollupPreview(value,{revision,property,recordId=null}){
 if(!id(property?.id)||typeof property.name!=='string'||!property.name.trim()||!validRollup(property,{allowRedacted:false})||!exact(value,['revision','propertyId','valid'],['result'])||value.revision!==revision||!Number.isSafeInteger(value.revision)||value.revision<0||value.propertyId!==property.id||value.valid!==true||Object.hasOwn(value,'result')!==(recordId!==null))throw new Error('invalidResponse');
 if(recordId!==null){const result=value.result;if(!exact(result,['recordId','value'],['error'])||result.recordId!==recordId||!id(result.recordId))throw new Error('invalidResponse');if(result.error!==undefined&&(!exact(result.error,['code'])||typeof result.error.code!=='string'||!/^ROLLUP_[A-Z0-9_]{1,64}$/.test(result.error.code)||result.value!==null))throw new Error('invalidResponse');if(result.value!==null&&JSON.stringify(parseCollectionValue(property,result.value,{computed:true}))!==JSON.stringify(result.value))throw new Error('invalidResponse');}
 return structuredClone(value);
}
