export const validWorkspaceDirectoryId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const literal=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.values(Object.getOwnPropertyDescriptors(value)).every(item=>Object.hasOwn(item,'value'));
export class WorkspaceDirectoryError extends Error{
 constructor(code='UNAVAILABLE',status=0){super(code);this.name='WorkspaceDirectoryError';this.code=code;this.status=status;}
}
export function workspaceDirectoryEntry(value){
 if(!record(value)||!validWorkspaceDirectoryId(value.id)||!literal(value.name,500)||!literal(value.slug,100))throw new WorkspaceDirectoryError('INVALID_RESPONSE');
 return Object.freeze({id:value.id,name:value.name,slug:value.slug});
}
export function workspaceCreationInput(value){
 if(!record(value)||Object.keys(value).some(key=>!['name','slug'].includes(key)))throw new WorkspaceDirectoryError('INVALID_NAME');
 const name=typeof value.name==='string'?value.name.trim():'',slug=typeof value.slug==='string'?value.slug.trim():'';
 if(!literal(name,100))throw new WorkspaceDirectoryError('INVALID_NAME');
 if(!literal(slug,100)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw new WorkspaceDirectoryError('INVALID_SLUG');
 return Object.freeze({name,slug});
}

/** Account-bound directory; nothing is saved to local storage or used as an auth token. */
export class WorkspaceDirectory{
 #accountId;#fetcher;#controller=new AbortController();#signal;#generation=0;#destroyed=false;#creating=false;#uncertain=false;#actorChanged=false;
 constructor({accountId,fetcher=globalThis.fetch,signal}={}){
  if(!validWorkspaceDirectoryId(accountId)||typeof fetcher!=='function')throw new WorkspaceDirectoryError('INVALID_CONTEXT');
  this.#accountId=accountId;this.#fetcher=(...args)=>fetcher(...args);this.#signal=signal?AbortSignal.any([signal,this.#controller.signal]):this.#controller.signal;
 }
 get busy(){return this.#creating;}
 get creationUncertain(){return this.#uncertain;}
 #assertLive(generation){
  if(this.#destroyed||this.#signal.aborted)throw new WorkspaceDirectoryError('DESTROYED');
  if(this.#actorChanged)throw new WorkspaceDirectoryError('ACCOUNT_CHANGED',401);
  if(generation!==this.#generation)throw new WorkspaceDirectoryError('STALE_OPERATION');
 }
 async #request(path,{method='GET',body}={}){
  let response,data;
  try{
   response=await this.#fetcher('/api/auth'+path,{method,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([this.#signal,AbortSignal.timeout(15000)]),
    headers:{'X-Yumunio-Expected-Account':this.#accountId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   data=await response.json();
  }catch{throw new WorkspaceDirectoryError(this.#destroyed||this.#signal.aborted?'DESTROYED':'UNAVAILABLE');}
  if(!response.ok){
   if(['ACCOUNT_CHANGED','SIGN_IN_REQUIRED','VERIFY_EMAIL'].includes(data?.error?.code)){this.#actorChanged=true;throw new WorkspaceDirectoryError('ACCOUNT_CHANGED',response.status);}
   throw new WorkspaceDirectoryError(response.status===429?'RATE_LIMITED':response.status===401?'ACCOUNT_UNAVAILABLE':'REQUEST_FAILED',response.status);
  }
  return data;
 }
 async #verify(generation){
  this.#assertLive(generation);const session=await this.#request('/get-session');this.#assertLive(generation);
  if(!record(session)||!record(session.user)||session.user.id!==this.#accountId||session.user.emailVerified!==true){this.#actorChanged=true;throw new WorkspaceDirectoryError('ACCOUNT_CHANGED',401);}
  if(typeof session.user.name!=='string'||session.user.name.length>500||/[\u0000-\u001f\u007f]/.test(session.user.name))throw new WorkspaceDirectoryError('INVALID_RESPONSE');
  return Object.freeze({id:this.#accountId,name:session.user.name});
 }
 async load(){
  if(this.#creating)throw new WorkspaceDirectoryError('BUSY');
  const generation=++this.#generation;const user=await this.#verify(generation);this.#assertLive(generation);
  const data=await this.#request('/organization/list');this.#assertLive(generation);
  if(!Array.isArray(data)||data.length>1000)throw new WorkspaceDirectoryError('INVALID_RESPONSE');
  const workspaces=data.map(workspaceDirectoryEntry),ids=new Set(workspaces.map(item=>item.id)),slugs=new Set(workspaces.map(item=>item.slug));
  if(ids.size!==workspaces.length||slugs.size!==workspaces.length)throw new WorkspaceDirectoryError('INVALID_RESPONSE');
  await this.#verify(generation);this.#assertLive(generation);
  return Object.freeze({user,workspaces:Object.freeze(workspaces)});
 }
 async create(value){
  if(this.#creating)throw new WorkspaceDirectoryError('BUSY');
  if(this.#uncertain)throw new WorkspaceDirectoryError('CREATE_UNCONFIRMED');
  const input=workspaceCreationInput(value),generation=++this.#generation;this.#creating=true;let sent=false;
  try{
   await this.#verify(generation);this.#assertLive(generation);sent=true;
   const value=await this.#request('/organization/create',{method:'POST',body:input});this.#assertLive(generation);
   const workspace=workspaceDirectoryEntry(value);
   if(workspace.name!==input.name||workspace.slug!==input.slug)throw new WorkspaceDirectoryError('INVALID_RESPONSE');
   await this.#verify(generation);this.#assertLive(generation);return workspace;
  }catch(error){
   if(sent&&(error.status===0||error.status>=500||error.code==='ACCOUNT_CHANGED'&&error.status!==409&&error.status!==403)){this.#uncertain=true;throw new WorkspaceDirectoryError('CREATE_UNCONFIRMED',error.status);}
   throw error;
  }finally{this.#creating=false;}
 }
 destroy(){if(this.#destroyed)return;this.#destroyed=true;this.#generation++;this.#controller.abort();}
}
