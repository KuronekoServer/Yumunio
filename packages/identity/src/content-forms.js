import {assertId,assertPlainObject,assertJsonSerializable,assertTitle,validatePropertyValue,validatePropertyValues,validatePage,validateDocument,createPageAccessEvaluator} from '@yumunio/domain';
import {symmetricEncrypt,symmetricDecrypt,generateRandomString,constantTimeEqual} from 'better-auth/crypto';

const supported=new Set(['text','number','checkbox','date','select','multi_select']),encoder=new TextEncoder();
const PUBLIC_TOKEN=/^[a-f0-9]{160,2048}$/,PUBLIC_REQUEST=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const size=value=>encoder.encode(JSON.stringify(value)).length;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(value,status=200)=>Response.json(value,{status,headers});
export class ContentFormsError extends Error{constructor(code='INVALID_FORM',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code='INVALID_FORM',status=400)=>{throw new ContentFormsError(code,status);};
const missing=()=>fail('CONTENT_NOT_FOUND',404),conflict=()=>fail('CONTENT_CONFLICT',409);
const own=(value,key)=>Object.hasOwn(value,key);
function exact(value,allowed,required=allowed){assertJsonSerializable(value);assertPlainObject(value);if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!own(value,key)))fail();}
function revision(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail();}
function text(value,max,required=false){if(typeof value!=='string'||value.length>max||required&&!value.trim())fail();}
function definition(value,properties=null,{publish=false}={}){
  exact(value,['title','description','fields']);text(value.title,240,true);text(value.description,4000);
  if(!Array.isArray(value.fields)||value.fields.length<1||value.fields.length>64)fail();
  const ids=new Map(),bindings=new Set();
  for(const field of value.fields){exact(field,['id','propertyId','label','description','required','condition']);assertId(field.id);assertId(field.propertyId);text(field.label,240,true);text(field.description,1000);
    if(ids.has(field.id)||bindings.has(field.propertyId)||typeof field.required!=='boolean')fail();
    if(field.condition!==null){exact(field.condition,['fieldId','value']);assertId(field.condition.fieldId);const source=ids.get(field.condition.fieldId);if(!source||field.condition.value===null||!['string','number','boolean'].includes(typeof field.condition.value))fail();
      if(properties){const property=properties.find(item=>item.id===source.propertyId);if(!property||!supported.has(property.type)||property.type==='multi_select')fail();validatePropertyValue({...property,required:false},field.condition.value);}}
    if(properties){const property=properties.find(item=>item.id===field.propertyId);if(!property||!supported.has(property.type))fail('FORM_SCHEMA_CHANGED',409);if(publish&&(field.required||property.required)&&['select','multi_select'].includes(property.type)&&!property.options?.length)fail('FORM_REQUIRED_PROPERTY',409);}
    ids.set(field.id,field);bindings.add(field.propertyId);
  }
  if(publish)for(const property of properties)if(property.required&&!value.fields.some(field=>field.propertyId===property.id&&field.condition===null))fail('FORM_REQUIRED_PROPERTY',409);
  return value;
}

