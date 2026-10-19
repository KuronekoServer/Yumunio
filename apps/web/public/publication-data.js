import {validateSimpleTableData} from './simple-table.js';
const encoder=new TextEncoder();
const types=new Set(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote','callout','toggle','divider']);
const exclusions=new Set(['child-pages','database-records','attachments','comments','authors','source-code','unsupported-blocks','structured-links']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const token=value=>typeof value==='string'&&/^[a-f0-9]{160,2048}$/.test(value);
const fail=()=>{throw new TypeError('INVALID_PUBLICATION');};
function object(value,required,optional=[]){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);if(keys.some(key=>typeof key!=='string'||![...required,...optional].includes(key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value'))||required.some(key=>!Object.hasOwn(descriptors,key)))fail();}
function array(value,max){if(!Array.isArray(value)||value.length>max)fail();const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);if(keys.length!==value.length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!/^\d+$/.test(key)||Number(key)>=value.length||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value'))))fail();for(let index=0;index<value.length;index++)if(!Object.hasOwn(descriptors,String(index)))fail();}
function text(value,max){if(typeof value!=='string'||value.length>max||value.includes('\0'))fail();}
const integer=(value,min=0)=>{if(!Number.isSafeInteger(value)||value<min)fail();};
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail();}
export function validatePublicSnapshot(value){object(value,['title','blocks']);text(value.title,240);let count=0;const visit=(blocks,depth)=>{array(blocks,1000);if(depth>20)fail();return blocks.map(block=>{object(block,['type'],['text','level','checked','children','data']);if(block.type==='table'){object(block,['type','data']);if(++count>1000)fail();try{validateSimpleTableData(block.data);}catch{fail();}return{type:'table',data:structuredClone(block.data)};}if(!types.has(block.type)||++count>1000)fail();const required=['type',...(block.type==='divider'?[]:['text']),...(block.type==='heading'?['level']:[]),...(block.type==='checklist'?['checked']:[])];object(block,required,['children']);if(block.type!=='divider')text(block.text,100000);if(block.type==='heading'&&![1,2,3].includes(block.level))fail();if(block.type==='checklist'&&typeof block.checked!=='boolean')fail();return{type:block.type,...(block.type==='divider'?{}:{text:block.text}),...(block.type==='heading'?{level:block.level}:{}),...(block.type==='checklist'?{checked:block.checked}:{}),...(Object.hasOwn(block,'children')?{children:visit(block.children,depth+1)}:{})};});};const result={title:value.title,blocks:visit(value.blocks,1)};if(encoder.encode(JSON.stringify(result)).length>200000)fail();return result;}
export function validatePublicPage(value){object(value,['schemaVersion','mode','title','publishedAt','blocks']);if(value.schemaVersion!==1||value.mode!=='snapshot')fail();date(value.publishedAt);const snapshot=validatePublicSnapshot({title:value.title,blocks:value.blocks});return{schemaVersion:1,mode:'snapshot',publishedAt:value.publishedAt,...snapshot};}
export function publicToken(value){if(!token(value))fail();return value;}
export function validatePublicationStatus(value,pageId){object(value,['revision','pageId','mode','active','needsRepublish','sourceVersion','currentSourceVersion','publishedAt','publicPath']);integer(value.revision);integer(value.currentSourceVersion,1);if(!id(value.pageId)||value.pageId!==pageId||value.mode!=='snapshot'||typeof value.active!=='boolean'||typeof value.needsRepublish!=='boolean')fail();if(value.sourceVersion!==null)integer(value.sourceVersion,1);if(value.publishedAt!==null)date(value.publishedAt);if(value.publicPath!==null){if(typeof value.publicPath!=='string'||!value.publicPath.startsWith('/site?publication='))fail();publicToken(value.publicPath.slice('/site?publication='.length));}if(value.sourceVersion!==null&&value.sourceVersion>value.currentSourceVersion||value.active!==(value.publicPath!==null)||value.active&&(value.sourceVersion!==value.currentSourceVersion||value.publishedAt===null||value.needsRepublish))fail();return structuredClone(value);}
export function validatePublicationReview(value,pageId){object(value,['revision','pageId','mode','sourceVersion','snapshot','summary','exclusions','reviewDigest']);integer(value.revision);integer(value.sourceVersion,1);if(value.pageId!==pageId||!id(value.pageId)||value.mode!=='snapshot'||typeof value.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.reviewDigest))fail();const snapshot=validatePublicSnapshot(value.snapshot);object(value.summary,['blocksIncluded','blocksOmitted','linkSpansOmitted']);for(const count of Object.values(value.summary))integer(count);let count=0;const visit=blocks=>{for(const block of blocks){count++;if(block.children)visit(block.children);}};visit(snapshot.blocks);if(value.summary.blocksIncluded!==count)fail();array(value.exclusions,exclusions.size);if(new Set(value.exclusions).size!==value.exclusions.length||value.exclusions.some(key=>!exclusions.has(key)))fail();return{...structuredClone(value),snapshot};}

export async function readPublicationJson(response) {
  if (!response?.body || typeof response.body.getReader !== 'function') fail();
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) { try { await reader.cancel(); } catch {} fail(); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
}
