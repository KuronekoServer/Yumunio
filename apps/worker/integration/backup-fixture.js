import baseWorker from '../worker.js';
import {hashPassword} from 'better-auth/crypto';
import {createD1RecoveryStore} from '@yumunio/backup/d1';
import {readRecoveryArchive,verifyRecoveryArchive,readRecoveryKey,manifestKey,sha256} from '@yumunio/backup/archive';
import {restoreRecoveryArchive} from '@yumunio/backup/restore';
import {prepareRecoverySnapshot} from '@yumunio/backup';
import {createR2BlobStore} from '../../../packages/adapters/src/blob.js';
const encoder=new TextEncoder(),stamp='2026-10-15T00:00:00.000Z',pending=new Set();
let externalAttempts=0;
globalThis.fetch=()=>{externalAttempts++;throw new Error('External requests are forbidden in this synthetic backup fixture.');};
const safeId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value))throw new Error('Invalid fixture id.');return value;};
const source=env=>createD1RecoveryStore(env.DB),target=env=>createD1RecoveryStore(env.TARGET);
const destination=env=>createR2BlobStore(env.BACKUPS,{driver:'r2',binding:'BACKUPS'});
const targetBlobs=env=>createR2BlobStore(env.RESTORED,{driver:'r2',binding:'RESTORED'});
const options=async(env,id)=>({source:await destination(env),key:readRecoveryKey(env.FIXTURE_KEY),backupId:safeId(id),authSecret:env.YUMUNIO_AUTH_SECRET});
function contextFor(context){return{waitUntil(task){pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});context?.waitUntil?.(task);}};}
async function settled(){await Promise.all([...pending]);}
function runtimeEnvironment(env,restored=false){return restored?{...env,DB:env.TARGET,YUMUNIO_PUBLIC_ORIGIN:'https://restored-backup.fixture.invalid',YUMUNIO_BACKUP_DRIVER:'disabled',YUMUNIO_R2_BINDING:'RESTORED'}:env;}
export default{async fetch(request,env,context){
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/__fixture/'))return baseWorker.fetch(request,runtimeEnvironment(env,url.hostname==='restored-backup.fixture.invalid'),contextFor(context));
  try{
    if(path==='/__fixture/seed'){
      const password=await hashPassword('Synthetic-backup-password-2026!'),date=Date.parse(stamp),db=env.DB;
      const statements=[];
      for(const[id,name,email]of [['backup-admin','Synthetic backup administrator','backup-admin@example.invalid'],['backup-owner','Synthetic workspace owner','backup-owner@example.invalid']]){
        statements.push(db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').bind(id,name,email,date,date));
        statements.push(db.prepare('INSERT INTO yumunio_auth_accounts(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').bind('credential-'+id,id,'credential',id,password,date,date));
      }
      statements.push(db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').bind('backup-workspace','Synthetic private backup workspace','synthetic-backup',date));
      for(const id of ['backup-admin','backup-owner'])statements.push(db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').bind('membership-'+id,'backup-workspace',id,'owner',date));
      await db.batch(statements);
      const bytes=new Uint8Array(1024*1024+19);bytes.fill(83);const checksum=await sha256(bytes),live=await createR2BlobStore(env.LIVE,{driver:'r2',binding:'LIVE'});await live.put('objects/synthetic',bytes);
      const item={page:{id:'backup-page',workspaceId:'backup-workspace',title:'Synthetic private recovery page',parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:'backup-page',workspaceId:'backup-workspace',version:1,blocks:[{id:'body',type:'paragraph',data:{text:'SYNTHETIC-BACKUP-CONTENT'}}],updatedAt:stamp},inheritPermissions:false};
      const payload={schemaVersion:1,pages:[item],grants:[{id:'backup-grant',workspaceId:'backup-workspace',pageId:'backup-page',accountId:'backup-admin',permission:'full',includeDescendants:false,status:'active'}],grantBindings:[{grantId:'backup-grant',membershipId:'membership-backup-admin'}],attachments:[{id:'backup-attachment',pageId:'backup-page',name:'synthetic.bin',mediaType:'application/octet-stream',size:bytes.length,checksum,profileId:live.profileId,objectKey:'objects/synthetic'}]};
      await db.prepare('INSERT INTO yumunio_account_content(workspace_id,revision,payload_json) VALUES(?,?,?)').bind('backup-workspace',2,JSON.stringify(payload)).run();return Response.json({size:bytes.length,checksum});
    }
    if(path==='/__fixture/settle'){await settled();return Response.json({pending:pending.size,externalAttempts});}
    if(path==='/__fixture/scheduled'){
      await settled();const tasks=[],ctx={waitUntil(task){tasks.push(task);}};await baseWorker.scheduled({scheduledTime:Date.now(),cron:'* * * * *'},env,ctx);await Promise.all(tasks);return Response.json({externalAttempts});
    }
    if(path==='/__fixture/objects'){
      const list=await env.BACKUPS.list({limit:1000}),live=await env.LIVE.list({limit:1000}),plain=['SYNTHETIC-BACKUP-CONTENT','backup-admin@example.invalid','synthetic.bin'];let privatePlaintext=false;
      for(const object of list.objects){const value=new TextDecoder().decode(await(await env.BACKUPS.get(object.key)).arrayBuffer());if(plain.some(text=>value.includes(text)))privatePlaintext=true;}
      return Response.json({backupObjects:list.objects.length,liveObjects:live.objects.length,privatePlaintext,externalAttempts});
    }
    if(path==='/__fixture/archive'){
      await settled();const input=await request.json(),args=await options(env,input.backupId),verified=await verifyRecoveryArchive(args),archive=await readRecoveryArchive(args),sealed=await env.BACKUPS.get(manifestKey(args.backupId)),envelope=JSON.parse(await sealed.text());let wrongKeyCode;
      try{await verifyRecoveryArchive({...args,key:new Uint8Array(32)});}catch(error){wrongKeyCode=error.code;}
      return Response.json({...verified,envelopeKeys:Object.keys(envelope).sort(),excludedEnvironment:archive.manifest.excludedEnvironment,includesAccounts:archive.snapshot.tables.some(row=>row.name==='yumunio_auth_accounts'&&row.rows.length===2),includesAcl:archive.snapshot.tables.some(row=>row.name==='yumunio_account_content'&&JSON.parse(row.rows[0][2]).grantBindings[0].membershipId==='membership-backup-admin'),wrongKeyCode});
    }
    if(path==='/__fixture/restore-start'){
      const input=await request.json(),args=await options(env,input.backupId),archive=await readRecoveryArchive(args),blobs=await targetBlobs(env),mapping=new Map();
      for(const object of archive.manifest.objects)mapping.set(object.profileId+'/'+object.objectKey,{profileId:blobs.profileId,objectKey:'objects/'+await sha256(encoder.encode('yumunio-restored-object-v1\nworker-runtime-restore\n'+object.profileId+'/'+object.objectKey))});
      const snapshot=prepareRecoverySnapshot(archive.snapshot,{objectMapping:mapping,now:stamp}),restore={restoreId:'worker-runtime-restore',manifestDigest:archive.manifestChecksum,targetProfileId:blobs.profileId,preparedAt:stamp};
      await target(env).beginRestore(snapshot,restore);await target(env).applyRestoreBatch(snapshot,{...restore,maxRows:1});return Response.json(await target(env).inspectRecoveryGate());
    }
    if(path==='/__fixture/restore'){
      const input=await request.json(),args=await options(env,input.backupId);return Response.json(await restoreRecoveryArchive({...args,target:target(env),targetBlobs:await targetBlobs(env),restoreId:'worker-runtime-restore',preparedAt:stamp}));
    }
    if(path==='/__fixture/restored'){
      const gate=await target(env).inspectRecoveryGate();if(gate.state!=='ready')return Response.json({gate},{status:503});
      const saved=await env.TARGET.prepare('SELECT revision,payload_json FROM yumunio_account_content WHERE workspace_id=?').bind('backup-workspace').first(),payload=JSON.parse(saved.payload_json),attachment=payload.attachments[0],blobs=await targetBlobs(env),bytes=await blobs.get(attachment.objectKey),sessions=await env.TARGET.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions').first(),live=await createR2BlobStore(env.LIVE,{driver:'r2',binding:'LIVE'});
      return Response.json({gate,revision:saved.revision,version:payload.pages[0].document.version,bodyRestored:payload.pages[0].document.blocks[0].data.text==='SYNTHETIC-BACKUP-CONTENT',grant:payload.grantBindings[0],sessions:sessions.n,size:bytes.length,checksum:await sha256(bytes),profileChanged:attachment.profileId!==live.profileId,keyChanged:attachment.objectKey!=='objects/synthetic'});
    }
    return new Response('Unknown synthetic fixture route',{status:404});
  }catch(error){return Response.json({error:{code:error?.code??'FIXTURE_FAILED'}},{status:500});}
}};