import {effectivePropertyType,formulaErrorCode,rollupErrorCode,parseCollectionValue,isComputedProperty} from './collections-model.js';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const FEED_WINDOW_SIZE=20;
export function feedWindow(collection,{shown=FEED_WINDOW_SIZE}={}){
  if(!object(collection)||!Array.isArray(collection.properties)||collection.properties.length>128||!Array.isArray(collection.records)||collection.records.length>1000||!Number.isSafeInteger(shown)||shown<1||shown>1000)throw new Error('invalidResponse');
  const propertyIds=new Set(),recordIds=new Set();
  for(const property of collection.properties){if(!id(property.id)||propertyIds.has(property.id)||typeof property.name!=='string'||!['text','number','checkbox','date','datetime','select','multi_select','person','relation'].includes(effectivePropertyType(property)))throw new Error('invalidResponse');propertyIds.add(property.id);}
  for(const record of collection.records){if(!id(record.id)||recordIds.has(record.id)||!id(record.pageId)||typeof record.title!=='string'||!object(record.values)||!Array.isArray(record.capabilities)||!record.capabilities.includes('read')||record.redactedProperties!==undefined&&(!Array.isArray(record.redactedProperties)||record.redactedProperties.some(key=>!propertyIds.has(key))))throw new Error('invalidResponse');recordIds.add(record.id);}
  const cards=collection.records.slice(0,shown).map(record=>({id:record.id,pageId:record.pageId,title:record.title,fields:collection.properties.map(property=>{
    const result={propertyId:property.id,name:property.name,kind:property.type,valueType:effectivePropertyType(property),value:null,redacted:record.redactedProperties?.includes(property.id)??false};
    const errors=property.type==='formula'?record.formulaErrors:property.type==='rollup'?record.rollupErrors:null;
    if(errors&&Object.hasOwn(errors,property.id)){result.errorCode=property.type==='formula'?formulaErrorCode(errors[property.id]):rollupErrorCode(errors[property.id]);return result;}
    if(!result.redacted){const value=record.values[property.id]??null;if(JSON.stringify(parseCollectionValue(property,value,{computed:isComputedProperty(property)}))!==JSON.stringify(value))throw new Error('invalidResponse');result.value=structuredClone(value);}
    return result;
  })}));
  return{cards,shown:cards.length,total:collection.records.length,hasMore:cards.length<collection.records.length};
}
