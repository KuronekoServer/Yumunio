import {fail,utc} from './model.js';
import {readRecoveryKey} from './archive.js';
export function readBackupConfig(env={}){
  const driver=env.YUMUNIO_BACKUP_DRIVER??'disabled';if(driver==='disabled'||driver==='')return Object.freeze({enabled:false,driver:'disabled',schedule:null,retentionDays:30});if(!['local','s3','r2'].includes(driver))fail('INVALID_BACKUP_CONFIG');
  let key;try{key=readRecoveryKey(env.YUMUNIO_BACKUP_ENCRYPTION_KEY);}catch{fail('INVALID_BACKUP_CONFIG');}
  const scheduleValue=env.YUMUNIO_BACKUP_SCHEDULE??'',match=/^(0|[1-9]|[1-5][0-9]) (0|[1-9]|1[0-9]|2[0-3]) \* \* \*$/.exec(scheduleValue);if(scheduleValue!==''&&!match)fail('INVALID_BACKUP_CONFIG');
  const days=env.YUMUNIO_BACKUP_RETENTION_DAYS??'30';if(typeof days!=='string'||!/^[1-9][0-9]{0,3}$/.test(days)||Number(days)>3650)fail('INVALID_BACKUP_CONFIG');
  const cleanup=env.YUMUNIO_BACKUP_CLEANUP_ENABLED??'false',grace=env.YUMUNIO_BACKUP_CLEANUP_FAILED_GRACE_DAYS??'7';if(!['true','false'].includes(cleanup)||typeof grace!=='string'||!/^[1-9][0-9]{0,3}$/.test(grace)||Number(grace)>3650)fail('INVALID_BACKUP_CONFIG');
  return Object.freeze({enabled:true,driver,key,schedule:match?Object.freeze({cron:scheduleValue,minute:Number(match[1]),hour:Number(match[2]),timezone:'UTC'}):null,retentionDays:Number(days),cleanup:Object.freeze({enabled:cleanup==='true',failedGraceDays:Number(grace)})});
}
export function publicBackupConfig(config){return{enabled:config.enabled,driver:config.driver,schedule:config.schedule?.cron??null,timezone:'UTC',retentionDays:config.retentionDays,automaticRetention:false};}
/** One deduplicated slot for the most recent daily UTC deadline; external Cron/timer invokes the runner. */
export function scheduledBackupRequestKey(config,now=new Date().toISOString()){utc(now);if(!config.enabled||!config.schedule)return null;const stamp=new Date(now),due=new Date(Date.UTC(stamp.getUTCFullYear(),stamp.getUTCMonth(),stamp.getUTCDate(),config.schedule.hour,config.schedule.minute));if(due>stamp)due.setUTCDate(due.getUTCDate()-1);return'schedule:'+due.toISOString().replace(/[-:.]/g,'');}
