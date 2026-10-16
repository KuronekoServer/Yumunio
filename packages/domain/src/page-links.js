export const MAX_PAGE_LINKS = 1000;
const MAX_TEXT = 100000;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export class PageLinksError extends TypeError { constructor() { super('INVALID_PAGE_LINKS'); this.name = 'PageLinksError'; this.code = 'INVALID_PAGE_LINKS'; } }
const fail = () => { throw new PageLinksError(); };
const plain = value => { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail(); const descriptors=Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value'))) fail(); };
const textValue = text => { if (typeof text !== 'string' || text.length > MAX_TEXT) fail(); };
export function isPageLinkBoundary(text,offset) { return Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&!(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset])); }
function range(text,start,end) { textValue(text); if (!isPageLinkBoundary(text,start)||!isPageLinkBoundary(text,end)||start>end) fail(); }
/** The read projection may contain an unavailable marker; source references exist only before import remapping. */
export function validatePageLinks(text,links,{allowUnavailable=false,allowSourceReferences=false}={}) {
  textValue(text); if (!Array.isArray(links)||links.length>MAX_PAGE_LINKS||Object.getPrototypeOf(links)!==Array.prototype||Reflect.ownKeys(links).length!==links.length+1) fail();
  for(let index=0;index<links.length;index++){const descriptor=Object.getOwnPropertyDescriptor(links,String(index));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();}
  let previous=0;
  return links.map((link,index)=>{const descriptor=Object.getOwnPropertyDescriptor(links,String(index));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();plain(link);
    const allowed=['start','end','label','pageId','attachmentId','fragment',...(allowUnavailable?['unavailable']:[]),...(allowSourceReferences?['sourcePageId','sourceCollectionId','sourceAssetId']:[])];
    if(Object.keys(link).some(key=>!allowed.includes(key)))fail();range(text,link.start,link.end);if(link.start<previous||link.start===link.end||typeof link.label!=='string'||text.slice(link.start,link.end)!==link.label)fail();
    if(Object.hasOwn(link,'fragment')&&(typeof link.fragment!=='string'||link.fragment.length>512||/[\u0000-\u001f\u007f]/.test(link.fragment)))fail();
    const sourceKeys=['sourcePageId','sourceCollectionId','sourceAssetId'].filter(key=>Object.hasOwn(link,key));
    if(Object.hasOwn(link,'unavailable')){if(!allowUnavailable||link.unavailable!==true||Object.keys(link).some(key=>!['start','end','label','unavailable'].includes(key)))fail();}
    else if(sourceKeys.length){if(!allowSourceReferences||sourceKeys.length!==1||!id(link[sourceKeys[0]])||Object.hasOwn(link,'pageId')||Object.hasOwn(link,'attachmentId'))fail();}
    else if(!id(link.pageId)||Object.hasOwn(link,'attachmentId')&&!id(link.attachmentId))fail();
    previous=link.end;return {...link};
  });
}
const options={allowUnavailable:true};
/** Intersected references are removed as a whole. An insertion at either boundary stays outside the reference. */
export function replacePageLinks(text,links,start,end,inserted) {
  range(text,start,end);textValue(inserted);const source=validatePageLinks(text,links,options),next=text.slice(0,start)+inserted+text.slice(end);textValue(next);const delta=inserted.length-(end-start),result=[];
  for(const link of source){if(link.end<=start)result.push({...link});else if(link.start>=end)result.push({...link,start:link.start+delta,end:link.end+delta});}
  return validatePageLinks(next,result,options);
}
/** A conservative single replacement handles IME and browser mutations without guessing which identical occurrence was edited. */
export function rebasePageLinks(before,after,links) {
  textValue(before);textValue(after);const source=validatePageLinks(before,links,options);if(before===after)return source;
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;while(!isPageLinkBoundary(before,start)||!isPageLinkBoundary(after,start))start--;
  let oldEnd=before.length,newEnd=after.length;while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}while(!isPageLinkBoundary(before,oldEnd)||!isPageLinkBoundary(after,newEnd)){oldEnd++;newEnd++;}
  return replacePageLinks(before,source,start,oldEnd,after.slice(start,newEnd));
}
export function removePageLinks(text,links,start,end) { range(text,start,end);const source=validatePageLinks(text,links,options);return start===end?source:source.filter(link=>link.end<=start||link.start>=end); }
export function setPageLink(text,links,start,end,pageId) { range(text,start,end);if(start===end||!id(pageId))fail();const next=removePageLinks(text,links,start,end);next.push({start,end,label:text.slice(start,end),pageId});next.sort((a,b)=>a.start-b.start);return validatePageLinks(text,next,options); }
export function splitPageLinks(text,links,start,end) { range(text,start,end);const source=validatePageLinks(text,links,options);return{beforeLinks:source.filter(link=>link.end<=start),afterLinks:source.filter(link=>link.start>=end).map(link=>({...link,start:link.start-end,end:link.end-end}))}; }
export function joinPageLinks(before,left,after,right) { textValue(before);textValue(after);return validatePageLinks(before+after,[...validatePageLinks(before,left,options),...validatePageLinks(after,right,options).map(link=>({...link,start:link.start+before.length,end:link.end+before.length}))],options); }