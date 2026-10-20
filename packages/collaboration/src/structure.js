import * as Y from 'yjs';
import {assertTitle,validateBlocks,validateInlineMarks,INLINE_STYLES,safeInlineHref,isInlineBoundary,TEXT_BLOCK_TYPES,BLOCK_PARENT_TYPES,validateBlockPresentation} from '@yumunio/domain';
import {CollaborationError,ROOM_LIMITS,inspectUpdate,inspectStateVector} from './index.js';
import {createTextFlows,textFlowDelta,textFlowValue,textFlowAnchor,splitTextFlow,crossingFlowReferences,replaceTextFlow,formatTextFlow,textFlowPosition,textFlowOffset,clearTextFlows} from './structure-flow.js';
import {isRoomTable,seedTableCells,roomTables,tableKeys,tableData,tableCellKey,liveTableCell} from './structure-table.js';

export const STRUCTURED_ROOM_LIMITS=Object.freeze({operations:1000,nodes:1000,depth:8});
export const STRUCTURED_ROOM_FEATURES=Object.freeze(['check-state','block-transforms','content-blocks']);
const encoder=new TextEncoder(),textual=new Set([...TEXT_BLOCK_TYPES,'divider']),known=new Set([...textual,'table','file','image','bookmark','database','synced-block','breadcrumb','table-of-contents','columns','column']),parents=new Set(BLOCK_PARENT_TYPES);
const fail=(code='ROOM_CONTENT_UNSUPPORTED',status=400)=>{throw new CollaborationError(code,status);};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const json=value=>JSON.stringify(value),clone=value=>structuredClone(value);
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const same=(a,b)=>json(ordered(a))===json(ordered(b));
const canonical=value=>{const result=clone(value);const visit=items=>{for(const block of items){if(block.data?.marks){const marks=[];for(const mark of block.data.marks){const previous=marks.at(-1);if(previous&&previous.end===mark.start&&same(previous.styles,mark.styles)&&previous.href===mark.href)previous.end=mark.end;else marks.push({...mark});}block.data.marks=marks;}if(block.children)visit(block.children);}};visit(result.blocks);return result;};
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();}
function index(blocks){const map=new Map();const visit=(items,parent=null,ancestors=[])=>{for(const block of items){if(map.has(block.id))fail();map.set(block.id,{block,parent,ancestors,items,index:items.indexOf(block),depth:ancestors.length});if(block.children)visit(block.children,block.id,[...ancestors,block]);}};visit(blocks);return map;}
const layout=block=>['columns','column'].includes(block?.type)&&Array.isArray(block.children)&&(block.data===undefined||Object.keys(block.data).length===0)&&Object.keys(block).every(key=>['id','type','data','children'].includes(key));
function mutable(row){return !!row&&row.depth<8&&(known.has(row.block.type)||row.block.type==='columns'&&layout(row.block))&&row.block.data?.purpose!=='import-source'&&row.ancestors.every(parent=>parent.data?.purpose!=='import-source'&&(parents.has(parent.type)||parent.type==='columns'&&layout(parent)));}
function seed(value){exact(value,['title','blocks']);assertTitle(value.title);validateBlocks(value.blocks);if(index(value.blocks).size>STRUCTURED_ROOM_LIMITS.nodes||encoder.encode(json(value)).length>ROOM_LIMITS.documentBytes)fail('ROOM_TOO_LARGE',413);return value;}
function allNodes(doc,base){const result=index(clone(base.blocks)),nodes=doc.getMap('nodes');if(nodes.size+result.size>STRUCTURED_ROOM_LIMITS.nodes)fail('ROOM_CAPACITY',409);
 for(const[key,value]of nodes){let record;try{record=JSON.parse(value);}catch{fail();}exact(record,['id','type',...(Object.hasOwn(record,'data')?['data']:[]),...(Object.hasOwn(record,'split')?['split']:[])]);if(!id(key)||record.id!==key||!known.has(record.type)||result.has(key)||json(record)!==value)fail();const properties=typeData(record.type,record.data??{});if(record.split){exact(record.split,['source','cut']);if(!id(record.split.source)||typeof record.split.cut!=='string'||record.split.cut.length>684)fail();}else if(Object.hasOwn(record,'split'))fail();const data={...(textual.has(record.type)&&record.type!=='divider'?{text:''}:{}),...(record.type==='checklist'?{checked:false}:{}),...(record.type==='heading'?{level:1}:{}),...(record.type==='numbered-list'?{start:1}:{}),...properties};result.set(key,{block:{id:key,type:record.type,data,...(['columns','column'].includes(record.type)?{children:[]}:{} )},...(record.split?{split:record.split}:{}),parent:null,ancestors:[],items:[],index:0,depth:0});}
 for(const row of result.values())if(row.split&&!mutable(result.get(row.split.source)))fail();return result;}
