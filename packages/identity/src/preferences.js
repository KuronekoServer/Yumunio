import { assertId, assertPlainObject, assertJsonSerializable } from '@yumunio/domain';
import { validatePreferences } from './preferences-model.js';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(value,status=200)=>Response.json(value,{status,headers});
class PreferencesError extends Error {constructor(code,status){super(code);this.code=code;this.status=status;}}
const fail=(code='PREFERENCES_NOT_FOUND',status=404)=>{throw new PreferencesError(code,status);};
async function body(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))fail('CONTENT_TYPE',415);
  const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))fail('PREFERENCES_TOO_LARGE',413);
  if(!request.body)fail('INVALID_PREFERENCES',400);
  const reader=request.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){try{await reader.cancel();}catch{}fail('PREFERENCES_TOO_LARGE',413);}parts.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_PREFERENCES',400);}
  }finally{reader.releaseLock();}
}
export function createPreferencesApi({store,resolveSession,origin}={}){
  if(!store||typeof store.read!=='function'||typeof store.write!=='function'||typeof resolveSession!=='function'||new URL(origin).origin!==origin)throw new Error('Invalid preference service configuration.');
  return async request=>{
    try{
      const url=new URL(request.url),suppliedOrigin=request.headers.get('origin');
      if(url.origin!==origin||url.pathname!=='/api/preferences'||url.search||url.hash||url.username||url.password)fail();
      if(suppliedOrigin!==null&&suppliedOrigin!==origin||request.method!=='GET'&&suppliedOrigin!==origin)fail('PREFERENCES_REQUEST_REJECTED',403);
      if(!['GET','PUT'].includes(request.method))fail('METHOD_NOT_ALLOWED',405);
      const session=await resolveSession(request),accountId=session?.user?.id;
      if(!accountId||session.user.emailVerified!==true)fail();assertId(accountId);
      const expected=request.headers.get('x-yumunio-expected-account');
      if((request.method==='PUT'||expected!==null)&&expected!==accountId)fail();
      if(request.method==='GET'){const result=await store.read(accountId);if(!result)fail();return json(result);}
      const data=await body(request);assertPlainObject(data);assertJsonSerializable(data);
      if(Object.keys(data).length!==2||!Object.hasOwn(data,'expectedRevision')||!Object.hasOwn(data,'preferences')||
        !Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<0||data.expectedRevision>=Number.MAX_SAFE_INTEGER)fail('INVALID_PREFERENCES',400);
      let checked;try{checked=validatePreferences(data.preferences);}catch{fail('INVALID_PREFERENCES',400);}
      return json(await store.write(accountId,{expectedRevision:data.expectedRevision,preferences:checked}));
    }catch(error){
      if(error instanceof PreferencesError)return json({error:{code:error.code}},error.status);
      if(error?.code==='PREFERENCES_CONFLICT')return json({error:{code:'PREFERENCES_CONFLICT'}},409);
      if(error?.code==='PREFERENCES_NOT_FOUND')return json({error:{code:'PREFERENCES_NOT_FOUND'}},404);
      if(error?.code==='INVALID_INPUT')return json({error:{code:'INVALID_PREFERENCES'}},400);
      return json({error:{code:'PREFERENCES_UNAVAILABLE'}},503);
    }
  };
}
