import {INLINE_STYLES,safeInlineHref,validateInlineMarks} from './inline-text.js';

const ignored=new Set(['SCRIPT','STYLE','META','LINK','IFRAME','OBJECT','EMBED','SVG','MATH','NOSCRIPT','HEAD','INPUT','BUTTON','SELECT','TEXTAREA']);
const containers=new Set(['P','DIV','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','UL','OL','LI','DETAILS','HR','TABLE']);
const tagOf=node=>node.tagName??node.nodeName;
const children=node=>Array.from(node.childNodes??[]);
const plain=value=>String(value??'').replace(/\r\n?/g,'\n').replace(/\u0000/g,'').toWellFormed();
const fail=()=>{throw new RangeError('CLIPBOARD_DOCUMENT_TOO_LARGE');};

/** Walk an inert parsed tree. Only text, bounded semantic blocks and canonical mark ranges survive. */
export function richBlocksFromNodes(nodes,{createId=()=>crypto.randomUUID(),tableParser=()=>null}={}){
 let visited=0,blockCount=0,total=0;
 const inspect=(node,depth)=>{if(++visited>20000||depth>32)fail();for(const child of children(node))inspect(child,depth+1);};
 for(const node of nodes)inspect(node,0);
 function inline(source){
  let text='',marks=[];
  const append=(value,styles,href)=>{value=plain(value);if(!value)return;const start=text.length;text+=value;if(text.length>100000)fail();if(styles.size||href){const run={start,end:text.length,styles:INLINE_STYLES.filter(style=>styles.has(style)),...(href?{href}:{})},previous=marks.at(-1);if(previous?.end===start&&previous.href===run.href&&JSON.stringify(previous.styles)===JSON.stringify(run.styles))previous.end=run.end;else marks.push(run);}};
  const visit=(node,styles=new Set(),href)=>{
   if(node.nodeType===3){append(node.textContent,styles,href);return;}
   const tag=tagOf(node);if(ignored.has(tag)||['UL','OL','TABLE'].includes(tag))return;
   if(tag==='BR'){append('\n',styles,href);return;}
   if(tag==='IMG'){append(node.getAttribute?.('alt')??'',styles,href);return;}
   const next=new Set(styles),style=node.getAttribute?.('style')??'';
   if(['STRONG','B'].includes(tag)||/font-weight\s*:\s*(bold|[6-9]00)/i.test(style))next.add('bold');
   if(['EM','I'].includes(tag)||/font-style\s*:\s*italic/i.test(style))next.add('italic');
   if(['S','DEL','STRIKE'].includes(tag)||/text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style))next.add('strike');
   if(tag==='U'||/text-decoration(?:-line)?\s*:[^;]*underline/i.test(style))next.add('underline');
   if(tag==='CODE')next.add('code');
   if(tag==='A'){try{href=safeInlineHref(node.getAttribute('href'));}catch{href=undefined;}}
   for(const child of children(node))visit(child,next,href);
  };
  for(const node of source)visit(node);marks=validateInlineMarks(text,marks);return{text,...(marks.length?{marks}:{})};
 }
 const make=(type,data,childBlocks)=>{if(++blockCount>500||(data?.text?.length??0)>100000||(total+=data?.text?.length??0)>200000)fail();return{id:createId(),type,...(data?{data}:{}),...(childBlocks?.length?{children:childBlocks}:{})};};
 function walk(source){
  const result=[];let pending=[];
  const flush=()=>{if(!pending.length)return;const data=inline(pending);pending=[];if(data.text.trim())result.push(make('paragraph',data));};
  for(const node of source){
   const tag=tagOf(node);if(ignored.has(tag))continue;
   if(node.nodeType===3||!containers.has(tag)){pending.push(node);continue;}
   flush();
   if(tag==='TABLE'){const data=tableParser(node);if(data)result.push(make('table',data));continue;}
   if(tag==='HR'){result.push(make('divider',{}));continue;}
   if(['UL','OL'].includes(tag)){
    let number=Number(node.getAttribute?.('start'))||1;
    for(const item of children(node).filter(child=>tagOf(child)==='LI')){
     const content=children(item),nested=content.filter(child=>['UL','OL'].includes(tagOf(child))),data=inline(content);
     result.push(make(tag==='UL'?'bulleted-list':'numbered-list',{...data,...(tag==='OL'?{start:Math.min(999999999,Math.max(1,number++))}:{})},walk(nested)));
    }continue;
   }
   if(tag==='DETAILS'){
    const content=children(node),summary=content.find(child=>tagOf(child)==='SUMMARY');result.push(make('toggle',inline(summary?children(summary):[]),walk(content.filter(child=>child!==summary))));continue;
   }
   if(tag==='PRE'){result.push(make('code',{text:plain(node.textContent)}));continue;}
   if(tag==='DIV'||tag==='SECTION'||tag==='ARTICLE'){
    if(children(node).some(child=>containers.has(tagOf(child)))){result.push(...walk(children(node)));continue;}
   }
   const data=inline(children(node)),heading=/^H([1-6])$/.exec(tag);
   result.push(make(heading?'heading':tag==='BLOCKQUOTE'?'quote':'paragraph',{...data,...(heading?{level:Math.min(3,Number(heading[1]))}:{})}));
  }
  flush();return result;
 }
 return walk(Array.from(nodes));
}

export function richBlocksFromHtml(html,document=globalThis.document,options={}){
 if(typeof html!=='string'||!html||!document?.createElement)return null;
 if(html.length>512000)fail();
 const template=document.createElement('template');template.innerHTML=html;
 const blocks=richBlocksFromNodes(children(template.content),options);return blocks.length?blocks:null;
}
