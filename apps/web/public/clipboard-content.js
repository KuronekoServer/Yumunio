import {createSimpleTable,validateSimpleTableData,SIMPLE_TABLE_LIMITS} from './simple-table.js';
import {richBlocksFromHtml} from './clipboard-rich-text.js';

export const CLIPBOARD_FILE_LIMIT=16*1024*1024;
export const CLIPBOARD_BATCH_LIMIT=32*1024*1024;
const fail=code=>{throw new TypeError(code);};
const plain=value=>String(value??'').replace(/\r\n?/g,'\n');
const imageTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export const previewableImage=type=>imageTypes.has(type);

/** Read clipboard files synchronously, while the paste/drop event owns its data. */
export function clipboardFiles(data){
 let files=Array.from(data?.files??[]);
 if(!files.length)files=Array.from(data?.items??[]).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);
 if(files.length>20)fail('CLIPBOARD_FILES_TOO_LARGE');
 let total=0;
 return files.map((file,index)=>{
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>CLIPBOARD_FILE_LIMIT||(total+=file.size)>CLIPBOARD_BATCH_LIMIT)fail('CLIPBOARD_FILES_TOO_LARGE');
  const type=typeof file.type==='string'?file.type:'application/octet-stream';
  const extension=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'})[type]??'bin';
  const name=String(file.name||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\]/g,'_').slice(0,240).toWellFormed();
  return {file,name:name.trim()&&!['.','..'].includes(name)?name:`pasted-${index+1}.${extension}`,mediaType:type};
 });
}

/** Excel/Sheets text: quoted tabs/newlines and a terminal row separator are preserved. */
export function tableFromTsv(source){
 const text=plain(source);
 if(!text.includes('\t'))return null;
 if(text.length>200000)fail('SIMPLE_TABLE_TOO_LARGE');
 const rows=[];let row=[],cell='',quoted=false,closed=false;
 const saveCell=()=>{if(cell.length>SIMPLE_TABLE_LIMITS.cellCharacters)fail('SIMPLE_TABLE_TOO_LARGE');row.push(cell);if(row.length>SIMPLE_TABLE_LIMITS.columns)fail('SIMPLE_TABLE_TOO_LARGE');cell='';closed=false;};
 const saveRow=()=>{saveCell();rows.push(row);row=[];if(rows.length>SIMPLE_TABLE_LIMITS.rows)fail('SIMPLE_TABLE_TOO_LARGE');};
 for(let at=0;at<text.length;at++){
  const char=text[at];
  if(quoted){if(char==='"'){if(text[at+1]==='"'){cell+='"';at++;}else{quoted=false;closed=true;}}else cell+=char;}
  else if(char==='\t')saveCell();
  else if(char==='\n')saveRow();
  else if(char==='"'&&!cell&&!closed)quoted=true;
  else{if(closed)fail('INVALID_CLIPBOARD_TABLE');cell+=char;}
 }
 if(quoted)fail('INVALID_CLIPBOARD_TABLE');
 if(cell||row.length||!text.endsWith('\n'))saveRow();
 const width=Math.max(...rows.map(item=>item.length));
 for(const item of rows)while(item.length<width)item.push('');
 return createSimpleTable({rows,headerRow:false});
}