function typeData(type,data){
 if(data?.mentions?.some(mention=>mention.kind!=='date')||data?.links?.some(link=>!link.attachmentId))fail();
 if(!textual.has(type)){try{if(['columns','column'].includes(type)){if(!data||typeof data!=='object'||Object.keys(data).length)fail();}else validateBlocks([{id:'validated',type,data}]);}catch{fail();}return data;}
 const allowed=[...(type==='heading'?['level']:type==='checklist'?['checked']:type==='numbered-list'?['start']:type==='code'?['language']:[]),...(type==='divider'?[]:['color','background','icon','text','marks','links','mentions'])];try{validateBlockPresentation(data);validateBlocks([{id:'validated',type,data:{...(type==='divider'?{}:{text:''}),...data}}]);}catch{fail();}if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!allowed.includes(key))||Object.hasOwn(data,'level')&&![1,2,3].includes(data.level)||Object.hasOwn(data,'checked')&&typeof data.checked!=='boolean'||Object.hasOwn(data,'start')&&(!Number.isSafeInteger(data.start)||data.start<1||data.start>999999999)||Object.hasOwn(data,'language')&&(typeof data.language!=='string'||data.language.length>100))fail();return data;
}
const textIds=nodes=>[...nodes].filter(([,row])=>mutable(row)&&textual.has(row.block.type)).map(([key])=>key);
function parseOperations(doc,nodes){const array=doc.getArray('operations');if(array.length>STRUCTURED_ROOM_LIMITS.operations)fail('ROOM_CAPACITY',409);const seen=new Set();return array.toArray().map(encoded=>{let op;try{if(typeof encoded!=='string'||encoded.length>8192)fail();op=JSON.parse(encoded);}catch{fail();}if(!id(op.id)||seen.has(op.id)||json(op)!==encoded)fail();seen.add(op.id);
 if(op.kind==='add'){exact(op,['id','kind','blockId','parentId','beforeId']);if(!id(op.blockId)||!doc.getMap('nodes').has(op.blockId))fail();}
 else if(op.kind==='move'){exact(op,['id','kind','blockIds','parentId','beforeId']);if(!Array.isArray(op.blockIds)||!op.blockIds.length||op.blockIds.length>1000||new Set(op.blockIds).size!==op.blockIds.length||op.blockIds.some(value=>!nodes.has(value)))fail();}
 else if(op.kind==='remove'){exact(op,['id','kind','blockIds','removedIds']);for(const key of ['blockIds','removedIds'])if(!Array.isArray(op[key])||!op[key].length||op[key].length>1000||new Set(op[key]).size!==op[key].length||op[key].some(value=>!nodes.has(value)))fail();if(op.blockIds.some(value=>!op.removedIds.includes(value)))fail();}
 else if(op.kind==='check'){exact(op,['id','kind','blockId','checked']);if(!id(op.blockId)||!nodes.has(op.blockId)||typeof op.checked!=='boolean')fail();}
 else if(op.kind==='split'){exact(op,['id','kind','blockId','newBlockId']);if(!nodes.has(op.blockId)||!nodes.get(op.newBlockId)?.split||nodes.get(op.newBlockId).split.source!==op.blockId)fail();}
 else if(op.kind==='merge'){exact(op,['id','kind','blockId','previousId']);if(!nodes.has(op.blockId)||!nodes.has(op.previousId)||op.blockId===op.previousId)fail();}
 else if(op.kind==='convert'){exact(op,['id','kind','blockId','type','data']);if(!nodes.has(op.blockId)||!known.has(op.type))fail();typeData(op.type,op.data);}
 else if(op.kind==='table-axis'){exact(op,['id','kind','blockId','axis','action','itemId','beforeId']);if(!isRoomTable(nodes.get(op.blockId)?.block)||!['row','column'].includes(op.axis)||!['insert','remove'].includes(op.action)||!id(op.itemId)||op.beforeId!==null&&!id(op.beforeId))fail();}
 else if(op.kind==='table-style'){exact(op,['id','kind','blockId','columnId','headerRow','alignment']);if(!isRoomTable(nodes.get(op.blockId)?.block)||(op.columnId===null?typeof op.headerRow!=='boolean'||op.alignment!==null:!id(op.columnId)||op.headerRow!==null||![null,'left','center','right'].includes(op.alignment)))fail();}
 else fail();if(['add','move'].includes(op.kind)&&(![null,...nodes.keys()].includes(op.parentId)||![null,...nodes.keys()].includes(op.beforeId)))fail();return op;});}
