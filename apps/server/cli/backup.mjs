import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readServerConfig } from '../config.mjs';
import { readNodeInstanceEnvironment } from '../setup.mjs';
import { createNodeBackupService } from '../backup.mjs';
import { verifyRecoveryArchive } from '@yumunio/backup/archive';
import { restoreRecoveryArchive } from '@yumunio/backup/restore';
import { backupJobStatus } from '@yumunio/backup/jobs';
import { publicBackupConfig } from '@yumunio/backup/config';
import { createBackupMaintenance } from '@yumunio/backup/operations';
import {cleanupJobStatus} from '../../../packages/backup/src/maintenance.js';

const usage = 'Usage: npm run backup -- status | create --confirm-scope database-and-private-files --destination-profile ID [--request-id ID] [--steps N] | work [--steps N] | verify --backup-id ID | restore --backup-id ID --restore-id ID --confirm-empty-target | cleanup-preview --destination-profile ID | cleanup-approve --destination-profile ID --policy-digest HASH --plan-digest HASH --expected-version N --confirm-scope expired-app-backup-artifacts --confirm-quiescent | cleanup-revoke --destination-profile ID --expected-version N --confirm-stop | cleanup-work [--steps N]';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
function options(argv) {
  const [command, ...tokens] = argv, result = {};
  const allowed = { status: [], create: ['confirm-scope', 'destination-profile', 'request-id', 'steps'], work: ['steps'], verify: ['backup-id'], restore: ['backup-id', 'restore-id', 'confirm-empty-target'], 'cleanup-preview':['destination-profile'], 'cleanup-approve':['destination-profile','policy-digest','plan-digest','expected-version','confirm-scope','confirm-quiescent'], 'cleanup-revoke':['destination-profile','expected-version','confirm-stop'], 'cleanup-work':['steps'] }[command];
  if (!allowed) throw new Error('INVALID_BACKUP_ARGUMENTS');
  for (let index = 0; index < tokens.length; index++) {
    const name = tokens[index].replace(/^--/, '');
    if (tokens[index] !== '--' + name || !allowed.includes(name) || Object.hasOwn(result, name)) throw new Error('INVALID_BACKUP_ARGUMENTS');
    if (['confirm-empty-target','confirm-quiescent','confirm-stop'].includes(name)) result[name] = true;
    else { const value = tokens[++index]; if (!value || value.startsWith('--')) throw new Error('INVALID_BACKUP_ARGUMENTS'); result[name] = value; }
  }
  const steps = result.steps ?? '8000';
  if (!/^[1-9][0-9]{0,3}$/.test(steps) || Number(steps) > 8000) throw new Error('INVALID_BACKUP_ARGUMENTS');
  if (['verify', 'restore'].includes(command) && !safeId(result['backup-id'])) throw new Error('INVALID_BACKUP_ARGUMENTS');
  if (command === 'restore' && (!safeId(result['restore-id']) || !result['confirm-empty-target'])) throw new Error('EMPTY_TARGET_CONFIRMATION_REQUIRED');
  if (command === 'create' && (result['confirm-scope'] !== 'database-and-private-files' || typeof result['destination-profile'] !== 'string' || result['request-id'] !== undefined && !safeId(result['request-id']))) throw new Error('BACKUP_CONSENT_REQUIRED');
  if(['cleanup-preview','cleanup-approve','cleanup-revoke'].includes(command)&&typeof result['destination-profile']!=='string')throw new Error('BACKUP_CLEANUP_CONSENT_REQUIRED');
  if(['cleanup-approve','cleanup-revoke'].includes(command)&&(!/^(0|[1-9][0-9]*)$/.test(result['expected-version']??'')||!Number.isSafeInteger(Number(result['expected-version']))))throw new Error('INVALID_BACKUP_ARGUMENTS');
  if(command==='cleanup-approve'&&(result['confirm-scope']!=='expired-app-backup-artifacts'||result['confirm-quiescent']!==true||!['policy-digest','plan-digest'].every(key=>/^[a-f0-9]{64}$/.test(result[key]??''))))throw new Error('BACKUP_CLEANUP_CONSENT_REQUIRED');
  if(command==='cleanup-revoke'&&result['confirm-stop']!==true)throw new Error('BACKUP_CLEANUP_CONSENT_REQUIRED');
  return { command, values: result, steps: Number(steps) };
}

