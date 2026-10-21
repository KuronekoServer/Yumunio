import {surfaceTransition} from './ui-motion-policy.js';

/** Animate connected chrome without reconciling the editor's browsing context. */
export function createAnimatedRecordSurface({surface,animate,getReducedMotion,onDestroy}){
 let control=null,closed=false,exiting=null,resolveExit=null;
 const stop=()=>{control?.stop();control=null;};
 function remove(){if(closed)return;closed=true;stop();surface.destroy();onDestroy?.();resolveExit?.();resolveExit=null;}
 const play=keyframes=>{const next=animate(surface.host,keyframes,surfaceTransition('panel',getReducedMotion()));control=next;return next;};
 play({x:[getReducedMotion()?0:'100%',0]});
 return{
  get host(){return surface.host;},get frame(){return surface.frame;},get exit(){return surface.exit;},get full(){return surface.full;},get status(){return surface.status;},
  setStatus:(...args)=>surface.setStatus(...args),retryFrame:()=>surface.retryFrame(),
  close(){
   if(closed)return Promise.resolve();if(exiting)return exiting;
   surface.host.inert=true;stop();
   exiting=new Promise(resolve=>{resolveExit=resolve;const next=play({x:getReducedMotion()?0:'100%'});Promise.resolve(next).then(()=>{if(control===next)remove();});});return exiting;
  },
  reduce(){if(closed||!getReducedMotion())return;if(exiting){remove();return;}stop();play({x:0});},
  destroy:remove
 };
}
