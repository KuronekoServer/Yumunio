const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REFERENCES=100;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
export class ContentBacklinksError extends Error{constructor(code='INVALID_CONTENT',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new ContentBacklinksError(code,status);};
const splitSurrogate=(text,index)=>index>0&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]);
function validLink(link,text,targetId){
  if(!link||typeof link!=='object'||Array.isArray(link)||Object.keys(link).some(key=>!['start','end','label','pageId','fragment'].includes(key))||link.pageId!==targetId||!ID.test(link.pageId))return false;
  if(!Number.isSafeInteger(link.start)||!Number.isSafeInteger(link.end)||link.start<0||link.end<=link.start||link.end>text.length||typeof link.label!=='string'||text.slice(link.start,link.end)!==link.label||splitSurrogate(text,link.start)||splitSurrogate(text,link.end))return false;
  return !Object.hasOwn(link,'fragment')||typeof link.fragment==='string'&&link.fragment.length<=512&&!/[\u0000-\u001f\u007f]/.test(link.fragment);
}
function snippet(text,start,end){
  const before=Array.from(text.slice(0,start)).slice(-60).join(''),selected=Array.from(text.slice(start,end)).slice(0,160).join(''),after=Array.from(text.slice(end)).slice(0,60).join('');
  const prefix=text.slice(0,start).length>before.length?'…':'',suffix=text.slice(start,end).length>selected.length||text.slice(end).length>after.length?'…':'';
  return Array.from(prefix+before+selected+after+suffix).slice(0,240).join('');
}
/** Derived read projection only. Access decisions come from this request's current aggregate. */
export function projectBacklinks({pageId,payload,saved,access}){
  const target=payload.pages.find(item=>item.page.id===pageId);
  if(!target||target.page.trashedAt!==null||!access(pageId).includes('read'))fail('CONTENT_NOT_FOUND',404);
  const project=item=>({id:item.page.id,title:item.page.title,version:item.document.version});
  const sources=[];let count=0,truncated=false;
  for(const source of payload.pages){
    if(source.page.id===pageId||source.page.trashedAt!==null||!access(source.page.id).includes('read'))continue;
    const references=[];
    const walk=blocks=>{for(const block of blocks){if(block.data?.purpose==='import-source')continue;const text=block.data?.text;
      if(typeof text==='string'&&ID.test(block.id)&&Array.isArray(block.data?.links))for(const link of block.data.links){if(!validLink(link,text,pageId))continue;if(count===MAX_REFERENCES){truncated=true;continue;}references.push({blockId:block.id,label:Array.from(link.label).slice(0,200).join(''),snippet:snippet(text,link.start,link.end)});count++;}
      if(Array.isArray(block.children))walk(block.children);
    }};walk(source.document.blocks);
    if(references.length)sources.push({page:project(source),references});
  }
  return{revision:saved.revision,page:project(target),scope:'structured-links',sources,truncated};
}
export function handleBacklinks(context){if(context.request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);return Response.json(projectBacklinks(context),{headers});}
