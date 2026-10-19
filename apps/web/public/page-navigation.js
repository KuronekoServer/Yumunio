const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const stale=()=>new DOMException('The page read is no longer current.','AbortError');
export function workspacePageTarget(href,{origin,workspaceId}){
 try{const url=new URL(href,origin);if(url.origin!==origin||url.pathname!=='/workspace'||url.searchParams.get('workspace')!==workspaceId)return null;
  const pageId=url.searchParams.get('page');if(!id(pageId))return null;const viewId=url.searchParams.get('view');if(viewId&&!id(viewId))return null;
  return{pageId,viewId:viewId||null,hash:url.hash};
 }catch{return null;}
}
/** In-memory, account-scoped reading previews. Every navigation still awaits an authorized read. */
export class PageReadPool{
 constructor({scope,read,validate,now=Date.now,maxEntries=6,maxBytes=2*1024*1024,ttl=30000}){Object.assign(this,{scope,read,validate,now,maxEntries,maxBytes,ttl});this.epoch=0;this.owner=null;this.cache=new Map();this.pending=new Map();}
 check(){const owner=this.scope();if(owner!==this.owner){this.clear();this.owner=owner;}return owner;}
 clear(){this.epoch++;for(const item of this.pending.values())item.controller.abort();this.pending.clear();this.cache.clear();}
 remember(pageId,value){if(!this.check())return;this.validate(value,pageId);const bytes=JSON.stringify(value).length*2;if(bytes>this.maxBytes)return;this.cache.delete(pageId);this.cache.set(pageId,{value:structuredClone(value),time:this.now(),bytes});let total=[...this.cache.values()].reduce((sum,item)=>sum+item.bytes,0);while(this.cache.size>this.maxEntries||total>this.maxBytes){const key=this.cache.keys().next().value;total-=this.cache.get(key).bytes;this.cache.delete(key);}}
 preview(pageId){if(!this.check())return null;const item=this.cache.get(pageId);if(!item||this.now()-item.time>this.ttl){this.cache.delete(pageId);return null;}this.cache.delete(pageId);this.cache.set(pageId,item);return structuredClone(item.value);}
 async load(pageId,{signal,prefetch=false}={}){
  if(!id(pageId))throw new TypeError('INVALID_PAGE_ID');const owner=this.check(),epoch=this.epoch;if(!owner)throw stale();signal?.throwIfAborted();
  let task=this.pending.get(pageId);
  if(!task){
   if(prefetch&&this.pending.size>=2)return null;
   const controller=new AbortController();task={controller,promise:null};this.pending.set(pageId,task);
   task.promise=(async()=>{
    try{const value=this.validate(await this.read(pageId,{signal:controller.signal}),pageId);if(this.check()!==owner||this.epoch!==epoch)throw stale();
     this.remember(pageId,value);
     return value;
    }finally{if(this.pending.get(pageId)===task)this.pending.delete(pageId);}
   })();
  }
  let abort;try{return await Promise.race([task.promise,...(signal?[new Promise((_,reject)=>{abort=()=>reject(signal.reason??stale());signal.addEventListener('abort',abort,{once:true});})]:[])]);}finally{if(abort)signal.removeEventListener('abort',abort);}
 }
}
export function matchingPageTitles(pages,query,{limit=12}={}){
 const needle=query.trim().normalize('NFKC').toLocaleLowerCase();
 return pages.filter(page=>!needle||page.title.normalize('NFKC').toLocaleLowerCase().includes(needle)).slice(0,limit).map(page=>({page,snippet:''}));
}
