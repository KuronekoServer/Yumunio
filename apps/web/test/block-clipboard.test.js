import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks} from '@yumunio/domain';
import {BLOCK_CLIPBOARD_TYPE,serializeEditorBlockClipboard,readEditorBlockClipboard,writeEditorBlockClipboard} from '../public/block-clipboard.js';
import {removeEditorBlocks,replaceEditorBlockSelection} from '../public/editor-tree.js';
import {createSimpleTable} from '../public/simple-table.js';
import {EditorHistory,markdownPrefix} from '../public/editor-model.js';
import {createInlineEditor} from '../public/inline-editor.js';
import {inlineDomFixture} from './fixtures/inline-dom.js';
const context={origin:'https://clipboard.example.invalid',workspaceId:'workspace',pageId:'page',accountId:'actor'};
const paragraph=(id,text)=>({id,type:'paragraph',data:{text}});
const transfer=value=>({getData:type=>type===BLOCK_CLIPBOARD_TYPE?value.json:type==='text/html'?value.html:type==='text/plain'?value.text:''});

test('whole block clipboard round trips nested text, inline formatting, Japanese and tables with fresh IDs',()=>{
 const blocks=[{...paragraph('parent','日本語 🐈'),data:{text:'日本語 🐈',marks:[{start:0,end:3,styles:['bold']}],objectKey:'private-locator'},children:[paragraph('child','Nested')]},{id:'table',type:'table',data:createSimpleTable({rows:[['Name','Value'],['A','B']]})},paragraph('after','Keep')],before=structuredClone(blocks);
 const value=serializeEditorBlockClipboard(blocks,['child','parent','table'],context);assert.equal(JSON.parse(value.json).blocks.length,2);assert.doesNotMatch(value.json,/private-locator|objectKey/);assert.match(value.text,/日本語 🐈\nNested\nName\tValue/);
 let count=0;const inserted=readEditorBlockClipboard(transfer(value),context,{createId:()=> 'copy-'+(++count)});assert.equal(inserted[0].id,'copy-1');assert.equal(inserted[0].children[0].id,'copy-2');assert.deepEqual(inserted[0].data.marks,blocks[0].data.marks);assert.deepEqual(inserted[1].data,blocks[1].data);assert.doesNotThrow(()=>validateBlocks(inserted));
 const htmlOnly={getData:type=>type==='text/html'?value.html:''};assert.equal(readEditorBlockClipboard(htmlOnly,context)[0].data.text,'日本語 🐈');assert.deepEqual(blocks,before);
});

test('cut and replacement preserve surrounding subtrees and can undo or redo the entire action',()=>{
 const blocks=[paragraph('a','A'),{...paragraph('b','B'),children:[paragraph('nested','N')]},paragraph('c','C'),paragraph('d','D')],history=new EditorHistory({title:'Fixture',blocks});
 const cut=removeEditorBlocks(blocks,['b','nested','c']);assert.deepEqual(cut.blocks.map(block=>block.id),['a','d']);history.record({title:'Fixture',blocks:cut.blocks});assert.deepEqual(history.undo().draft.blocks,blocks);assert.deepEqual(history.redo().draft.blocks,cut.blocks);
 const replaced=replaceEditorBlockSelection(blocks,['b','c'],[paragraph('new','Pasted')],{createId:()=> 'tail'});assert.deepEqual(replaced.blocks.map(block=>block.id),['a','new','tail','d']);assert.equal(replaced.blocks.at(-1).data.text,'D');assert.doesNotThrow(()=>validateBlocks(replaced.blocks));assert.equal(blocks[1].children[0].id,'nested');
});

test('clipboard content rejects private import source and malformed or oversized forged payloads atomically',()=>{
 const source={...paragraph('parent','Visible'),children:[{id:'source',type:'code',data:{text:'Private import',purpose:'import-source'}}]};assert.throws(()=>serializeEditorBlockClipboard([source],['parent'],context),/BLOCK_CLIPBOARD/);
 const forged=blocks=>transfer({json:JSON.stringify({format:'yumunio-blocks',version:1,context,blocks})});
 for(const blocks of [[paragraph('same','A'),paragraph('same','B')],[{id:'x',type:'bookmark',data:{format:'web-link-v1',text:'Unsafe',url:'javascript:alert(1)'}}],[{...paragraph('x','A'),data:{text:'A',marks:[{start:0,end:2,styles:['bold']}]}}]])assert.throws(()=>readEditorBlockClipboard(forged(blocks),context));
 assert.throws(()=>readEditorBlockClipboard({getData:type=>type===BLOCK_CLIPBOARD_TYPE?'x'.repeat(800001):''},context),/CLIPBOARD_DOCUMENT_TOO_LARGE/);assert.equal(readEditorBlockClipboard({getData:()=> ''},context),null);
 const value=serializeEditorBlockClipboard([paragraph('a','A')],['a'],context);let wrote=0;assert.throws(()=>writeEditorBlockClipboard({setData(){if(++wrote===2)throw Error('Clipboard blocked');}},value),/Clipboard blocked/);
});

test('same-page attachment references survive; cross-page attachments fail and foreign workspace references are removed',()=>{
 const attachment={id:'file',type:'file',data:{format:'attachment-v1',text:'file.pdf',links:[{start:0,end:8,label:'file.pdf',pageId:'page',attachmentId:'asset'}]}};
 const value=serializeEditorBlockClipboard([attachment],['file'],context);assert.equal(readEditorBlockClipboard(transfer(value),context)[0].data.links[0].attachmentId,'asset');assert.throws(()=>readEditorBlockClipboard(transfer(value),{...context,pageId:'other'}),/BLOCK_CLIPBOARD_ATTACHMENT_PAGE/);
 const linked={...paragraph('p','Linked'),data:{text:'Linked',links:[{start:0,end:6,label:'Linked',pageId:'target'}]}};const linkValue=serializeEditorBlockClipboard([linked],['p'],context);assert.equal(readEditorBlockClipboard(transfer(linkValue),{...context,workspaceId:'other'})[0].data.links,undefined);
});

test('familiar keyboard and Markdown shortcuts apply inline code, strike, toggles and quotes without affecting IME',t=>{
 const dom=inlineDomFixture(t),changes=[],input=createInlineEditor({text:'Hello',onChange:(text,metadata)=>changes.push(metadata)});dom.select(input,0,5);
 assert.equal(input.dispatch('keydown',{key:'e',ctrlKey:true}).prevented,true);assert.ok(changes.at(-1).marks[0].styles.includes('code'));
 dom.select(input,0,5);input.dispatch('keydown',{key:'s',ctrlKey:true,shiftKey:true});assert.ok(changes.at(-1).marks[0].styles.includes('strike'));
 const before=changes.length;input.dispatch('compositionstart');input.dispatch('keydown',{key:'e',ctrlKey:true,isComposing:true});assert.equal(changes.length,before);
 assert.equal(markdownPrefix('> ').type,'toggle');assert.equal(markdownPrefix('" ').type,'quote');
});