function cellText(cell){
 const walk=node=>{
  if(node.nodeType===3)return node.textContent;
  if(node.nodeType!==1||['SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(node.tagName))return '';
  if(node.tagName==='BR')return '\n';
  const value=Array.from(node.childNodes).map(walk).join('');
  return value+(['DIV','P','LI'].includes(node.tagName)?'\n':'');
 };
 return plain(Array.from(cell.childNodes).map(walk).join('')).replace(/\n$/,'');
}

/** Parse in an inert template. Only bounded cell text reaches the document model. */
export function tableFromHtml(html,document=globalThis.document){
 if(typeof html!=='string'||!/<table[\s>]/i.test(html))return null;
 if(html.length>2000000)fail('SIMPLE_TABLE_TOO_LARGE');
 const template=document.createElement('template');template.innerHTML=html;
 const tables=template.content.querySelectorAll('table');
 if(tables.length!==1)fail('INVALID_CLIPBOARD_TABLE');
 const table=tables[0],sourceRows=Array.from(table.rows);
 if(!sourceRows.length)return null;
 if(sourceRows.length>SIMPLE_TABLE_LIMITS.rows)fail('SIMPLE_TABLE_TOO_LARGE');
 const rows=[];
 sourceRows.forEach((source,rowIndex)=>{
  rows[rowIndex]??=[];let column=0;
  for(const cell of Array.from(source.cells)){
   while(rows[rowIndex][column]!==undefined)column++;
   const height=cell.rowSpan===0?sourceRows.length-rowIndex:Math.max(1,cell.rowSpan),width=Math.max(1,cell.colSpan);
   if(rowIndex+height>SIMPLE_TABLE_LIMITS.rows||column+width>SIMPLE_TABLE_LIMITS.columns)fail('SIMPLE_TABLE_TOO_LARGE');
   const value=cellText(cell);
   for(let y=rowIndex;y<rowIndex+height;y++)for(let x=column;x<column+width;x++){
    rows[y]??=[];if(rows[y][x]!==undefined)fail('INVALID_CLIPBOARD_TABLE');rows[y][x]=y===rowIndex&&x===column?value:'';
   }
   column+=width;
  }
 });
 const width=Math.max(...rows.map(row=>row.length));if(!width)return null;
 for(const row of rows)for(let column=0;column<width;column++)row[column]??='';
 return createSimpleTable({rows,headerRow:Array.from(sourceRows[0].cells).every(cell=>cell.tagName==='TH')});
}

export function readClipboardContent(data,{document=globalThis.document,tables=true,rich=true}={}){
 const text=data?.getData?.('text/plain')??'';
 const html=data?.getData?.('text/html')??'';let blocks;
 if(tables){
  if(rich)blocks=richBlocksFromHtml(html,document,{tableParser:node=>tableFromHtml(node.outerHTML,document)});
  if(blocks?.some(block=>block.type==='table'))return blocks.length===1?{kind:'table',table:blocks[0].data}:{kind:'blocks',blocks};
  const table=tableFromHtml(html,document)??tableFromTsv(text);if(table)return {kind:'table',table};
 }
 const files=clipboardFiles(data);if(files.length)return {kind:'files',files};
 if(rich){blocks??=richBlocksFromHtml(html,document);if(blocks)return{kind:'blocks',blocks};}
 if(rich&&/[\r\n]/.test(text)){
  const lines=plain(text).split('\n');if(lines.length>500||lines.some(line=>line.length>100000))fail('CLIPBOARD_DOCUMENT_TOO_LARGE');
  return{kind:'blocks',blocks:lines.map(text=>({id:crypto.randomUUID(),type:'paragraph',data:{text}}))};
 }
 return {kind:'text',text};
}

/** Paste into a cell as one atomic grid edit, extending rows/columns when needed. */
export function pasteTableCells(data,incoming,row,column){
 validateSimpleTableData(data);validateSimpleTableData(incoming);
 if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row>=data.rows.length||column>=data.columnAlignments.length)fail('INVALID_CLIPBOARD_TABLE');
 const rows=data.rows.map(cells=>cells.slice()),width=Math.max(data.columnAlignments.length,column+incoming.columnAlignments.length),height=Math.max(rows.length,row+incoming.rows.length);
 if(width>SIMPLE_TABLE_LIMITS.columns||height>SIMPLE_TABLE_LIMITS.rows)fail('SIMPLE_TABLE_TOO_LARGE');
 while(rows.length<height)rows.push([]);
 for(const cells of rows)while(cells.length<width)cells.push('');
 incoming.rows.forEach((cells,y)=>cells.forEach((value,x)=>{rows[row+y][column+x]=value;}));
 const alignments=data.columnAlignments.slice();while(alignments.length<width)alignments.push(null);
 return createSimpleTable({rows,headerRow:data.headerRow,columnAlignments:alignments});
}
