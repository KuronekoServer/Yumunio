import * as Y from 'yjs';
import {isInlineBoundary} from '@yumunio/domain';
import {CollaborationError,toBase64,fromBase64} from './index.js';

const fail=()=>{throw new CollaborationError('ROOM_CONTENT_UNSUPPORTED');};
const position=(doc,encoded,roots)=>{
 try{
  const relative=Y.decodeRelativePosition(fromBase64(encoded,512));
  if(toBase64(Y.encodeRelativePosition(relative))!==encoded||relative.assoc!==-1)fail();
  const absolute=Y.createAbsolutePositionFromRelativePosition(relative,doc);
  if(!absolute||!(absolute.type instanceof Y.Text))fail();
  const key=Y.findRootTypeKey(absolute.type),text=absolute.type.toString();
  if(roots&&!roots.has(key)||!isInlineBoundary(text,absolute.index))fail();
  return{key,index:absolute.index,text:absolute.type,relative};
 }catch(error){if(error instanceof CollaborationError)throw error;fail();}
};

/** Immutable split scaffolds insert two text slots around an anchored boundary.
 * Slots remain routed into the original text when the split itself is undone,
 * so selective undo cannot hide a peer's subsequent input in the new block.
 */
export function createTextFlows(doc,nodes,textIds){
 const roots=new Set(textIds.map(id=>'block:'+id));
 for(const[id,row]of nodes)if(row.split)roots.add('split:'+id);
 for(const key of roots)doc.getText(key);
 const cuts=new Map(),ranks=new Map();
 // Collapsed absolute offsets are not equal boundaries: tombstoned characters
 // still determine the original cut order. Item IDs can point inside one run.
 const order=cut=>{if(cut.relative.item===null)return -1;const item=Y.getItem(doc.store,cut.relative.item);if(!(item instanceof Y.Item)||item.parent!==cut.text)fail();let map=ranks.get(cut.key);if(!map){map=new Map();let offset=0;for(let entry=cut.text._start;entry;entry=entry.right){map.set(entry,offset);offset+=entry.length;}ranks.set(cut.key,map);}if(!map.has(item))fail();return map.get(item)+cut.relative.item.clock-item.id.clock;};
 for(const[id,row]of nodes)if(row.split){
  const cut=position(doc,row.split.cut,roots),items=cuts.get(cut.key)??[];
  items.push({id,index:cut.index,order:order(cut),anchor:row.split.cut});cuts.set(cut.key,items);
 }
 for(const items of cuts.values())items.sort((a,b)=>a.index-b.index||a.order-b.order||(a.id<b.id?-1:a.id>b.id?1:0));
 const checked=new Set(),checking=new Set();
 const check=key=>{if(checking.has(key))fail();if(checked.has(key))return;checking.add(key);for(const cut of cuts.get(key)??[]){check('split:'+cut.id);check('block:'+cut.id);}checking.delete(key);checked.add(key);};
 for(const key of roots)check(key);
 const expand=key=>{
  const result=[];let from=null;
  for(const cut of cuts.get(key)??[]){result.push({key,from,to:cut.anchor},...expand('split:'+cut.id),{cut:cut.id},...expand('block:'+cut.id));from=cut.anchor;}
  result.push({key,from,to:null});return result;
 };
 return{roots,flows:new Map(textIds.map(id=>[id,nodes.get(id).split?[]:expand('block:'+id)]))};
}

