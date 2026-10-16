import {createEditorMovePlanner,createEditorMultiMovePlanner,normalizeEditorBlockSelection,indexEditorBlocks,editorDropPlacement} from './editor-tree.js';

const pointInRect=(point,rect)=>!!point&&!!rect&&['x','y'].every(key=>Number.isFinite(point[key]))&&
  ['left','top','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0&&
  point.x>=rect.left&&point.x<=rect.left+rect.width&&point.y>=rect.top&&point.y<=rect.top+rect.height;

function projector(blocks,blockId,{allowInside=true,blockIds}={}){
  const locations=indexEditorBlocks(blocks),source=locations.get(blockId),selected=blockIds===undefined?undefined:normalizeEditorBlockSelection(blocks,blockIds);
  const plan=selected?createEditorMultiMovePlanner(blocks,selected):createEditorMovePlanner(blocks);
  if(selected&&source&&!selected.some(id=>id===blockId||source.ancestors.some(parent=>parent.id===id)))return()=>null;
  if(!source)return()=>null;
  return({targetId=null,placement,rect,point})=>{
    try{
      if(!placement){
        if(targetId===null)placement='end';
        else{
          if(!pointInRect(point,rect))return null;
          let canNest=false;try{if(allowInside){plan({blockId,targetId,placement:'inside'});canNest=true;}}catch{}
          placement=editorDropPlacement({offset:point.y-rect.top,height:rect.height,canNest});
        }
      }
      if(placement==='inside'&&!allowInside)return null;
      const operation={blockId,...(selected?{blockIds:[...selected]}:{}),targetId,placement},destination=plan(operation);
      if(selected){if(!destination.changed)return null;}else{const index=destination.index-(destination.parentId===source.parentId&&destination.index>source.index?1:0);
      if(destination.parentId===source.parentId&&index===source.index)return null;}
      return operation;
    }catch{return null;}
  };
}
/** Pure projection; the tree and its metadata are never mutated during a drag. */
export function projectBlockDrop({blocks,blockId,blockIds,allowInside=true,...target}){
  try{return projector(blocks,blockId,{allowInside,blockIds})(target);}catch{return null;}
}
/** Recheck the latest document before committing, including positional no-ops. */
export function validateBlockDrop({blocks,blockId,blockIds,targetId=null,placement,allowInside=true}){
  if(!placement)return null;
  return projectBlockDrop({blocks,blockId,blockIds,targetId,placement,allowInside});
}

/** A handle-only dnd-kit controller. Text editors stay in place until a validated drop. */
export function createBlockDnd({root,canStart,getScope,getBlocks,getBlockIds,onCommit,onCrossPage,canDropOnPage=()=>true,onActiveChange=()=>{},labels,allowInside=true,allowMultiPageTransfer=false,
  loadToolkit=()=>import('./shared/dnd-kit.js')}){
  const doc=root.ownerDocument,win=doc.defaultView;
  let destroyed=false,manager,context=null,pending=null,overlay=null,dropTimer=null,previewFrame=null,suppressUntil=0;
  const bindings=[],dropBindings=[],cleanups=[];
  const label=(key,values={})=>typeof labels==='function'?labels(key,values):key;
  const status=message=>{const node=root.querySelector('#block-dnd-status');if(node)node.textContent=message;};
  const allowed=id=>!destroyed&&root.isConnected&&getScope()!==null&&canStart(id);
  const pageAllowed=(drag,pageId)=>{
    if(!drag||drag.blockIds?.length>1&&!allowMultiPageTransfer)return false;
    try{
      if(allowMultiPageTransfer){
        const requested=getBlockIds?.(drag.blockId),current=normalizeEditorBlockSelection(getBlocks(),requested===undefined?[drag.blockId]:requested),captured=drag.blockIds||[drag.blockId];
        if(current.length!==captured.length||current.some((id,index)=>id!==captured[index]))return false;
      }
      return canDropOnPage({blockId:drag.blockIds?.[0]||drag.blockId,blockIds:drag.blockIds?[...drag.blockIds]:undefined,pageId})===true;
    }catch{return false;}
  };
  const sameScope=()=>context&&Object.is(context.scope,getScope());
  const clearTargets=()=>{for(const node of root.querySelectorAll('[data-block-drop]')){delete node.dataset.blockDrop;delete node.dataset.dropLabel;}};
  const removeVisuals=()=>{
    clearTargets();overlay?.remove();overlay=null;root.classList.remove('block-dragging');
    for(const row of root.querySelectorAll('.is-block-drag-source'))row.classList.remove('is-block-drag-source');
    for(const handle of root.querySelectorAll('[data-block-drag-handle][aria-pressed="true"]'))handle.setAttribute('aria-pressed','false');
  };
  const restoreFocus=(blockId,scope)=>win.requestAnimationFrame(()=>{
    if(destroyed||!Object.is(scope,getScope())||!doc.hasFocus()||doc.querySelector('dialog[open]'))return;
    const row=[...root.querySelectorAll('.block-row[data-block-id]')].find(node=>node.dataset.blockId===blockId);
    row?.querySelector('[data-block-drag-handle]')?.focus({preventScroll:true});
  });
  const endVisuals=()=>{
    if(previewFrame!==null){win.cancelAnimationFrame(previewFrame);previewFrame=null;}
    const previous=context;context=null;pending=null;removeVisuals();
    if(previous){suppressUntil=Date.now()+200;onActiveChange(false,previous.blockId);}
    return previous;
  };
  const cancel=()=>{
    if(dropTimer!==null){win.clearTimeout(dropTimer);dropTimer=null;}
    pending=null;
    if(context){
      manager?.actions.stop({canceled:true});
      const previous=endVisuals();
      if(previous){status(label('canceled'));restoreFocus(previous.blockId,previous.scope);}
    }
  };
  const listen=(target,name,handler,options)=>{target.addEventListener(name,handler,options);cleanups.push(()=>target.removeEventListener(name,handler,options));};
  listen(doc,'click',event=>{
    if((context||Date.now()<suppressUntil)&&root.contains(event.target)){
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  listen(win,'resize',cancel);
  listen(win,'blur',cancel);
  listen(win,'pagehide',cancel);
  listen(doc,'visibilitychange',()=>{if(doc.hidden)cancel();});
  function targetOperation(operation,{latest=false}={}){
    if(!sameScope()||!allowed(context.blockId))return null;
    const target=operation.target,data=target?.data,point=operation.position?.current;
    if(!target?.element?.isConnected||!pointInRect(point,target.element.getBoundingClientRect()))return null;
    if(data?.kind==='page')return pageAllowed(context,data.pageId)?{kind:'page',blockId:context.blockIds?.[0]||context.blockId,...(allowMultiPageTransfer?{blockIds:[...(context.blockIds||[context.blockId])]}:{}),pageId:data.pageId,element:target.element}:null;
    if(!['block','end'].includes(data?.kind))return null;
    const input={targetId:data.kind==='end'?null:data.blockId,point,rect:target.element.getBoundingClientRect(),...(data.kind==='end'?{placement:'end'}:{})};
    const result=latest?projectBlockDrop({blocks:getBlocks(),blockId:context.blockId,blockIds:context.blockIds,allowInside,...input}):context.project(input);
    return result?{kind:'block',operation:result,element:target.element}:null;
  }
  function releaseOperation(event){
    if(event.canceled||event.operation.canceled)return null;
    const native=event.nativeEvent;
    if(native?.type==='pointerup'){
      // PointerSensor queues its last move for a frame, then clears it on up.
      // Hit-test the actual release instead of reusing a possibly older snapshot.
      const point={x:native.clientX,y:native.clientY},surface=root.getRootNode?.()||doc;
      if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||native.view&&native.view!==win||native.target?.ownerDocument&&native.target.ownerDocument!==doc||doc.querySelector('dialog[open]')||typeof surface.elementFromPoint!=='function')return null;
      let hit;try{hit=surface.elementFromPoint(point.x,point.y);}catch{return null;}
      if(!hit||hit.ownerDocument!==doc||!root.contains(hit)||hit.shadowRoot||hit.localName?.includes('-'))return null;
      for(let node=hit;node;node=node.parentElement||node.getRootNode?.()?.host||null)if(node.inert)return null;
      let target;
      for(let node=hit;node;node=node.parentElement){
        target=dropBindings.find(binding=>binding.element===node);
        if(target||node===root)break;
      }
      // An invalid nearest registered target never falls through to an ancestor.
      if(!target||target.disabled||target.element.disabled)return null;
      try{if(!target.accepts(event.operation.source))return null;}catch{return null;}
      return targetOperation({...event.operation,target,position:{current:point}},{latest:true});
    }
    if(native?.type?.startsWith('pointer')||event.operation.activatorEvent?.type?.startsWith('pointer'))return null;
    return targetOperation(event.operation,{latest:true});
  }
  function preview(operation){
    if(!context)return;
    if(!sameScope()||!allowed(context.blockId)){cancel();return;}
    clearTargets();const projected=targetOperation(operation),point=operation.position?.current;
    if(overlay&&point&&Number.isFinite(point.x)&&Number.isFinite(point.y)){
      const width=overlay.getBoundingClientRect().width||280;
      const x=Math.max(8,Math.min(win.innerWidth-width-8,point.x+16));
      const y=Math.max(8,Math.min(win.innerHeight-72,point.y+16));
      overlay.style.transform=`translate3d(${x}px,${y}px,0)`;
      overlay.dataset.valid=String(!!projected);
    }
    let message=label('invalid');
    if(projected){
      const placement=projected.kind==='page'?'page':projected.operation.placement;
      projected.element.dataset.blockDrop=placement;
      projected.element.dataset.dropLabel=label(placement);
      const text=projected.kind==='page'?projected.element.textContent.trim():projected.kind==='block'&&projected.operation.targetId?context.texts.get(projected.operation.targetId):label('end');
      message=label(projected.kind==='page'?'page':'target',{text:context.text,target:text,placement:label(placement)});
    }
    status(message);
  }
  const ready=Promise.resolve().then(loadToolkit).then(kit=>{
    if(destroyed||!root.isConnected)return;
    const {DragDropManager,Draggable,Droppable,PointerSensor,PointerActivationConstraints,KeyboardSensor,Feedback,Accessibility,DOMRectangle}=kit;
    manager=new DragDropManager({
      // Keep scrolling/cursor/selection plugins. Our one translated live region owns announcements.
      plugins:defaults=>defaults.filter(plugin=>plugin!==Accessibility),
      sensors:[
        PointerSensor.configure({activationConstraints:event=>event.pointerType==='touch'?
          [new PointerActivationConstraints.Delay({value:250,tolerance:6})]:[new PointerActivationConstraints.Distance({value:5})]}),
        KeyboardSensor.configure({offset:{x:24,y:16},keyboardCodes:{start:['Space'],end:['Space','Enter'],cancel:['Escape'],up:['ArrowUp'],down:['ArrowDown'],left:['ArrowLeft'],right:['ArrowRight']},
          preventActivation:(event,source)=>event.target!==source.handle||event.isComposing||event.keyCode===229})
      ]
    });
    const observe=(name,handler)=>cleanups.push(manager.monitor.addEventListener(name,handler));
    observe('beforedragstart',event=>{
      const blockId=event.operation.source?.data?.blockId;
      const activator=event.operation.activatorEvent;
      if(!allowed(blockId)||context||activator?.isComposing||activator?.keyCode===229){event.preventDefault();return;}
      try{
        const blocks=getBlocks(),locations=indexEditorBlocks(blocks);
        const requested=getBlockIds?.(blockId),blockIds=requested===undefined?undefined:normalizeEditorBlockSelection(blocks,requested);
        if(blockIds&&!blockIds.some(id=>id===blockId||locations.get(blockId)?.ancestors.some(parent=>parent.id===id))){event.preventDefault();return;}
        const project=projector(blocks,blockId,{allowInside,blockIds}),texts=new Map([...locations].map(([id,{block}])=>[id,Array.from(block.data?.text||label('handle')).slice(0,90).join('')]));
        const forest=blockIds||[blockId];
        pending={blockId,blockIds,scope:getScope(),project,texts,text:forest.length>1?label('selection',{count:forest.length}):texts.get(forest[0])||label('handle'),count:[...locations.values()].filter(item=>item.ancestors.some(parent=>forest.includes(parent.id))).length};
      }catch{pending=null;event.preventDefault();}
    });
    observe('dragstart',event=>{
      if(!pending||!Object.is(pending.scope,getScope())||!allowed(pending.blockId)){manager.actions.stop({canceled:true});return;}
      context=pending;pending=null;root.classList.add('block-dragging');
      const row=event.operation.source.element;
      // Feedback:none preserves the editor DOM. Supply the virtual shape that
      // dnd-kit's collision observer, keyboard sensor and scroller require.
      context.shape=new DOMRectangle(row);context.origin={...event.operation.position.current};
      manager.dragOperation.shape=context.shape;
      for(const id of context.blockIds||[context.blockId]){const sourceRow=[...root.querySelectorAll('.block-row[data-block-id]')].find(item=>item.dataset.blockId===id);sourceRow?.closest('[data-dnd-block-id]')?.classList.add('is-block-drag-source');}
      event.operation.source.handle.setAttribute('aria-pressed','true');
      overlay=doc.createElement('div');overlay.className='block-dnd-overlay';overlay.setAttribute('aria-hidden','true');overlay.inert=true;
      const text=doc.createElement('span');text.className='block-dnd-overlay-label';text.textContent=context.text;overlay.append(text);
      if(context.count){const count=doc.createElement('span');count.className='block-dnd-overlay-count';count.textContent=label('children',{count:context.count});overlay.append(count);}
      doc.body.append(overlay);onActiveChange(true,context.blockId);status(label('started',{text:context.text,count:context.count}));
      for(const binding of bindings)if(typeof binding.refreshShape==='function')binding.refreshShape();
      manager.collisionObserver.forceUpdate();
      preview(event.operation);
    });
    observe('dragmove',event=>{
      if(!context)return;
      const current=event.operation.position.current;
      const point=event.to||{x:current.x+(event.by?.x||0),y:current.y+(event.by?.y||0)};
      manager.dragOperation.shape=context.shape.translate(point.x-context.origin.x,point.y-context.origin.y);
      // dragmove precedes dnd-kit's queued coordinate update. Read after it settles.
      if(previewFrame!==null)win.cancelAnimationFrame(previewFrame);
      previewFrame=win.requestAnimationFrame(()=>{
        previewFrame=null;if(context&&!destroyed){manager.collisionObserver.forceUpdate();preview(manager.dragOperation.snapshot());}
      });
    });
    observe('dragover',event=>preview(event.operation));
    observe('dragend',event=>{
      if(!context){pending=null;return;}
      const projected=releaseOperation(event);
      const previous=endVisuals();
      if(!projected||destroyed){status(label('canceled'));if(previous)restoreFocus(previous.blockId,previous.scope);return;}
      // Let dnd-kit finish its sensor and plugin cleanup before the application rerenders.
      dropTimer=win.setTimeout(()=>{
        dropTimer=null;
        if(destroyed||!Object.is(previous.scope,getScope())||!allowed(previous.blockId))return;
        if(projected.kind==='page'){
          if(!pageAllowed(previous,projected.pageId)||onCrossPage?.({blockId:projected.blockId,...(allowMultiPageTransfer?{blockIds:[...projected.blockIds]}:{}),pageId:projected.pageId})===false){status(label('canceled'));restoreFocus(previous.blockId,previous.scope);}
          else status(label('page',{text:previous.text,target:projected.element.textContent.trim()}));
        }else{
          const operation=validateBlockDrop({blocks:getBlocks(),allowInside,...projected.operation});
          if(!operation||onCommit(operation)===false){status(label('canceled'));restoreFocus(previous.blockId,previous.scope);}
          else status(label('moved',{text:previous.text}));
        }
      },0);
    });
    for(const row of root.querySelectorAll('.block-row[data-block-id]')){
      const blockId=row.dataset.blockId,handle=row.querySelector('[data-block-drag-handle]');
      if(handle&&!handle.disabled){
        handle.setAttribute('aria-pressed','false');handle.setAttribute('aria-roledescription',label('handle'));
        bindings.push(new Draggable({id:'block:'+blockId,type:'editor-block',data:{blockId},element:row,handle,plugins:[Feedback.configure({feedback:'none',dropAnimation:null})]},manager));
      }
      const target=new Droppable({id:'target:'+blockId,element:row,data:{kind:'block',blockId},accept:source=>{
        const drag=context||pending;
        if(!drag||source.data.blockId!==drag.blockId||!allowed(drag.blockId))return false;
        return ['before','after','inside'].some(placement=>drag.project({targetId:blockId,placement}));
      }},manager);bindings.push(target);dropBindings.push(target);
    }
    for(const element of root.querySelectorAll('.block-end-drop,[data-dnd-page-id]')){
      const pageId=element.dataset.dndPageId;
      const target=new Droppable({id:pageId?'page:'+pageId:'end',element,data:pageId?{kind:'page',pageId}:{kind:'end'},accept:source=>{
        const drag=context||pending;return !!drag&&source.data.blockId===drag.blockId&&allowed(drag.blockId)&&(!pageId||!element.disabled&&pageAllowed(drag,pageId));
      }},manager);bindings.push(target);dropBindings.push(target);
    }
    root.dataset.blockDnd='ready';
  }).catch(()=>{if(!destroyed){
    cancel();for(const binding of bindings.splice(0))binding.destroy();manager?.destroy();
    for(const cleanup of cleanups.splice(0))if(typeof cleanup==='function')cleanup();
    root.dataset.blockDnd='unavailable';status(label('unavailable'));
  }});
  return Object.freeze({ready,get active(){return !!context;},cancel,destroy(){
    if(destroyed)return;destroyed=true;cancel();removeVisuals();
    for(const cleanup of cleanups.splice(0))if(typeof cleanup==='function')cleanup();
    for(const binding of bindings.splice(0))binding.destroy();manager?.destroy();delete root.dataset.blockDnd;
  }});
}
