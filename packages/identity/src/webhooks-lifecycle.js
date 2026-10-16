import {webhookChangeTypes,webhookPageInScope,createWebhookAuthorityResolver} from './webhooks-model.js';
import {buildPageUpdatedWebhookCommands,webhookCancelCommands,webhookSql,webhookActorSql,webhookApprovalSql} from './webhooks-commands.js';

const sameAuthority=(sub,authority)=>Boolean(authority&&sub.issuerAccountId===authority.accountId&&sub.membershipId===authority.membershipId&&sub.actorRole===authority.actorRole&&sub.authorityFingerprint===authority.fingerprint);
// personalPageOwners classifies the sidebar; it is not an access grant and is removed by a normal move.
const authorizationKeys=['grants','grantBindings','teamspaces','teamspaceMembers','teamspacePages','groups','groupMembers','groupGrants'];
function unchangedAuthorization(before,after){
 if(authorizationKeys.some(key=>JSON.stringify(before[key]??[])!==JSON.stringify(after[key]??[])))return false;
 const pages=new Map(after.pages.map(item=>[item.page.id,item]));
 return before.pages.every(item=>pages.get(item.page.id)?.inheritPermissions===item.inheritPermissions);
}
const descriptor=(s,sql)=>({sql,params:s.params});
/** Rebind only a structural transition with unchanged ACL, after checking both current authorities. */
function advanceAuthority({dialect,subscription,authority,approval,now}){
 const s=webhookSql(dialect),sub=subscription;
 const pending=()=>"EXISTS(SELECT 1 FROM yumunio_webhook_jobs wp WHERE "+s.equal('wp.subscription_id',s.bind(sub.id))+" AND wp.status IN ('queued','leased'))";
 const update=descriptor(s,"UPDATE yumunio_webhook_subscriptions SET status=CASE WHEN "+pending()+" THEN 'paused' ELSE status END,reason=CASE WHEN "+pending()+" THEN 'authority' ELSE reason END,authority_fingerprint="+s.bind(authority.fingerprint)+',version=version+1,updated_at='+s.bind(now)+' WHERE '+s.equal('id',s.bind(sub.id))+' AND version='+s.bind(sub.version)+' AND '+s.equal('authority_fingerprint',s.bind(sub.authorityFingerprint))+" AND status IN ('active','paused') AND "+webhookActorSql(s,authority)+' AND '+webhookApprovalSql(s,approval));
 const c=webhookSql(dialect),cancel=descriptor(c,"UPDATE yumunio_webhook_jobs SET status='cancelled',last_code='AUTHORITY',lease_id=NULL,lease_until=NULL,version=version+1,updated_at="+c.bind(now)+' WHERE '+c.equal('subscription_id',c.bind(sub.id))+" AND status IN ('queued','leased') AND EXISTS(SELECT 1 FROM yumunio_webhook_subscriptions advanced WHERE "+c.equal('advanced.id',c.bind(sub.id))+' AND advanced.version='+c.bind(sub.version+1)+' AND '+c.equal('advanced.authority_fingerprint',c.bind(authority.fingerprint))+')');
 return[update,cancel];
}
/** A bounded bulk transition must not turn webhook pressure into a failed content save.
 * Unknown-size gaps deliberately have no invented page-version range. Resume requires explicit gap consent. */
function pauseWorkspace({dialect,workspaceId,now}){
 let s=webhookSql(dialect);const pause=descriptor(s,"UPDATE yumunio_webhook_subscriptions SET status='paused',reason='capacity',version=version+1,updated_at="+s.bind(now)+' WHERE '+s.equal('workspace_id',s.bind(workspaceId))+" AND status='active'");
 s=webhookSql(dialect);return[pause,descriptor(s,"UPDATE yumunio_webhook_jobs SET status='cancelled',last_code='CAPACITY',lease_id=NULL,lease_until=NULL,version=version+1,updated_at="+s.bind(now)+' WHERE '+s.equal('workspace_id',s.bind(workspaceId))+" AND status IN ('queued','leased')")];
}