/** Private account aggregate metadata; never returned wholesale to respondents. */
export function validateForms(payload,pages){
  const forms=payload.forms??[],grants=payload.formGrants??[],receipts=payload.formReceipts??[];
  if(!Array.isArray(forms)||forms.length>32||!Array.isArray(grants)||grants.length>1000||!Array.isArray(receipts)||receipts.length>1000)fail();
  const ids=new Map(),collections=new Map((payload.collections??[]).map(entry=>[entry.collection.id,entry]));
  for(const form of forms){exact(form,['id','collectionId','draft','activeVersion','publications','publicLink'],['id','collectionId','draft','activeVersion','publications']);assertId(form.id);assertId(form.collectionId);definition(form.draft);
    if(ids.has(form.id)||!collections.has(form.collectionId)||!Array.isArray(form.publications)||form.publications.length>20||form.activeVersion!==null&&(!Number.isSafeInteger(form.activeVersion)||form.activeVersion<1))fail();
    const versions=new Set();let previous=0;
    for(const publication of form.publications){exact(publication,['version','definition','schemaFingerprint','managerAccountId','managerMembershipId','publishedAt']);definition(publication.definition);assertId(publication.managerAccountId);assertId(publication.managerMembershipId);
      if(!Number.isSafeInteger(publication.version)||publication.version<=previous||typeof publication.schemaFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(publication.schemaFingerprint)||typeof publication.publishedAt!=='string'||!Number.isFinite(Date.parse(publication.publishedAt)))fail();previous=publication.version;versions.add(publication.version);}
    if(form.activeVersion!==null&&!versions.has(form.activeVersion))fail();
    if(form.publicLink!==undefined){const link=form.publicLink;exact(link,['version','nonce','token','authorizationFingerprint']);if(!versions.has(link.version)||!PUBLIC_TOKEN.test(link.token)||!/^[A-Za-z0-9_-]{32}$/.test(link.nonce)||!/^[a-f0-9]{64}$/.test(link.authorizationFingerprint))fail();}
    ids.set(form.id,form);
  }
  const bound=new Set();for(const grant of grants){exact(grant,['formId','accountId','membershipId']);assertId(grant.formId);assertId(grant.accountId);assertId(grant.membershipId);const key=grant.formId+'\0'+grant.accountId;if(!ids.has(grant.formId)||bound.has(key))fail();bound.add(key);}
  const seen=new Set();for(const receipt of receipts){exact(receipt,['requestId','formId','accountId','membershipId','version','digest','acceptedAt','pageId','recordId']);for(const key of ['requestId','formId','accountId','membershipId','pageId','recordId'])assertId(receipt[key]);
    const form=ids.get(receipt.formId),key=receipt.accountId+'\0'+receipt.membershipId+'\0'+receipt.requestId,entry=form&&collections.get(form.collectionId);
    if(seen.has(key)||!form?.publications.some(item=>item.version===receipt.version)||!/^[a-f0-9]{64}$/.test(receipt.digest)||typeof receipt.acceptedAt!=='string'||!Number.isFinite(Date.parse(receipt.acceptedAt))||!pages.has(receipt.pageId)||!entry.recordPages.some(row=>row.pageId===receipt.pageId&&row.recordId===receipt.recordId))fail();seen.add(key);
  }
  const publicReceipts=payload.publicFormReceipts??[],rates=payload.formRateCounters??[];
  if(!Array.isArray(publicReceipts)||publicReceipts.length>1000||!Array.isArray(rates)||rates.length>32)fail();
  const publicSeen=new Set();for(const receipt of publicReceipts){exact(receipt,['requestId','formId','version','digest','acceptedAt','pageId','recordId']);for(const key of ['formId','pageId','recordId'])assertId(receipt[key]);const form=ids.get(receipt.formId),entry=form&&collections.get(form.collectionId),key=receipt.formId+'\0'+receipt.version+'\0'+receipt.requestId;
    if(!PUBLIC_REQUEST.test(receipt.requestId)||publicSeen.has(key)||!form?.publications.some(item=>item.version===receipt.version)||!/^[a-f0-9]{64}$/.test(receipt.digest)||typeof receipt.acceptedAt!=='string'||!Number.isFinite(Date.parse(receipt.acceptedAt))||!pages.has(receipt.pageId)||!entry.recordPages.some(row=>row.pageId===receipt.pageId&&row.recordId===receipt.recordId))fail();publicSeen.add(key);
  }
  const rateSeen=new Set();for(const rate of rates){exact(rate,['formId','minuteStart','hourStart','minuteCount','hourCount']);if(!ids.has(rate.formId)||rateSeen.has(rate.formId)||!['minuteStart','hourStart','minuteCount','hourCount'].every(key=>Number.isSafeInteger(rate[key])&&rate[key]>=0)||rate.minuteStart%60000||rate.hourStart%3600000||rate.minuteStart<rate.hourStart||rate.minuteStart>=rate.hourStart+3600000||rate.minuteCount>20||rate.hourCount>200||rate.minuteCount>rate.hourCount)fail();rateSeen.add(rate.formId);}
}
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';}
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(canonical(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');}
function collectionIn(context,collectionId){const entry=context.payload.collections?.find(row=>row.collection.id===collectionId);if(!entry)missing();return entry;}
function manage(context,entry){if(!context.access(entry.pageId).includes('manage'))missing();}
function publication(form){if(!form||!Array.isArray(form.publications))missing();return form.publications.find(item=>item.version===form.activeVersion);}
async function publishedContext(context,form){
  const entry=collectionIn(context,form.collectionId),published=publication(form);if(!published)missing();
  const manager=context.saved.principals.find(row=>row.accountId===published.managerAccountId&&row.id===published.managerMembershipId&&row.emailVerified);if(!manager)missing();
  const evaluate=createPageAccessEvaluator(context.policy(context.payload,context.saved.principals,context.workspaceId));
  if(!evaluate({accountId:manager.accountId,workspaceId:context.workspaceId,pageId:entry.pageId}).capabilities.includes('manage'))missing();
  if(published.schemaFingerprint!==await digest(entry.collection.properties))missing();
  definition(published.definition,entry.collection.properties,{publish:true});return{entry,published,manager};
}
async function admission(context,form){if(form.publicLink)missing();const grant=context.payload.formGrants?.find(row=>row.formId===form.id&&row.accountId===context.accountId&&row.membershipId===context.actor.id);if(!grant)missing();return publishedContext(context,form);}
function respondentProjection(form,published,entry,anonymous=false){return{id:anonymous?'public-form':form.id,version:published.version,title:published.definition.title,description:published.definition.description,accountRequired:!anonymous,accessToSubmission:'none',fields:published.definition.fields.map(field=>{const property=entry.collection.properties.find(item=>item.id===field.propertyId);return{id:field.id,label:field.label,description:field.description,required:field.required||property.required===true,type:property.type,condition:structuredClone(field.condition),...(['select','multi_select'].includes(property.type)?{options:[...(property.options??[])]}:{})};})};}
async function managerProjection(context,form){let accepting=false;try{await publishedContext(context,form);accepting=!form.publicLink||await publicAdmission(context,form,context.publicationSecret,form.publicLink.token);accepting=Boolean(accepting);}catch{}return{id:form.id,collectionId:form.collectionId,draft:structuredClone(form.draft),activeVersion:form.activeVersion,accepting,needsRepublish:form.activeVersion!==null&&!accepting,lastVersion:form.publications.at(-1)?.version??0,audience:form.publicLink?'anonymous':'assigned',publicPath:accepting&&form.publicLink?'/forms?public='+form.publicLink.token:null,respondentAccountIds:(context.payload.formGrants??[]).filter(grant=>grant.formId===form.id&&context.saved.principals.some(row=>row.accountId===grant.accountId&&row.id===grant.membershipId&&row.emailVerified)).map(row=>row.accountId)};}
function mint(context){const used=new Set([...context.payload.pages.flatMap(row=>[row.page.id,...row.document.blocks.map(block=>block.id)]),...context.payload.grants.map(row=>row.id),...(context.payload.collections??[]).flatMap(entry=>[entry.collection.id,...entry.collection.records.map(row=>row.id)]),...(context.payload.forms??[]).map(row=>row.id)]);return()=>{const value=assertId(context.createId());if(used.has(value))fail('FORM_UNAVAILABLE',503);used.add(value);return value;};}
async function fresh(context){const saved=await context.store.read(context.workspaceId,context.accountId),actor=saved?.principals.find(row=>row.accountId===context.accountId&&row.id===context.actor.id&&row.emailVerified);if(!actor)missing();const payload=context.readPayload(saved,context.workspaceId),evaluate=createPageAccessEvaluator(context.policy(payload,saved.principals,context.workspaceId));return{...context,saved,payload,actor,access:pageId=>evaluate({accountId:context.accountId,workspaceId:context.workspaceId,pageId}).capabilities};}
async function commit(context,guards,authorizeFresh,result,status=200){const captured=context.validatePayload(context.payload,context.workspaceId);try{const written=await context.store.write(context.workspaceId,context.accountId,{expectedRevision:context.saved.revision,payload:captured,actorMembershipId:context.actor.id,actorRole:context.actor.role,guardMemberships:guards});return json({revision:written.revision,...result},status);}catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;await authorizeFresh(await fresh(context));conflict();}}
async function body(context){const value=await context.readJson(context.request);if(size(value)>64000)fail('FORM_TOO_LARGE',413);return value;}
function answersFor(definition,properties,answers){
  assertPlainObject(answers);assertJsonSerializable(answers);if(Object.keys(answers).some(id=>!definition.fields.some(field=>field.id===id)))fail();
  const values=Object.fromEntries(properties.map(property=>[property.id,null])),visible=new Set(),normalized={};
  for(const field of definition.fields){const shown=field.condition===null||visible.has(field.condition.fieldId)&&own(normalized,field.condition.fieldId)&&normalized[field.condition.fieldId]===field.condition.value;
    if(!shown){if(own(answers,field.id))fail('FORM_HIDDEN_ANSWER');continue;}
    visible.add(field.id);const property=properties.find(item=>item.id===field.propertyId),value=own(answers,field.id)?answers[field.id]:null;
    if(typeof value==='string'&&value.length>10000||Array.isArray(value)&&value.length>128)fail('FORM_TOO_LARGE',413);
    if((field.required||property.required)&&(value===null||value===''||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length))fail('FORM_REQUIRED_ANSWER');
    validatePropertyValue({...property,required:field.required||property.required===true},value);normalized[field.id]=structuredClone(value);values[property.id]=structuredClone(value);
  }
  validatePropertyValues(properties,values);return{values,normalized};
}
function appendResponse(context,entry,published,manager,values,normalized,stamp){
  const create=mint(context),pageId=create(),recordId=create(),grantId=create(),sourceId=create();
  const source={formTitle:published.definition.title,formVersion:published.version,acceptedAt:stamp,questions:published.definition.fields.filter(field=>own(normalized,field.id)).map(field=>({label:field.label,value:normalized[field.id]}))},sourceText=JSON.stringify(source);if(sourceText.length>100000)fail('FORM_TOO_LARGE',413);
  const page=validatePage({id:pageId,workspaceId:context.workspaceId,title:published.definition.title,parentId:entry.pageId,createdAt:stamp,updatedAt:stamp,trashedAt:null}),document=validateDocument({pageId,workspaceId:context.workspaceId,version:1,updatedAt:stamp,blocks:[{id:sourceId,type:'code',data:{text:sourceText,language:'json',purpose:'import-source',sourceKind:'form-response'}}]});
  context.payload.pages.push({page,document,inheritPermissions:false});context.payload.grants.push({id:grantId,workspaceId:context.workspaceId,pageId,accountId:manager.accountId,permission:'full',includeDescendants:false,status:'active'});context.payload.grantBindings.push({grantId,membershipId:manager.id});
  entry.collection.records.push({id:recordId,values});entry.recordPages.push({recordId,pageId,sourceValues:{},sourceKind:'manual'});entry.collection.updatedAt=stamp;return{pageId,recordId};
}
const publicKey=secret=>secret+'\0Yumunio.form-public.v1';
const publicConfigured=secret=>typeof secret==='string'&&secret.length>=32&&secret.length<=4096;
async function publicLocator(token,secret){if(!publicConfigured(secret)||!PUBLIC_TOKEN.test(token??''))return null;try{const value=JSON.parse(await symmetricDecrypt({key:publicKey(secret),data:token}));exact(value,['scope','workspaceId','formId','nonce']);if(value.scope!=='Yumunio.form-public.v1'||!/^[A-Za-z0-9_-]{32}$/.test(value.nonce))return null;assertId(value.workspaceId);assertId(value.formId);return value;}catch{return null;}}
async function publicAuthorization(context,manager,entry){
  const state=context.policy(context.payload,context.saved.principals,context.workspaceId),chain=[],ids=new Set();let page=state.pages.find(row=>row.id===entry.pageId);
  while(page){if(ids.has(page.id))missing();ids.add(page.id);chain.push(page);page=page.parentId===null?null:state.pages.find(row=>row.id===page.parentId);}
  const grants=context.payload.grants.filter(row=>row.accountId===manager.accountId&&ids.has(row.pageId)),grantIds=new Set(grants.map(row=>row.id));
  const groupMembers=state.groupMembers.filter(row=>row.accountId===manager.accountId),groupIds=new Set(groupMembers.map(row=>row.groupId));
  const placements=state.teamspacePages.filter(row=>ids.has(row.pageId)),teamIds=new Set(placements.map(row=>row.teamspaceId));
  return digest({manager:{id:manager.id,accountId:manager.accountId,role:manager.role},chain,grants,bindings:context.payload.grantBindings.filter(row=>grantIds.has(row.grantId)),groupMembers,groups:state.groups.filter(row=>groupIds.has(row.id)),groupGrants:state.groupGrants.filter(row=>groupIds.has(row.groupId)&&ids.has(row.pageId)),placements,teamspaces:state.teamspaces.filter(row=>teamIds.has(row.id)),teamspaceMembers:state.teamspaceMembers.filter(row=>teamIds.has(row.teamspaceId)&&row.accountId===manager.accountId)});
}
async function publicAdmission(context,form,secret,token,locator){
  const link=form?.publicLink;if(!link||link.version!==form.activeVersion||!PUBLIC_TOKEN.test(token??''))missing();locator??=await publicLocator(token,secret);
  if(!locator||locator.workspaceId!==context.workspaceId||locator.formId!==form.id||!constantTimeEqual(locator.nonce,link.nonce)||!constantTimeEqual(token,link.token))missing();
  const admitted=await publishedContext(context,form);if(!constantTimeEqual(await publicAuthorization(context,admitted.manager,admitted.entry),link.authorizationFingerprint))missing();return admitted;
}
function chargePublicAttempt(payload,formId,stamp){
  const time=Date.parse(stamp);if(!Number.isFinite(time)||time<0)fail('FORM_UNAVAILABLE',503);const minuteStart=Math.floor(time/60000)*60000,hourStart=Math.floor(time/3600000)*3600000;
  payload.formRateCounters??=[];let row=payload.formRateCounters.find(item=>item.formId===formId);if(!row){if(payload.formRateCounters.length>=32)fail('FORM_UNAVAILABLE',503);row={formId,minuteStart,hourStart,minuteCount:0,hourCount:0};payload.formRateCounters.push(row);}
  if(minuteStart<row.minuteStart||hourStart<row.hourStart)fail('FORM_UNAVAILABLE',503);if(row.minuteStart!==minuteStart){row.minuteStart=minuteStart;row.minuteCount=0;}if(row.hourStart!==hourStart){row.hourStart=hourStart;row.hourCount=0;}
  if(row.minuteCount>=20||row.hourCount>=200)fail('FORM_RATE_LIMITED',429);row.minuteCount++;row.hourCount++;
}

/** Anonymous create-only capability. Cookies/identity headers are neither read nor promoted to rights. */
export function createPublicFormApi({store,secret,origin,readPayload,validatePayload,policy,readJson,now,createId}){
  return async request=>{try{
    const url=new URL(request.url),match=/^\/api\/public\/forms\/([a-f0-9]{160,2048})(?:\/(responses))?$/.exec(url.pathname);
    if(!match||url.origin!==origin||url.search)missing();if(request.method!==(match[2]?'POST':'GET'))fail('METHOD_NOT_ALLOWED',405);
    if(request.headers.has('origin')&&request.headers.get('origin')!==origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))||match[2]&&request.headers.get('origin')!==origin)fail('ORIGIN_REJECTED',403);
    const token=match[1],locator=await publicLocator(token,secret);if(!locator||typeof store.readPublication!=='function')missing();
    let bodyRead=false,data,parseError;
    for(let attempt=0;attempt<6;attempt++){
      const saved=await store.readPublication(locator.workspaceId);if(!saved)missing();const payload=readPayload(saved,locator.workspaceId),form=payload.forms?.find(row=>row.id===locator.formId),context={request,store,saved,payload,workspaceId:locator.workspaceId,policy,createId,now};
      const admitted=await publicAdmission(context,form,secret,token,locator),{entry,published,manager}=admitted;
      if(!match[2])return json(respondentProjection(form,published,entry,true));
      if(!bodyRead){try{data=await readJson(request,64000);}catch(error){parseError=error;}bodyRead=true;}
      let invalid=parseError,answer;
      if(!invalid)try{exact(data,['requestId','version','answers']);if(!PUBLIC_REQUEST.test(data.requestId??'')||!Number.isSafeInteger(data.version)||data.version<1)fail();if(data.version!==published.version)fail('FORM_VERSION_CHANGED',409);answer=answersFor(published.definition,entry.collection.properties,data.answers);}catch(error){invalid=error;}
      const existing=!invalid&&(payload.publicFormReceipts??[]).find(row=>row.formId===form.id&&row.version===data.version&&row.requestId===data.requestId),hash=!invalid?await digest({formId:form.id,version:data.version,answers:answer.normalized}):null;
      if(existing){if(existing.digest===hash)return json({requestId:data.requestId,accepted:true});invalid=new ContentFormsError('FORM_SUBMISSION_CONFLICT',409);}
      const stamp=now();chargePublicAttempt(payload,form.id,stamp);
      if(!invalid){if((payload.publicFormReceipts?.length??0)>=1000)fail('FORM_UNAVAILABLE',503);context.accountId=manager.accountId;context.actor=manager;const ids=appendResponse(context,entry,published,manager,answer.values,answer.normalized,stamp);payload.publicFormReceipts??=[];payload.publicFormReceipts.push({requestId:data.requestId,formId:form.id,version:data.version,digest:hash,acceptedAt:stamp,...ids});}
      const captured=validatePayload(payload,locator.workspaceId);
      try{await store.write(locator.workspaceId,manager.accountId,{expectedRevision:saved.revision,payload:captured,actorMembershipId:manager.id,actorRole:manager.role,guardMemberships:[]});if(invalid)throw invalid;return json({requestId:data.requestId,accepted:true},201);}
      catch(error){if(error?.code==='CONTENT_CONFLICT')continue;throw error;}
    }
    conflict();
  }catch(error){const status=error?.code==='CONTENT_NOT_FOUND'?404:error?.status===413?413:error?.status===429?429:error?.status===409?409:error?.status===403?403:error?.status===405?405:error?.status>=500?503:error instanceof ContentFormsError||error?.name==='DomainError'||error?.status>=400&&error?.status<500?400:503;const code=status===404?'PUBLIC_FORM_NOT_FOUND':status===503?'FORM_UNAVAILABLE':status===413?'FORM_TOO_LARGE':status===429?'FORM_RATE_LIMITED':status===409?error.code:status===403?'ORIGIN_REJECTED':status===405?'METHOD_NOT_ALLOWED':error instanceof ContentFormsError?error.code:'INVALID_FORM';return json({error:{code,message:'The form request could not be completed.'}},status);}};
}

