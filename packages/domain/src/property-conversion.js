/** Explicit, non-destructive text-column conversion. No locale guessing or I/O. */
export const PROPERTY_CONVERSION_TYPES=Object.freeze(['number','date']);
export class PropertyConversionError extends Error{constructor(code='INVALID_PROPERTY_CONVERSION'){super(code);this.code=code;}}
const fail=code=>{throw new PropertyConversionError(code);};
const decimal=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
// Compare the exact decimal significand/exponent against the Number's printed value.
function decimalKey(text){const match=/^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/.exec(text);if(!match)return null;let digits=(match[2]+(match[3]??'')).replace(/^0+/,'');if(!digits)return'0';let exponent=Number(match[4]??0)-(match[3]?.length??0);while(digits.endsWith('0')){digits=digits.slice(0,-1);exponent++;}return match[1]+digits+'e'+exponent;}
export function convertTextPropertyValue(value,targetType){
 if(!PROPERTY_CONVERSION_TYPES.includes(targetType))fail();
 if(value===null||value===undefined||value==='')return{value:null,blank:true};
 if(typeof value!=='string')return{value:null,blank:false,error:'CONVERSION_NOT_TEXT'};
 if(targetType==='date'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return{value:null,blank:false,error:'CONVERSION_INVALID_DATE'};
  const date=new Date(value+'T00:00:00.000Z');if(!Number.isFinite(date.getTime())||date.toISOString()!==value+'T00:00:00.000Z')return{value:null,blank:false,error:'CONVERSION_INVALID_DATE'};
  return{value,blank:false};
 }
 if(value.length>128||!decimal.test(value))return{value:null,blank:false,error:'CONVERSION_INVALID_NUMBER'};
 const result=Number(value);
 if(!Number.isFinite(result)||Object.is(result,-0)||Number.isInteger(result)&&!Number.isSafeInteger(result)||decimalKey(value)!==decimalKey(String(result)))return{value:null,blank:false,error:'CONVERSION_NUMBER_PRECISION'};
 return{value:result,blank:false};
}
export function planTextPropertyConversion(records,sourcePropertyId,targetType){
 if(!Array.isArray(records)||records.length>1000||typeof sourcePropertyId!=='string'||!PROPERTY_CONVERSION_TYPES.includes(targetType))fail();
 let blankCount=0,invalidCount=0;const ids=new Set(),rows=records.map(record=>{
  if(!record||typeof record.id!=='string'||ids.has(record.id)||!record.values||typeof record.values!=='object'||Array.isArray(record.values))fail();ids.add(record.id);
  const sourceValue=Object.hasOwn(record.values,sourcePropertyId)?record.values[sourcePropertyId]:null,result=convertTextPropertyValue(sourceValue,targetType);if(result.blank)blankCount++;if(result.error)invalidCount++;
  return{recordId:record.id,sourceValue:sourceValue??null,value:result.value,...(result.error?{error:result.error}:{})};
 });return{rows,blankCount,invalidCount,valid:invalidCount===0};
}
