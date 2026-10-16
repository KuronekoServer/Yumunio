import {aggregateRollupValues,ROLLUP_LIMITS,RollupError} from '@yumunio/domain';
const requests=new WeakMap();
const accessCache=new WeakMap();
function readable(context,pageId){let entries=accessCache.get(context);if(!entries){entries=new Map();accessCache.set(context,entries);}if(!entries.has(pageId))entries.set(pageId,context.access(pageId).includes('read'));return entries.get(pageId);}
function stateFor(context){let state=requests.get(context);if(state)return state;const collections=new Map(),records=new Map();for(const entry of context.payload.collections??[]){collections.set(entry.collection.id,entry);const rows=new Map(entry.collection.records.map(row=>[row.id,row]));for(const binding of entry.recordPages){if(records.has(binding.pageId))records.set(binding.pageId,null);else records.set(binding.pageId,{entry,row:rows.get(binding.recordId),pageId:binding.pageId});}}state={collections,records,remaining:ROLLUP_LIMITS.requestVisits};requests.set(context,state);return state;}
export function validateRollupTargets(properties,context){
  for(const property of properties)if(property.type==='rollup'){
    const definition=property.rollup,target=context.payload.collections?.find(entry=>entry.collection.id===definition.targetCollectionId);
    if(!target||!readable(context,target.pageId))return{code:'CONTENT_NOT_FOUND',status:404};
    if(definition.operation!=='count'){const source=target.collection.properties.find(item=>item.id===definition.targetPropertyId);if(!source||!['number','date'].includes(source.type)||source.type!==definition.resultType||definition.operation==='sum'&&source.type!=='number')return{code:'ROLLUP_SOURCE_UNAVAILABLE',status:400};}
  }return null;
}
/** A redacted schema DTO is for display only; it must never be sent back as an editable definition. */
export function projectRollupProperties(properties,context){const collections=stateFor(context).collections;return properties.map(property=>{if(property.type!=='rollup')return structuredClone(property);const target=collections.get(property.rollup.targetCollectionId);return target&&readable(context,target.pageId)?structuredClone(property):{...structuredClone(property),rollup:{...structuredClone(property.rollup),targetCollectionId:null,targetPropertyId:null,redacted:true}};});}
/** Raw relation IDs establish completeness; target values enter arithmetic only after every ACL check passes. */
export function projectRollupValues(entry,row,context,redactedProperties){
  const state=stateFor(context),values={},errors={},redacted=[];
  for(const property of entry.collection.properties)if(property.type==='rollup'){
    values[property.id]=null;const definition=property.rollup,target=state.collections.get(definition.targetCollectionId),relation=row.values[definition.relationPropertyId]??[],deny=code=>{errors[property.id]={code};if(code==='ROLLUP_REDACTED_INPUT')redacted.push(property.id);};
    if(!target||!readable(context,target.pageId)||redactedProperties.includes(definition.relationPropertyId)){deny('ROLLUP_REDACTED_INPUT');continue;}
    if(!Array.isArray(relation)||relation.length>ROLLUP_LIMITS.targets){deny('ROLLUP_LIMIT');continue;}
    const linked=[];let denied=false,unavailable=false;
    for(const pageId of relation){const found=state.records.get(pageId);if(!readable(context,pageId)||found&&!readable(context,found.entry.pageId)){denied=true;break;}if(!found?.row||found.entry!==target){unavailable=true;continue;}linked.push(found);}
    if(denied){deny('ROLLUP_REDACTED_INPUT');continue;}if(unavailable){deny('ROLLUP_SOURCE_UNAVAILABLE');continue;}
    const targetProperty=definition.operation==='count'?null:target.collection.properties.find(property=>property.id===definition.targetPropertyId);
    if(definition.operation!=='count'&&(!targetProperty||!['number','date'].includes(targetProperty.type)||targetProperty.type!==definition.resultType)){deny('ROLLUP_SOURCE_UNAVAILABLE');continue;}
    if(state.remaining<relation.length){deny('ROLLUP_LIMIT');continue;}state.remaining-=relation.length;
    try{values[property.id]=aggregateRollupValues(definition,linked.map(item=>targetProperty?item.row.values[targetProperty.id]??null:null));}catch(error){deny(error instanceof RollupError?error.code:'ROLLUP_UNAVAILABLE');}
  }
  return{values,errors,redacted};
}