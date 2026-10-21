/** Stored proportions are integers, independent of viewport size and device pixels. */
export const COLUMN_WIDTH_TOTAL=1000;
export const MIN_COLUMN_WIDTH=150;
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validColumnWidths(widths,count=widths?.length){
 return [2,3].includes(count)&&Array.isArray(widths)&&widths.length===count&&widths.every(value=>Number.isSafeInteger(value)&&value>=MIN_COLUMN_WIDTH)&&widths.reduce((sum,value)=>sum+value,0)===COLUMN_WIDTH_TOTAL;
}
export function validColumnData(data,count){
 return data===undefined||record(data)&&Object.keys(data).every(key=>key==='widths')&&(!Object.hasOwn(data,'widths')||validColumnWidths(data.widths,count));
}
export function isColumnWrapper(block){
 return !!block&&['columns','column'].includes(block.type)&&Object.keys(block).every(key=>['id','type','data','children'].includes(key))&&Array.isArray(block.children)&&
  (block.type==='columns'?validColumnData(block.data,block.children.length):block.data===undefined||record(block.data)&&!Object.keys(block.data).length);
}
export function equalColumnWidths(count){
 if(![2,3].includes(count))throw new TypeError('BLOCK_COLUMNS_STRUCTURE');
 return Array.from({length:count},(_,index)=>Math.floor(COLUMN_WIDTH_TOTAL/count)+(index<COLUMN_WIDTH_TOTAL%count?1:0));
}
export function columnWidths(block){return validColumnWidths(block?.data?.widths,block?.children?.length)?[...block.data.widths]:equalColumnWidths(block.children.length);}
/** Change just the adjacent pair. A third column retains its exact width. */
export function resizeColumnBoundary(widths,index,delta){
 if(!validColumnWidths(widths)||!Number.isSafeInteger(index)||index<0||index>=widths.length-1||!Number.isFinite(delta))throw new TypeError('BLOCK_COLUMNS_STRUCTURE');
 const next=[...widths],pair=next[index]+next[index+1],left=Math.max(MIN_COLUMN_WIDTH,Math.min(pair-MIN_COLUMN_WIDTH,Math.round(next[index]+delta)));
 next[index]=left;next[index+1]=pair-left;return next;
}
/** Preserve custom proportions when a column is added or the last two are merged. */
export function changeColumnCountWidths(widths,count){
 if(!validColumnWidths(widths)||![2,3].includes(count))throw new TypeError('BLOCK_COLUMNS_STRUCTURE');
 if(widths.length===count)return [...widths];
 if(count===2)return[widths[0],widths[1]+widths[2]];
 const last=333,left=Math.max(MIN_COLUMN_WIDTH,Math.min(COLUMN_WIDTH_TOTAL-last-MIN_COLUMN_WIDTH,Math.round(widths[0]*(COLUMN_WIDTH_TOTAL-last)/COLUMN_WIDTH_TOTAL)));
 return[left,COLUMN_WIDTH_TOTAL-last-left,last];
}
export function columnGridTemplate(widths){if(!validColumnWidths(widths))throw new TypeError('BLOCK_COLUMNS_STRUCTURE');return widths.map(value=>'minmax(0,'+value+'fr)').join(' ');}

export function validAttachmentLayout(layout){return record(layout)&&Object.keys(layout).length===2&&Number.isSafeInteger(layout.width)&&layout.width>=15&&layout.width<=100&&['left','center','right'].includes(layout.align);}
export function validDatabasePresentation(value){
 return record(value)&&Object.keys(value).every(key=>['title','icon','showTitle','height'].includes(key))&&
  (!Object.hasOwn(value,'title')||typeof value.title==='string'&&value.title.length<=240&&value.title.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value.title))&&
  (!Object.hasOwn(value,'icon')||typeof value.icon==='string'&&value.icon.length<=32&&value.icon.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value.icon))&&
  (!Object.hasOwn(value,'showTitle')||typeof value.showTitle==='boolean')&&
  (!Object.hasOwn(value,'height')||Number.isSafeInteger(value.height)&&value.height>=200&&value.height<=1200);
}
