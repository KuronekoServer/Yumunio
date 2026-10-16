import { assertId } from '@yumunio/domain';
import { symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto';
import { validateMailMessage } from './mail.js';
const encoder=new TextEncoder();
const stamp=value=>{if(typeof value!=='string'||new Date(value).toISOString()!==value)throw new Error('Invalid job time.');return value;};
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
export async function prepareMailJob(message,{secret,id=crypto.randomUUID(),dedupeKey,now=new Date().toISOString(),expiresAt,invitationId,invitationGeneration}={}){
  if(typeof secret!=='string'||secret.length<32||secret.length>4096)throw new Error('Invalid outbox configuration.');
  assertId(id);stamp(now);stamp(expiresAt);if(expiresAt<=now||typeof dedupeKey!=='string'||!dedupeKey||dedupeKey.length>256||/[\u0000-\u001f\u007f]/.test(dedupeKey))throw new Error('Invalid mail job.');
  if(invitationId!==undefined){assertId(invitationId);if(!Number.isSafeInteger(invitationGeneration)||invitationGeneration<1)throw new Error('Invalid mail job.');}
  const text=JSON.stringify(validateMailMessage(message)),digest=await sha(text);
  const ciphertext=await symmetricEncrypt({key:secret,data:text});
  if(encoder.encode(ciphertext).length>140000)throw new Error('Mail job too large.');
  return {id,dedupeKey,ciphertext,digest,now,expiresAt,...(invitationId?{invitationId,invitationGeneration}:{})};
}
/** Durable enqueue is acknowledged separately from provider submission or final delivery. */
export function createDurableMailQueue({store,secret,sendMail,now=()=>new Date().toISOString(),createId=()=>crypto.randomUUID(),leaseMs=60000,maxAttempts=5}={}){
  if(!store||typeof store.enqueue!=='function'||typeof store.claim!=='function'||typeof secret!=='string'||secret.length<32||secret.length>4096||
    (sendMail!==undefined&&typeof sendMail!=='function')||!Number.isSafeInteger(leaseMs)||leaseMs<30000||leaseMs>600000||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)throw new Error('Invalid durable outbox configuration.');
  let running=null;
  const enqueue=async(message,options={})=>{
    const current=stamp(now()),expiresAt=options.expiresAt??new Date(Date.parse(current)+3600000).toISOString();
    const validated=validateMailMessage(message),dedupeKey=options.dedupeKey??'mail:'+await sha(JSON.stringify(validated));
    const job=await prepareMailJob(validated,{secret,id:createId(),dedupeKey,now:current,expiresAt});
    const result=await store.enqueue(job);return {status:'queued',id:result.id};
  };
  const process=async({limit=10}={})=>{
    const result={claimed:0,accepted:0,retried:0,dead:0,cancelled:0};
    if(!sendMail)return result;
    for(const id of await store.due(stamp(now()),limit)){
      const current=stamp(now()),leaseId=assertId(createId());
      const row=await store.claim(id,leaseId,current,new Date(Date.parse(current)+leaseMs).toISOString());if(!row)continue;result.claimed++;
      const settle=async(status,availableAt)=>{if(await store.settle(id,leaseId,{status,now:stamp(now()),availableAt}))result[status==='queued'?'retried':status]++;};
      if(row.expires_at<=current||Number(row.attempts)>maxAttempts){await settle('dead');continue;}
      if(row.invitation_id){
        const invite=await store.invitation(row.invitation_id);
        if(!invite||invite.status!=='pending'||invite.generation!==Number(row.invitation_generation)||invite.invitation.expiresAt<=current){await settle('cancelled');continue;}
      }
      try{
        const text=await symmetricDecrypt({key:secret,data:row.payload_ciphertext});
        if(await sha(text)!==row.payload_digest)throw new Error('Invalid job.');
        const message=validateMailMessage(JSON.parse(text));
        // Recheck the lease after decrypting. Resend/cancel may have invalidated this generation.
        if(!await store.leased(id,leaseId))continue;
        const outcome=await sendMail(message,{idempotencyKey:id});
        if(outcome?.status!=='accepted')throw new Error('Submission not confirmed.');
        await settle('accepted');
      }catch{
        const attempts=Number(row.attempts);
        if(attempts>=maxAttempts||row.expires_at<=stamp(now()))await settle('dead');
        else await settle('queued',new Date(Date.parse(stamp(now()))+Math.min(3600000,30000*2**(attempts-1))).toISOString());
      }
    }
    return result;
  };
  return Object.freeze({enqueue,send:enqueue,runDue(options){return running??=(process(options).finally(()=>{running=null;}));},async flush(){await running;}});
}
