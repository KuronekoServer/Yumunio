/** Saved chart definitions and aggregates over already ACL-projected records. */
export class ChartError extends Error { constructor(code='INVALID_CHART'){super(code);this.code=code;} }
export const CHART_TYPES=Object.freeze(['bar','donut']);
export const CHART_AGGREGATIONS=Object.freeze(['count','sum','average']);
export const CHART_UNAVAILABLE_REASONS=Object.freeze(['CHART_INPUT_UNAVAILABLE','CHART_GROUP_LIMIT','CHART_NUMBER_RANGE','CHART_NEGATIVE_DONUT']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const effective=property=>['formula','rollup'].includes(property?.type)?property[property.type]?.resultType:property?.type;
const invalid=()=>{throw new ChartError();};
export function validateChartDefinition(view,properties){
 if(!object(view)||!Array.isArray(properties)||properties.length>128||!object(view.chart)||Object.keys(view.chart).length!==3||!Object.hasOwn(view.chart,'type')||!Object.hasOwn(view.chart,'aggregation')||!Object.hasOwn(view.chart,'valuePropertyId')||!CHART_TYPES.includes(view.chart.type)||!CHART_AGGREGATIONS.includes(view.chart.aggregation)||view.type!=='chart'||!id(view.groupBy)||view.datePropertyId!==null||view.endDatePropertyId!==null)invalid();
 const group=properties.find(property=>property.id===view.groupBy);
 if(!group||!['text','select','checkbox'].includes(effective(group)))invalid();
 if(view.chart.aggregation==='count'){if(view.chart.valuePropertyId!==null)invalid();}
 else if(!id(view.chart.valuePropertyId)||!properties.some(property=>property.id===view.chart.valuePropertyId&&effective(property)==='number'))invalid();
 return structuredClone(view.chart);
}
const unavailable=reason=>({status:'unavailable',reason});
const empty=value=>value===null||value===undefined||value==='';
/** Include all filter/sort inputs in the preflight, before filters can hide errors. */
export function chartInputsAvailable(records,view){
 if(!Array.isArray(records)||records.length>1000)return false;
 const ids=new Set([view.groupBy,...(view.chart?.valuePropertyId?[view.chart.valuePropertyId]:[]),...(view.filters??[]).map(filter=>filter.propertyId),...(view.sorts??[]).map(sort=>sort.propertyId)]);
 if((view.filters??[]).some(filter=>filter.redacted===true))return false;
 return records.every(row=>object(row)&&object(row.values)&&[...ids].every(key=>!row.redactedProperties?.includes(key)&&!Object.hasOwn(row.formulaErrors??{},key)&&!Object.hasOwn(row.rollupErrors??{},key)));
}
/** Never pass unprojected records. A failure returns no counts or partial values. */
export function aggregateChart(records,view,properties,{inputsAvailable=true}={}){
 validateChartDefinition(view,properties);
 if(!inputsAvailable||!chartInputsAvailable(records,view))return unavailable('CHART_INPUT_UNAVAILABLE');
 const groups=new Map(),groupType=effective(properties.find(property=>property.id===view.groupBy));
 for(const row of records){
  const raw=row.values[view.groupBy],value=empty(raw)?null:raw;
  if(value!==null&&(groupType==='checkbox'?typeof value!=='boolean':typeof value!=='string'))return unavailable('CHART_INPUT_UNAVAILABLE');
  const key=JSON.stringify(value);if(!groups.has(key)){if(groups.size===128)return unavailable('CHART_GROUP_LIMIT');groups.set(key,{value,count:0,numericCount:0,total:0,compensation:0});}
  const group=groups.get(key);group.count++;
  if(view.chart.aggregation!=='count'){
   const input=row.values[view.chart.valuePropertyId];if(input===null||input===undefined)continue;
   if(typeof input!=='number'||!Number.isFinite(input))return unavailable('CHART_INPUT_UNAVAILABLE');
   const adjusted=input-group.compensation,next=group.total+adjusted;group.compensation=(next-group.total)-adjusted;group.total=next;group.numericCount++;
   if(!Number.isFinite(next)||Math.abs(next)>Number.MAX_SAFE_INTEGER||Math.abs(input)>Number.MAX_SAFE_INTEGER)return unavailable('CHART_NUMBER_RANGE');
  }
 }
 const result=[...groups.values()].sort((a,b)=>a.value===null?-1:b.value===null?1:a.value<b.value?-1:a.value>b.value?1:0).map(group=>({value:group.value,count:group.count,numericCount:group.numericCount,result:view.chart.aggregation==='count'?group.count:view.chart.aggregation==='average'?(group.numericCount?group.total/group.numericCount:null):group.total}));
 if(view.chart.type==='donut'&&result.some(group=>group.result!==null&&group.result<0))return unavailable('CHART_NEGATIVE_DONUT');
 return{status:'available',groups:result};
}
/** Strict public projection; unavailable responses deliberately contain no totals. */
export function validateChartResult(result,view,properties){
 validateChartDefinition(view,properties);
 if(!object(result))invalid();
 if(result.status==='unavailable'){if(Object.keys(result).length!==2||!CHART_UNAVAILABLE_REASONS.includes(result.reason))invalid();return structuredClone(result);}
 if(result.status!=='available'||Object.keys(result).length!==2||!Array.isArray(result.groups)||result.groups.length>128)invalid();
 const seen=new Set(),type=effective(properties.find(property=>property.id===view.groupBy));let count=0;
 for(const group of result.groups){if(!object(group)||Object.keys(group).length!==4||!['value','count','numericCount','result'].every(key=>Object.hasOwn(group,key))||group.value!==null&&(type==='checkbox'?typeof group.value!=='boolean':typeof group.value!=='string')||!Number.isSafeInteger(group.count)||group.count<1||!Number.isSafeInteger(group.numericCount)||group.numericCount<0||group.numericCount>group.count||group.result!==null&&(typeof group.result!=='number'||!Number.isFinite(group.result)||Math.abs(group.result)>Number.MAX_SAFE_INTEGER))invalid();
  const key=JSON.stringify(group.value);if(seen.has(key)||(count+=group.count)>1000)invalid();seen.add(key);
  if(view.chart.aggregation==='count'&&(group.result!==group.count||group.numericCount!==0)||view.chart.aggregation==='sum'&&group.result===null||view.chart.aggregation==='average'&&(group.result===null)!==(group.numericCount===0)||view.chart.type==='donut'&&group.result!==null&&group.result<0)invalid();
 }
 return structuredClone(result);
}
