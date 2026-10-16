const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
const missing=()=>json({error:{code:'ADMIN_NOT_FOUND'}},404);
async function body(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new Error('body');
  const reader=request.body?.getReader();if(!reader)throw new Error('body');const chunks=[];let size=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new Error('body');}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  finally{reader.releaseLock();}
}
/** Full-instance backup authority is the explicit server-admin allowlist, never a workspace role. */
export function createBackupOperationsApi({operations,resolveSession,adminIds=[],origin}={}){
  if(!operations||typeof resolveSession!=='function'||new URL(origin).origin!==origin||!Array.isArray(adminIds)||adminIds.some(value=>!id(value)))throw new Error('Invalid backup API configuration.');
  const administrators=new Set(adminIds);
  return async request=>{
    try{
      const url=new URL(request.url);
      const cleanup=/^\/api\/admin\/backups\/cleanup\/(preview|approval|jobs)$/.exec(url.pathname);
      if(url.origin!==origin||url.search||url.pathname!=='/api/admin/backups'&&!cleanup||!['GET','POST','DELETE'].includes(request.method)||
        request.headers.has('origin')&&request.headers.get('origin')!==origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))||
        ['POST','DELETE'].includes(request.method)&&request.headers.get('origin')!==origin)return missing();
      const session=await resolveSession(request),accountId=session?.user?.id;
      if(!id(accountId)||session.user.emailVerified!==true||!administrators.has(accountId)||request.headers.get('x-yumunio-expected-account')!==accountId)return missing();
      if(cleanup){
        if(!operations.config.enabled||!operations.config.cleanup?.enabled)return json({error:{code:'BACKUP_CLEANUP_DISABLED'}},503);
        if(cleanup[1]==='jobs')return request.method==='GET'?json({cleanup:await operations.cleanup.status()}):missing();
        if(cleanup[1]==='preview'){if(request.method!=='POST')return missing();let input;try{input=await body(request);}catch{return json({error:{code:'INVALID_BACKUP_REQUEST'}},400);}if(!input||typeof input!=='object'||Object.keys(input).length!==1||input.destinationProfileId!==operations.destination?.profileId)return json({error:{code:'BACKUP_CLEANUP_CONFLICT'}},409);return json(await operations.cleanup.preview());}
        if(!['POST','DELETE'].includes(request.method))return missing();let input;try{input=await body(request);}catch{return json({error:{code:'INVALID_BACKUP_REQUEST'}},400);}
        const keys=request.method==='POST'?['destinationProfileId','policyDigest','planDigest','expectedVersion','confirmScope','confirmQuiescent']:['destinationProfileId','expectedVersion'];
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||!id(input.destinationProfileId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)return json({error:{code:'INVALID_BACKUP_REQUEST'}},400);
        return json({cleanup:await operations.cleanup[request.method==='POST'?'approve':'revoke']({...input,accountId})});
      }
      if(request.method==='DELETE')return missing();
      if(request.method==='GET')return json(await operations.status());
      if(!operations.config.enabled)return json({error:{code:'BACKUP_DISABLED'}},503);
      let input;try{input=await body(request);}catch{return json({error:{code:'INVALID_BACKUP_REQUEST'}},400);}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='confirmScope,destinationProfileId,requestId'||input.confirmScope!=='database-and-private-files'||typeof input.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.requestId)||!id(input.destinationProfileId))return json({error:{code:'BACKUP_CONSENT_REQUIRED'}},400);
      if(input.destinationProfileId!==operations.destination?.profileId)return json({error:{code:'BACKUP_DESTINATION_CHANGED'}},409);
      const job=await operations.request({requestId:input.requestId,accountId});return json({job},202);
    }catch(error){const code=error?.code;if(code==='BACKUP_CLEANUP_CONSENT_REQUIRED')return json({error:{code}},400);if(/^BACKUP_CLEANUP_(CONFLICT|KEEPER_REQUIRED|KEEPER_UNVERIFIED|CATALOG_TOO_LARGE)$/.test(code??'')||code==='BACKUP_ARCHIVE_BUSY')return json({error:{code}},409);return json({error:{code:['BACKUP_DISABLED','BACKUP_CLEANUP_DISABLED','BACKUP_CLEANUP_SCHEMA_REQUIRED','RECOVERY_IN_PROGRESS','RECOVERY_UNAVAILABLE'].includes(code)?code:'BACKUP_UNAVAILABLE'}},503);}
  };
}