/** Authenticated create-only submission. No owner/session impersonation and no respondent page-read grant. */
async function submit(initial,formId,data){
  exact(data,['requestId','version','answers']);assertId(data.requestId);if(!Number.isSafeInteger(data.version)||data.version<1)fail();
  let context=initial;
  for(let attempt=0;attempt<4;attempt++){
    const form=context.payload.forms?.find(row=>row.id===formId);if(!form)missing();const{entry,published,manager}=await admission(context,form);
    if(data.version!==published.version)fail('FORM_VERSION_CHANGED',409);
    const existing=context.payload.formReceipts?.find(row=>row.accountId===context.accountId&&row.membershipId===context.actor.id&&row.requestId===data.requestId);
    if(existing&&(existing.formId!==formId||existing.version!==data.version))fail('FORM_SUBMISSION_CONFLICT',409);
    let values,normalized;try{({values,normalized}=answersFor(published.definition,entry.collection.properties,data.answers));}catch(error){if(existing)fail('FORM_SUBMISSION_CONFLICT',409);throw error;}
    const hash=await digest({formId,version:data.version,answers:normalized});
    if(existing){if(existing.digest!==hash)fail('FORM_SUBMISSION_CONFLICT',409);return json({requestId:data.requestId,accepted:true});}
    const stamp=context.now(),time=Date.parse(stamp);if(!Number.isFinite(time))fail('FORM_UNAVAILABLE',503);
    const prior=(context.payload.formReceipts??[]).filter(row=>row.formId===formId&&row.accountId===context.accountId&&row.membershipId===context.actor.id);
    if(prior.filter(row=>Date.parse(row.acceptedAt)>time-60000).length>=5||prior.filter(row=>Date.parse(row.acceptedAt)>time-3600000).length>=50)fail('FORM_RATE_LIMITED',429);
    if((context.payload.formReceipts?.length??0)>=1000)fail('FORM_UNAVAILABLE',503);
    const{pageId,recordId}=appendResponse(context,entry,published,manager,values,normalized,stamp);
    context.payload.formReceipts??=[];context.payload.formReceipts.push({requestId:data.requestId,formId,accountId:context.accountId,membershipId:context.actor.id,version:data.version,digest:hash,acceptedAt:stamp,pageId,recordId});
    const captured=context.validatePayload(context.payload,context.workspaceId);
    try{await context.store.write(context.workspaceId,context.accountId,{expectedRevision:context.saved.revision,payload:captured,actorMembershipId:context.actor.id,actorRole:context.actor.role,guardMemberships:[{id:manager.id,accountId:manager.accountId,role:manager.role}]});return json({requestId:data.requestId,accepted:true},201);}
    catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;context=await fresh(initial);const current=context.payload.forms?.find(row=>row.id===formId);if(!current)missing();await admission(context,current);}
  }
  conflict();
}

