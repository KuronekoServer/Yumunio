import {nextBoardKeyboardTarget} from './board-keyboard.js';
let sequence=0;
const pointInRect=(point,rect)=>!!point&&!!rect&&['x','y'].every(key=>Number.isFinite(point[key]))&&['left','top','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0&&point.x>=rect.left&&point.x<=rect.left+rect.width&&point.y>=rect.top&&point.y<=rect.top+rect.height;
/** Cards and their keyboard handles share one sensor. Only a validated drop changes data. */
export function createBoardDnd({root,getScope,canMove,canDrop,onCommit,labels,keyboardOffset,loadToolkit=()=>import('./shared/dnd-kit.js')}){
 const doc=root.ownerDocument,win=doc.defaultView,bindings=[],cleanups=[],created=[];
 let destroyed=false,manager,context=null,pending=null,overlay=null,frame=null,dropTimer=null,suppressUntil=0,registeredTargets=null;
 const label=(key,values={})=>typeof labels==='function'?labels(key,values):key;
 const announce=message=>{if(!destroyed)status.textContent=message;};
 const addMessage=(attribute,text)=>{let node=root.querySelector('['+attribute+']');if(!node){node=doc.createElement('p');node.className='board-dnd-status';node.setAttribute(attribute,'');root.append(node);created.push(node);}node.textContent=text;return node;};
 const instructions=addMessage('data-board-dnd-instructions',label('instructions'));if(!instructions.id)instructions.id='board-dnd-instructions-'+(++sequence);
 const status=addMessage('data-board-dnd-status','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
 const scopeNow=()=>{try{return getScope();}catch{return null;}};
 const allowed=id=>{try{return!destroyed&&root.isConnected&&scopeNow()!==null&&canMove(id)===true;}catch{return false;}};
 const canTarget=(id,key)=>{try{return canDrop(id,key)===true;}catch{return false;}};
 const sameScope=scope=>!destroyed&&root.isConnected&&Object.is(scope,scopeNow());
 const clearTargets=()=>{for(const target of root.querySelectorAll('[data-board-drop]')){delete target.dataset.boardDrop;delete target.dataset.dropLabel;}};
 const clearVisuals=()=>{clearTargets();overlay?.remove();overlay=null;root.classList.remove('board-dragging');for(const card of root.querySelectorAll('.is-board-drag-source'))card.classList.remove('is-board-drag-source');for(const handle of root.querySelectorAll('[data-board-dnd-handle][aria-pressed="true"]'))handle.setAttribute('aria-pressed','false');};
 const end=()=>{if(frame!==null){win.cancelAnimationFrame(frame);frame=null;}const previous=context;context=null;pending=null;clearVisuals();if(previous)suppressUntil=Date.now()+200;return previous;};
 const restoreFocus=previous=>{if(!previous)return;win.requestAnimationFrame(()=>{if(!sameScope(previous.scope)||!doc.hasFocus()||doc.querySelector('dialog[open]'))return;[...root.querySelectorAll('[data-board-dnd-card]')].find(card=>card.dataset.boardDndCard===previous.recordId)?.querySelector('[data-board-dnd-handle]')?.focus({preventScroll:true});});};
 const cancel=()=>{if(dropTimer!==null){win.clearTimeout(dropTimer);dropTimer=null;}const previous=context;pending=null;if(previous){manager?.actions.stop({canceled:true});end();announce(label('canceled'));restoreFocus(previous);}};
 const listen=(target,name,handler,options)=>{target.addEventListener(name,handler,options);cleanups.push(()=>target.removeEventListener(name,handler,options));};
 listen(doc,'click',event=>{if((context||Date.now()<suppressUntil)&&root.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}},true);
 // Register before the SDK's active keyboard listener. Keep Space/Enter/Escape in the SDK.
 listen(doc,'keydown',event=>{
  if(!context?.keyboard||keyboardOffset!==undefined&&keyboardOffset!==null)return;
  if(event.isComposing||event.keyCode===229){cancel();return;}
  const direction=({ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'})[event.key];if(!direction)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  if(!sameScope(context.scope)||!allowed(context.recordId)){cancel();return;}
  const source=context.card;if(!source?.isConnected){cancel();return;}
  const raw=[...root.querySelectorAll('[data-board-dnd-target]')].filter(element=>registeredTargets?.has(element)),declared=[...root.querySelectorAll('[data-board-dnd-column]')];
  const ancestorColumn=element=>{for(let node=element;node&&node!==root;node=node.parentElement||node.parentNode)if(Object.hasOwn(node.dataset??{},'boardDndColumn'))return node;return raw.find(target=>target===element||target.contains(element))??element;};
  const columnNodes=[...new Set([...declared,...raw.map(ancestorColumn)])].filter(element=>displayed(element));
  const columns=columnNodes.map((element,index)=>({id:element,rect:element.getBoundingClientRect(),order:index}));
  const targets=raw.filter(element=>displayed(element)&&canTarget(context.recordId,element.dataset.boardDndTarget)).map((element,index)=>({key:element.dataset.boardDndTarget,column:ancestorColumn(element),rect:element.getBoundingClientRect(),order:index,element}));
  const sourceColumn=declared.find(column=>column.contains(source))??raw.find(target=>target.contains(source));
  const next=nextBoardKeyboardTarget({columns,targets,sourceColumn,sourceRect:source.getBoundingClientRect(),currentKey:context.keyboardTarget?.key??null,direction,rtl:win.getComputedStyle?.(root).direction==='rtl'});
  if(!next){announce(label('invalid'));return;}
  next.element.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
  const point=visibleCenter(next.element);if(!point||!sameScope(context.scope)||!allowed(context.recordId)||!canTarget(context.recordId,next.key)){announce(label('invalid'));return;}
  context.keyboardTarget={key:next.key,element:next.element};manager.actions.move({to:point,event});
 },true);
 listen(doc,'compositionstart',()=>{if(context?.keyboard)cancel();},true);
 listen(win,'blur',cancel);listen(win,'resize',cancel);listen(win,'pagehide',cancel);listen(doc,'visibilitychange',()=>{if(doc.hidden)cancel();});
 function project(operation){
  if(!context||!sameScope(context.scope)||!allowed(context.recordId))return null;
  const target=operation.target,key=context.keyboardTarget?.key??target?.data?.targetKey,element=context.keyboardTarget?.element??target?.element;
  if(typeof key!=='string'||!element?.isConnected||!root.contains(element)||!pointInRect(operation.position?.current,element.getBoundingClientRect())||!canTarget(context.recordId,key))return null;
  if(context.keyboardTarget&&!pointInRect(operation.position?.current,visibleRect(element)))return null;
  return{recordId:context.recordId,targetKey:key,element};
 }
 function displayed(element){
  if(!element?.isConnected||!root.contains(element))return false;
  for(let node=element;node&&node!==doc;node=node.parentElement||node.parentNode){const style=win.getComputedStyle?.(node);if(node.hidden||node.inert||node.getAttribute?.('aria-hidden')==='true'||style?.display==='none'||['hidden','collapse'].includes(style?.visibility))return false;}
  const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0;
 }
 function visibleRect(element){
  if(!displayed(element))return null;const rect=element.getBoundingClientRect();let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(win.innerWidth,rect.left+rect.width),bottom=Math.min(win.innerHeight,rect.top+rect.height);
  for(let node=element.parentElement||element.parentNode;node&&node!==doc;node=node.parentElement||node.parentNode){const style=win.getComputedStyle?.(node),clip=node.getBoundingClientRect?.();if(!clip)continue;if(/^(auto|scroll|hidden|clip)$/.test(style?.overflowX??style?.overflow??'')){left=Math.max(left,clip.left);right=Math.min(right,clip.left+clip.width);}if(/^(auto|scroll|hidden|clip)$/.test(style?.overflowY??style?.overflow??'')){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.top+clip.height);}}
  return right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;
 }
 function visibleCenter(element){const rect=visibleRect(element);return rect?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null;}
 function preview(operation){
  if(!context)return;if(!sameScope(context.scope)||!allowed(context.recordId)){cancel();return;}
  clearTargets();const projected=project(operation),point=operation.position?.current;
  if(overlay&&point&&Number.isFinite(point.x)&&Number.isFinite(point.y)){const width=overlay.getBoundingClientRect().width||260;overlay.style.transform='translate3d('+Math.max(8,Math.min(win.innerWidth-width-8,point.x+16))+'px,'+Math.max(8,Math.min(win.innerHeight-72,point.y+16))+'px,0)';overlay.dataset.valid=String(!!projected);}
  if(projected){projected.element.dataset.boardDrop='active';const target=projected.element.dataset.boardDndLabel||projected.element.querySelector('h2,h3,summary')?.textContent||'';projected.element.dataset.dropLabel=target;announce(label('target',{text:context.text,target}));}else announce(label('invalid'));
 }
 const ready=Promise.resolve().then(loadToolkit).then(kit=>{
  if(destroyed||!root.isConnected)return;
  const {DragDropManager,Draggable,Droppable,PointerSensor,PointerActivationConstraints,KeyboardSensor,Feedback,Accessibility,DOMRectangle}=kit;
  // A programmatic stop (resize/blur/policy loss) bypasses KeyboardSensor.handleEnd.
  // Clean its active document listener on every end, without changing SDK internals.
  class BoardKeyboardSensor extends KeyboardSensor{
   constructor(manager,options){super(manager,options);this.releaseBoardEnd=manager.monitor.addEventListener('dragend',()=>this.cleanup());}
   destroy(){this.releaseBoardEnd?.();this.releaseBoardEnd=null;super.destroy();}
  }
  const targetNodes=[...root.querySelectorAll('[data-board-dnd-target]')],offset=keyboardOffset??{x:280,y:24};
  registeredTargets=new Set(targetNodes);
  const refreshKeyboardOffset=()=>{
    if(keyboardOffset!==undefined&&keyboardOffset!==null)return;
    const columns=[...root.querySelectorAll('[data-board-dnd-column]')],rects=(columns.length?columns:targetNodes).filter(node=>node.isConnected).map(node=>node.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0),span=rects.length>1?Math.abs(rects[1].left-rects[0].left):0;
    offset.x=span||280;
  };
  refreshKeyboardOffset();
  const keyboardHandle=source=>source.element.querySelector('[data-board-dnd-handle]');
  manager=new DragDropManager({plugins:defaults=>defaults.filter(plugin=>plugin!==Accessibility),sensors:[PointerSensor.configure({
   preventActivation:(event,source)=>{const target=event.target;if(event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.button>0)return true;if(target===source.element||target===keyboardHandle(source)||target.closest?.('[data-card-open],[data-board-dnd-handle]'))return false;return!!target.closest?.('button,a,input,select,textarea,summary,[contenteditable],[data-card-actions]');},
   activationConstraints:event=>event.pointerType==='touch'?[new PointerActivationConstraints.Delay({value:250,tolerance:6})]:[new PointerActivationConstraints.Distance({value:5})]
  }),{plugin:BoardKeyboardSensor,options:{offset,keyboardCodes:{start:['Space'],end:['Space','Enter'],cancel:['Escape'],up:['ArrowUp'],down:['ArrowDown'],left:['ArrowLeft'],right:['ArrowRight']},preventActivation:(event,source)=>![source.element,keyboardHandle(source)].includes(event.target)||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||false}}]});
  const observe=(name,handler)=>cleanups.push(manager.monitor.addEventListener(name,handler));
  observe('beforedragstart',event=>{const source=event.operation.source,recordId=source?.data?.recordId,activator=event.operation.activatorEvent;pending=null;if(!allowed(recordId)||context||activator?.isComposing||activator?.keyCode===229){event.preventDefault();return;}refreshKeyboardOffset();const text=Array.from(source.element.dataset.boardDndTitle||source.element.dataset.boardDndLabel||source.handle.getAttribute('aria-label')||label('handle',{text:''})).slice(0,120).join('');pending={recordId,scope:scopeNow(),text,card:source.element,keyboard:activator?.type==='keydown'};});
  observe('dragstart',event=>{if(!pending||!sameScope(pending.scope)||!allowed(pending.recordId)){manager.actions.stop({canceled:true});return;}context=pending;pending=null;const card=event.operation.source.element;context.shape=new DOMRectangle(card);context.origin={...event.operation.position.current};manager.dragOperation.shape=context.shape;card.classList.add('is-board-drag-source');root.classList.add('board-dragging');keyboardHandle(event.operation.source)?.setAttribute('aria-pressed','true');overlay=doc.createElement('div');overlay.className='board-dnd-overlay';overlay.setAttribute('aria-hidden','true');overlay.inert=true;overlay.textContent=context.text;doc.body.append(overlay);announce(label('started',{text:context.text}));for(const binding of bindings)if(typeof binding.refreshShape==='function')binding.refreshShape();manager.collisionObserver.forceUpdate();preview(event.operation);});
  observe('dragmove',event=>{if(!context)return;const current=event.operation.position.current,point=event.to||{x:current.x+(event.by?.x||0),y:current.y+(event.by?.y||0)};manager.dragOperation.shape=context.shape.translate(point.x-context.origin.x,point.y-context.origin.y);if(frame!==null)win.cancelAnimationFrame(frame);frame=win.requestAnimationFrame(()=>{frame=null;if(context&&!destroyed){manager.collisionObserver.forceUpdate();preview(manager.dragOperation.snapshot());}});});
  observe('dragover',event=>preview(event.operation));
  observe('dragend',event=>{if(!context){pending=null;return;}const projected=event.canceled||event.operation.canceled?null:project(event.operation),previous=end();if(!projected||destroyed){announce(label('canceled'));restoreFocus(previous);return;}dropTimer=win.setTimeout(()=>{dropTimer=null;if(!sameScope(previous.scope)||!allowed(previous.recordId)||!projected.element.isConnected||!canTarget(previous.recordId,projected.targetKey)||previous.keyboardTarget&&!visibleRect(projected.element))return;try{const result=onCommit({recordId:previous.recordId,targetKey:projected.targetKey});if(result===false){announce(label('canceled'));restoreFocus(previous);}else if(result&&typeof result.then==='function'){Promise.resolve(result).then(confirmed=>{if(!sameScope(previous.scope))return;if(confirmed===true)announce(label('moved',{text:previous.text}));else if(confirmed===false){announce(label('canceled'));restoreFocus(previous);}},()=>{if(sameScope(previous.scope))announce(label('unavailable'));});}else announce(label('moved',{text:previous.text}));}catch{announce(label('unavailable'));restoreFocus(previous);}},0);});
  const ids=new Set();for(const card of root.querySelectorAll('[data-board-dnd-card]')){const recordId=card.dataset.boardDndCard,handle=card.querySelector('[data-board-dnd-handle]');if(!recordId||ids.has(recordId)||!handle||handle.disabled)continue;ids.add(recordId);handle.setAttribute('aria-pressed','false');handle.setAttribute('aria-describedby',instructions.id);card.setAttribute('aria-describedby',instructions.id);card.dataset.boardDraggable='true';bindings.push(new Draggable({id:'board-card:'+recordId,type:'board-card',data:{recordId},element:card,handle:card,plugins:[Feedback.configure({feedback:'none',dropAnimation:null})]},manager));}
  for(const element of targetNodes){const targetKey=element.dataset.boardDndTarget;bindings.push(new Droppable({id:'board-target:'+bindings.length,element,data:{targetKey},accept:source=>{const drag=context||pending;return!!drag&&sameScope(drag.scope)&&source.data.recordId===drag.recordId&&allowed(drag.recordId)&&canTarget(drag.recordId,targetKey);}},manager));}
  root.dataset.boardDnd='ready';
 }).catch(()=>{if(destroyed)return;cancel();for(const binding of bindings.splice(0))binding.destroy();manager?.destroy();for(const cleanup of cleanups.splice(0))if(typeof cleanup==='function')cleanup();root.dataset.boardDnd='unavailable';announce(label('unavailable'));});
 return Object.freeze({ready,get active(){return!!context;},cancel,destroy(){if(destroyed)return;cancel();destroyed=true;end();for(const cleanup of cleanups.splice(0))if(typeof cleanup==='function')cleanup();for(const binding of bindings.splice(0))binding.destroy();manager?.destroy();for(const node of created)node.remove();for(const card of root.querySelectorAll('[data-board-draggable]')){delete card.dataset.boardDraggable;card.removeAttribute('aria-describedby');}delete root.dataset.boardDnd;}});
}
