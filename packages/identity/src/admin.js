import {assertId,assertPlainObject,assertJsonSerializable} from '@yumunio/domain';
import {prepareMailJob} from './jobs.js';
import {createDomainPolicy} from './config.js';
import {readInstanceConfig} from './instance.js';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(body,status=200)=>Response.json(body,{status,headers});
export class AdminError extends Error {constructor(code='ADMIN_NOT_FOUND',status=404){super('The administration request could not be completed.');this.code=code;this.status=status;}}
const fail=(code='ADMIN_NOT_FOUND',status=404)=>{throw new AdminError(code,status);};
const value=(env,key)=>typeof env[key]==='string'?env[key]:'';
const oneOf=(input,list,fallback)=>list.includes(input)?input:fallback;
export function readServerAdminIds(env={}){
  const raw=env.YUMUNIO_SERVER_ADMIN_IDS;
  if(raw===undefined||raw==='')return Object.freeze([]);
  if(typeof raw!=='string'||raw.length>13000)throw new Error('Invalid server administrator configuration.');
  const list=raw.split(',').map(id=>id.trim());
  if(list.length>100||list.some(id=>!id))throw new Error('Invalid server administrator configuration.');
  try{return Object.freeze([...new Set(list.map(id=>assertId(id)))]);}catch{throw new Error('Invalid server administrator configuration.');}
}
/** A fixed whitelist of resolved settings. Never returns the environment object or connection details. */
export function readAdminDiagnostics({env={},runtime='node',storage}={}){
  const driver=oneOf(storage??value(env,'YUMUNIO_STORAGE'),['browser-local','sqlite','mariadb','mysql','tidb','postgres','d1'],'unknown');
  const mail=oneOf(value(env,'YUMUNIO_MAIL_DRIVER')||'disabled',['disabled','smtp','http'],'invalid');
  let domain;
  try{domain=createDomainPolicy({mode:value(env,'YUMUNIO_EMAIL_DOMAIN_MODE')||'unrestricted',
    allowedDomains:value(env,'YUMUNIO_EMAIL_ALLOWED_DOMAINS').split(',').map(v=>v.trim()).filter(Boolean),
    blockedDomains:value(env,'YUMUNIO_EMAIL_BLOCKED_DOMAINS').split(',').map(v=>v.trim()).filter(Boolean),
    allowSubdomains:value(env,'YUMUNIO_EMAIL_ALLOW_SUBDOMAINS')==='true',blockSubdomains:value(env,'YUMUNIO_EMAIL_BLOCK_SUBDOMAINS')!=='false'});}
  catch{domain={valid:false};}
  const brand=readInstanceConfig(env),sourceKeys=['YUMUNIO_SERVER_ADMIN_IDS','YUMUNIO_PUBLIC_ORIGIN','YUMUNIO_STORAGE','YUMUNIO_DATABASE_URL','YUMUNIO_DATABASE_TLS',
    'YUMUNIO_ACCOUNTS_ENABLED','YUMUNIO_REGISTRATION_MODE','YUMUNIO_EMAIL_DOMAIN_MODE','YUMUNIO_EMAIL_ALLOWED_DOMAINS','YUMUNIO_EMAIL_BLOCKED_DOMAINS',
    'YUMUNIO_MAIL_DRIVER','YUMUNIO_SMTP_TLS','YUMUNIO_MAIL_HTTP_ENDPOINT','YUMUNIO_BLOB_DRIVER','YUMUNIO_BRAND_NAME','YUMUNIO_DEFAULT_THEME','YUMUNIO_DEFAULT_LOCALE'];
  return {schemaVersion:1,readonly:true,source:'environment',runtime:oneOf(runtime,['node','worker'],'unknown'),pageAccess:'separate-page-permissions',
    accounts:{enabled:value(env,'YUMUNIO_ACCOUNTS_ENABLED')==='true',registrationMode:oneOf(value(env,'YUMUNIO_REGISTRATION_MODE')||'closed',['open','closed'],'invalid'),domainPolicy:domain},
    database:{driver,tls:['mariadb','mysql','tidb','postgres'].includes(driver)?oneOf(value(env,'YUMUNIO_DATABASE_TLS')||'verify-full',['verify-full','disable'],'invalid'):'not-applicable'},
    mail:{driver:mail,tls:mail==='smtp'?oneOf(value(env,'YUMUNIO_SMTP_TLS')||'starttls_required',['starttls_required','implicit_tls'],'invalid'):mail==='http'?'https':'not-applicable'},
    attachments:{driver:oneOf(value(env,'YUMUNIO_BLOB_DRIVER')||'disabled',['disabled','local','s3','r2'],'invalid')},
    branding:{applicationName:brand.applicationName,initialTheme:brand.initialTheme,defaultLocale:brand.defaultLocale,customAssets:Object.values(brand.logos).some(Boolean)||Object.values(brand.favicons).some(Boolean)},
    sourceEnvironment:sourceKeys.map(key=>({key,configured:Boolean(value(env,key))}))};
}
function object(value,keys){assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail('INVALID_ADMIN_REQUEST',400);}
async function readJson(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))fail('CONTENT_TYPE',415);
  const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096))fail('ADMIN_TOO_LARGE',413);
  if(!request.body)fail('INVALID_ADMIN_REQUEST',400);const reader=request.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){try{await reader.cancel();}catch{}fail('ADMIN_TOO_LARGE',413);}parts.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_ADMIN_REQUEST',400);}
  }finally{reader.releaseLock();}
}
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
export function createAdminApi({store,resolveSession,origin,secret,env={},runtime='node',storage,adminIds=readServerAdminIds(env),now=()=>new Date().toISOString(),createId=()=>crypto.randomUUID()}={}){
  if(!store||typeof store.authorize!=='function'||typeof resolveSession!=='function'||new URL(origin).origin!==origin||typeof secret!=='string'||secret.length<32||secret.length>4096||
    !Array.isArray(adminIds)||adminIds.length>100)throw new Error('Invalid administration configuration.');
  const ids=new Set(adminIds.map(id=>assertId(id))),diagnostics=readAdminDiagnostics({env,runtime,storage});
  const currentTime=()=>{const time=now();if(typeof time!=='string'||new Date(time).toISOString()!==time)throw new Error('Invalid clock.');return time;};
  const job=async(account,prefix,requestId)=>{
    const time=currentTime(),dedupeKey=prefix+await hash(requestId);
    return prepareMailJob({to:account.email,subject:'Yumunio: メール送信テスト',text:'管理者が明示的に依頼したメール送信テストです。このメールの到着状況は管理画面で自動判定しません。'},
      {secret,id:createId(),dedupeKey,now:time,expiresAt:new Date(Date.parse(time)+3600000).toISOString()});
  };
  return async request=>{
    try{
      const url=new URL(request.url),suppliedOrigin=request.headers.get('origin');
      if(url.origin!==origin||url.username||url.password||url.search||url.hash)fail();
      if(suppliedOrigin!==null&&suppliedOrigin!==origin||request.method!=='GET'&&suppliedOrigin!==origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site')))fail('ADMIN_REQUEST_REJECTED',403);
      const session=await resolveSession(request),accountId=session?.user?.id;
      if(!accountId||session.user.emailVerified!==true||!ids.has(accountId))fail();
      const expected=request.headers.get('x-yumunio-expected-account');
      if((request.method!=='GET'||expected!==null)&&expected!==accountId)fail();
      const account=await store.authorize(accountId),path=url.pathname;
      if(path==='/api/admin/config'&&request.method==='GET')return json(diagnostics);
      if(path==='/api/admin/users'&&request.method==='GET')return json(await store.users(accountId));
      const sessions=/^\/api\/admin\/users\/([A-Za-z0-9._:-]+)\/sessions(?:\/([A-Za-z0-9._:-]+))?$/.exec(path);
      if(sessions){
        const [,targetId,sessionId]=sessions;assertId(targetId);if(sessionId)assertId(sessionId);
        if(!sessionId&&request.method==='GET')return json(await store.sessions(accountId,targetId,session.session?.id));
        if(sessionId&&request.method==='DELETE'){
          const data=await readJson(request);object(data,['consent']);if(data.consent!==true)fail('ADMIN_CONSENT_REQUIRED',400);
          const result=await store.revokeSession(accountId,targetId,sessionId);
          return json({...result,currentSession:targetId===accountId&&sessionId===session.session?.id});
        }
        fail('METHOD_NOT_ALLOWED',405);
      }
      const prefix='admin-test:'+await hash(accountId)+':';
      if(path==='/api/admin/jobs'&&request.method==='GET')return json(await store.jobs(accountId,prefix));
      if(path==='/api/admin/mail-test'&&request.method==='POST'){
        const data=await readJson(request);object(data,['requestId','consent']);assertId(data.requestId);if(data.consent!==true)fail('ADMIN_CONSENT_REQUIRED',400);
        if(!['smtp','http'].includes(diagnostics.mail.driver))fail('ADMIN_MAIL_DISABLED',503);
        return json(await store.enqueueTest(accountId,account.email,prefix,await job(account,prefix,data.requestId)),202);
      }
      const retry=/^\/api\/admin\/jobs\/([A-Za-z0-9._:-]+)\/retry$/.exec(path);
      if(retry&&request.method==='POST'){
        const data=await readJson(request);object(data,['consent']);if(data.consent!==true)fail('ADMIN_CONSENT_REQUIRED',400);
        if(!['smtp','http'].includes(diagnostics.mail.driver))fail('ADMIN_MAIL_DISABLED',503);
        return json(await store.retryTest(accountId,account.email,prefix,assertId(retry[1]),await job(account,prefix,'retry:'+retry[1])),202);
      }
      fail();
    }catch(error){
      if(error instanceof AdminError)return json({error:{code:error.code,message:error.message}},error.status);
      if(error?.code==='ADMIN_NOT_FOUND')return json({error:{code:'ADMIN_NOT_FOUND'}},404);
      if(error?.code==='ADMIN_CONFLICT')return json({error:{code:'ADMIN_CONFLICT'}},409);
      if(error?.code==='INVALID_INPUT'||error?.code==='MAIL_INVALID_MESSAGE')return json({error:{code:'INVALID_ADMIN_REQUEST'}},400);
      return json({error:{code:'ADMIN_UNAVAILABLE'}},503);
    }
  };
}