/** Explicit operator command. Does not load an env file or print secrets itself. */
export async function runBackupCommand(argv, env = process.env) {
  env = await readNodeInstanceEnvironment(env);
  const { command, values, steps } = options(argv);
  const inspection = ['status', 'verify', 'restore'].includes(command);
  const service = await createNodeBackupService(env, readServerConfig(env), { forRestore: inspection });
  if (!service) throw new Error('BACKUP_SQL_REQUIRED');
  try {
    if (command === 'status'){const cleanup=await createBackupMaintenance({store:service.store,config:service.config,destination:service.destination,sourceBlobs:service.sourceBlobs,authSecret:env.YUMUNIO_AUTH_SECRET,env,initialize:false}),status=await cleanup.status();return { configuration:{...publicBackupConfig(service.config),automaticRetention:status.approved}, destinationProfileId: service.destination?.profileId ?? null, recovery: await service.store.inspectRecoveryGate(), jobs: service.config.enabled ? (await service.store.jobs.list({ limit: 20 })).map(backupJobStatus) : [],cleanup:status };}
    if (!service.config.enabled) throw new Error('BACKUP_DISABLED');
    if(command.startsWith('cleanup-')){
      if(values['destination-profile']!==undefined&&values['destination-profile']!==service.destination.profileId)throw new Error('BACKUP_CLEANUP_CONFLICT');
      if(command==='cleanup-preview')return await service.operations.cleanup.preview();
      if(command==='cleanup-approve')return{cleanup:await service.operations.cleanup.approve({accountId:'operator',operatorMode:true,destinationProfileId:values['destination-profile'],policyDigest:values['policy-digest'],planDigest:values['plan-digest'],expectedVersion:Number(values['expected-version']),confirmScope:values['confirm-scope'],confirmQuiescent:values['confirm-quiescent']})};
      if(command==='cleanup-revoke')return{cleanup:await service.operations.cleanup.revoke({destinationProfileId:values['destination-profile'],expectedVersion:Number(values['expected-version'])})};
      const cleanupStatus=await service.operations.cleanup.status();if(!cleanupStatus.configured)throw new Error('BACKUP_CLEANUP_DISABLED');if(!cleanupStatus.available)throw new Error('BACKUP_CLEANUP_SCHEMA_REQUIRED');let last=null,idle=false;for(let count=0;count<steps;count++){const result=await service.operations.cleanup.tick();if(!result){idle=true;break;}last=result;}const unfinished=await service.store.maintenance.unfinished();return{cleanup:unfinished?cleanupJobStatus(unfinished):last,finished:idle&&!unfinished};
    }
    if (command === 'verify') return { ...await verifyRecoveryArchive({ source: service.destination, key: service.config.key, backupId: values['backup-id'], authSecret: env.YUMUNIO_AUTH_SECRET }), verified: true, restoreTested: false };
    if (command === 'restore') return await restoreRecoveryArchive({ source: service.destination, key: service.config.key, backupId: values['backup-id'], authSecret: env.YUMUNIO_AUTH_SECRET, target: service.store, targetBlobs: service.sourceBlobs, restoreId: values['restore-id'] });
    let requested = null;
    if (command === 'create') {
      if (values['destination-profile'] !== service.destination.profileId) throw new Error('BACKUP_DESTINATION_CHANGED');
      requested = await service.operations.request({ requestId: values['request-id'] ?? randomUUID(), accountId: 'operator' });
    }
    if (requested && ['complete', 'failed', 'cancelled'].includes(requested.status)) return { job: requested, finished: true };
    let last = requested, idle = false;
    for (let count = 0; count < steps; count++) {
      const result = await service.operations.tick({ steps: 1, schedule: false });
      if (!result) { idle = true; break; }
      last = result;
      if (requested && result.id === requested.id && ['complete', 'failed', 'cancelled'].includes(result.status)) break;
    }
    const job = requested ? backupJobStatus(await service.store.jobs.get(requested.id)) : last;
    return { job, finished: requested ? ['complete', 'failed', 'cancelled'].includes(job.status) : idle };
  } finally { await service.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runBackupCommand(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.job?.status === 'failed'||['blocked','failed'].includes(result.cleanup?.status)) process.exitCode = 1;
    else if (result.finished === false) process.exitCode = 2;
  } catch (error) {
    // Provider/SQL error messages may contain credentials, paths or connection strings.
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message ?? '') ? error.message : 'BACKUP_COMMAND_FAILED';
    console.error(code + '\n' + usage);
    process.exitCode = 1;
  }
}
