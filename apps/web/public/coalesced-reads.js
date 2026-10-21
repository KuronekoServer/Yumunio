/** Shares only concurrent reads, never an authorization result across time.
 * Each caller owns cancellation; abandoning one placement must not abort others. */
export class CoalescedReads{
 constructor(){this.pending=new Map();this.epoch=0;}
 clear(){this.epoch++;this.pending.clear();}
 async run(key,read,{signal}={}){
  signal?.throwIfAborted();const scoped=this.epoch+':'+key;
  let task=this.pending.get(scoped);
  if(!task){task=Promise.resolve().then(read).finally(()=>{if(this.pending.get(scoped)===task)this.pending.delete(scoped);});this.pending.set(scoped,task);}
  let abort;
  try{const value=await Promise.race([task,...(signal?[new Promise((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});})]:[])]);signal?.throwIfAborted();return structuredClone(value);}
  finally{if(abort)signal.removeEventListener('abort',abort);}
 }
}
