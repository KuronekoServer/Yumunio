const outcomes=new Set(['saved','paused','conflict','unknown','rejected']);
const defaultClock={now:()=>globalThis.performance?.now?.()??Date.now(),setTimeout:(callback,delay)=>globalThis.setTimeout(callback,delay),clearTimeout:timer=>globalThis.clearTimeout(timer)};
const rejection=error=>error?.status===409?'conflict':[400,401,403,404,413,422].includes(error?.status)?'rejected':'unknown';

/** Schedules editor saves in a single flight. The adapter owns HTTP, authorization, CAS and ACK validation. */
export class PageAutosave {
 #getState;#save;#onState;#clock;#debounce;#maxWait;
 #timer=null;#inFlight=null;#epoch=0;#stopped=false;#stateError=false;#held=false;
 #current={scopeKey:null,generation:0,dirty:false,paused:true};#seen=null;#first=null;#last=null;#time=0;#blocked=new Map();#emitted='';
 constructor({getState,save,onState=()=>{},clock=defaultClock,debounceMs=900,maxWaitMs=3000}={}){
  if(typeof getState!=='function'||typeof save!=='function'||typeof onState!=='function'||!clock||!['now','setTimeout','clearTimeout'].every(key=>typeof clock[key]==='function')||!Number.isInteger(debounceMs)||debounceMs<700||debounceMs>1000||!Number.isInteger(maxWaitMs)||maxWaitMs<debounceMs||maxWaitMs>3000)throw new TypeError('INVALID_PAGE_AUTOSAVE');
  this.#getState=getState;this.#save=save;this.#onState=onState;this.#clock=clock;this.#debounce=debounceMs;this.#maxWait=maxWaitMs;
 }
 #read(){
  const value=this.#getState();
  if(!value||typeof value!=='object'||Array.isArray(value)||!(value.scopeKey===null||typeof value.scopeKey==='string'&&value.scopeKey.length>0&&value.scopeKey.length<=1024&&!value.scopeKey.includes('\0'))||!Number.isSafeInteger(value.generation)||value.generation<0||typeof value.dirty!=='boolean'||typeof value.paused!=='boolean'||value.scopeKey===null&&value.dirty)throw new TypeError('INVALID_PAGE_AUTOSAVE_STATE');
  return{scopeKey:value.scopeKey,generation:value.generation,dirty:value.dirty,paused:value.paused};
 }
 #clear(){if(this.#timer!==null){this.#clock.clearTimeout(this.#timer);this.#timer=null;}}
 #update(){
  try{
   const value=this.#read(),now=this.#clock.now();if(!Number.isFinite(now)||now<0)throw new TypeError('INVALID_PAGE_AUTOSAVE_CLOCK');this.#time=Math.max(this.#time,now);this.#stateError=false;
   if(value.scopeKey!==this.#current.scopeKey){this.#epoch++;this.#clear();this.#seen=null;this.#first=null;this.#last=null;this.#held=false;}
   const changed=value.generation!==this.#seen;
   if(this.#seen!==null&&value.generation<this.#seen&&value.scopeKey)this.#blocked.set(value.scopeKey,'rejected');
   this.#seen=value.generation;this.#current=value;
   if(!value.dirty){this.#first=null;this.#last=null;}
   else if(!(this.#inFlight?.scopeKey===value.scopeKey&&this.#inFlight.generation===value.generation)){
    if(this.#first===null)this.#first=this.#time;
    if(changed||this.#last===null)this.#last=this.#time;
   }
   return value;
  }catch{this.#stateError=true;this.#clear();return null;}
 }
 snapshot(){
  const value=this.#current,reason=this.#stateError?'rejected':this.#blocked.get(value.scopeKey)??null;
  const phase=this.#stopped?'stopped':reason?'blocked':this.#inFlight?.scopeKey===value.scopeKey?'saving':!value.scopeKey||!value.dirty?'idle':value.paused||this.#held?'paused':'scheduled';
  return Object.freeze({phase,reason,pending:value.dirty,inFlight:!!this.#inFlight,scopeKey:value.scopeKey,generation:value.generation});
 }
 #emit(){const state=this.snapshot(),encoded=JSON.stringify(state);if(encoded!==this.#emitted){this.#emitted=encoded;try{this.#onState(state);}catch{}}return state;}
 #eligible(){const value=this.#current;return!this.#stopped&&!this.#stateError&&!!value.scopeKey&&value.dirty&&!value.paused&&!this.#held&&!this.#blocked.has(value.scopeKey);}
 #arm(){
  this.#clear();if(!this.#eligible()||this.#inFlight)return;
  if(this.#first===null)this.#first=this.#time;if(this.#last===null)this.#last=this.#time;
  const due=Math.min(this.#last+this.#debounce,this.#first+this.#maxWait);
  this.#timer=this.#clock.setTimeout(()=>{this.#timer=null;void this.#run(false);},Math.max(0,due-this.#time));
 }
 #currentOperation(operation){
  if(this.#stopped||this.#epoch!==operation.epoch||this.#current.scopeKey!==operation.scopeKey)return false;
  try{return this.#read().scopeKey===operation.scopeKey;}catch{return false;}
 }
 async #run(force){
  if(this.#stopped)return{status:'paused'};
  this.#update();
  if(!this.#eligible()||this.#inFlight){this.#emit();return{status:'paused'};}
  const due=Math.min((this.#last??this.#time)+this.#debounce,(this.#first??this.#time)+this.#maxWait);
  if(!force&&this.#time<due){this.#arm();this.#emit();return{status:'paused'};}
  this.#clear();const operation={scopeKey:this.#current.scopeKey,generation:this.#current.generation,epoch:this.#epoch,promise:null};
  this.#inFlight=operation;this.#first=null;this.#last=null;this.#emit();
  operation.promise=(async()=>{
   let status;
   try{
    try{
     const latest=this.#read();
     if(!this.#currentOperation(operation)||latest.paused||!latest.dirty||latest.generation!==operation.generation)status='paused';
     else{const result=await this.#save(Object.freeze({scopeKey:operation.scopeKey,generation:operation.generation,isCurrent:()=>this.#currentOperation(operation)}));status=result&&typeof result==='object'&&outcomes.has(result.status)?result.status:'unknown';}
    }
    catch(error){status=rejection(error);}
    this.#update();const current=this.#currentOperation(operation);
    if(status==='saved'&&(!current||this.#current.generation===operation.generation&&this.#current.dirty))status='unknown';
    if(['conflict','unknown','rejected'].includes(status))this.#blocked.set(operation.scopeKey,status);
    if(status==='paused'&&current)this.#held=true;
    return Object.freeze({status,scopeKey:operation.scopeKey,generation:operation.generation});
   }finally{
    if(this.#inFlight===operation)this.#inFlight=null;
    if(!this.#stopped){this.#update();this.#arm();this.#emit();}
   }
  })();
  return operation.promise;
 }
 /** Call after an editor edit; generation changes establish the debounce and maximum-wait clocks. */
 notify(){if(this.#stopped)return this.snapshot();this.#held=false;this.#update();this.#arm();return this.#emit();}
 /** Recheck IME, room, modal, loading and other caller-owned pause conditions. */
 refresh(){return this.notify();}
 /** Wait for an older save, then flush at most one current dirty generation. */
 async flush(){
  if(this.#stopped)return{status:'paused'};
  this.#update();const marker={scopeKey:this.#current.scopeKey,epoch:this.#epoch};
  if(this.#inFlight)await this.#inFlight.promise;
  if(this.#stopped||this.#epoch!==marker.epoch||this.#current.scopeKey!==marker.scopeKey)return{status:'paused'};
  return this.#run(true);
 }
 /** Only after an explicit fresh read/rebase. Never use reset as a retry of an uncertain write. */
 reset(){
  if(this.#stopped)return this.snapshot();this.#epoch++;this.#clear();this.#seen=null;this.#first=null;this.#last=null;this.#held=false;
  const value=this.#update();if(value?.scopeKey)this.#blocked.delete(value.scopeKey);this.#arm();return this.#emit();
 }
 /** Terminal: sent requests are not aborted or assumed uncommitted; late UI adoption is fenced. */
 stop(){if(!this.#stopped){this.#stopped=true;this.#epoch++;this.#clear();}return this.#emit();}
}
