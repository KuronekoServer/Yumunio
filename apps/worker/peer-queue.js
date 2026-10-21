/** Keep a connection's frame order without serializing unrelated editors.
 * Durable content CAS remains the authority for concurrent page updates. */
export class PeerRequestQueue{
 #tails=new WeakMap();
 async run(peer,task){
  const result=(this.#tails.get(peer)??Promise.resolve()).catch(()=>{}).then(task);this.#tails.set(peer,result);
  try{return await result;}finally{if(this.#tails.get(peer)===result)this.#tails.delete(peer);}
 }
}
