import {assertId,assertJsonSerializable,assertPlainObject,assertTitle,createPageAccessEvaluator,isSimpleTableData,validateSimpleTableData} from '@yumunio/domain';
import {symmetricEncrypt,symmetricDecrypt,generateRandomString,constantTimeEqual} from 'better-auth/crypto';

const encoder=new TextEncoder(),MAX_SNAPSHOT_BYTES=200000,MAX_BLOCKS=1000,MAX_DEPTH=20;
const TYPES=new Set(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote','callout','toggle','divider','table']);
const EXCLUSIONS=Object.freeze(['child-pages','database-records','attachments','comments','authors','source-code','unsupported-blocks','structured-links']);
const TOKEN=/^[a-f0-9]{160,2048}$/;
const headers={'Cache-Control':'no-store','Surrogate-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(value,status=200)=>Response.json(value,{status,headers});
export class ContentPublicationError extends Error{constructor(code='INVALID_PUBLICATION',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code='INVALID_PUBLICATION',status=400)=>{throw new ContentPublicationError(code,status);},missing=()=>fail('CONTENT_NOT_FOUND',404),conflict=()=>fail('CONTENT_CONFLICT',409);
function exact(value,allowed,required=allowed){assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail();}
function stamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||new Date(value).toISOString()!==value)fail();return value;}
function integer(value,min=0){if(!Number.isSafeInteger(value)||value<min||value>=Number.MAX_SAFE_INTEGER)fail();}
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';}
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
const hash=value=>digest(canonical(value));
const key=secret=>secret+'\0Yumunio.publication.v1';
function configured(secret){return typeof secret==='string'&&secret.length>=32&&secret.length<=4096;}

/** This schema is intentionally unrelated to the private Domain block payload. */
function validateSnapshot(value){
  exact(value,['title','blocks']);assertTitle(value.title);if(value.title.includes('\0'))fail();if(encoder.encode(JSON.stringify(value)).length>MAX_SNAPSHOT_BYTES)fail('PUBLICATION_TOO_LARGE',413);
  let count=0;function visit(blocks,depth){if(!Array.isArray(blocks)||depth>MAX_DEPTH)fail();for(const block of blocks){if(++count>MAX_BLOCKS)fail('PUBLICATION_TOO_LARGE',413);exact(block,['type','text','level','checked','children','data'],['type']);if(!TYPES.has(block.type))fail();
    if(block.type==='table'){exact(block,['type','data']);try{validateSimpleTableData(block.data);}catch{fail();}continue;}if(Object.hasOwn(block,'data'))fail();
    if(block.type==='divider'){if(Object.hasOwn(block,'text'))fail();}else if(typeof block.text!=='string'||block.text.length>100000||block.text.includes('\0'))fail();
    if(block.type==='heading'){if(![1,2,3].includes(block.level))fail();}else if(Object.hasOwn(block,'level'))fail();
    if(block.type==='checklist'){if(typeof block.checked!=='boolean')fail();}else if(Object.hasOwn(block,'checked'))fail();
    if(block.children!==undefined)visit(block.children,depth+1);
  }}visit(value.blocks,1);return value;
}

/** Private aggregate metadata. Never expose rows, locators or token fingerprints. */
export function validatePublications(payload,pages){
  const rows=payload.publications??[];if(!Array.isArray(rows)||rows.length>32)fail();const seen=new Set();
  for(const row of rows){exact(row,['pageId','publisherAccountId','publisherMembershipId','nonce','token','tokenHash','sourceVersion','authorizationFingerprint','publishedAt','active','snapshot']);for(const field of ['pageId','publisherAccountId','publisherMembershipId'])assertId(row[field]);
    if(seen.has(row.pageId)||!pages.has(row.pageId)||typeof row.nonce!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(row.nonce)||typeof row.token!=='string'||!TOKEN.test(row.token)||typeof row.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(row.tokenHash)||typeof row.authorizationFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.authorizationFingerprint)||typeof row.active!=='boolean')fail();
    integer(row.sourceVersion,1);if(row.sourceVersion>pages.get(row.pageId).document.version)fail();stamp(row.publishedAt);validateSnapshot(row.snapshot);seen.add(row.pageId);
  }
}