export async function handleFormRequest(context){
  const{request,kind,collectionId,formId,payload,saved,accountId,actor,now}=context;
  if(request.headers.get('x-yumunio-expected-account')!==accountId)missing();
  if(kind==='respond'||kind==='submit'){
    const form=payload.forms?.find(row=>row.id===formId);if(!form)missing();const admitted=await admission(context,form);
    if(kind==='respond'){if(request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);return json(respondentProjection(form,admitted.published,admitted.entry));}
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);return submit(context,formId,await body(context));
  }
  const entry=collectionIn(context,collectionId);manage(context,entry);
  if(kind==='manage-list'&&request.method==='GET')return json({revision:saved.revision,collectionId,pageId:entry.pageId,forms:await Promise.all((payload.forms??[]).filter(form=>form.collectionId===collectionId).map(form=>managerProjection(context,form)))});
  if(kind==='manage-list'){
    if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);const data=await body(context);exact(data,['expectedRevision','definition']);revision(data.expectedRevision);definition(data.definition,entry.collection.properties);if(data.expectedRevision!==saved.revision)conflict();
    if((payload.forms?.length??0)>=32)fail('FORM_TOO_LARGE',413);const id=mint(context)();payload.forms??=[];payload.forms.push({id,collectionId,draft:structuredClone(data.definition),activeVersion:null,publications:[]});
    return commit(context,[],fresh=>manage(fresh,collectionIn(fresh,collectionId)),{formId:id},201);
  }
  const form=payload.forms?.find(row=>row.id===formId&&row.collectionId===collectionId);if(!form)missing();
  if(kind==='manage'&&request.method==='GET')return json({revision:saved.revision,pageId:entry.pageId,form:await managerProjection(context,form)});
  const data=await body(context);revision(data?.expectedRevision);if(data.expectedRevision!==saved.revision)conflict();
  if(kind==='manage'){
    if(request.method!=='PATCH')fail('METHOD_NOT_ALLOWED',405);exact(data,['expectedRevision','definition']);definition(data.definition,entry.collection.properties);form.draft=structuredClone(data.definition);
    return commit(context,[],fresh=>manage(fresh,collectionIn(fresh,collectionId)),{formId});
  }
  if(kind!=='acceptance'||request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
  exact(data,['expectedRevision','accepting','confirmManagerAccess','respondentAccountIds','audience','confirmPublicExposure'],['expectedRevision','accepting']);if(typeof data.accepting!=='boolean')fail();
  const guards=[];
  if(data.accepting){
    const audience=data.audience??'assigned';if(!['assigned','anonymous'].includes(audience)||data.confirmManagerAccess!==true)fail('FORM_ACCEPTANCE_CONSENT');
    if(audience==='anonymous'){if(data.confirmPublicExposure!==true||own(data,'respondentAccountIds'))fail('FORM_ACCEPTANCE_CONSENT');if(!publicConfigured(context.publicationSecret)||typeof context.store.readPublication!=='function')fail('FORM_UNAVAILABLE',503);}
    else if(own(data,'confirmPublicExposure')||!Array.isArray(data.respondentAccountIds)||data.respondentAccountIds.length>16||new Set(data.respondentAccountIds).size!==data.respondentAccountIds.length)fail('FORM_ACCEPTANCE_CONSENT');
    definition(form.draft,entry.collection.properties,{publish:true});if(form.publications.length>=20)fail('FORM_TOO_LARGE',413);
    const recipients=(data.respondentAccountIds??[]).map(id=>{assertId(id);const principal=saved.principals.find(row=>row.accountId===id&&row.emailVerified);if(!principal)missing();return principal;});
    // More live guards than the shared atomic store supports must never be silently dropped.
    if(recipients.filter(row=>row.id!==actor.id).length>16)fail('FORM_TOO_LARGE',413);
    payload.formGrants=(payload.formGrants??[]).filter(row=>row.formId!==formId);for(const recipient of recipients){payload.formGrants.push({formId,accountId:recipient.accountId,membershipId:recipient.id});if(recipient.id!==actor.id)guards.push({id:recipient.id,accountId:recipient.accountId,role:recipient.role});}
    const version=(form.publications.at(-1)?.version??0)+1;form.publications.push({version,definition:structuredClone(form.draft),schemaFingerprint:await digest(entry.collection.properties),managerAccountId:accountId,managerMembershipId:actor.id,publishedAt:now()});form.activeVersion=version;
    delete form.publicLink;if(audience==='anonymous'){const nonce=generateRandomString(32),token=await symmetricEncrypt({key:publicKey(context.publicationSecret),data:JSON.stringify({scope:'Yumunio.form-public.v1',workspaceId:context.workspaceId,formId,nonce})});if(!PUBLIC_TOKEN.test(token))fail('FORM_UNAVAILABLE',503);form.publicLink={version,nonce,token,authorizationFingerprint:await publicAuthorization(context,actor,entry)};}
  }else{if(['confirmManagerAccess','respondentAccountIds','audience','confirmPublicExposure'].some(key=>own(data,key)))fail();form.activeVersion=null;delete form.publicLink;}
  return commit(context,guards,fresh=>manage(fresh,collectionIn(fresh,collectionId)),{formId,accepting:data.accepting,version:form.activeVersion});
}
