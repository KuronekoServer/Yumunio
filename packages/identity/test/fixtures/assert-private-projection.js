import assert from 'node:assert/strict';

/** Compare parsed JSON keys and literal leaves; UUID/numeric substrings are not values. */
export function assertNoPrivateJsonLiterals(projection, privateLiterals) {
 const forbidden=new Set(privateLiterals),pending=[{value:projection,path:'$'}];
 for(let index=0;index<pending.length;index++){
  const{value,path}=pending[index];
  if(value!==null&&typeof value==='object'){
   for(const[key,child]of Object.entries(value)){
    if(!Array.isArray(value))assert.equal(forbidden.has(key),false,'Private JSON key exposed at '+path+'.'+key);
    pending.push({value:child,path:path+'['+JSON.stringify(key)+']'});
   }
  }else assert.equal(forbidden.has(value),false,'Private JSON literal exposed at '+path+': '+JSON.stringify(value));
 }
}
