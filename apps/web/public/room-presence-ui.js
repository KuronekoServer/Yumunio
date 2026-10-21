const COLORS=['#236da8','#9254a1','#b44b42','#477946','#9a6720','#485bb1'];
export function participantColor(id){let value=0;for(const char of String(id))value=(Math.imul(value,31)+char.charCodeAt(0))|0;return COLORS[(value>>>0)%COLORS.length];}
export function participantRoster(doc,participants,{label='Coediting participants',you='You',waiting=''}={}){
 const list=doc.createElement('div');list.className='room-participants';list.setAttribute('role','list');list.setAttribute('aria-label',label);
 for(const person of participants){
  const item=doc.createElement('span'),color=doc.createElement('span'),name=doc.createElement('span');item.className='room-person';item.setAttribute('role','listitem');item.style.setProperty('--participant-color',participantColor(person.id));color.className='room-person-color';color.setAttribute('aria-hidden','true');name.textContent=person.displayName+(person.self?' ('+you+')':'');item.title=name.textContent;item.setAttribute('aria-label',name.textContent);color.setAttribute('data-initial',Array.from(person.displayName||'?')[0]);name.className='room-person-name';name.setAttribute('translate','no');name.setAttribute('dir','auto');item.append(color,name);list.append(item);
 }
 if(!participants.length&&waiting){const message=doc.createElement('span');message.className='hint';message.textContent=waiting;list.append(message);}
 return list;
}
function endpoint(doc,element,offset){
 if(!Number.isSafeInteger(offset)||offset<0||offset>element.textContent.length)return null;
 const walker=doc.createTreeWalker(element,4);let node,left=offset;
 while((node=walker.nextNode())){if(left<=node.textContent.length)return[node,left];left-=node.textContent.length;}
 return offset===0?[element,0]:null;
}
/** Ephemeral overlays stay outside contenteditable so they never enter saved text or copy/paste. */
export function remoteCursorLayer(doc,root,participants,{pageId}={}){
 const layer=doc.createElement('div');layer.className='room-cursor-layer';layer.setAttribute('aria-hidden','true');
 const editors=[...root.querySelectorAll('.inline-editor[data-block-id]')],view=doc.defaultView,scroll=root.querySelector('.workspace-scroll'),bounds=scroll?.getBoundingClientRect()||{top:0,bottom:view.innerHeight,left:0,right:view.innerWidth};
 const clip={top:Math.max(0,bounds.top),bottom:Math.min(view.innerHeight,bounds.bottom),left:Math.max(0,bounds.left),right:Math.min(view.innerWidth,bounds.right)};
 if(clip.right<=clip.left||clip.bottom<=clip.top)return layer;
 layer.style.clipPath='inset('+clip.top+'px '+(view.innerWidth-clip.right)+'px '+(view.innerHeight-clip.bottom)+'px '+clip.left+'px)';
 for(const person of participants){
  if(person.self||!person.cursor)continue;
  const cursor=person.cursor,editor=editors.find(item=>item.dataset.blockId===cursor.blockId&&item.dataset.pageId===pageId);
  if(!editor)continue;const start=endpoint(doc,editor,cursor.start),end=endpoint(doc,editor,cursor.end);if(!start||!end)continue;
  const range=doc.createRange();try{range.setStart(...start);range.setEnd(...end);}catch{continue;}
  const color=participantColor(person.id),inside=rect=>rect.bottom>Math.max(0,clip.top)&&rect.top<Math.min(view.innerHeight,clip.bottom)&&rect.right>=Math.max(0,clip.left)&&rect.left<Math.min(view.innerWidth,clip.right);
  if(cursor.start!==cursor.end)for(const rect of [...range.getClientRects()].slice(0,100)){if(!inside(rect))continue;const selection=doc.createElement('span');selection.className='room-remote-selection';selection.style.setProperty('--participant-color',color);Object.assign(selection.style,{left:Math.max(rect.left,clip.left)+'px',top:Math.max(rect.top,clip.top)+'px',width:Math.max(0,Math.min(rect.right,clip.right)-Math.max(rect.left,clip.left))+'px',height:Math.max(0,Math.min(rect.bottom,clip.bottom)-Math.max(rect.top,clip.top))+'px'});layer.append(selection);}
  range.collapse(cursor.direction==='backward');let rect=range.getBoundingClientRect();
  if(!rect.height){const bounds=editor.getBoundingClientRect();if(editor.textContent.length)continue;rect={left:bounds.left,right:bounds.left+2,top:bounds.top,bottom:bounds.top+24,height:24};}
  if(!inside(rect))continue;
  const caret=doc.createElement('span'),name=doc.createElement('span');caret.className='room-remote-caret';caret.style.setProperty('--participant-color',color);Object.assign(caret.style,{left:Math.max(clip.left,rect.left)+'px',top:Math.max(clip.top,rect.top)+'px',height:Math.max(0,Math.min(rect.bottom,clip.bottom)-Math.max(rect.top,clip.top))+'px'});name.className='room-remote-label';name.textContent=person.displayName;name.setAttribute('translate','no');name.setAttribute('dir','auto');caret.append(name);layer.append(caret);
 }
 return layer;
}
