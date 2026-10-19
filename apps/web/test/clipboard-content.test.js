import test from 'node:test';
import assert from 'node:assert/strict';
import {clipboardFiles,tableFromTsv,tableFromHtml,readClipboardContent,pasteTableCells,CLIPBOARD_FILE_LIMIT} from '../public/clipboard-content.js';

test('plain multiline clipboard becomes separate paragraphs while literal code paste keeps line breaks',()=>{
 const data={getData:type=>type==='text/plain'?'First\r\n\r\n日本語 🐈':''},result=readClipboardContent(data);
 assert.equal(result.kind,'blocks');assert.deepEqual(result.blocks.map(block=>block.data.text),['First','','日本語 🐈']);assert.equal(new Set(result.blocks.map(block=>block.id)).size,3);
 assert.deepEqual(readClipboardContent(data,{rich:false,tables:false}),{kind:'text',text:'First\r\n\r\n日本語 🐈'});
 assert.throws(()=>readClipboardContent({getData:type=>type==='text/plain'?'a\n'.repeat(501):''}),/CLIPBOARD_DOCUMENT_TOO_LARGE/);
});
import {createSimpleTable} from '../public/simple-table.js';

test('spreadsheet paste retains tabs/newlines in quoted cells, empty cells, Japanese and formula display text',()=>{
 const table=tableFromTsv('名前\t値\t備考\r\n"日本\t語"\t42\t"一行目\n二行目 ""引用"""\r\n\t=1+1\t\r\n');
 assert.deepEqual(table.rows,[['名前','値','備考'],['日本\t語','42','一行目\n二行目 "引用"'],['','=1+1','']]);assert.equal(table.headerRow,false);
 assert.deepEqual(tableFromTsv('a\tb\nc').rows,[['a','b'],['c','']]);assert.equal(tableFromTsv('plain\ntext'),null);
});
test('oversized or incomplete spreadsheet paste fails before changing any destination',()=>{
 for(const text of ['"unclosed\tvalue','a\t'+ 'x'.repeat(4097),Array(33).fill('a').join('\t'),Array(257).fill('a\tb').join('\n')])assert.throws(()=>tableFromTsv(text));
 const original=createSimpleTable({rows:[['Keep']]}),incoming=createSimpleTable({rows:[Array(32).fill('x')]});
 assert.throws(()=>pasteTableCells(createSimpleTable({rows:[['A','B']]}),incoming,0,1),/SIMPLE_TABLE_TOO_LARGE/);assert.deepEqual(original.rows,[['Keep']]);
});
test('cell-grid paste expands the table atomically and preserves neighbors, header choice and alignment',()=>{
 const original=createSimpleTable({rows:[['Header','Keep'],['Before','Old']],columnAlignments:['left','right']}),incoming=tableFromTsv('<script>x</script>\t2\n3\t4');
 const pasted=pasteTableCells(original,incoming,1,1);
 assert.deepEqual(pasted.rows,[['Header','Keep',''],['Before','<script>x</script>','2'],['','3','4']]);
 assert.deepEqual(pasted.columnAlignments,['left','right',null]);assert.equal(pasted.headerRow,true);assert.deepEqual(original.rows,[['Header','Keep'],['Before','Old']]);
});
test('file events are captured synchronously, item fallback and generated image names work, and names cannot contain paths',()=>{
 const image={name:'',type:'image/png',size:3},path={name:'folder/example.txt',type:'text/plain',size:2};
 assert.equal(clipboardFiles({files:[image]})[0].name,'pasted-1.png');
 assert.equal(clipboardFiles({items:[{kind:'file',getAsFile:()=>path}]})[0].name,'folder_example.txt');
 assert.equal(clipboardFiles({files:[image],items:[{kind:'file',getAsFile:()=>image}]}).length,1);
 assert.throws(()=>clipboardFiles({files:[{...image,size:CLIPBOARD_FILE_LIMIT+1}]}),/CLIPBOARD_FILES_TOO_LARGE/);
 assert.throws(()=>clipboardFiles({files:Array(21).fill(image)}),/CLIPBOARD_FILES_TOO_LARGE/);
 assert.throws(()=>clipboardFiles({files:Array(3).fill({...image,size:CLIPBOARD_FILE_LIMIT})}),/CLIPBOARD_FILES_TOO_LARGE/);
});
test('spreadsheet text wins over an alternate bitmap flavor, code keeps tabs literal and rich HTML alone stays plain text',()=>{
 const data={files:[{name:'copy.png',type:'image/png',size:1}],getData:type=>type==='text/plain'?'a\tb':''};
 assert.equal(readClipboardContent(data).kind,'table');assert.equal(readClipboardContent(data,{tables:false}).kind,'files');
 assert.deepEqual(readClipboardContent({getData:type=>type==='text/plain'?'a\tb':''},{tables:false}),{kind:'text',text:'a\tb'});
 assert.deepEqual(readClipboardContent({getData:type=>type==='text/plain'?'<literal>':'<b>literal</b>'}),{kind:'text',text:'<literal>'});
 assert.equal(tableFromHtml('<p>ordinary</p>'),null);
});

// DOM-shaped cells test extraction/merge expansion; native HTML parsing is checked in browser QA.
const text=value=>({nodeType:3,textContent:value}),element=(tagName,children=[])=>({nodeType:1,tagName,childNodes:children});
const cell=(value,options={})=>({...element('TD',[text(value)]),rowSpan:1,colSpan:1,...options});
function htmlDocument(rows){return{createElement:tag=>{assert.equal(tag,'template');return{content:{querySelectorAll:selector=>{assert.equal(selector,'table');return[{rows:rows.map(cells=>({cells}))}];}}};}};}
test('HTML tables extract text only, expand merged cells without duplicates and retain line breaks',()=>{
 const head=cell('見出し',{tagName:'TH',colSpan:2}),multiline=cell('',{childNodes:[text('A'),element('BR'),element('SCRIPT',[text('evil')]),text('B')],rowSpan:2});
 const table=tableFromHtml('<table></table>',htmlDocument([[head],[multiline,cell('one')],[cell('two')]]));
 assert.deepEqual(table.rows,[['見出し',''],['A\nB','one'],['','two']]);assert.equal(table.headerRow,true);
 assert.throws(()=>tableFromHtml('<table></table>',htmlDocument([[cell('x',{colSpan:33})]])),/SIMPLE_TABLE_TOO_LARGE/);
});
