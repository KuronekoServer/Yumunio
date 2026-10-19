import test from 'node:test';
import assert from 'node:assert/strict';
import {pasteEditorBlocks,indexEditorBlocks,canEditNestedBlock,moveEditorBlockTo,mergeEditorBlock} from '../public/editor-tree.js';
import {createAttachmentBlock,isAttachmentBlock,renderAttachmentBlock} from '../public/attachment-block.js';
import {createSimpleTable} from '../public/simple-table.js';
import {validateBlocks} from '@yumunio/domain';
import {planBlockForestMove} from '../public/block-forest.js';
import {createInlineEditor} from '../public/inline-editor.js';
import {inlineDomFixture} from './fixtures/inline-dom.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';
const table=()=>({id:'table',type:'table',data:createSimpleTable({rows:[['A','B']]})});
const image=()=>createAttachmentBlock({id:'asset',name:'日本語.png',mediaType:'image/png'},{pageId:'page',id:'image'});

test('pasting a table into a selection retains surrounding text, formatting, links and children without mutating its source',()=>{
 const blocks=[{id:'source',type:'paragraph',data:{text:'before CUT after',marks:[{start:0,end:6,styles:['bold']}],links:[{start:11,end:16,label:'after',pageId:'other'}]},children:[{id:'child',type:'paragraph',data:{text:'Child'}}]}];
 const result=pasteEditorBlocks(blocks,{blockId:'source',start:7,end:10,inserted:[table()],createId:()=> 'tail'});
 assert.equal(result.blocks[0].data.text,'before ');assert.equal(result.blocks[0].children[0].data.text,'Child');assert.deepEqual(result.blocks[0].data.marks,blocks[0].data.marks);
 assert.equal(result.blocks[1].id,'table');assert.equal(result.blocks[2].data.text,' after');assert.deepEqual(result.blocks[2].data.links,[{start:1,end:6,label:'after',pageId:'other'}]);
 assert.equal(blocks[0].data.text,'before CUT after');assert.doesNotThrow(()=>validateBlocks(result.blocks));
});
test('an empty nested paragraph becomes an attachment at the same depth and remains editable/movable/deletable',()=>{
 const blocks=[{id:'parent',type:'quote',data:{text:'Parent'},children:[{id:'empty',type:'paragraph',data:{text:''}}]}];
 const result=pasteEditorBlocks(blocks,{blockId:'empty',start:0,inserted:[image()],createId:()=> 'tail'}),locations=indexEditorBlocks(result.blocks);
 assert.deepEqual(result.blocks[0].children.map(block=>block.id),['image','tail']);assert.equal(canEditNestedBlock(locations.get('image')),true);assert.equal(isAttachmentBlock(image()),true);
 assert.doesNotThrow(()=>moveEditorBlockTo(result.blocks,{blockId:'image',targetId:'tail',placement:'after'}));
 assert.throws(()=>planBlockForestMove(result.blocks,[],{blockIds:['image'],index:0}),error=>error.code==='BLOCK_ATTACHMENTS_UNSUPPORTED');
 assert.throws(()=>mergeEditorBlock(result.blocks,'tail'),/BLOCK_MERGE_UNSUPPORTED/);
});
test('body-entry paste inserts a trailing paragraph; invalid destinations and duplicate IDs fail atomically',()=>{
 const result=pasteEditorBlocks([],{index:0,inserted:[table(),image()],createId:()=> 'tail'});assert.deepEqual(result.blocks.map(block=>block.type),['table','image','paragraph']);
 assert.deepEqual(result.focus,{blockId:'tail',start:0});assert.throws(()=>pasteEditorBlocks([table()],{blockId:'table',inserted:[image()],createId:()=> 'tail'}));
 assert.throws(()=>pasteEditorBlocks([table()],{index:1,inserted:[table()],createId:()=> 'tail'}));
});
test('inline paste/drop hooks consume files without inserting fallback text, and readonly/composing editors do not invoke them',t=>{
 const dom=inlineDomFixture(t),calls=[],changes=[],input=createInlineEditor({text:'AB',onClipboard:(data,selection,kind)=>{calls.push({data,selection,kind});return true;},onChange:value=>changes.push(value)});
 dom.select(input,1);const data={getData:()=> 'wrong fallback'};assert.equal(input.dispatch('paste',{clipboardData:data}).prevented,true);assert.equal(calls.length,1);assert.deepEqual(calls[0].selection,{start:1,end:1});assert.equal(input.textContent,'AB');assert.equal(changes.length,0);
 input.dispatch('compositionstart');input.dispatch('paste',{clipboardData:data});assert.equal(calls.length,1);
 const readonly=createInlineEditor({readOnly:true,onClipboard:()=>calls.push('readonly')});readonly.dispatch('paste',{clipboardData:data});assert.equal(calls.length,1);
});
test('image blocks use private preview/download endpoints and never render untrusted URLs or absent attachments',t=>{
 const f=settingsDomFixture(t),block=image(),asset={id:'asset',name:'<literal>.png',mediaType:'image/png'},options={document:f.doc,pageId:'page',attachments:[asset],path:id=>'/private/'+id};
 const rendered=renderAttachmentBlock(block,options);assert.equal(rendered.querySelector('img').src,'/private/asset/preview');assert.equal(rendered.querySelector('a').getAttribute('href'),'/private/asset');assert.equal(rendered.querySelector('a').textContent,asset.name);
 const absent=renderAttachmentBlock(block,{...options,pageId:'other',unavailable:'Unavailable'});assert.equal(absent.querySelectorAll('img,a').length,0);assert.equal(absent.textContent,'Unavailable');
});