export function textFlowParts(doc,flow){
 if(!Array.isArray(flow))fail();let offset=0;const result=[];
 for(const part of flow){if(part.cut)continue;const text=doc.getText(part.key),value=text.toString(),left=part.from===null?null:position(doc,part.from),right=part.to===null?null:position(doc,part.to),from=left?.index??0,to=right?.index??value.length;
  if(left&&left.key!==part.key||right&&right.key!==part.key)fail();
  if(from>to||!isInlineBoundary(value,from)||!isInlineBoundary(value,to))fail();
  result.push({key:part.key,text,from,to,offset,length:to-from});offset+=to-from;
 }
 return result;
}
export function textFlowDelta(doc,flow){
 const result=[];
 for(const part of textFlowParts(doc,flow)){let offset=0;for(const run of part.text.toDelta()){
  if(typeof run.insert!=='string')fail();const from=Math.max(part.from-offset,0),to=Math.min(part.to-offset,run.insert.length);
  if(to>from)result.push({insert:run.insert.slice(from,to),...(run.attributes?{attributes:{...run.attributes}}:{}),root:part.key});offset+=run.insert.length;
 }}
 return result;
}
export const textFlowValue=(doc,flow)=>textFlowDelta(doc,flow).map(run=>run.insert).join('');
export function textFlowPosition(doc,flow,offset){
 const parts=textFlowParts(doc,flow),length=parts.reduce((count,part)=>count+part.length,0),value=parts.map(part=>part.text.toString().slice(part.from,part.to)).join('');
 if(!Number.isSafeInteger(offset)||!isInlineBoundary(value,offset)||!parts.length)fail();
 const part=offset===length?parts.at(-1):offset===0?parts[0]:parts.find(part=>offset>=part.offset&&offset<part.offset+part.length)??parts.at(-1);
 return{key:part.key,text:part.text,index:part.from+offset-part.offset};
}
export function textFlowAnchor(doc,flow,offset){const point=textFlowPosition(doc,flow,offset);return toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(point.text,point.index,-1)));}
export function splitTextFlow(flow,id){const at=flow.findIndex(part=>part.cut===id);return at<0?null:{left:flow.slice(0,at),right:flow.slice(at+1)};}
export function crossingFlowReferences(doc,flow,id){
 const at=flow.findIndex(part=>part.cut===id);if(at<0)return[];
 const boundary=textFlowValue(doc,flow.slice(0,at)).length,ranges=new Map();let offset=0;
 for(const run of textFlowDelta(doc,flow)){for(const kind of ['links','mentions']){const token=run.attributes?.[kind];if(token!==undefined){const range=ranges.get(token)??{start:offset,end:offset};range.end=offset+run.insert.length;ranges.set(token,range);}}offset+=run.insert.length;}
 return[...ranges].filter(([,range])=>range.start<boundary&&range.end>boundary).map(([token])=>token);
}

/** Map a logical edit back to existing physical Y.Text runs; no replacement body or text copy. */
export function replaceTextFlow(doc,flow,start,end,inserted,marks=[]){
 const value=textFlowValue(doc,flow);if(!isInlineBoundary(value,start)||!isInlineBoundary(value,end)||end<start||typeof inserted!=='string')fail();
 const insertion=textFlowPosition(doc,flow,start),deletions=new Map();
 for(const part of textFlowParts(doc,flow)){const left=Math.max(start,part.offset),right=Math.min(end,part.offset+part.length);if(right<=left)continue;
  const ranges=deletions.get(part.key)??[];ranges.push({from:part.from+left-part.offset,to:part.from+right-part.offset});deletions.set(part.key,ranges);
 }
 let index=insertion.index;
 for(const range of deletions.get(insertion.key)??[])index-=Math.max(0,Math.min(insertion.index,range.to)-range.from);
 for(const[key,ranges]of deletions)for(const range of ranges.sort((a,b)=>b.from-a.from))doc.getText(key).delete(range.from,range.to-range.from);
 const points=[...new Set([0,inserted.length,...marks.flatMap(mark=>[Math.max(0,Math.min(inserted.length,mark.start)),Math.max(0,Math.min(inserted.length,mark.end))])])].sort((a,b)=>a-b);
 for(let n=0;n<points.length-1;n++){const left=points[n],right=points[n+1];if(right<=left)continue;const mark=marks.find(mark=>mark.start<=left&&mark.end>=right),attributes={...Object.fromEntries((mark?.styles??[]).map(style=>[style,true])),...(mark?.href?{href:mark.href}:{})};insertion.text.insert(index+left,inserted.slice(left,right),attributes);}
}
export function formatTextFlow(doc,flow,start,end,attributes){
 const value=textFlowValue(doc,flow);if(!isInlineBoundary(value,start)||!isInlineBoundary(value,end)||end<start)fail();
 for(const part of textFlowParts(doc,flow)){const left=Math.max(start,part.offset),right=Math.min(end,part.offset+part.length);if(right>left)part.text.format(part.from+left-part.offset,right-left,attributes);}
}
export function textFlowOffset(doc,flow,type,index,assoc=0){
 const parts=textFlowParts(doc,flow).filter(part=>part.text===type&&index>=part.from&&index<=part.to);const part=parts.find(part=>assoc<0?index>part.from&&index<=part.to:index>=part.from&&index<part.to)??(assoc<0?parts[0]:parts.at(-1));return part?part.offset+index-part.from:null;
}

/** Capture all physical ranges before deleting any: adjacent flows can share a root. */
export function clearTextFlows(doc,flows){
 const grouped=new Map();for(const flow of flows)for(const part of textFlowParts(doc,flow)){if(!part.length)continue;const ranges=grouped.get(part.key)??[];ranges.push({from:part.from,to:part.to});grouped.set(part.key,ranges);}
 for(const[key,ranges]of grouped){const merged=[];for(const range of ranges.sort((a,b)=>a.from-b.from)){const previous=merged.at(-1);if(previous&&range.from<=previous.to)previous.to=Math.max(previous.to,range.to);else merged.push({...range});}for(const range of merged.reverse())doc.getText(key).delete(range.from,range.to-range.from);}
}
