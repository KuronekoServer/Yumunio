/** Deterministic one-hop aggregation. The caller must prove that every source record is readable. */
export const ROLLUP_LIMITS=Object.freeze({properties:32,targets:100,requestVisits:2048,depth:1});
export class RollupError extends Error{constructor(code){super(code);this.name='RollupError';this.code=code;}}
const fail=code=>{throw new RollupError(code);},id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export function validateRollupDefinition(value){
  const keys=['version','relationPropertyId','targetCollectionId','targetPropertyId','operation','resultType'];
  if(!plain(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.version!==1||!id(value.relationPropertyId)||!id(value.targetCollectionId)||!['count','sum','min','max'].includes(value.operation)||!['number','date'].includes(value.resultType))fail('INVALID_ROLLUP_DEFINITION');
  if(value.operation==='count'?(value.targetPropertyId!==null||value.resultType!=='number'):!id(value.targetPropertyId)||value.operation==='sum'&&value.resultType!=='number')fail('INVALID_ROLLUP_DEFINITION');return value;
}
export function validateRollupProperties(properties){
  if(!Array.isArray(properties)||properties.length>128||properties.some(property=>!plain(property)||!id(property.id)))fail('INVALID_ROLLUP_DEFINITION');const byId=new Map(properties.map(property=>[property.id,property]));let count=0;if(byId.size!==properties.length)fail('INVALID_ROLLUP_DEFINITION');
  for(const property of properties)if(property.type==='rollup'){if(++count>ROLLUP_LIMITS.properties)fail('ROLLUP_PROPERTY_LIMIT');validateRollupDefinition(property.rollup);if(byId.get(property.rollup.relationPropertyId)?.type!=='relation')fail('ROLLUP_RELATION_REQUIRED');}return properties;
}
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString()===value+'T00:00:00.000Z';
/** Values contain every linked record, including null fields. Never pass a partial visible subset. */
export function aggregateRollupValues(definition,values){
  validateRollupDefinition(definition);if(!Array.isArray(values))fail('ROLLUP_SOURCE_UNAVAILABLE');if(values.length>ROLLUP_LIMITS.targets)fail('ROLLUP_LIMIT');if(definition.operation==='count')return values.length;
  const actual=[];for(const value of values){if(value===null)continue;if(definition.resultType==='number'?(typeof value!=='number'||!Number.isFinite(value)):!validDate(value))fail('ROLLUP_SOURCE_UNAVAILABLE');actual.push(value);}
  if(definition.operation==='sum'){let sum=0;for(const value of actual){sum+=value;if(!Number.isFinite(sum))fail('ROLLUP_NUMBER_RANGE');}return sum;}
  if(!actual.length)return null;let result=actual[0];for(const value of actual.slice(1))if(definition.operation==='min'?value<result:value>result)result=value;return result;
}