function page(context,pageId){const item=context.payload.pages.find(row=>row.page.id===pageId);if(!item)missing();return item;}
function manage(context,pageId){if(!context.access(pageId).includes('manage'))missing();}
async function authority(context,accountId,pageId){
  const principal=context.saved.principals.find(row=>row.accountId===accountId&&row.emailVerified);if(!principal)missing();
  const evaluate=createPageAccessEvaluator(context.policy(context.payload,context.saved.principals,context.workspaceId));if(!evaluate({accountId,workspaceId:context.workspaceId,pageId}).capabilities.includes('manage'))missing();
  const chain=[],ids=new Set();let cursor=page(context,pageId);while(cursor){if(ids.has(cursor.page.id))missing();ids.add(cursor.page.id);chain.push({id:cursor.page.id,parentId:cursor.page.parentId,trashedAt:cursor.page.trashedAt,inheritPermissions:cursor.inheritPermissions});cursor=cursor.page.parentId===null?null:page(context,cursor.page.parentId);}
  const bindings=new Map(context.payload.grantBindings.map(row=>[row.grantId,row.membershipId]));
  // Revoked grant history is included. Regranting a new ID cannot revive an old URL.
  const grants=context.payload.grants.filter(row=>row.accountId===accountId&&ids.has(row.pageId)).map(row=>({...row,membershipId:bindings.get(row.id)})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return{principal,fingerprint:await hash({membershipId:principal.id,chain,grants})};
}
function projection(item){
  const summary={blocksIncluded:0,blocksOmitted:0,linkSpansOmitted:0};let visited=0;
  const omit=block=>{const pending=[block];while(pending.length){const row=pending.pop();if(++visited>20000)fail('PUBLICATION_TOO_LARGE',413);summary.blocksOmitted++;if(Array.isArray(row.children))pending.push(...row.children);}};
  function literal(block){const text=block.data?.text;if(typeof text!=='string'||text.length>100000||text.includes('\0'))return null;if(block.data.links===undefined)return text;
    if(!Array.isArray(block.data.links)||block.data.links.length>1000)return null;let result='',offset=0;
    for(const link of block.data.links){if(!link||!Number.isSafeInteger(link.start)||!Number.isSafeInteger(link.end)||link.start<offset||link.end<=link.start||link.end>text.length||typeof link.label!=='string'||text.slice(link.start,link.end)!==link.label||link.start>0&&/[\uD800-\uDBFF]/.test(text[link.start-1])&&/[\uDC00-\uDFFF]/.test(text[link.start])||link.end<text.length&&/[\uD800-\uDBFF]/.test(text[link.end-1])&&/[\uDC00-\uDFFF]/.test(text[link.end]))return null;
      result+=text.slice(offset,link.start)+'…';offset=link.end;summary.linkSpansOmitted++;}return result+text.slice(offset);
  }
  function visit(blocks,depth){if(depth>MAX_DEPTH)fail('PUBLICATION_TOO_LARGE',413);const result=[];for(const block of blocks){
      if(block.type==='table'){if(!isSimpleTableData(block.data)||Object.hasOwn(block,'children')){omit(block);continue;}if(++visited>20000||++summary.blocksIncluded>MAX_BLOCKS)fail('PUBLICATION_TOO_LARGE',413);result.push({type:'table',data:structuredClone(block.data)});continue;}
      if(!TYPES.has(block.type)||block.data?.purpose==='import-source'||block.data?.references!==undefined||block.type!=='divider'&&typeof block.data?.text!=='string'){omit(block);continue;}
      const text=block.type==='divider'?undefined:literal(block);if(text===null){omit(block);continue;}if(++visited>20000||++summary.blocksIncluded>MAX_BLOCKS)fail('PUBLICATION_TOO_LARGE',413);
      const projected={type:block.type,...(text===undefined?{}:{text}),...(block.type==='heading'?{level:[1,2,3].includes(block.data?.level)?block.data.level:1}:{}),...(block.type==='checklist'?{checked:block.data?.checked===true}:{})};
      if(block.children)projected.children=visit(block.children,depth+1);result.push(projected);
    }return result;}
  const snapshot=validateSnapshot({title:item.page.title,blocks:visit(item.document.blocks,1)});return{snapshot,summary,exclusions:[...EXCLUSIONS]};
}
async function review(context){const item=page(context,context.pageId);manage(context,context.pageId);const{principal,fingerprint}=await authority(context,context.accountId,context.pageId),projected=projection(item);
  return{...projected,sourceVersion:item.document.version,reviewDigest:await hash({workspaceId:context.workspaceId,pageId:context.pageId,accountId:context.accountId,membershipId:principal.id,sourceVersion:item.document.version,authorizationFingerprint:fingerprint,...projected}),authorizationFingerprint:fingerprint};
}
async function decode(token,secret){if(!configured(secret)||typeof token!=='string'||!TOKEN.test(token))return null;try{const value=JSON.parse(await symmetricDecrypt({key:key(secret),data:token}));exact(value,['scope','workspaceId','pageId','nonce']);if(value.scope!=='Yumunio.publication.v1'||typeof value.nonce!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(value.nonce))return null;assertId(value.workspaceId);assertId(value.pageId);return value;}catch{return null;}}
async function live(context,row,secret,token=row?.token,locator){
  if(!row?.active)return false;locator??=await decode(token,secret);if(!locator||locator.workspaceId!==context.workspaceId||locator.pageId!==row.pageId||!constantTimeEqual(locator.nonce,row.nonce)||!constantTimeEqual(await digest(token),row.tokenHash)||!constantTimeEqual(await digest(row.token),row.tokenHash))return false;
  try{const item=page(context,row.pageId);if(item.document.version!==row.sourceVersion)return false;const current=await authority(context,row.publisherAccountId,row.pageId);return current.principal.id===row.publisherMembershipId&&constantTimeEqual(current.fingerprint,row.authorizationFingerprint);}catch{return false;}
}
async function status(context){const row=context.payload.publications?.find(row=>row.pageId===context.pageId),active=await live(context,row,context.publicationSecret);return{revision:context.saved.revision,pageId:context.pageId,mode:'snapshot',active,needsRepublish:Boolean(row?.active&&!active),sourceVersion:row?.sourceVersion??null,currentSourceVersion:page(context,context.pageId).document.version,publishedAt:row?.publishedAt??null,publicPath:active?'/site?publication='+row.token:null};}

/** Authenticated management; review never writes and publishing never grants ACL. */
export async function handlePublicationRequest(context){
  const{request,pageId,accountId,publicationSecret:secret}=context;if(request.headers.get('x-yumunio-expected-account')!==accountId)missing();manage(context,pageId);if(!configured(secret))fail('PUBLICATION_UNAVAILABLE',503);
  if(request.method==='GET'&&context.kind!=='review')return json(await status(context));
  const data=await context.readJson(request);integer(data?.expectedRevision);if(data.expectedRevision!==context.saved.revision)conflict();
  if(context.kind==='review'){if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);exact(data,['expectedRevision']);const{authorizationFingerprint,...result}=await review(context);return json({revision:context.saved.revision,pageId,mode:'snapshot',...result});}
  if(request.method==='POST'){
    exact(data,['expectedRevision','reviewDigest','confirmPublicExposure']);if(data.confirmPublicExposure!==true)fail('PUBLICATION_CONSENT_REQUIRED');if(typeof data.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.reviewDigest))fail();
    const current=await review(context);if(!constantTimeEqual(current.reviewDigest,data.reviewDigest))fail('PUBLICATION_REVIEW_CHANGED',409);
    const nonce=generateRandomString(32),token=await symmetricEncrypt({key:key(secret),data:JSON.stringify({scope:'Yumunio.publication.v1',workspaceId:context.workspaceId,pageId,nonce})});if(!TOKEN.test(token))fail('PUBLICATION_UNAVAILABLE',503);
    const row={pageId,publisherAccountId:accountId,publisherMembershipId:context.actor.id,nonce,token,tokenHash:await digest(token),sourceVersion:current.sourceVersion,authorizationFingerprint:current.authorizationFingerprint,publishedAt:stamp(context.now()),active:true,snapshot:current.snapshot};
    context.payload.publications??=[];const index=context.payload.publications.findIndex(row=>row.pageId===pageId);if(index<0){if(context.payload.publications.length>=32)fail('PUBLICATION_TOO_LARGE',413);context.payload.publications.push(row);}else context.payload.publications[index]=row;
  }else if(request.method==='DELETE'){exact(data,['expectedRevision']);const row=context.payload.publications?.find(row=>row.pageId===pageId);if(row)row.active=false;
  }else fail('METHOD_NOT_ALLOWED',405);
  const captured=context.validatePayload(context.payload,context.workspaceId);
  try{const written=await context.store.write(context.workspaceId,accountId,{expectedRevision:context.saved.revision,payload:captured,actorMembershipId:context.actor.id,actorRole:context.actor.role,guardMemberships:[]});return json({...await status(context),revision:written.revision});}
  catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;const saved=await context.store.read(context.workspaceId,accountId),actor=saved?.principals.find(row=>row.accountId===accountId&&row.id===context.actor.id&&row.emailVerified);if(!actor)missing();const payload=context.readPayload(saved,context.workspaceId),evaluate=createPageAccessEvaluator(context.policy(payload,saved.principals,context.workspaceId));if(!evaluate({accountId,workspaceId:context.workspaceId,pageId}).capabilities.includes('manage'))missing();conflict();}
}

/** No cookies, session substitution, writes, redirects, external fetch or private DTO. */
export function createPublicPageApi({store,secret,origin,readPayload,policy}){
  return async request=>{
    try{const url=new URL(request.url),match=/^\/api\/public\/pages\/([a-f0-9]{160,2048})$/.exec(url.pathname);if(request.method!=='GET'||url.origin!==origin||url.search||!match)missing();const token=match[1],locator=await decode(token,secret);if(!locator||typeof store.readPublication!=='function')missing();
      const saved=await store.readPublication(locator.workspaceId);if(!saved)missing();const payload=readPayload(saved,locator.workspaceId),row=payload.publications?.find(row=>row.pageId===locator.pageId),context={saved,payload,workspaceId:locator.workspaceId,policy};
      if(!await live(context,row,secret,token,locator))missing();const snapshot=validateSnapshot(row.snapshot);return json({schemaVersion:1,mode:'snapshot',title:snapshot.title,publishedAt:row.publishedAt,blocks:structuredClone(snapshot.blocks)});
    }catch{return json({error:{code:'PUBLIC_PAGE_NOT_FOUND',message:'The public page is unavailable.'}},404);}
  };
}