/** Internal only: these descriptors must follow a successful content CAS in the same transaction. */
export async function buildWorkspaceWebhookCommands({dialect,workspaceId,saved,checked,subscriptions,config,approval,validatePayload,now,createId=()=>crypto.randomUUID()}){
 const previous=validatePayload(saved.payload,workspaceId),beforePages=new Map(previous.pages.map(item=>[item.page.id,item]));
 const changes=checked.pages.map(item=>({item,types:webhookChangeTypes(beforePages.get(item.page.id),item).filter(type=>config.eventTypes.includes(type))})).filter(change=>change.types.length);
 if(!changes.length)return[];
 const nextSaved={...saved,revision:saved.revision+1,payload:checked},beforeResolve=createWebhookAuthorityResolver({workspaceId,saved,validatePayload,includeTrash:true}),afterResolve=createWebhookAuthorityResolver({workspaceId,saved:nextSaved,validatePayload,includeTrash:true}),visibleResolve=createWebhookAuthorityResolver({workspaceId,saved:nextSaved,validatePayload});
 const authorizationStable=unchangedAuthorization(previous,checked),commands=[];let eventCount=0;
 for(const original of subscriptions){
  if(!['active','paused'].includes(original.status))continue;
  const candidates=changes.filter(({item})=>webhookPageInScope(checked,original.pageId,item.page.id,config.includeDescendants));if(!candidates.length)continue;
  const lookup={pageId:original.pageId,accountId:original.issuerAccountId},before=await beforeResolve(lookup),after=await afterResolve(lookup);
  if(original.profileHash!==config.profileHash){commands.push(...webhookCancelCommands({dialect,subscription:original,status:'quarantined',reason:'profile',now}));if(commands.length>60)return pauseWorkspace({dialect,workspaceId,now});continue;}
  let sub=original;
  if(!sameAuthority(sub,after)){
   const anchorChange=changes.find(({item})=>item.page.id===sub.pageId),structural=anchorChange?.types.some(type=>['page.moved','page.trashed','page.restored'].includes(type));
   if(!structural||!authorizationStable||!sameAuthority(sub,before)||!after||after.membershipId!==before.membershipId||after.actorRole!==before.actorRole||!approval||approval.revokedAt!==null){commands.push(...webhookCancelCommands({dialect,subscription:sub,reason:'authority',now}));if(commands.length>60)return pauseWorkspace({dialect,workspaceId,now});continue;}
   commands.push(...advanceAuthority({dialect,subscription:sub,authority:after,approval,now}));
   sub={...sub,authorityFingerprint:after.fingerprint,version:sub.version+1,updatedAt:now};
  }
  for(const {item,types} of candidates){
   const lookup={pageId:item.page.id,accountId:sub.issuerAccountId},trashedSubject=await afterResolve(lookup),visibleSubject=await visibleResolve(lookup);
   for(const eventType of types){
    if(item.page.trashedAt!==null&&eventType!=='page.trashed')continue;
    const subject=eventType==='page.trashed'?trashedSubject:visibleSubject;if(!subject)continue;
    if(++eventCount>8||commands.length>55)return pauseWorkspace({dialect,workspaceId,now});
    commands.push(...await buildPageUpdatedWebhookCommands({dialect,event:{schemaVersion:1,eventId:createId(),eventType,workspaceId,pageId:item.page.id,version:item.document.version,occurredAt:now},subscription:sub,authority:after,eventAuthority:subject,includeDescendants:!!config.includeDescendants,approval,profileHash:config.profileHash,now}));
   }
  }
  // Leave room for the content CAS plus all32 content chunks and their old-revision cleanup.
  if(commands.length>60)return pauseWorkspace({dialect,workspaceId,now});
 }
 return commands;
}
