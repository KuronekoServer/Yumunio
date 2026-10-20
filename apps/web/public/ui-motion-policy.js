export const UI_MOTION=Object.freeze({menu:0.12,panel:0.2,sidebar:0.2,modal:0.16,placement:0.16,ease:Object.freeze([0.2,0,0.2,1])});
export function surfaceTransition(kind,reduced=false){return{type:'tween',duration:reduced?0:(UI_MOTION[kind]??UI_MOTION.menu),ease:[...UI_MOTION.ease]};}
export function observeReducedMotion(view,changed){const media=view.matchMedia('(prefers-reduced-motion: reduce)'),update=()=>changed(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);}
export function captureBlockPositions(root){
 const positions=new Map();for(const row of root?.querySelectorAll('.block-row[data-block-id]')??[]){const rect=row.getBoundingClientRect?.();if(rect&&rect.width>0&&rect.height>0)positions.set(row.dataset.blockId,{left:rect.left,top:rect.top});}return positions;
}
export function blockPlacementChanges(root,before){
 const changes=[];for(const row of root?.querySelectorAll('.block-row[data-block-id]')??[]){const old=before.get(row.dataset.blockId),rect=row.getBoundingClientRect?.();if(!old||!rect)continue;const x=old.left-rect.left,y=old.top-rect.top;if(Math.abs(x)+Math.abs(y)>1)changes.push({element:row,x,y});}
 return changes.filter(change=>!changes.some(parent=>parent!==change&&parent.element.contains(change.element))).slice(0,60);
}
