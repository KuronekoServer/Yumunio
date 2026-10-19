import {assertJsonSerializable,assertPlainObject} from '@yumunio/domain';
import {validateContentPayload} from '@yumunio/identity/content';
import {decodeContentPayload,encodeContentPayload} from '@yumunio/identity/content-codec';
import {validateSnapshot} from '@yumunio/prototype';
import {validatePreferences} from '@yumunio/identity/preferences-model';
import {validateWebhookApproval,validateWebhookSubscription,validateWebhookJob,WEBHOOK_APPROVAL_FIELDS,WEBHOOK_SUBSCRIPTION_FIELDS,WEBHOOK_JOB_FIELDS} from '@yumunio/identity/webhooks-model';
export const RECOVERY_LIMITS=Object.freeze({databaseBytes:16*1024*1024,rows:10000,objects:1000,objectBytes:16*1024*1024,totalBlobBytes:256*1024*1024,chunkBytes:1024*1024,jobBytes:1000000});
export class RecoveryError extends Error{constructor(code='RECOVERY_UNAVAILABLE'){super(code);this.name='RecoveryError';this.code=code;}}
export const fail=code=>{throw new RecoveryError(code);};
const encoder=new TextEncoder();
export const byteSize=value=>encoder.encode(JSON.stringify(value)).length;
export function exact(value,allowed,required=allowed){assertJsonSerializable(value);assertPlainObject(value);if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail('INVALID_RECOVERY_DATA');}
export const safeInteger=value=>{if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('INVALID_RECOVERY_DATA');return value;};
export const utc=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('INVALID_RECOVERY_DATA');return value;};
const table=(name,columns,{dates=[],isoDates=[],integers=[],booleans=[],nullable=[],group='accounts'}={})=>Object.freeze({name,columns:Object.freeze(columns.split(' ')),dates:Object.freeze(dates),isoDates:Object.freeze(isoDates),integers:Object.freeze(integers),booleans:Object.freeze(booleans),nullable:Object.freeze(nullable),group});
export const TABLES=Object.freeze([
  table('yumunio_users','id name email emailVerified image createdAt updatedAt',{dates:['createdAt','updatedAt'],booleans:['emailVerified'],nullable:['image']}),
  table('yumunio_workspaces','id name slug logo createdAt metadata',{dates:['createdAt'],nullable:['logo','metadata']}),
  table('yumunio_memberships','id organizationId userId role createdAt',{dates:['createdAt']}),
  table('yumunio_auth_accounts','id accountId providerId userId accessToken refreshToken idToken accessTokenExpiresAt refreshTokenExpiresAt scope password createdAt updatedAt',{dates:['accessTokenExpiresAt','refreshTokenExpiresAt','createdAt','updatedAt'],nullable:['accessToken','refreshToken','idToken','accessTokenExpiresAt','refreshTokenExpiresAt','scope','password']}),
  table('yumunio_auth_sessions','id expiresAt token createdAt updatedAt ipAddress userAgent userId activeOrganizationId',{dates:['expiresAt','createdAt','updatedAt'],nullable:['ipAddress','userAgent','activeOrganizationId']}),
  table('yumunio_auth_verifications','id identifier value expiresAt createdAt updatedAt',{dates:['expiresAt','createdAt','updatedAt'],nullable:['createdAt','updatedAt']}),
  table('yumunio_workspace_invitations','id organizationId email role status expiresAt createdAt inviterId',{dates:['expiresAt','createdAt'],nullable:['role']}),
  table('yumunio_auth_rate_limits','id key count lastRequest',{integers:['count','lastRequest']}),
  table('yumunio_account_content','workspace_id revision payload_json',{integers:['revision']}),
  table('yumunio_content_chunks','workspace_id revision ordinal payload_text',{integers:['revision','ordinal'],group:'content-transport'}),
  table('yumunio_content_guards','id ok',{integers:['ok'],group:'content-transport'}),
  table('yumunio_account_preferences','account_id revision preferences_json',{integers:['revision']}),
  table('yumunio_collaboration_invitations','id workspace_id generation invitation_json issuer_membership_id status',{integers:['generation']}),
  table('yumunio_mail_jobs','id dedupe_key payload_ciphertext payload_digest status attempts available_at lease_id lease_until created_at updated_at expires_at invitation_id invitation_generation',{integers:['attempts','invitation_generation'],nullable:['lease_id','lease_until','invitation_id','invitation_generation']}),
  table('yumunio_transaction_guards','id ok',{integers:['ok']}),
  table('yumunio_prototype_snapshots','id revision payload_json updated_at',{integers:['id','revision'],group:'prototype'}),
  table('yumunio_instance_settings','id revision sealed',{integers:['id','revision'],group:'instance'}),
  table('yumunio_api_tokens','id account_id workspace_id page_id membership_id actor_role name scopes_json token_hash expires_at created_at revoked_at version request_id request_digest active_slot metadata_slot',{dates:['expires_at','created_at','revoked_at'],integers:['version','active_slot','metadata_slot'],nullable:['revoked_at','active_slot'],group:'api-tokens'}),
  table('yumunio_webhook_approvals','profile_hash approved_by approved_at revoked_at version',{dates:['approved_at','revoked_at'],isoDates:['approved_at','revoked_at'],integers:['version'],nullable:['revoked_at'],group:'webhooks'}),
  table('yumunio_webhook_subscriptions','id workspace_id page_id issuer_account_id membership_id actor_role profile_hash authority_fingerprint start_version status reason missed_from_version missed_through_version gap_acknowledged_at created_at updated_at version',{dates:['gap_acknowledged_at','created_at','updated_at'],isoDates:['gap_acknowledged_at','created_at','updated_at'],integers:['start_version','missed_from_version','missed_through_version','version'],nullable:['reason','missed_from_version','missed_through_version','gap_acknowledged_at'],group:'webhooks'}),
  table('yumunio_webhook_jobs','event_id subscription_id subscription_version profile_hash workspace_id page_id page_version event_type occurred_at payload_json payload_digest status attempts next_attempt_at lease_id lease_until last_code created_at updated_at version',{dates:['occurred_at','next_attempt_at','lease_until','created_at','updated_at'],isoDates:['occurred_at','next_attempt_at','lease_until','created_at','updated_at'],integers:['subscription_version','page_version','attempts','version'],nullable:['lease_id','lease_until','last_code'],group:'webhooks'}),
  table('yumunio_webhook_guards','id ok',{integers:['ok'],group:'webhooks'})
]);
export const TABLE_BY_NAME=new Map(TABLES.map(item=>[item.name,item]));
// Read-only version-1 archive compatibility. Never captured, created or restored as a live table.
const retiredDefinition=table('yumunio_ai_requests','request_id account_id workspace_id page_id membership_id actor_role expected_revision page_version source_digest projection_version profile_hash request_digest task status created_at deadline_at finished_at version result_ciphertext day_key day_slot active_slot metadata_slot',{dates:['created_at','deadline_at','finished_at'],isoDates:['created_at','deadline_at','finished_at'],integers:['expected_revision','page_version','projection_version','version','day_slot','active_slot','metadata_slot'],nullable:['finished_at','result_ciphertext','active_slot'],group:'ai'});
export const RETIRED_TABLE_NAMES=Object.freeze([retiredDefinition.name]);
const ARCHIVE_TABLE_BY_NAME=new Map([...TABLE_BY_NAME,[retiredDefinition.name,retiredDefinition]]);
export const OPERATION_TABLES=Object.freeze(['yumunio_backup_jobs','yumunio_backup_fragments','yumunio_backup_guards','yumunio_recovery_state']);
export const OPTIONAL_OPERATION_TABLES=Object.freeze(['yumunio_backup_artifacts','yumunio_backup_cleanup_approval','yumunio_backup_cleanups']);
// Ephemeral data is never archived or restored, but an empty current schema is a valid target.
export const EPHEMERAL_TABLES=Object.freeze(['yumunio_room_presence']);
export function cell(definition,column,value,{source=false}={}){
  if(value===null){if(!definition.nullable.includes(column))fail('INVALID_RECOVERY_DATA');return null;}
  if(definition.dates.includes(column)){let time=value instanceof Date?value.getTime():typeof value==='number'?value:source&&typeof value==='string'?Date.parse(value):NaN;if(!Number.isSafeInteger(time)||!Number.isFinite(new Date(time).getTime()))fail('INVALID_RECOVERY_DATA');return time;}
  if(definition.booleans.includes(column)){if(value===true||source&&value===1)return true;if(value===false||source&&value===0)return false;fail('INVALID_RECOVERY_DATA');}
  if(definition.integers.includes(column)){if(source&&typeof value==='bigint')value=Number(value);if(source&&typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value))value=Number(value);return safeInteger(value);}
  if(typeof value!=='string')fail('INVALID_RECOVERY_DATA');return value;
}
export const recoveryRowKey=(name,row)=>name==='yumunio_ai_requests'?JSON.stringify([row[1],row[0]]):name==='yumunio_content_chunks'?JSON.stringify(row.slice(0,3)):String(row[0]);
const rowKey=recoveryRowKey;
export function recoveryContentPayload(snapshot,row){
 const values=Array.isArray(row)?Object.fromEntries(['workspace_id','revision','payload_json'].map((key,index)=>[key,row[index]])):row;
 const chunks=(snapshot.tables.find(entry=>entry.name==='yumunio_content_chunks')?.rows??[]).filter(chunk=>chunk[0]===values.workspace_id).map(chunk=>({revision:chunk[1],ordinal:chunk[2],payload_text:chunk[3]})).sort((a,b)=>a.ordinal-b.ordinal);
 try{return decodeContentPayload(values.payload_json,chunks,values.revision);}catch{fail('INVALID_RECOVERY_DATA');}
}
export function normalizeTable(name,rows){const definition=TABLE_BY_NAME.get(name);if(!definition||!Array.isArray(rows))fail('INVALID_RECOVERY_DATA');return{name,columns:[...definition.columns],rows:rows.map(row=>{if(!row||Object.keys(row).length!==definition.columns.length||definition.columns.some(column=>!Object.hasOwn(row,column)))fail('RECOVERY_SCHEMA_UNSUPPORTED');return definition.columns.map(column=>cell(definition,column,row[column],{source:true}));}).sort((a,b)=>rowKey(name,a)<rowKey(name,b)?-1:rowKey(name,a)>rowKey(name,b)?1:0)};}
export function validateDatabaseSnapshot(value){
  exact(value,['format','schemaVersion','sourceDialect','capturedAt','tables','excludedTables']);if(value.format!=='yumunio-recovery-database'||value.schemaVersion!==1||!['sqlite','d1','mysql','postgres'].includes(value.sourceDialect))fail('INVALID_RECOVERY_DATA');utc(value.capturedAt);
  if(!Array.isArray(value.tables)||!value.tables.length||!Array.isArray(value.excludedTables)||value.excludedTables.length>1000||value.excludedTables.some(name=>typeof name!=='string'||name.length>256)||new Set(value.excludedTables).size!==value.excludedTables.length)fail('INVALID_RECOVERY_DATA');
  let rows=0;const present=new Map();for(const entry of value.tables){exact(entry,['name','columns','rows']);const definition=ARCHIVE_TABLE_BY_NAME.get(entry.name);if(!definition||present.has(entry.name)||JSON.stringify(entry.columns)!==JSON.stringify(definition.columns)||!Array.isArray(entry.rows))fail('INVALID_RECOVERY_DATA');present.set(entry.name,entry);const keys=new Set();for(const row of entry.rows){if(!Array.isArray(row)||row.length!==definition.columns.length)fail('INVALID_RECOVERY_DATA');row.forEach((item,index)=>cell(definition,definition.columns[index],item));const key=rowKey(entry.name,row);if(keys.has(key))fail('INVALID_RECOVERY_DATA');keys.add(key);if(++rows>RECOVERY_LIMITS.rows)fail('RECOVERY_TOO_LARGE');}}
  const accountTables=TABLES.filter(table=>table.group==='accounts');if(accountTables.some(table=>present.has(table.name))&&!accountTables.every(table=>present.has(table.name)))fail('RECOVERY_SCHEMA_UNSUPPORTED');
  const webhookTables=TABLES.filter(table=>table.group==='webhooks');if(webhookTables.some(table=>present.has(table.name))&&!webhookTables.every(table=>present.has(table.name)))fail('RECOVERY_SCHEMA_UNSUPPORTED');
  if(byteSize(value)>RECOVERY_LIMITS.databaseBytes)fail('RECOVERY_TOO_LARGE');
  const data=name=>(present.get(name)?.rows??[]).map(row=>Object.fromEntries(TABLE_BY_NAME.get(name).columns.map((column,index)=>[column,row[index]])));
  const users=new Set(data('yumunio_users').map(row=>row.id)),workspaces=new Set(data('yumunio_workspaces').map(row=>row.id));
  const instance=data('yumunio_instance_settings');if(instance.length>1||instance.some(row=>row.id!==1||row.revision<1||row.sealed.length>100000||!/^[-A-Za-z0-9+/=]+\.[-A-Za-z0-9+/=]+$/.test(row.sealed)))fail('INVALID_RECOVERY_DATA');
  for(const name of ['yumunio_auth_accounts','yumunio_auth_sessions','yumunio_memberships'])for(const row of data(name))if(!users.has(row.userId))fail('INVALID_RECOVERY_DATA');
  for(const name of ['yumunio_memberships','yumunio_workspace_invitations'])for(const row of data(name))if(!workspaces.has(row.organizationId))fail('INVALID_RECOVERY_DATA');
  for(const row of data('yumunio_workspace_invitations'))if(!users.has(row.inviterId))fail('INVALID_RECOVERY_DATA');
  for(const row of data('yumunio_account_content')){if(!workspaces.has(row.workspace_id)||row.revision<1)fail('INVALID_RECOVERY_DATA');try{validateContentPayload(recoveryContentPayload(value,row),row.workspace_id);}catch{fail('INVALID_RECOVERY_DATA');}}
  for(const row of data('yumunio_content_chunks'))if(!data('yumunio_account_content').some(content=>content.workspace_id===row.workspace_id&&content.revision===row.revision))fail('INVALID_RECOVERY_DATA');
  if(data('yumunio_content_guards').length)fail('INVALID_RECOVERY_DATA');
  for(const row of data('yumunio_account_preferences')){if(!users.has(row.account_id)||row.revision<1)fail('INVALID_RECOVERY_DATA');let preferences;try{preferences=validatePreferences(JSON.parse(row.preferences_json));}catch{fail('INVALID_RECOVERY_DATA');}if(!preferences||typeof preferences!=='object'||Array.isArray(preferences))fail('INVALID_RECOVERY_DATA');}
  for(const row of data('yumunio_collaboration_invitations'))if(!workspaces.has(row.workspace_id)||row.generation<1)fail('INVALID_RECOVERY_DATA');
  if(data('yumunio_transaction_guards').length)fail('INVALID_RECOVERY_DATA');
  if(data('yumunio_webhook_guards').length)fail('INVALID_RECOVERY_DATA');
  for(const[name,fields,validate]of[['yumunio_webhook_approvals',WEBHOOK_APPROVAL_FIELDS,validateWebhookApproval],['yumunio_webhook_subscriptions',WEBHOOK_SUBSCRIPTION_FIELDS,validateWebhookSubscription],['yumunio_webhook_jobs',WEBHOOK_JOB_FIELDS,validateWebhookJob]])for(const row of data(name)){try{const definition=TABLE_BY_NAME.get(name),value=Object.fromEntries(Object.entries(fields).map(([key,column])=>[key,row[column]===null?null:definition.dates.includes(column)?new Date(row[column]).toISOString():row[column]]));validate(value);}catch{fail('INVALID_RECOVERY_DATA');}}
  for(const row of data('yumunio_prototype_snapshots')){if(row.id!==1||row.revision<1)fail('INVALID_RECOVERY_DATA');try{validateSnapshot(JSON.parse(row.payload_json));}catch{fail('INVALID_RECOVERY_DATA');}}
  return structuredClone(value);
}
export function snapshotObjects(snapshot){validateDatabaseSnapshot(snapshot);const entries=snapshot.tables.find(table=>table.name==='yumunio_account_content'),definition=TABLE_BY_NAME.get('yumunio_account_content'),locations=new Map();let total=0;
  for(const values of entries?.rows??[]){const row=Object.fromEntries(definition.columns.map((column,index)=>[column,values[index]])),payload=recoveryContentPayload(snapshot,row);for(const item of [...(payload.attachments??[]),...(payload.pendingBlobs??[]).filter(item=>item.status==='ready')]){const key=item.profileId+'/'+item.objectKey,previous=locations.get(key);if(previous&&(previous.size!==item.size||previous.checksum!==item.checksum))fail('INVALID_RECOVERY_DATA');if(!previous){locations.set(key,{profileId:item.profileId,objectKey:item.objectKey,size:item.size,checksum:item.checksum});total+=item.size;if(locations.size>RECOVERY_LIMITS.objects||item.size>RECOVERY_LIMITS.objectBytes||total>RECOVERY_LIMITS.totalBlobBytes)fail('RECOVERY_TOO_LARGE');}}}
  return [...locations.values()].sort((a,b)=>a.profileId+'/'+a.objectKey<b.profileId+'/'+b.objectKey?-1:1);
}
export const LEGACY_RECOVERY_TRANSFORMS=Object.freeze(['Discard login sessions, verification/reset/OAuth-state challenges and rate-limit counters.','Cancel pending workspace invitations and queued or leased mail; never resend external actions automatically.','Discard uncommitted upload reservations, public links and collaboration epochs; increment restored document, content, prototype and preference revisions.','Preserve account IDs, password hashes, encrypted OAuth tokens, membership generations, page ACL, committed content, history, comments and preference values.','Remap attachment locators to newly verified immutable target objects.']);
export const PRE_AI_RECOVERY_TRANSFORMS=Object.freeze(LEGACY_RECOVERY_TRANSFORMS.map((value,index)=>index===0?'Discard login sessions, verification/reset/OAuth-state challenges, API tokens and rate-limit counters.':value));
export const PRE_WEBHOOK_RECOVERY_TRANSFORMS=Object.freeze(PRE_AI_RECOVERY_TRANSFORMS.map((value,index)=>index===1?'Cancel pending workspace invitations and queued or leased mail; preserve consumed AI request IDs as unknown without proposals; never resend external actions automatically.':value));
export const PRE_RETIREMENT_RECOVERY_TRANSFORMS=Object.freeze(PRE_WEBHOOK_RECOVERY_TRANSFORMS.map((value,index)=>index===1?'Cancel pending workspace invitations, queued or leased mail and webhook deliveries; revoke webhook approvals and pause subscriptions; preserve consumed AI request IDs as unknown without proposals; never resend external actions automatically.':value));
export const RECOVERY_TRANSFORMS=Object.freeze(PRE_RETIREMENT_RECOVERY_TRANSFORMS.map(value=>value.replace(' preserve consumed AI request IDs as unknown without proposals;','')));
export const isKnownRecoveryTransforms=value=>[RECOVERY_TRANSFORMS,PRE_RETIREMENT_RECOVERY_TRANSFORMS,PRE_WEBHOOK_RECOVERY_TRANSFORMS,PRE_AI_RECOVERY_TRANSFORMS,LEGACY_RECOVERY_TRANSFORMS].some(known=>JSON.stringify(value)===JSON.stringify(known));
export function omitRetiredRecoveryTables(snapshot){
  const result=validateDatabaseSnapshot(snapshot),retired=result.tables.filter(entry=>RETIRED_TABLE_NAMES.includes(entry.name)).map(entry=>entry.name);
  result.tables=result.tables.filter(entry=>!RETIRED_TABLE_NAMES.includes(entry.name));
  result.excludedTables=[...new Set([...result.excludedTables,...retired])];
  return validateDatabaseSnapshot(result);
}
export function prepareRecoverySnapshot(snapshot,{objectMapping,now=new Date().toISOString()}={}){
  const result=omitRetiredRecoveryTables(snapshot);utc(now);if(!(objectMapping instanceof Map))fail('INVALID_RECOVERY_DATA');
  for(const entry of result.tables){const definition=TABLE_BY_NAME.get(entry.name),at=key=>definition.columns.indexOf(key);if(['yumunio_auth_sessions','yumunio_auth_verifications','yumunio_auth_rate_limits','yumunio_api_tokens'].includes(entry.name)){entry.rows=[];continue;}
    if(entry.name==='yumunio_workspace_invitations')entry.rows=entry.rows.filter(row=>row[at('status')]!=='pending');
    for(const row of entry.rows){if(entry.name==='yumunio_account_content'){const payload=recoveryContentPayload(result,row);delete payload.rooms;delete payload.pendingBlobs;if(Object.hasOwn(payload,'publications'))payload.publications=[];for(const form of payload.forms??[])if(form.publicLink){delete form.publicLink;form.activeVersion=null;}delete payload.formRateCounters;for(const item of payload.pages){item.document.version=safeInteger(item.document.version+1);item.document.updatedAt=now;item.page.updatedAt=now;}for(const item of payload.attachments??[]){const mapping=objectMapping.get(item.profileId+'/'+item.objectKey);if(!mapping||typeof mapping.profileId!=='string'||typeof mapping.objectKey!=='string')fail('RECOVERY_OBJECT_MISSING');item.profileId=mapping.profileId;item.objectKey=mapping.objectKey;}row[at('revision')]=safeInteger(row[at('revision')]+1);const encoded=encodeContentPayload(validateContentPayload(payload,row[at('workspace_id')]),row[at('revision')]);row[at('payload_json')]=encoded.head;const chunks=result.tables.find(item=>item.name==='yumunio_content_chunks');if(chunks)chunks.rows=chunks.rows.filter(item=>item[0]!==row[at('workspace_id')]).concat(encoded.chunks.map((text,index)=>[row[at('workspace_id')],row[at('revision')],index,text]));else if(encoded.chunks.length)fail('RECOVERY_SCHEMA_UNSUPPORTED');}
      if(entry.name==='yumunio_account_preferences'||entry.name==='yumunio_prototype_snapshots')row[at('revision')]=safeInteger(row[at('revision')]+1);
      if(entry.name==='yumunio_collaboration_invitations'&&row[at('status')]==='pending'){let invitation;try{invitation=JSON.parse(row[at('invitation_json')]);}catch{fail('INVALID_RECOVERY_DATA');}invitation.revokedAt=now;row[at('invitation_json')]=JSON.stringify(invitation);row[at('status')]='revoked';row[at('generation')]=safeInteger(row[at('generation')]+1);}
      if(entry.name==='yumunio_mail_jobs'&&['queued','leased'].includes(row[at('status')])){row[at('status')]='cancelled';row[at('lease_id')]=null;row[at('lease_until')]=null;row[at('updated_at')]=now;}

      if(entry.name==='yumunio_webhook_approvals'){row[at('revoked_at')]=Date.parse(now);row[at('version')]=safeInteger(row[at('version')]+1);}
      if(entry.name==='yumunio_webhook_subscriptions'){row[at('status')]='paused';row[at('reason')]='restore';row[at('updated_at')]=Date.parse(now);row[at('version')]=safeInteger(row[at('version')]+1);}
      if(entry.name==='yumunio_webhook_jobs'&&['queued','leased'].includes(row[at('status')])){row[at('status')]='cancelled';row[at('lease_id')]=null;row[at('lease_until')]=null;row[at('last_code')]='RESTORE';row[at('updated_at')]=Date.parse(now);row[at('version')]=safeInteger(row[at('version')]+1);}
    }
  }
  return validateDatabaseSnapshot(result);
}
