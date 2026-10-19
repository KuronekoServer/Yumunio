import {safeInlineHref} from './inline-text.js';

export function outlineEntries(blocks){
 const entries=[];const visit=items=>{for(const block of items){if(['heading','heading1','heading2'].includes(block.type)&&typeof block.data?.text==='string')entries.push({id:block.id,text:block.data.text,level:block.type==='heading1'?1:block.type==='heading2'?2:Math.max(1,Math.min(3,block.data.level??1))});if(block.children)visit(block.children);}};visit(blocks);return entries;
}
export function renderOutline(blocks,{document=globalThis.document,empty='Add headings to show a table of contents',label='Table of contents'}={}){
 const nav=document.createElement('nav');nav.className='page-outline';nav.setAttribute('aria-label',label);const entries=outlineEntries(blocks);
 if(!entries.length){const note=document.createElement('p');note.className='hint';note.textContent=empty;nav.append(note);return nav;}
 const list=document.createElement('ul');for(const entry of entries){const item=document.createElement('li'),link=document.createElement('a');item.className='outline-level-'+entry.level;link.href='#block-'+entry.id;link.textContent=entry.text||label;link.setAttribute('translate','no');item.append(link);list.append(item);}nav.append(list);return nav;
}
export function pageAncestors(pages,pageId){const index=new Map(pages.map(page=>[page.id,page])),result=[],seen=new Set();let page=index.get(pageId);while(page&&!seen.has(page.id)){result.unshift(page);seen.add(page.id);page=index.get(page.parentId);}return result;}
export function renderBreadcrumb(pages,pageId,{document=globalThis.document,href,label='Page path'}={}){
 const nav=document.createElement('nav');nav.className='page-breadcrumb';nav.setAttribute('aria-label',label);for(const [index,page]of pageAncestors(pages,pageId).entries()){if(index){const separator=document.createElement('span');separator.textContent=' / ';separator.setAttribute('aria-hidden','true');nav.append(separator);}const link=document.createElement('a');link.href=href(page.id);link.textContent=page.title;link.setAttribute('translate','no');nav.append(link);}return nav;
}
export function createBookmarkBlock(url,title='',id=crypto.randomUUID()){
 const safe=safeInlineHref(url.trim());return{id,type:'bookmark',data:{format:'web-link-v1',url:safe,text:(title.trim()||new URL(safe).hostname).slice(0,240)}};
}
export function renderBookmark(block,document=globalThis.document){
 const link=document.createElement('a');link.href=safeInlineHref(block.data.url);link.className='web-bookmark';link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';
 const title=document.createElement('strong'),address=document.createElement('span');title.textContent=block.data.text;address.textContent=block.data.url;link.append(title,address);return link;
}
