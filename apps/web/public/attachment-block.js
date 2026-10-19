import {previewableImage} from './clipboard-content.js';
export {isAttachmentBlock} from './attachment-block-model.js';
export function createAttachmentBlock(attachment,{pageId,id=crypto.randomUUID()}={}){
 return {id,type:previewableImage(attachment.mediaType)?'image':'file',data:{format:'attachment-v1',text:attachment.name,links:[{start:0,end:attachment.name.length,label:attachment.name,pageId,attachmentId:attachment.id}]}};
}
export function renderAttachmentBlock(block,{document=globalThis.document,pageId,attachments=[],path,unavailable='Attachment unavailable',imageError='Image preview unavailable'}={}){
 const host=document.createElement('figure');host.className='attachment-block';
 const link=block.data.links[0],asset=link.unavailable!==true&&link.pageId===pageId?attachments.find(row=>row.id===link.attachmentId):null;
 if(!asset){const note=document.createElement('p');note.textContent=unavailable;host.append(note);return host;}
 if(block.type==='image'&&previewableImage(asset.mediaType)){
  const image=document.createElement('img');image.src=path(asset.id)+'/preview';image.alt=asset.name;image.loading='lazy';image.decoding='async';
  image.addEventListener('error',()=>{image.hidden=true;const note=document.createElement('p');note.className='hint';note.textContent=imageError;host.prepend(note);},{once:true});host.append(image);
 }
 if(asset.mediaType==='application/pdf'){
  const frame=document.createElement('iframe');frame.className='attachment-pdf';frame.src=path(asset.id)+'/preview';frame.title=asset.name;frame.loading='lazy';frame.referrerPolicy='no-referrer';host.append(frame);
 }else if(['audio/mpeg','audio/wav','audio/x-wav','audio/ogg','audio/mp4','audio/webm','video/mp4','video/webm','video/ogg'].includes(asset.mediaType)){
  const player=document.createElement(asset.mediaType.startsWith('audio/')?'audio':'video');player.controls=true;player.preload='metadata';player.src=path(asset.id)+'/preview';player.setAttribute('aria-label',asset.name);host.append(player);
 }
 const caption=document.createElement('figcaption'),download=document.createElement('a');download.href=path(asset.id);download.download=asset.name;download.textContent=asset.name;download.setAttribute('translate','no');caption.append(download);host.append(caption);return host;
}
