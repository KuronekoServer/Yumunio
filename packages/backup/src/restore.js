import {withMaintenanceGate} from './maintenance-gate.js';
import {RecoveryError,fail,prepareRecoverySnapshot,validateDatabaseSnapshot,TABLE_BY_NAME,recoveryContentPayload} from './model.js';
import {readRecoveryArchive,readRecoveryObject,putImmutable,sha256} from './archive.js';
const encoder=new TextEncoder();
const profile=value=>{if(typeof value!=='string'||value.length>128||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))fail('INVALID_RECOVERY_DATA');return value;};
function committedReferences(snapshot){validateDatabaseSnapshot(snapshot);const definition=TABLE_BY_NAME.get('yumunio_account_content'),index=definition.columns.indexOf('payload_json'),references=new Set();for(const row of snapshot.tables.find(table=>table.name===definition.name)?.rows??[])for(const attachment of recoveryContentPayload(snapshot,row).attachments??[])references.add(attachment.profileId+'/'+attachment.objectKey);return references;}
async function verifiedTarget(store,key,bytes){let existing;try{existing=await store.get(key);}catch{fail('RECOVERY_DESTINATION_UNAVAILABLE');}if(existing!==null&&existing!==undefined){if(!(existing instanceof Uint8Array)||existing.length!==bytes.length||await sha256(existing)!==await sha256(bytes))fail('RECOVERY_DESTINATION_CONFLICT');return;}await putImmutable(store,key,bytes);try{existing=await store.get(key);}catch{fail('RECOVERY_DESTINATION_UNAVAILABLE');}if(!(existing instanceof Uint8Array)||existing.length!==bytes.length||await sha256(existing)!==await sha256(bytes))fail('RECOVERY_CHECKSUM_FAILED');}
/** Explicit operator operation; the target must be schema-only and fenced from application requests. */
export async function restoreRecoveryArchive(options={}){return withMaintenanceGate({resource:options.source,backupId:options.backupId,mode:'restore'},async gate=>{let attempted=false;try{return await restoreRecoveryArchiveUnlocked({...options,onRestoreAttempt:()=>{attempted=true;}});}catch(error){if(attempted)gate.hold();throw error;}});}
async function restoreRecoveryArchiveUnlocked({source,key,backupId,authSecret,target,targetBlobs=null,restoreId,preparedAt,onRestoreAttempt=()=>{}}={}){
  if(!target||typeof target.beginRestore!=='function'||typeof restoreId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(restoreId))fail('INVALID_RECOVERY_DATA');
  const archive=await readRecoveryArchive({source,key,backupId,authSecret}),references=committedReferences(archive.snapshot),mapping=new Map();
  if(references.size&&(!targetBlobs||typeof targetBlobs.get!=='function'||typeof targetBlobs.put!=='function'))fail('RECOVERY_DESTINATION_UNAVAILABLE');
  const targetProfile=references.size?profile(targetBlobs.profileId):'';
  for(const object of archive.manifest.objects){await readRecoveryObject(object,{source,key,header:archive.header});const reference=object.profileId+'/'+object.objectKey;if(references.has(reference))mapping.set(reference,{profileId:targetProfile,objectKey:'objects/'+await sha256(encoder.encode('yumunio-restored-object-v1\n'+restoreId+'\n'+reference))});}
  const current=await target.getRecoveryState(),stamp=current?.restoreId===restoreId?current.preparedAt:preparedAt??new Date().toISOString();
  const snapshot=prepareRecoverySnapshot(archive.snapshot,{objectMapping:mapping,now:stamp});const options={restoreId,manifestDigest:archive.manifestChecksum,targetProfileId:targetProfile,preparedAt:stamp};
  onRestoreAttempt();let state=await target.beginRestore(snapshot,options);if(state.status==='ready')return{restoreId,status:'ready',rowCount:state.rowCount,objectCount:references.size,discardedPendingObjects:archive.manifest.objects.length-references.size};
  for(const object of archive.manifest.objects){const location=mapping.get(object.profileId+'/'+object.objectKey);if(!location)continue;const bytes=await readRecoveryObject(object,{source,key,header:archive.header});await verifiedTarget(targetBlobs,location.objectKey,bytes);}
  while(state.cursor<state.rowCount)state=await target.applyRestoreBatch(snapshot,options);
  state=await target.finishRestore(snapshot,options);return{restoreId,status:state.status,rowCount:state.rowCount,objectCount:references.size,discardedPendingObjects:archive.manifest.objects.length-references.size};
}
export async function assertRecoveryReady(store){try{const gate=await store.inspectRecoveryGate();if(gate.state==='restoring')fail('RECOVERY_IN_PROGRESS');if(!['absent','ready'].includes(gate.state))fail('RECOVERY_UNAVAILABLE');return gate;}catch(error){if(error instanceof RecoveryError)throw error;fail('RECOVERY_UNAVAILABLE');}}
