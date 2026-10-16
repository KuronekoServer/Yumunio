import {assertId} from '@yumunio/domain';
import {validateContentPayload} from './content.js';
import {WebhookError,WEBHOOK_LIMITS,WEBHOOK_DEFAULT_EVENT_TYPES,webhookFail,webhookExact,webhookHash,webhookInteger,webhookUuid,webhookTime,webhookPageAuthority,webhookPageInScope,webhookRetryDelay,webhookDigest} from './webhooks-model.js';
import {invokeWebhook} from './webhooks-transport.js';

const headers={'Cache-Control':'no-store','Surrogate-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(body,status=200)=>Response.json(body,{status,headers});
const missing=()=>webhookFail('WEBHOOK_NOT_FOUND',404),conflict=()=>webhookFail('WEBHOOK_CONFLICT',409);
const publicProfile=config=>config.enabled?{label:config.label,endpointOrigin:config.endpointOrigin,profileDigest:config.profileHash,...(config.includeDescendants?{includeDescendants:true}:{})}:null;
const publicApproval=(row,approved)=>row?{version:row.version,approved}:null;
const publicSubscription=row=>row?Object.fromEntries(['id','status','reason','version','startVersion','missedFromVersion','missedThroughVersion','gapAcknowledgedAt'].map(key=>[key,row[key]])):null;
const publicDelivery=row=>Object.fromEntries(['eventId','eventType','pageVersion','occurredAt','status','attempts','nextAttemptAt','lastCode','version'].map(key=>[key,row[key]]));
async function readJson(request){
 if((request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!=='application/json'||!request.body)webhookFail('WEBHOOK_INVALID_REQUEST',400);
 const reader=request.body.getReader(),parts=[];let length=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192){await reader.cancel().catch(()=>{});webhookFail('WEBHOOK_INVALID_REQUEST',413);}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{webhookFail('WEBHOOK_INVALID_REQUEST',400);}
}
function validId(value){try{return assertId(value);}catch{webhookFail('WEBHOOK_INVALID_REQUEST',400);}}
function sameAuthority(sub,authority){return Boolean(authority&&sub.issuerAccountId===authority.accountId&&sub.membershipId===authority.membershipId&&sub.actorRole===authority.actorRole&&sub.authorityFingerprint===authority.fingerprint);}
async function currentApproval(config,store,adminIds){const row=await store.approval(config.profileHash),approved=Boolean(row&&row.revokedAt===null&&adminIds.has(row.approvedBy)&&await store.verified(row.approvedBy));return{row,approved};}

/** Metadata-only page update events; endpoint and signing keys are fixed by the operator environment. */
export function createWebhookApi({config,store,contentStore,resolveSession,origin,adminIds=new Set(),now=()=>new Date().toISOString(),createId=()=>crypto.randomUUID()}={}){
 if(Array.isArray(adminIds))adminIds=new Set(adminIds);
 if(!config||typeof config.enabled!=='boolean'||typeof resolveSession!=='function'||new URL(origin).origin!==origin||!(adminIds instanceof Set)||config.enabled&&(!store||typeof contentStore?.read!=='function'))throw new Error('Invalid webhook service configuration.');
 const time=()=>webhookTime(now());
 return async request=>{try{
  const url=new URL(request.url),isConfig=url.pathname==='/api/webhooks/config',isApproval=url.pathname==='/api/webhooks/approval',route=/^\/api\/webhooks\/workspaces\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/pages\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(subscription|deliveries)(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
  if(!isConfig&&!isApproval&&!route)return null;
  if(url.origin!==origin||url.search||url.hash)missing();
  const mutation=['POST','DELETE'].includes(request.method);
  if(request.headers.has('authorization')||request.headers.has('origin')&&request.headers.get('origin')!==origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))||mutation&&request.headers.get('origin')!==origin)webhookFail('ORIGIN_REJECTED',403);
  if(isConfig&&request.method!=='GET'||isApproval&&!['POST','DELETE'].includes(request.method)||route&&(route[3]==='subscription'?route[4]||!['GET','POST','DELETE'].includes(request.method):route[4]?request.method!=='DELETE':request.method!=='GET'))webhookFail('METHOD_NOT_ALLOWED',405);
  const session=await resolveSession(request);if(!session?.user?.id||session.user.emailVerified!==true)webhookFail('UNAUTHORIZED',401);
  const accountId=validId(session.user.id),expected=validId(request.headers.get('x-yumunio-expected-account'));if(accountId!==expected)missing();
  const canApprove=adminIds.has(accountId)&&(!config.enabled||await store.verified(accountId));
  const configuration=async()=>{const approval=config.enabled?await currentApproval(config,store,adminIds):{row:null,approved:false};return{enabled:config.enabled,canApprove,profile:publicProfile(config),eventTypes:[...(config.enabled?config.eventTypes:WEBHOOK_DEFAULT_EVENT_TYPES)],limits:{pending:WEBHOOK_LIMITS.pending,metadata:WEBHOOK_LIMITS.metadata,attempts:WEBHOOK_LIMITS.attempts},approval:publicApproval(approval.row,approval.approved)};};
  if(isConfig)return json(await configuration());
  if(!config.enabled)webhookFail('WEBHOOK_DISABLED',503);
  if(isApproval){
   if(!canApprove)missing();const data=await readJson(request);webhookExact(data,request.method==='POST'?['expectedVersion','profileDigest','eventTypes','confirmMetadataTransfer']:['expectedVersion','profileDigest']);webhookHash(data.profileDigest);webhookInteger(data.expectedVersion);if(data.profileDigest!==config.profileHash)conflict();
   if(request.method==='POST'){if(data.confirmMetadataTransfer!==true||JSON.stringify(data.eventTypes)!==JSON.stringify(config.eventTypes))webhookFail('WEBHOOK_INVALID_REQUEST',400);await store.approve({profileHash:config.profileHash,accountId,expectedVersion:data.expectedVersion,now:time()});}
   else{webhookInteger(data.expectedVersion,1);await store.revokeApproval({profileHash:config.profileHash,accountId,expectedVersion:data.expectedVersion,now:time()});}
   return json(await configuration());
  }
  const workspaceId=validId(route[1]),pageId=validId(route[2]);if(route[4])webhookUuid(route[4]);
  const saved=await contentStore.read(workspaceId,accountId),authority=await webhookPageAuthority({workspaceId,pageId,accountId,saved,validatePayload:validateContentPayload,includeTrash:config.eventTypes.includes('page.trashed')||config.eventTypes.includes('page.restored')});if(!authority)missing();
  const subscription=await store.subscription(workspaceId,pageId);
  const recheck=async()=>{const current=await webhookPageAuthority({workspaceId,pageId,accountId,saved:await contentStore.read(workspaceId,accountId),validatePayload:validateContentPayload,includeTrash:config.eventTypes.includes('page.trashed')||config.eventTypes.includes('page.restored')});if(!current||current.membershipId!==authority.membershipId||current.actorRole!==authority.actorRole||current.fingerprint!==authority.fingerprint)missing();if(current.expectedRevision!==authority.expectedRevision)conflict();};
  const status=async()=>{const approval=await currentApproval(config,store,adminIds),current=await store.subscription(workspaceId,pageId);await recheck();return{revision:authority.expectedRevision,pageVersion:authority.pageVersion,profile:publicProfile(config),approval:publicApproval(approval.row,approval.approved),subscription:publicSubscription(current),canManage:true};};
  const deliveries=async()=>{
   const sub=await store.subscription(workspaceId,pageId);
   const rows=[];if(sub&&sameAuthority(sub,authority)){for(const job of await store.deliveries(sub.id,50)){if(!webhookPageInScope(saved.payload,pageId,job.pageId,config.includeDescendants))continue;const target=await webhookPageAuthority({workspaceId,pageId:job.pageId,accountId,saved,validatePayload:validateContentPayload,includeTrash:job.eventType==='page.trashed'});if(target)rows.push(publicDelivery(job));}}await recheck();
   return{revision:authority.expectedRevision,subscriptionId:sub?.id??null,deliveries:rows};
  };
  if(route[3]==='deliveries'){
   if(request.method==='GET')return json(await deliveries());
   if(!subscription||!sameAuthority(subscription,authority))missing();const data=await readJson(request);webhookExact(data,['expectedRevision','expectedVersion']);webhookInteger(data.expectedRevision,1);webhookInteger(data.expectedVersion,1);if(data.expectedRevision!==authority.expectedRevision)conflict();
   const job=await store.job(route[4]);if(!job||job.subscriptionId!==subscription.id||!webhookPageInScope(saved.payload,pageId,job.pageId,config.includeDescendants)||!await webhookPageAuthority({workspaceId,pageId:job.pageId,accountId,saved,validatePayload:validateContentPayload,includeTrash:job.eventType==='page.trashed'}))missing();if(!['queued','leased'].includes(job.status))conflict();await store.cancelJob(job,{authority,expectedVersion:data.expectedVersion,now:time()});return json(await deliveries());
  }
  if(request.method==='GET')return json(await status());
  const data=await readJson(request);webhookExact(data,request.method==='POST'?['expectedRevision','expectedVersion','profileDigest','confirmMetadataTransfer','acknowledgeMissing',...(config.includeDescendants?['confirmDescendants']:[])]:['expectedRevision','expectedVersion']);webhookInteger(data.expectedRevision,1);webhookInteger(data.expectedVersion);if(data.expectedRevision!==authority.expectedRevision||data.expectedVersion!==(subscription?.version??0))conflict();
  if(request.method==='DELETE'){if(!subscription)missing();await store.cancel(subscription,{authority,expectedVersion:data.expectedVersion,now:time(),reason:'user'});return json(await status());}
  if(authority.trashedAt!==null)missing();webhookHash(data.profileDigest);if(data.profileDigest!==config.profileHash)conflict();if(data.confirmMetadataTransfer!==true||config.includeDescendants&&data.confirmDescendants!==true||typeof data.acknowledgeMissing!=='boolean')webhookFail('WEBHOOK_INVALID_REQUEST',400);
  if((subscription?.missedFromVersion!==null&&subscription?.missedFromVersion!==undefined||['restore','capacity'].includes(subscription?.reason)||subscription?.status==='paused')&&!data.acknowledgeMissing)webhookFail('WEBHOOK_INVALID_REQUEST',400);
  const approval=await currentApproval(config,store,adminIds);if(!approval.approved)webhookFail('WEBHOOK_APPROVAL_REQUIRED',409);
  const stamp=time(),row={id:subscription?.id??webhookUuid(createId()),workspaceId,pageId,issuerAccountId:accountId,membershipId:authority.membershipId,actorRole:authority.actorRole,profileHash:config.profileHash,authorityFingerprint:authority.fingerprint,startVersion:authority.pageVersion,status:'active',reason:null,missedFromVersion:subscription?.missedFromVersion??null,missedThroughVersion:subscription?.missedThroughVersion??null,gapAcknowledgedAt:subscription&&(subscription.missedFromVersion!==null||['restore','capacity'].includes(subscription.reason)||subscription.status==='paused')?stamp:subscription?.gapAcknowledgedAt??null,createdAt:subscription?.createdAt??stamp,updatedAt:stamp,version:data.expectedVersion+1};
  await store.subscribe(row,{authority,approval:approval.row,expectedVersion:data.expectedVersion});return json(await status());
 }catch(error){const known=error instanceof WebhookError,code=known?(error.code==='INVALID_WEBHOOK_REQUEST'?'WEBHOOK_INVALID_REQUEST':error.code):'WEBHOOK_STORAGE_ERROR';return json({error:{code,message:'The webhook request could not be completed.'}},known?error.status:503);}};
}

