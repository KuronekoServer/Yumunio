import {indexEditorBlocks,normalizeEditorBlockSelection,canEditNestedBlock,planEditorNesting} from './editor-tree.js';
const fail=()=>{throw new TypeError('ROOM_OPERATION_UNSUPPORTED');};
const shape=block=>{const result=structuredClone(block);delete result.children;return JSON.stringify(result);};
const clean=items=>items.map(block=>{const next={...block};if(block.children?.length)next.children=clean(block.children);else delete next.children;return next;});
const equal=(left,right)=>JSON.stringify(clean(left))===JSON.stringify(clean(right));
/** A checked value is an explicit assignment; repeating it must not toggle it again. */
export function prepareRoomCheckOperation(blocks,{blockId,checked}){
 const row=indexEditorBlocks(blocks).get(blockId);
 if(typeof checked!=='boolean'||!row||row.block.type!=='checklist'||!canEditNestedBlock(row))fail();
 return(row.block.data?.checked===true)===checked?null:{kind:'check',blockId,checked};
}
/** Translate a reviewed local command into identifiers, never a replacement document. */
export function prepareRoomTreeOperation(before,after,{blockIds}={}){
 const old=indexEditorBlocks(before),next=indexEditorBlocks(after),added=[...next.keys()].filter(id=>!old.has(id)),removed=[...old.keys()].filter(id=>!next.has(id));
 for(const[id,row]of old){const target=next.get(id);if(target&&shape(row.block)!==shape(target.block))fail();}
 if(added.length){if(added.length!==1||removed.length)fail();const row=next.get(added[0]),block=row.block;if(block.children?.length||!canEditNestedBlock(row)||block.type==='columns'||block.type==='column'||block.data?.purpose==='import-source')fail();const data={...block.data},text=data.text,marks=data.marks??[];delete data.text;delete data.marks;if(data.links?.length||data.mentions?.length)fail();delete data.links;delete data.mentions;
  const strip=items=>items.filter(block=>block.id!==row.block.id).map(block=>({...block,...(block.children?{children:strip(block.children)}:{})}));if(!equal(strip(after),before))fail();
  return{operation:{kind:'add',blockId:block.id,type:block.type,data,parentId:row.parentId,beforeId:row.siblings[row.index+1]?.id??null},...(typeof text==='string'?{text,marks}:{})};
 }
 if(removed.length){const gone=new Set(removed),roots=removed.filter(id=>!old.get(id).ancestors.some(parent=>gone.has(parent.id)));if(roots.some(id=>!canEditNestedBlock(old.get(id))))fail();const strip=items=>items.filter(block=>!gone.has(block.id)).map(block=>({...block,...(block.children?{children:strip(block.children)}:{})}));if(!equal(strip(before),after))fail();return{operation:{kind:'remove',blockIds:roots}};}
 if(!blockIds?.length)fail();const roots=normalizeEditorBlockSelection(before,blockIds),positions=roots.map(id=>next.get(id));if(positions.some(row=>!row)||positions.some(row=>row.parentId!==positions[0].parentId))fail();const parentId=positions[0].parentId,siblings=positions[0].siblings,first=siblings.indexOf(positions[0].block);if(roots.some((id,n)=>siblings[first+n]?.id!==id))fail();
 const excluded=new Set(roots),strip=items=>items.filter(block=>!excluded.has(block.id)).map(block=>({...block,...(block.children?{children:strip(block.children)}:{})}));if(!equal(strip(before),strip(after)))fail();return{operation:{kind:'move',blockIds:roots,parentId,beforeId:siblings[first+roots.length]?.id??null}};
}

const textTypes=new Set(['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote']);
const boundary=(text,at)=>Number.isSafeInteger(at)&&at>=0&&at<=text.length&&!(at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]));
function transformRow(blocks,blockId){const row=indexEditorBlocks(blocks).get(blockId);if(!row||!canEditNestedBlock(row)||!textTypes.has(row.block.type)||typeof row.block.data?.text!=='string')fail();return row;}
function outdentOperation(blocks,blockId){const plan=planEditorNesting(blocks,blockId,'outdent');const siblings=plan.parentId===null?blocks:indexEditorBlocks(blocks).get(plan.parentId)?.block.children;return{kind:'move',blockIds:[blockId],parentId:plan.parentId,beforeId:siblings?.[plan.index]?.id??null};}
export function prepareRoomSplitOperation(blocks,{blockId,newBlockId,start,end=start}){
 const row=transformRow(blocks,blockId),text=row.block.data.text;if(typeof newBlockId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(newBlockId)||indexEditorBlocks(blocks).has(newBlockId)||!boundary(text,start)||!boundary(text,end)||end<start)fail();
 if(!text.length&&!row.block.children?.length){if(row.parentId!==null){const parent=indexEditorBlocks(blocks).get(row.parentId);if(parent?.block.type!=='column')return{operation:outdentOperation(blocks,blockId),focus:{blockId,start:0}};}if(row.parentId===null&&row.block.type!=='paragraph')return{operation:{kind:'convert',blockId,type:'paragraph',data:{}},focus:{blockId,start:0}};}
 return{operation:{kind:'split',blockId,newBlockId,start,end},focus:{blockId:newBlockId,start:0}};
}
export function prepareRoomMergeOperation(blocks,blockId){
 const row=transformRow(blocks,blockId);if(row.block.children?.length)fail();
 if(row.index===0){if(row.parentId!==null){const parent=indexEditorBlocks(blocks).get(row.parentId);if(parent?.block.type!=='column')return{operation:outdentOperation(blocks,blockId),focus:{blockId,start:0}};return null;}if(row.block.type!=='paragraph')return{operation:{kind:'convert',blockId,type:'paragraph',data:{}},focus:{blockId,start:0}};if(!row.block.data.text&&row.siblings.length>1)return{operation:{kind:'remove',blockIds:[blockId]},focus:{blockId:row.siblings[1].id,start:0}};return null;}
 const previous=row.siblings[row.index-1];transformRow(blocks,previous.id);if(previous.children?.length||Object.keys(row.block).some(key=>!['id','type','data','children'].includes(key))||Object.keys(row.block.data).some(key=>!['text','marks','links','mentions','level','checked','start'].includes(key)))fail();
 return{operation:{kind:'merge',blockId,previousId:previous.id},focus:{blockId:previous.id,start:previous.data.text.length}};
}
export function prepareRoomConvertOperation(blocks,{blockId,choice,seedBlocks=blocks}){
 const row=indexEditorBlocks(blocks).get(blockId),original=indexEditorBlocks(seedBlocks).get(blockId)?.block;if(!row||!canEditNestedBlock(row)||!textTypes.has(row.block.type)&&!['code','divider'].includes(row.block.type)||original&&['code','divider'].includes(original.type))fail();
 const type=/^heading[123]$/.test(choice)?'heading':choice;if(!textTypes.has(type)&&!['code','divider'].includes(type)||row.block.children?.length&&!['paragraph','checklist','bulleted-list','numbered-list','quote'].includes(type)||type==='divider'&&(row.block.data?.text||row.block.children?.length)||type==='code'&&['marks','links','mentions'].some(key=>row.block.data?.[key]?.length))fail();
 const data=type==='heading'?{level:Number(choice.at(-1))}:type==='checklist'?{checked:row.block.data?.checked===true}:type==='numbered-list'?{start:1}:{};return{kind:'convert',blockId,type,data};
}
