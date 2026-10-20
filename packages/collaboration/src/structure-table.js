import {isSimpleTableData,validateSimpleTableData,SIMPLE_TABLE_LIMITS} from '@yumunio/domain';
import {CollaborationError} from './index.js';
const fail=()=>{throw new CollaborationError('ROOM_CONTENT_UNSUPPORTED');};
export const isRoomTable=block=>block?.type==='table'&&isSimpleTableData(block.data)&&!block.children;
export const tableCellKey=(blockId,rowId,columnId)=>'cell/'+blockId+'/'+rowId+'/'+columnId;
export function seedTableCells(doc,block){if(!isRoomTable(block))return;block.data.rows.forEach((row,r)=>row.forEach((value,c)=>{const text=doc.getText(tableCellKey(block.id,'r'+r,'c'+c));if(value)text.insert(0,value);}));}
/** Stable row/column identities live in the shared operation log; each cell is an independent Y.Text. */
export function roomTables(doc,nodes,operations,mutable){
 const tables=new Map();for(const [id,row]of nodes)if(isRoomTable(row.block)&&mutable(row)){const data=row.block.data,rows=data.rows.map((_,n)=>'r'+n),columns=data.columnAlignments.map((_,n)=>'c'+n);tables.set(id,{id,rows,columns,allRows:new Set(rows),allColumns:new Set(columns),headerRow:data.headerRow,alignments:new Map(columns.map((id,n)=>[id,data.columnAlignments[n]]))});}
 for(const op of operations){if(!['table-axis','table-style'].includes(op.kind))continue;const table=tables.get(op.blockId);if(!table)fail();
  if(op.kind==='table-axis'){const rows=op.axis==='row',items=rows?table.rows:table.columns,all=rows?table.allRows:table.allColumns;
   if(op.action==='insert'){if(all.has(op.itemId)||op.itemId!==(rows?'r-':'c-')+op.id)fail();all.add(op.itemId);const before=op.beforeId===null?-1:items.indexOf(op.beforeId);items.splice(before<0?items.length:before,0,op.itemId);if(!rows)table.alignments.set(op.itemId,null);}
   else{if(!all.has(op.itemId))fail();const at=items.indexOf(op.itemId);if(at>=0&&items.length>1)items.splice(at,1);}
  }else{if(op.columnId===null)table.headerRow=op.headerRow;else{if(!table.allColumns.has(op.columnId))fail();table.alignments.set(op.columnId,op.alignment);}}
  if(table.rows.length>SIMPLE_TABLE_LIMITS.rows||table.columns.length>SIMPLE_TABLE_LIMITS.columns||table.allRows.size>512||table.allColumns.size>64)fail();
 }
 return tables;
}
export function tableKeys(doc,tables){
 const keys=new Set();for(const table of tables.values())for(const row of table.rows)for(const column of table.columns)keys.add(tableCellKey(table.id,row,column));
 for(const key of doc.share.keys())if(key.startsWith('cell/')){const parts=key.split('/'),table=tables.get(parts[1]);if(parts.length!==4||!table?.allRows.has(parts[2])||!table.allColumns.has(parts[3]))fail();keys.add(key);}
 return[...keys];
}
export function tableData(doc,table){return validateSimpleTableData({format:'simple-table-v1',headerRow:table.headerRow,columnAlignments:table.columns.map(id=>table.alignments.get(id)??null),rows:table.rows.map(row=>table.columns.map(column=>doc.getText(tableCellKey(table.id,row,column)).toString()))});}
export function liveTableCell(key,tables){const parts=key.split('/'),table=tables.get(parts[1]);return parts.length===4&&table?.rows.includes(parts[2])&&table.columns.includes(parts[3]);}
