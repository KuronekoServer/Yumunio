export const SIMPLE_TABLE_LIMITS=Object.freeze({rows:256,columns:32,cellCharacters:4096,totalCharacters:100000});
const alignments=new Set([null,'left','center','right']);
const fail=code=>{throw new TypeError(code??'INVALID_SIMPLE_TABLE');};
function record(value){if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();const keys=Reflect.ownKeys(value);if(keys.some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))fail();return keys;}
function array(value){if(!Array.isArray(value))fail();for(let index=0;index<value.length;index++)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,String(index))??{},'value'))fail();if(Reflect.ownKeys(value).some(key=>key!=='length'&&!(typeof key==='string'&&/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length)))fail();}
/** Canonical literal-cell table. Unknown legacy table payloads are intentionally outside this schema. */
export function validateSimpleTableData(data){
 const keys=record(data);if(keys.length!==4||keys.some(key=>!['format','rows','headerRow','columnAlignments'].includes(key))||data.format!=='simple-table-v1'||typeof data.headerRow!=='boolean')fail();
 array(data.rows);if(data.rows.length<1||data.rows.length>SIMPLE_TABLE_LIMITS.rows)fail('SIMPLE_TABLE_TOO_LARGE');array(data.rows[0]);const width=data.rows[0].length;if(width<1||width>SIMPLE_TABLE_LIMITS.columns)fail('SIMPLE_TABLE_TOO_LARGE');
 let total=0;for(const row of data.rows){array(row);if(row.length!==width)fail();for(const cell of row){if(typeof cell!=='string'||cell.includes('\0'))fail();if(cell.length>SIMPLE_TABLE_LIMITS.cellCharacters||(total+=cell.length)>SIMPLE_TABLE_LIMITS.totalCharacters)fail('SIMPLE_TABLE_TOO_LARGE');}}
 array(data.columnAlignments);if(data.columnAlignments.length!==width||data.columnAlignments.some(value=>!alignments.has(value)))fail();return data;
}
export function isSimpleTableData(data){try{validateSimpleTableData(data);return true;}catch{return false;}}
export function createSimpleTable({rows=2,columns=2,headerRow=true,columnAlignments}={}){
 if(Array.isArray(rows)){rows=rows.map(row=>Array.isArray(row)?row.slice():row);columns=rows[0]?.length;}
 else{if(!Number.isInteger(rows)||rows<1||rows>SIMPLE_TABLE_LIMITS.rows||!Number.isInteger(columns)||columns<1||columns>SIMPLE_TABLE_LIMITS.columns)fail('SIMPLE_TABLE_TOO_LARGE');rows=Array.from({length:rows},()=>Array(columns).fill(''));}
 return validateSimpleTableData({format:'simple-table-v1',rows,headerRow,columnAlignments:columnAlignments===undefined?Array(columns).fill(null):columnAlignments.slice()});
}
const copy=data=>structuredClone(validateSimpleTableData(data));
function index(value,length,{end=false}={}){if(!Number.isInteger(value)||value<0||value>=length+(end?1:0))fail('SIMPLE_TABLE_INDEX');return value;}
export function setSimpleTableCell(data,row,column,text){const next=copy(data);next.rows[index(row,next.rows.length)][index(column,next.columnAlignments.length)]=text;return validateSimpleTableData(next);}
export function insertSimpleTableRow(data,position){const next=copy(data);next.rows.splice(index(position,next.rows.length,{end:true}),0,Array(next.columnAlignments.length).fill(''));return validateSimpleTableData(next);}
export function deleteSimpleTableRow(data,position){const next=copy(data);index(position,next.rows.length);if(next.rows.length===1)fail('SIMPLE_TABLE_LAST_ROW');next.rows.splice(position,1);return validateSimpleTableData(next);}
export function insertSimpleTableColumn(data,position){const next=copy(data);index(position,next.columnAlignments.length,{end:true});for(const row of next.rows)row.splice(position,0,'');next.columnAlignments.splice(position,0,null);return validateSimpleTableData(next);}
export function deleteSimpleTableColumn(data,position){const next=copy(data);index(position,next.columnAlignments.length);if(next.columnAlignments.length===1)fail('SIMPLE_TABLE_LAST_COLUMN');for(const row of next.rows)row.splice(position,1);next.columnAlignments.splice(position,1);return validateSimpleTableData(next);}
export function setSimpleTableHeader(data,headerRow){const next=copy(data);next.headerRow=headerRow;return validateSimpleTableData(next);}
export function setSimpleTableAlignment(data,column,alignment){const next=copy(data);next.columnAlignments[index(column,next.columnAlignments.length)]=alignment;return validateSimpleTableData(next);}
export function simpleTableHasContent(data,{axis,index:position}={}){validateSimpleTableData(data);if(axis==='row')return data.rows[index(position,data.rows.length)].some(value=>value.length>0);if(axis==='column'){index(position,data.columnAlignments.length);return data.rows.some(row=>row[position].length>0);}fail('SIMPLE_TABLE_INDEX');}
/** GFM needs a header. A table without one gets an empty header; JSON keeps the exact flag/rows. */
export function simpleTableToMarkdown(data){validateSimpleTableData(data);const escape=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~:\-]/g,char=>'\\'+char).replace(/\r\n|\r|\n/g,'<br>'),row=cells=>'| '+cells.map(escape).join(' | ')+' |',header=data.headerRow?data.rows[0]:Array(data.columnAlignments.length).fill(''),separator=data.columnAlignments.map(value=>value==='center'?':---:':value==='right'?'---:':value==='left'?':---':'---');return[row(header),'| '+separator.join(' | ')+' |',...data.rows.slice(data.headerRow?1:0).map(row)].join('\n');}
