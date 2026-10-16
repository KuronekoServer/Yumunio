import { PreferencesStore } from './preferences.js';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const validRevision=value=>Number.isSafeInteger(value)&&value>=0;
const clone=value=>structuredClone(value);
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function canonical(value){if(!value||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';}
function preferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).filter(key=>key!=='followSystem').sort().join(',')!=='customColors,fontId,locale,schemaVersion,themeId'||
    !value.customColors||typeof value.customColors!=='object'||Array.isArray(value.customColors))throw new PreferenceSyncError('INVALID_PREFERENCE_RESPONSE');
  try{return PreferencesStore.prototype.validate(value);}catch{throw new PreferenceSyncError('INVALID_PREFERENCE_RESPONSE');}
}
export class PreferenceSyncError extends Error {
  constructor(code,status=0){super(code);this.name='PreferenceSyncError';this.code=code;this.status=status;}
}
/** Explicit synchronization only: loading never writes the browser's local preference store. */
export class AccountPreferenceSync {
  constructor({fetcher=globalThis.fetch?.bind(globalThis),timeoutMs=15000}={}){
    if(typeof fetcher!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw new TypeError('INVALID_PREFERENCE_SYNC');
    this.fetcher=fetcher;this.timeoutMs=timeoutMs;this.actor=null;this.revision=null;this.remote=null;this.phase='idle';this.pending=false;this.error=null;this.generation=0;
  }
  setActor(user){
    const next=user&&id(user.id)?{id:user.id,emailVerified:user.emailVerified===true}:null;
    if(next?.id!==this.actor?.id||next?.emailVerified!==this.actor?.emailVerified){this.generation++;this.revision=null;this.remote=null;this.error=null;this.phase=next?.emailVerified?'ready':'auth-required';}
    this.actor=next;
  }
  #context(){
    if(this.pending)throw new PreferenceSyncError('PREFERENCE_SYNC_BUSY');
    if(!this.actor?.emailVerified)throw new PreferenceSyncError('VERIFIED_ACCOUNT_REQUIRED',401);
    return {id:this.actor.id,generation:this.generation};
  }
  #check(context){if(context.generation!==this.generation||context.id!==this.actor?.id||!this.actor?.emailVerified)throw new PreferenceSyncError('ACCOUNT_CHANGED',401);}
  async #request(path,{method='GET',body,accountId}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const response=await this.fetcher(path,{method,mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{...(accountId?{'X-Yumunio-Expected-Account':accountId}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      let value;try{value=await response.json();}catch{throw new PreferenceSyncError('INVALID_PREFERENCE_RESPONSE');}
      if(!response.ok)throw new PreferenceSyncError(typeof value?.error?.code==='string'&&/^[A-Z_]{1,64}$/.test(value.error.code)?value.error.code:'PREFERENCE_SYNC_FAILED',response.status);
      return value;
    }catch(error){if(error instanceof PreferenceSyncError)throw error;throw new PreferenceSyncError('PREFERENCE_NETWORK_UNCERTAIN');}
    finally{clearTimeout(timer);}
  }
  async #session(context){
    const session=await this.#request('/api/auth/get-session');this.#check(context);
    if(session?.user?.id!==context.id||session.user.emailVerified!==true)throw new PreferenceSyncError(session?.user?'ACCOUNT_CHANGED':'UNAUTHORIZED',401);
  }
  #validateResult(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='preferences,revision'||!validRevision(value.revision)||
      (value.preferences===null?value.revision!==0:value.revision===0))throw new PreferenceSyncError('INVALID_PREFERENCE_RESPONSE');
    return {revision:value.revision,preferences:value.preferences===null?null:preferences(value.preferences)};
  }
  async #operation(context,phase,task){
    this.pending=true;this.phase=phase;this.error=null;
    try{return await task();}
    catch(error){if(context.generation===this.generation){this.error=error;this.phase=error.status===409?'conflict':error.code==='PREFERENCE_NETWORK_UNCERTAIN'?'uncertain':error.code==='ACCOUNT_CHANGED'?'account-changed':'failed';}throw error;}
    finally{this.pending=false;}
  }
  async load(){
    const context=this.#context();
    return this.#operation(context,'loading',async()=>{
      await this.#session(context);
      const result=this.#validateResult(await this.#request('/api/preferences',{accountId:context.id}));this.#check(context);
      this.revision=result.revision;this.remote=freeze(clone(result.preferences));this.phase=this.remote?'review':'empty';
      return freeze(clone(result));
    });
  }
  async save(snapshot,{consent=false}={}){
    const context=this.#context();
    if(consent!==true)throw new PreferenceSyncError('PREFERENCE_SYNC_CONSENT_REQUIRED');
    if(this.revision===null)throw new PreferenceSyncError('PREFERENCE_LOAD_REQUIRED');
    const captured=preferences(snapshot),expectedRevision=this.revision;
    if(expectedRevision>=Number.MAX_SAFE_INTEGER)throw new PreferenceSyncError('PREFERENCES_CONFLICT',409);
    return this.#operation(context,'saving',async()=>{
      await this.#session(context);
      const result=this.#validateResult(await this.#request('/api/preferences',{method:'PUT',accountId:context.id,body:{expectedRevision,preferences:captured}}));this.#check(context);
      if(result.revision!==expectedRevision+1||canonical(result.preferences)!==canonical(captured))throw new PreferenceSyncError('INVALID_PREFERENCE_RESPONSE');
      this.revision=result.revision;this.remote=freeze(clone(result.preferences));this.phase='saved';return freeze(clone(result));
    });
  }
  async applyRemote(localStore,{consent=false}={}){
    const context=this.#context();
    if(consent!==true)throw new PreferenceSyncError('PREFERENCE_SYNC_CONSENT_REQUIRED');
    if(!this.remote||this.revision===null)throw new PreferenceSyncError('PREFERENCE_REMOTE_EMPTY');
    if(!localStore||typeof localStore.update!=='function'||localStore.profileId!==context.id)throw new PreferenceSyncError('PREFERENCE_PROFILE_MISMATCH');
    const captured=preferences(this.remote);
    return this.#operation(context,'applying',async()=>{
      await this.#session(context);this.#check(context);
      const result=localStore.update(captured);this.phase='applied';return clone(result);
    });
  }
}