function replay(doc,base){seed(base);const nodes=allNodes(doc,base),tree=clone(base.blocks),active=new Set(index(tree).keys()),removed=new Set(),conflicts=[],blockedReferences=new Set(),{flows}=createTextFlows(doc,nodes,textIds(nodes));
 const ops=parseOperations(doc,nodes),initial=index(base.blocks);
 for(const op of ops){const rows=index(tree),roots=op.kind==='add'?[op.blockId]:op.blockIds;
  if(['table-axis','table-style'].includes(op.kind)){if(!mutable(nodes.get(op.blockId)))fail();continue;}
  if(op.kind==='split'){
   if(!mutable(nodes.get(op.blockId)))fail();if(active.has(op.newBlockId))fail();
   const source=rows.get(op.blockId),located=source&&splitTextFlow(flows.get(op.blockId)??[],op.newBlockId)?[op.blockId,source]:[...rows].find(([key,row])=>mutable(row)&&splitTextFlow(flows.get(key)??[],op.newBlockId));
   if(!located||['code','equation','divider','columns','column'].includes(located[1].block.type)){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
   const[targetId,target]=located,flow=flows.get(targetId),parts=splitTextFlow(flow,op.newBlockId);for(const token of crossingFlowReferences(doc,flow,op.newBlockId))blockedReferences.add(token);
   const added=clone(nodes.get(op.newBlockId).block);target.items.splice(target.index+1,0,added);flows.set(targetId,parts.left);flows.set(op.newBlockId,parts.right);active.add(op.newBlockId);continue;
  }
  if(op.kind==='merge'){
   if(!mutable(nodes.get(op.blockId))||!mutable(nodes.get(op.previousId)))fail();const row=rows.get(op.blockId),previous=rows.get(op.previousId),siblings=row?.items.filter(block=>!removed.has(block.id)),at=siblings?.findIndex(block=>block.id===op.blockId);
   if(!row||!previous||removed.has(op.blockId)||removed.has(op.previousId)||row.parent!==previous.parent||siblings[at-1]?.id!==op.previousId||!mergeable(row.block,true)||!mergeable(previous.block,false)){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
   flows.set(op.previousId,[...(flows.get(op.previousId)??[]),...(flows.get(op.blockId)??[])]);flows.set(op.blockId,[]);removed.add(op.blockId);continue;
  }
  if(op.kind==='convert'){
   if(!mutable(nodes.get(op.blockId))||['code','equation','divider'].includes(nodes.get(op.blockId).block.type))fail();const row=rows.get(op.blockId),flow=flows.get(op.blockId)??[],rich=textFlowDelta(doc,flow).some(run=>Object.keys(run.attributes??{}).length);
   if(!row||removed.has(op.blockId)||row.block.children?.length&&!parents.has(op.type)||op.type==='divider'&&(textFlowValue(doc,flow).length||row.block.children?.length)||['code','equation'].includes(op.type)&&rich){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
   row.block.type=op.type;row.block.data={...row.block.data,...op.data,...(op.type==='checklist'&&!Object.hasOwn(op.data,'checked')?{checked:false}:{}),...(op.type==='heading'&&!Object.hasOwn(op.data,'level')?{level:1}:{}),...(op.type==='numbered-list'&&!Object.hasOwn(op.data,'start')?{start:1}:{})};continue;
  }
  if(op.kind==='check'){
   const row=rows.get(op.blockId),original=initial.get(op.blockId);
   if(original&&!mutable(original))fail();
   if(!row||row.block.type!=='checklist'){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
   if(!mutable(row)||row.block.type!=='checklist')fail();
   row.block.data={...row.block.data,checked:op.checked};continue;
  }
  if(op.kind==='remove'){
   for(const root of roots)if(!mutable(rows.get(root)??initial.get(root)??nodes.get(root)))fail();
   for(const key of op.removedIds){const row=rows.get(key)??initial.get(key);if(row&&!mutable(row)&&!row.ancestors.some(parent=>roots.includes(parent.id)))fail();removed.add(key);}continue;
  }
  if(op.kind==='add'&&active.has(op.blockId))fail();
  const existing=roots.map(key=>rows.get(key));if(op.kind==='move'&&existing.some(row=>!mutable(row))) {conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
  if(op.kind==='move'&&existing.some(row=>row.ancestors.some(parent=>roots.includes(parent.id))))fail();
  const parent=op.parentId===null?null:rows.get(op.parentId);
  if(op.parentId!==null&&(!parent||(!parents.has(parent.block.type)&&!(parent.block.type==='columns'&&roots.every(id=>nodes.get(id)?.block.type==='column')))||!mutableParent(parent))){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
  if(parent&&(roots.includes(parent.block.id)||parent.ancestors.some(row=>roots.includes(row.id)))){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
  const moving=op.kind==='add'?[clone(nodes.get(op.blockId).block)]:existing.map(row=>row.block);
  const maxHeight=block=>block.children?.length?1+Math.max(...block.children.map(maxHeight)):0;
  const destinationDepth=parent?parent.depth+1:0;
  if(moving.some(block=>destinationDepth+maxHeight(block)>=8)){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
  const containsColumns=block=>block.type==='columns'||!!block.children?.some(containsColumns);
  if(parent&&(parent.block.type==='column'||parent.ancestors.some(row=>row.type==='columns'))&&moving.some(containsColumns)){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
  const destination=parent?(parent.block.children??=[]):tree;
  if(op.beforeId!==null&&(!rows.has(op.beforeId)||rows.get(op.beforeId).parent!==op.parentId||roots.includes(op.beforeId))){conflicts.push({id:op.id,code:'ROOM_OPERATION_CONFLICT'});continue;}
  if(op.kind==='move')for(const row of existing)row.items.splice(row.items.indexOf(row.block),1);
  const offset=op.beforeId===null?destination.length:destination.findIndex(block=>block.id===op.beforeId);destination.splice(offset,0,...moving);for(const root of roots)active.add(root);
 }
 // A concurrently added/moved child of a deleted parent survives at its closest live ancestor.
 const visible=items=>items.flatMap(block=>{const children=block.children?visible(block.children):undefined;if(removed.has(block.id))return children??[];return[{...block,...(children?{children}:{})}];});
 const blocks=visible(tree),tables=roomTables(doc,nodes,ops,mutable);return{blocks,nodes,conflicts,flows,blockedReferences,tables};
}
function mergeable(block,source){return !['code','equation','divider','columns','column'].includes(block.type)&&!block.children?.length&&(!source||Object.keys(block).every(key=>['id','type','data','children'].includes(key))&&Object.keys(block.data??{}).every(key=>['text','marks','links','mentions','level','checked','start'].includes(key)));}
function mutableParent(row){return row.block.type==='column'?layout(row.block)&&row.ancestors.some(parent=>parent.type==='columns')&&row.ancestors.every(parent=>parent.data?.purpose!=='import-source'&&(parents.has(parent.type)||parent.type==='columns'&&layout(parent))):mutable(row);}
function metadata(base,nodes=index(base.blocks)){const map=new Map();for(const[key,row]of nodes){const text=row.block.data?.text;if(typeof text!=='string')continue;for(const kind of ['links','mentions'])for(const[value,entry]of (row.block.data?.[kind]??[]).entries())map.set(kind+':'+key+':'+value,{blockId:key,kind,entry,text:text.slice(entry.start,entry.end)});}return map;}
function attributes(mark){return{...Object.fromEntries(mark.styles.map(style=>[style,true])),...(mark.href?{href:mark.href}:{})};}
export function createStructuredRoom(base){seed(base);const doc=new Y.Doc({gc:true});doc.transact(()=>{doc.getText('title').insert(0,base.title);doc.getMap('nodes');doc.getArray('operations');for(const[key,row]of index(base.blocks)){if(mutable(row)&&isRoomTable(row.block)){seedTableCells(doc,row.block);continue;}if(!mutable(row)||!textual.has(row.block.type)||typeof row.block.data?.text!=='string')continue;const text=doc.getText('block:'+key);text.insert(0,row.block.data.text);for(const mark of row.block.data.marks??[])text.format(mark.start,mark.end-mark.start,attributes(mark));for(const kind of ['links','mentions'])for(const[n,entry]of (row.block.data[kind]??[]).entries())text.format(entry.start,entry.end-entry.start,{[kind]:kind+':'+key+':'+n});}});validateStructuredRoom(doc,base);return doc;}
export function structuredRoomKeys(doc,base){const projected=replay(doc,base),nodes=projected.nodes;return['title',...textIds(nodes).map(key=>'block:'+key),...[...nodes].filter(([,row])=>row.split).map(([key])=>'split:'+key),...tableKeys(doc,projected.tables)];}
export const structuredRoomConflicts=(doc,base)=>clone(replay(doc,base).conflicts);
export const structuredRoomFeatures=doc=>{const kinds=new Set(doc.getArray('operations').toArray().map(encoded=>JSON.parse(encoded).kind)),nodes=[...doc.getMap('nodes').values()].map(value=>JSON.parse(value));return STRUCTURED_ROOM_FEATURES.filter(feature=>feature==='check-state'?kinds.has('check'):feature==='content-blocks'?[...doc.share.keys()].some(key=>key.startsWith('cell/'))||nodes.some(node=>!textual.has(node.type)||Object.hasOwn(node.data??{},'text')):['split','merge','convert'].some(kind=>kinds.has(kind))||nodes.some(node=>Object.hasOwn(node,'split')));};
function validateStructuredRoomUnsafe(doc,base){if(!(doc instanceof Y.Doc)||doc.store.pendingStructs||doc.store.pendingDs||doc.store.clients.size>ROOM_LIMITS.clients)fail();let count=0,length=0;for(const items of doc.store.clients.values())for(const item of items){if(++count>ROOM_LIMITS.structs||(length+=item.length)>ROOM_LIMITS.logicalLength)fail('ROOM_TOO_LARGE',413);}
 const projected=replay(doc,base),allowed=new Set(['nodes','operations',...structuredRoomKeys(doc,base)]),refs=metadata(base,projected.nodes);for(const key of doc.share.keys())if(!allowed.has(key))fail();
 for(const key of allowed)if(!['nodes','operations'].includes(key))doc.getText(key);
 // Deleted/empty runs are checked too, so a later selective undo cannot revive foreign attributes.
 for(const items of doc.store.clients.values())for(const item of items)if(item.content instanceof Y.ContentFormat){const{key,value}=item.content;if(INLINE_STYLES.includes(key)){if(value!==true&&value!==null)fail();}else if(key==='href'){if(value!==null&&(typeof value!=='string'||safeInlineHref(value)!==value))fail();}else if(['links','mentions'].includes(key)){if(value!==null&&(!refs.has(value)||refs.get(value).kind!==key||Y.findRootTypeKey(item.parent)!=='block:'+refs.get(value).blockId))fail();}else fail();}
 const title=doc.getText('title');if(title.toDelta().some(part=>typeof part.insert!=='string'||part.attributes))fail();assertTitle(title.toString());
 // Every physical field is validated, including inactive split slots and removed blocks.
 for(const key of allowed){if(['nodes','operations','title'].includes(key))continue;const text=doc.getText(key);if(text.length>100000)fail('ROOM_TOO_LARGE',413);for(const run of text.toDelta())if(typeof run.insert!=='string'||(key.startsWith('cell/')||['code','equation'].includes(projected.nodes.get(key.slice(6))?.block.type))&&run.attributes)fail();if(key.startsWith('cell/')&&text.length>4096)fail('ROOM_TOO_LARGE',413);if(projected.nodes.get(key.slice(6))?.block.type==='divider'&&text.length)fail();}
 const patch=items=>{for(const block of items){const row=projected.nodes.get(block.id);if(isRoomTable(block)&&projected.tables.has(block.id))block.data=tableData(doc,projected.tables.get(block.id));else if(mutable(row)&&textual.has(row.block.type)){
   const delta=textFlowDelta(doc,projected.flows.get(block.id)??[]);let offset=0;const marks=[],references=new Map();
   for(const part of delta){if(typeof part.insert!=='string')fail();const attrs=part.attributes??{};for(const[key,value]of Object.entries(attrs)){if(INLINE_STYLES.includes(key)){if(value!==true)fail();}else if(key==='href'){if(typeof value!=='string'||safeInlineHref(value)!==value)fail();}else if(['links','mentions'].includes(key)){const ref=refs.get(value);if(!ref||part.root!=='block:'+ref.blockId||ref.kind!==key)fail();const entries=references.get(value)??[];entries.push({start:offset,end:offset+part.insert.length});references.set(value,entries);}else fail();}
    const styles=INLINE_STYLES.filter(style=>attrs[style]);if(styles.length||attrs.href)marks.push({start:offset,end:offset+part.insert.length,styles,...(attrs.href?{href:attrs.href}:{})});offset+=part.insert.length;
   }
   const value=delta.map(run=>run.insert).join('');if(value.length>100000)fail('ROOM_TOO_LARGE',413);if(block.type==='code'&&(marks.length||references.size)||block.type==='divider'&&value.length)fail();block.data={...block.data,...(block.type==='divider'?{}:{text:value})};if(marks.length)block.data.marks=validateInlineMarks(value,marks);else delete block.data.marks;delete block.data.links;delete block.data.mentions;
   for(const[token,runs]of references){const entry=refs.get(token),start=runs[0].start,end=runs.at(-1).end;if(projected.blockedReferences.has(token)||runs.some((run,n)=>n>0&&run.start!==runs[n-1].end)||value.slice(start,end)!==entry.text||!isInlineBoundary(value,start)||!isInlineBoundary(value,end))continue;(block.data[entry.kind]??=[]).push({...entry.entry,start,end});}
   for(const kind of ['links','mentions'])block.data[kind]?.sort((a,b)=>a.start-b.start);
  }if(block.children)patch(block.children);}};
 patch(projected.blocks);const result=canonical({title:title.toString(),blocks:projected.blocks});seed(result);if(Y.encodeStateAsUpdate(doc).length>ROOM_LIMITS.stateBytes)fail('ROOM_TOO_LARGE',413);return result;
}
export function validateStructuredRoom(doc,base){try{return validateStructuredRoomUnsafe(doc,base);}catch(error){if(error instanceof CollaborationError)throw error;const wrapped=new CollaborationError('ROOM_CONTENT_UNSUPPORTED');wrapped.cause=error;throw wrapped;}}
export function loadStructuredRoom(input,base,{expectedDraft}={}){const{bytes}=inspectUpdate(input,{state:true,protocol:2}),doc=new Y.Doc({gc:true});try{Y.applyUpdate(doc,bytes);const value=validateStructuredRoom(doc,base);if(expectedDraft&&!same(value,canonical(expectedDraft)))fail('ROOM_BASELINE_MISMATCH');return doc;}catch(error){doc.destroy();if(error instanceof CollaborationError)throw error;fail();}}
export function applyStructuredUpdate(state,update,base,{expectedDraft}={}){inspectUpdate(update,{protocol:2});const doc=loadStructuredRoom(state,base,{expectedDraft});try{const previous=new Map(doc.getMap('nodes'));Y.applyUpdate(doc,update);for(const[key,value]of previous)if(doc.getMap('nodes').get(key)!==value)fail();const draft=validateStructuredRoom(doc,base);return{draft,state:Y.encodeStateAsUpdate(doc),stateVector:Y.encodeStateVector(doc),conflicts:replay(doc,base).conflicts,features:structuredRoomFeatures(doc)};}catch(error){if(error instanceof CollaborationError)throw error;fail();}finally{doc.destroy();}}
export function structuredRoomDiff(state,base,stateVector=null,{expectedDraft}={}){const doc=loadStructuredRoom(state,base,{expectedDraft});try{if(stateVector)inspectStateVector(stateVector);return{update:Y.encodeStateAsUpdate(doc,stateVector??undefined),stateVector:Y.encodeStateVector(doc),features:structuredRoomFeatures(doc)};}finally{doc.destroy();}}
export function structuredRoomOperation(doc,base,operation,{origin='local',createId=()=>crypto.randomUUID()}={}){
 const current=validateStructuredRoom(doc,base),rows=index(current.blocks),op={id:createId(),...clone(operation)};if(!id(op.id))fail();let record=null,recordId=null,erase=null;
 if(op.kind==='check'){exact(operation,['kind','blockId','checked']);const row=rows.get(op.blockId);if(!mutable(row)||row.block.type!=='checklist'||typeof op.checked!=='boolean')fail();if((row.block.data?.checked===true)===op.checked)return current;}
 if(op.kind==='add'){if(!id(op.blockId)||!known.has(op.type)||rows.has(op.blockId)||doc.getMap('nodes').has(op.blockId))fail();const type=op.type,data=op.data;delete op.type;delete op.data;recordId=op.blockId;record=json({id:op.blockId,type,...(data&&Object.keys(data).length?{data}:{})});}
 if(op.kind==='split'){
  exact(operation,['kind','blockId','newBlockId','start','end']);const row=rows.get(op.blockId),value=row?.block.data?.text;
  if(!mutable(row)||['code','equation','divider','columns'].includes(row.block.type)||!id(op.newBlockId)||rows.has(op.newBlockId)||doc.getMap('nodes').has(op.newBlockId)||typeof value!=='string'||!isInlineBoundary(value,op.start)||!isInlineBoundary(value,op.end)||op.end<op.start)fail();
  const type=['checklist','bulleted-list','numbered-list','quote'].includes(row.block.type)?row.block.type:'paragraph',data=type==='checklist'?{checked:false}:type==='numbered-list'?{start:Math.min(999999999,(row.block.data.start??1)+1)}:{};
  const flow=replay(doc,base).flows.get(op.blockId);recordId=op.newBlockId;record=json({id:recordId,type,...(Object.keys(data).length?{data}:{}),split:{source:op.blockId,cut:textFlowAnchor(doc,flow,op.start)}});erase={blockId:op.blockId,start:op.start,end:op.end};delete op.start;delete op.end;
 }
 if(op.kind==='merge'){exact(operation,['kind','blockId','previousId']);}
 if(op.kind==='convert'){exact(operation,['kind','blockId','type','data']);typeData(op.type,op.data);}
 if(op.kind==='remove'){if(!Array.isArray(op.blockIds))fail();op.removedIds=[...rows].filter(([key,row])=>op.blockIds.includes(key)||row.ancestors.some(parent=>op.blockIds.includes(parent.id))).map(([key])=>key);}
 const scaffold=target=>{if(record){target.getMap('nodes').set(recordId,record);target.getText('block:'+recordId);if(erase)target.getText('split:'+recordId);}};
 const apply=target=>{if(op.kind==='remove'){const flows=replay(target,base).flows;clearTextFlows(target,op.removedIds.map(id=>flows.get(id)??[]));}if(erase)replaceTextFlow(target,replay(target,base).flows.get(erase.blockId),erase.start,erase.end,'');target.getArray('operations').push([json(op)]);};
 const candidate=loadStructuredRoom(Y.encodeStateAsUpdate(doc),base);try{candidate.transact(()=>scaffold(candidate),'scaffold');candidate.transact(()=>apply(candidate),origin);validateStructuredRoom(candidate,base);if(replay(candidate,base).conflicts.some(value=>value.id===op.id))fail('ROOM_OPERATION_CONFLICT',409);}finally{candidate.destroy();}
 if(record)doc.transact(()=>scaffold(doc),'scaffold');doc.transact(()=>apply(doc),origin);return validateStructuredRoom(doc,base);
}
export function structuredRoomFormat(doc,base,{blockId,start,end,marks},{origin='local'}={}){
 const rows=index(validateStructuredRoom(doc,base).blocks),row=rows.get(blockId);if(!mutable(row)||['code','equation'].includes(row.block.type)||!known.has(row.block.type))fail();const flow=replay(doc,base).flows.get(blockId),value=textFlowValue(doc,flow),valid=validateInlineMarks(value,marks);if(!isInlineBoundary(value,start)||!isInlineBoundary(value,end)||end<=start)fail();
 doc.transact(()=>{formatTextFlow(doc,flow,start,end,Object.fromEntries([...INLINE_STYLES,'href'].map(key=>[key,null])));for(const mark of valid){const left=Math.max(start,mark.start),right=Math.min(end,mark.end);if(right>left)formatTextFlow(doc,flow,left,right,{...attributes(mark),...(mark.href?{links:null}:{})});}},origin);return validateStructuredRoom(doc,base);
}
export function structuredRoomText(doc,key,value,{origin='local',marks=[],base}={}){
 if(typeof value!=='string')fail();let flow;if(base&&key.startsWith('cell/')){const projected=replay(doc,base);if(!liveTableCell(key,projected.tables))fail();flow=[{key,from:null,to:null}];}else if(base&&key!=='title'){const projected=replay(doc,base),row=index(projected.blocks).get(key.slice(6));if(!key.startsWith('block:')||!mutable(row)||!textual.has(row.block.type)||row.block.type==='divider')fail();flow=projected.flows.get(row.block.id);}else{if(key!=='title'&&structuredRoomFeatures(doc).includes('block-transforms'))fail();flow=[{key,from:null,to:null}];}
 const previous=textFlowValue(doc,flow),valid=validateInlineMarks(value,marks);let start=0;while(start<previous.length&&start<value.length&&previous[start]===value[start])start++;while(!isInlineBoundary(previous,start)||!isInlineBoundary(value,start))start--;let end=0;while(end<previous.length-start&&end<value.length-start&&previous.at(-1-end)===value.at(-1-end))end++;while(!isInlineBoundary(previous,previous.length-end)||!isInlineBoundary(value,value.length-end))end--;
 const stop=value.length-end,insertedMarks=valid.filter(mark=>mark.end>start&&mark.start<stop).map(mark=>({...mark,start:Math.max(start,mark.start)-start,end:Math.min(stop,mark.end)-start}));doc.transact(()=>replaceTextFlow(doc,flow,start,previous.length-end,value.slice(start,stop),insertedMarks),origin);
}
export function structuredRoomTableKey(doc,base,{blockId,row,column}){const table=replay(doc,base).tables.get(blockId);if(!table||!Number.isSafeInteger(row)||!Number.isSafeInteger(column)||!table.rows[row]||!table.columns[column])fail();return tableCellKey(blockId,table.rows[row],table.columns[column]);}
export function structuredRoomTablePosition(doc,base,key){const parts=key.split('/');if(parts.length!==4||parts[0]!=='cell')return null;const table=replay(doc,base).tables.get(parts[1]);if(!table)return null;const row=table.rows.indexOf(parts[2]),column=table.columns.indexOf(parts[3]);return row<0||column<0?null:{blockId:parts[1],tableCell:{row,column}};}
/** Insert a reviewed forest atomically; immutable initial text is scaffolded outside selective undo. */
export function structuredRoomPaste(doc,base,after,{origin='local',createId=()=>crypto.randomUUID(),onField=()=>{}}={}){
 const before=validateStructuredRoom(doc,base);validateBlocks(after);const old=index(before.blocks),next=index(after),added=[...next].filter(([id])=>!old.has(id)),removed=[...old].filter(([id])=>!next.has(id)),gone=new Set(removed.map(([id])=>id)),records=[],commands=[],texts=[];
 if(added.length>500)fail('ROOM_TOO_LARGE',413);
 for(const [id,row]of old){const target=next.get(id);if(!target)continue;if(row.block.type!==target.block.type||row.parent!==target.parent)fail();const a=clone(row.block),b=clone(target.block);delete a.children;delete b.children;
  if(!same(a,b)){if(!textual.has(a.type)||typeof a.data?.text!=='string'||typeof b.data?.text!=='string')fail();texts.push({id,text:b.data.text,marks:b.data.marks??[]});a.data={...a.data,text:b.data.text};for(const key of ['marks','links','mentions'])if(b.data[key]?.length)a.data[key]=b.data[key];else delete a.data[key];if(!same(a,b))fail();}
 }
 if(removed.length){const roots=removed.filter(([,row])=>!row.ancestors.some(parent=>gone.has(parent.id))).map(([id])=>id);for(const id of roots)if(!mutable(old.get(id)))fail();commands.push({id:createId(),kind:'remove',blockIds:roots,removedIds:[...gone]});}
 for(const [id,row]of added){if(doc.getMap('nodes').has(id)||!known.has(row.block.type)||row.depth>=8||row.block.data?.purpose==='import-source')fail();const data=typeData(row.block.type,row.block.data??{}),record={id,type:row.block.type,...(Object.keys(data).length?{data}:{})};records.push(record);const beforeId=row.items.slice(row.index+1).find(block=>old.has(block.id)&&next.has(block.id))?.id??null;commands.push({id:createId(),kind:'add',blockId:id,parentId:row.parent,beforeId});}
 const scaffold=target=>{for(const record of records){target.getMap('nodes').set(record.id,json(record));if(textual.has(record.type)){const text=target.getText('block:'+record.id),value=record.data?.text??'';if(value)text.insert(0,value);for(const mark of record.data?.marks??[])text.format(mark.start,mark.end-mark.start,attributes(mark));for(const kind of ['links','mentions'])for(const [n,entry]of (record.data?.[kind]??[]).entries())text.format(entry.start,entry.end-entry.start,{[kind]:kind+':'+record.id+':'+n});}if(isRoomTable(record))seedTableCells(target,record);}};
 const apply=target=>{for(const command of commands)if(command.kind==='remove'){const flows=replay(target,base).flows;clearTextFlows(target,command.removedIds.map(id=>flows.get(id)??[]));}target.getArray('operations').push(commands.map(json));for(const change of texts)structuredRoomText(target,'block:'+change.id,change.text,{origin,marks:change.marks,base});};
 const candidate=loadStructuredRoom(Y.encodeStateAsUpdate(doc),base);try{candidate.transact(()=>scaffold(candidate),'scaffold');candidate.transact(()=>apply(candidate),origin);const result=validateStructuredRoom(candidate,base);if(!same(result.blocks,canonical({blocks:after}).blocks))fail('ROOM_OPERATION_CONFLICT',409);}finally{candidate.destroy();}
 doc.transact(()=>scaffold(doc),'scaffold');for(const key of structuredRoomKeys(doc,base))onField(key);doc.transact(()=>apply(doc),origin);return validateStructuredRoom(doc,base);
}
export function structuredRoomTableEdit(doc,base,{blockId,data,change={}},{origin='local',createId=()=>crypto.randomUUID(),onField=()=>{}}={}){
 const current=validateStructuredRoom(doc,base),block=index(current.blocks).get(blockId)?.block;if(!isRoomTable(block)||!isRoomTable({type:'table',data}))fail();
 const perform=operation=>{const id=createId();structuredRoomOperation(doc,base,operation(id),{origin,createId:()=>id});};
 let table=replay(doc,base).tables.get(blockId);if(!table)fail();
 if(change.kind==='text'){if(!Number.isSafeInteger(change.row)||!Number.isSafeInteger(change.column)||!table.rows[change.row]||!table.columns[change.column]||data.rows.length!==table.rows.length||data.columnAlignments.length!==table.columns.length)fail();const key=tableCellKey(blockId,table.rows[change.row],table.columns[change.column]);onField(key);structuredRoomText(doc,key,data.rows[change.row][change.column],{origin,base});return validateStructuredRoom(doc,base);}
 for(const [axis,wanted]of [['row',data.rows.length],['column',data.columnAlignments.length]]){
  let items=axis==='row'?table.rows:table.columns;
  if(wanted<items.length){if(items.length-wanted!==1||change.axis!==axis||!Number.isSafeInteger(change.index)||!items[change.index])fail();const itemId=items[change.index];perform(()=>({kind:'table-axis',blockId,axis,action:'remove',itemId,beforeId:null}));}
  else while(wanted>items.length){const at=change.kind==='paste'?items.length:Math.min(items.length,change.focus?.[axis==='row'?'row':'column']??items.length),beforeId=items[at]??null;perform(id=>({kind:'table-axis',blockId,axis,action:'insert',itemId:(axis==='row'?'r-':'c-')+id,beforeId}));table=replay(doc,base).tables.get(blockId);items=axis==='row'?table.rows:table.columns;}
  table=replay(doc,base).tables.get(blockId);
 }
 if(table.headerRow!==data.headerRow)perform(()=>({kind:'table-style',blockId,columnId:null,headerRow:data.headerRow,alignment:null}));
 for(const [column,id]of table.columns.entries())if((table.alignments.get(id)??null)!==data.columnAlignments[column])perform(()=>({kind:'table-style',blockId,columnId:id,headerRow:null,alignment:data.columnAlignments[column]}));
 doc.transact(()=>{for(const [r,row]of table.rows.entries())for(const [c,column]of table.columns.entries()){const key=tableCellKey(blockId,row,column),value=data.rows[r][c];if(doc.getText(key).toString()!==value){onField(key);structuredRoomText(doc,key,value,{origin,base});}}},origin);
 return validateStructuredRoom(doc,base);
}
export function structuredRoomSelection(doc,base,{key,start,end=start}){const projected=replay(doc,base),flow=key==='title'||liveTableCell(key,projected.tables)?[{key,from:null,to:null}]:projected.flows.get(key.slice(6));if(!flow||key!=='title'&&!liveTableCell(key,projected.tables)&&!index(projected.blocks).has(key.slice(6)))return null;const left=textFlowPosition(doc,flow,start),right=textFlowPosition(doc,flow,end);return{start:Y.createRelativePositionFromTypeIndex(left.text,left.index,0),end:Y.createRelativePositionFromTypeIndex(right.text,right.index,start===end?0:-1)};}
export function resolveStructuredRoomSelection(doc,base,saved){const left=Y.createAbsolutePositionFromRelativePosition(saved.start,doc),right=Y.createAbsolutePositionFromRelativePosition(saved.end,doc);if(!left||!right)return null;const projected=replay(doc,base),flows=new Map([['title',[{key:'title',from:null,to:null}]],...[...index(projected.blocks).keys()].map(id=>['block:'+id,projected.flows.get(id)??[]]),...tableKeys(doc,projected.tables).filter(key=>liveTableCell(key,projected.tables)).map(key=>[key,[{key,from:null,to:null}]])]);const entries=[...flows].sort(([a],[b])=>a===saved.key?-1:b===saved.key?1:0);for(const[key,flow]of entries){const start=textFlowOffset(doc,flow,left.type,left.index,saved.start.assoc),end=textFlowOffset(doc,flow,right.type,right.index,saved.end.assoc);if(start!==null&&end!==null)return{key,start:Math.min(start,end),end:Math.max(start,end)};}return null;}
