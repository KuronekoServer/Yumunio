import {validateBlocks,validatePageLinks,rebasePageLinks} from '@yumunio/domain';
export class ContentPageLinksError extends Error { constructor(code='INVALID_CONTENT',status=400) {super(code);this.code=code;this.status=status;} }
const fail=(code,status)=>{throw new ContentPageLinksError(code,status);};
/** Only a server-derived surviving span may recover an unavailable read marker. No client target is trusted. */
export function preparePageLinkBlocks({blocks,previousBlocks=[],access,attachments=[],pageId}) {
 validateBlocks(blocks);const previous=new Map();
 const index=items=>{for(const block of items){previous.set(block.id,block);if(block.children)index(block.children);}};index(previousBlocks);
 const captured=structuredClone(blocks),readable=new Map();const canRead=id=>{if(!readable.has(id))readable.set(id,access(id).includes('read'));return readable.get(id);};
 const visit=items=>{for(const block of items){if(Object.hasOwn(block.data??{},'links')){
  let links;try{links=validatePageLinks(block.data.text,block.data.links,{allowUnavailable:true});}catch{fail();}
  const original=previous.get(block.id),surviving=typeof original?.data?.text==='string'&&Array.isArray(original.data.links)?rebasePageLinks(original.data.text,block.data.text,original.data.links):[];
  const match=link=>surviving.find(old=>!old.unavailable&&old.start===link.start&&old.end===link.end&&old.label===link.label&&!canRead(old.pageId));
  block.data.links=links.map(link=>{
   if(link.unavailable){const old=match(link);if(!old)fail();return{...old};}
   if(!canRead(link.pageId)){const old=match(link);if(!old||old.pageId!==link.pageId||old.fragment!==link.fragment||old.attachmentId!==link.attachmentId)fail('CONTENT_NOT_FOUND',404);return{...old};}
   if(link.attachmentId&&!attachments.some(row=>row.id===link.attachmentId&&row.pageId===pageId&&link.pageId===pageId)){
    // Deleting a file must not make the rest of its page impossible to edit.
    // Only an unchanged surviving reference may retain an unavailable attachment.
    const old=surviving.find(old=>old.start===link.start&&old.end===link.end&&old.label===link.label&&old.pageId===link.pageId&&old.attachmentId===link.attachmentId&&old.fragment===link.fragment);
    if(!old)fail('CONTENT_NOT_FOUND',404);return {...old};
   }
   return link;
  });
 }if(block.children)visit(block.children);}};visit(captured);return captured;
}
