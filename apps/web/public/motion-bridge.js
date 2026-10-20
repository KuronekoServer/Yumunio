export const MOTION_SURFACE_EVENT='yumunio:motion-surface';
/** The React host owns animated chrome. Editor controllers retain their own DOM and save lifecycle. */
export function requestMotionSurface(type,model,view=globalThis.window){
 if(!view?.dispatchEvent)return null;const EventClass=view.CustomEvent??globalThis.CustomEvent;if(typeof EventClass!=='function')return null;
 const detail={type,model,result:null};view.dispatchEvent(new EventClass(MOTION_SURFACE_EVENT,{detail}));return detail.result;
}
