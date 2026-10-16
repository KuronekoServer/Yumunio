import {parseCollectionValue} from './collections-model.js';
export const FORM_TYPES=Object.freeze(['text','number','checkbox','date','select','multi_select']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export function validateManagedForm(value,collectionId){
 if(!value||!id(value.id)||value.collectionId!==collectionId||!value.draft||!Array.isArray(value.draft.fields)||value.draft.fields.length<1||value.draft.fields.length>64||typeof value.draft.title!=='string'||!Array.isArray(value.respondentAccountIds)||value.respondentAccountIds.some(account=>!id(account))||typeof value.accepting!=='boolean'||!['assigned','anonymous'].includes(value.audience)||value.publicPath!==null&&(typeof value.publicPath!=='string'||!/^\/forms\.html\?public=[a-f0-9]{160,2048}$/.test(value.publicPath))||value.audience==='assigned'&&value.publicPath!==null||value.audience==='anonymous'&&value.accepting&&value.publicPath===null||!value.accepting&&value.publicPath!==null)throw new TypeError('invalidResponse');
 return structuredClone(value);
}
export function validateRespondentForm(value,formId,{anonymous=false}={}){
  if(!value||Object.keys(value).some(key=>!['id','version','title','description','accountRequired','accessToSubmission','fields'].includes(key))||value.id!==formId||anonymous&&formId!=='public-form'||!id(value.id)||!Number.isSafeInteger(value.version)||value.version<1||typeof value.title!=='string'||typeof value.description!=='string'||value.accountRequired!==!anonymous||value.accessToSubmission!=='none'||!Array.isArray(value.fields)||value.fields.length<1||value.fields.length>64)throw new TypeError('invalidResponse');
  const fields=new Map();for(const field of value.fields){if(!id(field.id)||fields.has(field.id)||!FORM_TYPES.includes(field.type)||typeof field.label!=='string'||typeof field.description!=='string'||typeof field.required!=='boolean'||field.condition!==null&&(!field.condition||!fields.has(field.condition.fieldId)||!['string','number','boolean'].includes(typeof field.condition.value))||['select','multi_select'].includes(field.type)&&(!Array.isArray(field.options)||field.options.some(option=>typeof option!=='string')))throw new TypeError('invalidResponse');fields.set(field.id,field);}
  return structuredClone(value);
}
export function visibleFormFields(form,answers){const visible=new Set();return form.fields.filter(field=>{const shown=field.condition===null||visible.has(field.condition.fieldId)&&answers[field.condition.fieldId]===field.condition.value;if(shown)visible.add(field.id);return shown;});}
export function formValue(field,raw){const value=parseCollectionValue({...field,id:field.id,name:field.label,required:false},raw);if(field.required&&(value===null||value===''||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length))throw new TypeError('requiredAnswer');if(typeof value==='string'&&value.length>10000)throw new TypeError('tooLarge');return value;}
/** A transport retry always sends the exact captured request, even if its acknowledgement was lost. */
export class FormSubmissionDraft{
  constructor(form,answers,requestId){if(!id(requestId))throw new TypeError('invalidValue');this.body={requestId,version:form.version,answers:structuredClone(answers)};this.accepted=false;}
  snapshot(){return structuredClone(this.body);}
  acknowledge(value){if(!value||Object.keys(value).length!==2||value.requestId!==this.body.requestId||value.accepted!==true)throw new TypeError('invalidResponse');this.accepted=true;return true;}
}