/** Lease-based at-least-once delivery. Every send rechecks live approval, membership and page authority. */
export function createWebhookRunner({config,store,contentStore,adminIds=new Set(),now=()=>new Date().toISOString(),createId=()=>crypto.randomUUID(),fetcher=fetch,invoke=invokeWebhook}={}){
 if(Array.isArray(adminIds))adminIds=new Set(adminIds);
 if(!config||typeof config.enabled!=='boolean'||!(adminIds instanceof Set)||config.enabled&&(!store||typeof contentStore?.read!=='function'))throw new Error('Invalid webhook runner configuration.');
 const time=()=>webhookTime(now());
 return{async runJobs({limit=WEBHOOK_LIMITS.batch}={}){
  if(!config.enabled)return{processed:0};webhookInteger(limit,1);if(limit>WEBHOOK_LIMITS.batch)webhookFail('WEBHOOK_INVALID_REQUEST',400);
  await store.recoverExpired(time());await store.reconcileProfile(config.profileHash,time());let processed=0;
  const context=async job=>{
   const subscription=await store.subscriptionById(job.subscriptionId);if(!subscription||subscription.status!=='active'||subscription.version!==job.subscriptionVersion)return null;
   if(subscription.profileHash!==config.profileHash||job.profileHash!==config.profileHash)return null;
   if(!config.eventTypes.includes(job.eventType)){await store.cancel(subscription,{now:time(),reason:'profile'});return null;}
   const approval=await currentApproval(config,store,adminIds);if(!approval.approved){await store.cancel(subscription,{now:time(),reason:'approval'});return null;}
   const saved=await contentStore.read(subscription.workspaceId,subscription.issuerAccountId),authority=await webhookPageAuthority({workspaceId:subscription.workspaceId,pageId:subscription.pageId,accountId:subscription.issuerAccountId,saved,validatePayload:validateContentPayload,includeTrash:config.eventTypes.includes('page.trashed')||config.eventTypes.includes('page.restored')});
   if(!sameAuthority(subscription,authority)){await store.cancel(subscription,{now:time(),reason:'authority'});return null;}
   const inScope=webhookPageInScope(saved.payload,subscription.pageId,job.pageId,config.includeDescendants),subject=inScope?await webhookPageAuthority({workspaceId:subscription.workspaceId,pageId:job.pageId,accountId:subscription.issuerAccountId,saved,validatePayload:validateContentPayload,includeTrash:job.eventType==='page.trashed'}):null;if(!subject){try{await store.cancelJob(job,{authority,expectedVersion:job.version,now:time(),reason:'authority'});}catch(error){if(error?.code!=='WEBHOOK_CONFLICT')throw error;}return null;}return{subscription,authority,approval:approval.row};
  };
  for(const queued of await store.due(time(),limit)){
   const before=await context(queued);if(!before)continue;
   const job=await store.claim(queued,{...before,leaseId:webhookUuid(createId()),now:time()});if(!job)continue;
   const live=await context(job);if(!live||!await store.leaseValid(job,{...live,now:time()}))continue;
   if(await webhookDigest(job.payloadJson)!==job.payloadDigest){await store.settle(job,{status:'failed',lastCode:'INTEGRITY',now:time()});processed++;continue;}
   const result=await invoke(config,{event:JSON.parse(job.payloadJson),now:time(),fetcher});
   const stamp=time(),retry=!result.accepted&&result.retryable&&job.attempts<WEBHOOK_LIMITS.attempts;
   await store.settle(job,{status:result.accepted?'delivered':retry?'queued':'failed',lastCode:result.code,nextAttemptAt:retry?new Date(Date.parse(stamp)+webhookRetryDelay(job.attempts)).toISOString():stamp,now:stamp});processed++;
  }
  return{processed};
 }};
}
