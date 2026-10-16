import {fail,exact,utc} from './model.js';
import {sha256,putImmutable} from './archive.js';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true}),id=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value))fail('INVALID_RECOVERY_DATA');return value;};
export const MAINTENANCE_MARKER='recovery-control/v1';
export const archiveGateKey=backupId=>'recovery-control/'+id(backupId)+'/gate';
export const archiveTombstoneKey=backupId=>'recovery-control/'+id(backupId)+'/deleted';
export async function ensureMaintenanceMarker(resource){
 if(!resource||!['get','put','delete'].every(method=>typeof resource[method]==='function'))fail('BACKUP_CLEANUP_DESTINATION_REQUIRED');
 const bytes=encoder.encode(JSON.stringify({format:'yumunio-backup-maintenance',version:1,profileId:resource.profileId}));await putImmutable(resource,MAINTENANCE_MARKER,bytes);
}
export async function maintenanceMarker(resource){const bytes=await resource.get(MAINTENANCE_MARKER);if(bytes===null||bytes===undefined)return false;let value;try{if(!(bytes instanceof Uint8Array)||bytes.length>4096)fail('INVALID_RECOVERY_DATA');value=JSON.parse(decoder.decode(bytes));exact(value,['format','version','profileId']);if(value.format!=='yumunio-backup-maintenance'||value.version!==1||value.profileId!==resource.profileId)fail('INVALID_RECOVERY_DATA');}catch{fail('BACKUP_CLEANUP_DESTINATION_CHANGED');}return true;}
/** No TTL takeover: uncertain writes and crashed operations leave an archive protected. */
export async function withMaintenanceGate({resource,backupId,mode,allowDeleted=false,now=new Date().toISOString()},operation){
 id(backupId);utc(now);if(!await maintenanceMarker(resource))return operation({resource,hold(){}});
 if(!['get','put','delete'].every(method=>typeof resource[method]==='function'))fail('BACKUP_ARCHIVE_COORDINATION_REQUIRED');
 const key=archiveGateKey(backupId),bytes=encoder.encode(JSON.stringify({format:'yumunio-backup-gate',version:1,backupId,mode,owner:crypto.randomUUID(),createdAt:now})),checksum=await sha256(bytes);let hold=false;
 try{await resource.put(key,bytes);}catch(error){fail(error?.code==='BLOB_EXISTS'?'BACKUP_ARCHIVE_BUSY':'BACKUP_ARCHIVE_COORDINATION_UNCERTAIN');}
 const guarded={profileId:resource.profileId,get:resource.get.bind(resource),async put(key,value){try{return await resource.put(key,value);}catch(error){if(error?.code!=='BLOB_EXISTS')hold=true;throw error;}},async delete(key){try{return await resource.delete(key);}catch(error){hold=true;throw error;}}};
 try{if(!allowDeleted&&(await resource.get(archiveTombstoneKey(backupId)))!=null)fail('BACKUP_ARCHIVE_REMOVED');return await operation({resource:guarded,hold(){hold=true;}});}
 finally{if(!hold){try{const actual=await resource.get(key);if(!(actual instanceof Uint8Array)||await sha256(actual)!==checksum)fail('BACKUP_ARCHIVE_COORDINATION_UNCERTAIN');await resource.delete(key);}catch{fail('BACKUP_ARCHIVE_COORDINATION_UNCERTAIN');}}}
}
export async function markArchiveDeleting(resource,{backupId,cleanupId}){id(backupId);id(cleanupId);await putImmutable(resource,archiveTombstoneKey(backupId),encoder.encode(JSON.stringify({format:'yumunio-backup-removed',version:1,backupId,cleanupId})));}
