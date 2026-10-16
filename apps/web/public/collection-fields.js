import {parseCollectionValue,effectivePropertyType,isComputedProperty,formulaErrorCode,rollupErrorCode} from './collections-model.js';
const asText=value=>value===null||value===undefined?'':String(value);
function element(document,tag,text,classes){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(classes)node.className=classes;return node;}
function referenceOptions(options,selected,t){
  const result=[...options],known=new Set(result.map(([id])=>id));for(const value of selected){if(typeof value==='string'&&value&&!known.has(value)){result.push([value,t('savedReference')]);known.add(value);}}return result;
}
/** DOM-only field; rawValue never parses a draft. Call readValue only for an explicit save. */
export function createCollectionValueInput({document,property,value,filter=false,people=[],pages=[],t=key=>key,disabled=false}){
  if(isComputedProperty(property)){if(!filter)throw new Error('computedReadOnly');property={...property,type:effectivePropertyType(property)};}
  let input;const select=(options,selected,{multiple=false}={})=>{
    const control=element(document,'select');control.multiple=multiple;if(multiple)control.size=4;
    for(const[id,label]of options){const option=element(document,'option',label);option.value=id;option.selected=multiple?Array.isArray(selected)&&selected.includes(id):id===(selected??'');control.append(option);}
    if(!multiple)control.value=asText(selected);return control;
  };
  if(property.type==='checkbox')input=select([['',t('empty')],['true',t('yes')],['false',t('no')]],value===true||value==='true'?'true':value===false||value==='false'?'false':'');
  else if(property.type==='select'||property.type==='multi_select'){
    const multiple=property.type==='multi_select'&&!filter,selected=multiple?(Array.isArray(value)?value:[]):value;
    const options=referenceOptions((property.options??[]).map(option=>[option,option]),multiple?selected:[selected],t);
    input=select([...(multiple?[]:[['',t('empty')]]),...options],selected,{multiple});
  }else if(property.type==='relation'){
    const multiple=!filter,selected=multiple?(Array.isArray(value)?value:[]):value;
    const options=referenceOptions(pages.filter(page=>typeof page.recordId==='string').map(page=>[page.id,page.title||t('untitled')]),multiple?selected:[selected],t);
    input=select([...(multiple?[]:[['',t('empty')]]),...options],selected,{multiple});
  }else if(property.type==='person'){
    const options=referenceOptions(people.map(person=>[person.accountId,person.name||person.accountId]),[value],t);input=select([['',t('empty')],...options],value);
  }else if(property.type==='text'){
    input=element(document,'textarea');input.rows=2;input.maxLength=100000;input.value=asText(value);
  }else{
    input=element(document,'input');input.type=property.type==='date'?'date':'text';if(property.type==='number')input.inputMode='decimal';input.maxLength=100000;input.value=asText(value);
  }
  input.className='collection-value-input';input.disabled=disabled;input.rawValue=()=>{if(!input.multiple)return input.value;const selected=[...input.selectedOptions].map(option=>option.value),prior=Array.isArray(value)?value:[];return [...prior.filter(item=>selected.includes(item)),...selected.filter(item=>!prior.includes(item))];};
  input.readValue=()=>parseCollectionValue(property,input.rawValue(),{filter});return input;
}
export function renderCollectionValue({document,property,value,people=[],pages=[],t=key=>key}){
  if(value===null||value===undefined)return element(document,'span',t('empty'),'hint collection-empty-value');
  if(value==='')return element(document,'span',t(isComputedProperty(property)?'formulaEmptyText':'emptyText'),'hint collection-empty-value');
  const type=effectivePropertyType(property);
  if(type==='checkbox')return element(document,'span',t(value?'yes':'no'),'collection-cell-value');
  if(type==='person')return element(document,'span',people.find(person=>person.accountId===value)?.name||String(value),'collection-cell-value');
  if(Array.isArray(value)){
    if(!value.length)return element(document,'span',t('empty'),'hint collection-empty-value');
    const group=element(document,'span',undefined,'collection-cell-value');for(const item of value)group.append(element(document,'span',type==='relation'?pages.find(page=>page.id===item)?.title||t('relatedRecord'):item,'collection-badge'));return group;
  }
  return element(document,'span',String(value),'collection-cell-value');
}
export function renderRecordCollectionValue({record,property,document,t=key=>key,...options}){
  const error=(property.type==='rollup'?record.rollupErrors:record.formulaErrors)?.[property.id];
  if(error)return element(document,'span',t(property.type==='rollup'?rollupErrorCode(error):formulaErrorCode(error)),'field-error collection-field-error');
  if(record.redactedProperties?.includes(property.id))return element(document,'span',t('unavailableReference'),'hint collection-empty-value');
  return renderCollectionValue({document,t,property,value:record.values[property.id],...options});
}
export function collectionFieldHint(property,{record,t=key=>key}={}){
  if(record?.redactedProperties?.includes(property.id))return t('redactedValue');
  if(isComputedProperty(property))return t(property.type==='rollup'?'rollupReadOnly':'formulaReadOnly');
  if(property.type==='person')return t('personHint');if(property.type==='relation')return t('relationHint');return null;
}
