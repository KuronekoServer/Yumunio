import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks,validatePageAppearance,defaultPageAppearance} from '@yumunio/domain';
import {richBlocksFromNodes} from '../public/clipboard-rich-text.js';
import {outlineEntries,pageAncestors,createBookmarkBlock} from '../public/block-features.js';
import {duplicateEditorBlocks,pasteInlineFragment,pasteEditorBlocks,splitEditorBlock,mergeEditorBlock} from '../public/editor-tree.js';
import {renderToString} from '../public/math-renderer.js';
import {createStructuredRoom,validateStructuredRoom,structuredRoomText,structuredRoomOperation} from '../../../packages/collaboration/src/structure.js';
import {createInlineEditor} from '../public/inline-editor.js';
import {inlineDomFixture} from './fixtures/inline-dom.js';
const text=value=>({nodeType:3,textContent:value});
const element=(tag,content=[],attrs={})=>({nodeType:1,tagName:tag.toUpperCase(),childNodes:content.map(node=>typeof node==='string'?text(node):node),get textContent(){return this.childNodes.map(node=>node.textContent).join('');},getAttribute:key=>attrs[key]??null});

test('HTML clipboard conversion keeps semantic headings, nested lists and canonical inline formatting while discarding active content',()=>{
 let count=0;const blocks=richBlocksFromNodes([element('h2',['Heading']),element('p',['日本語 ',element('b',['bold ',element('em',['both'])]),' ',element('a',['safe'],{href:'https://example.invalid/path'}),element('a',['unsafe'],{href:'javascript:alert(1)'}),element('img',[],{src:'https://tracker.invalid/image',onerror:'bad()',alt:'alt'}),element('script',['bad()'])]),element('ol',[element('li',['First',element('ul',[element('li',['Nested'])])]),element('li',['Second'])],{start:'4'}),element('pre',['<script>literal</script>'])],{createId:()=> 'pasted-'+ ++count});
 assert.deepEqual(blocks.map(block=>block.type),['heading','paragraph','numbered-list','numbered-list','code']);assert.equal(blocks[0].data.level,2);assert.equal(blocks[1].data.text,'日本語 bold both safeunsafealt');
 assert.deepEqual(blocks[1].data.marks,[{start:4,end:9,styles:['bold']},{start:9,end:13,styles:['bold','italic']},{start:14,end:18,styles:[],href:'https://example.invalid/path'}]);
 assert.equal(blocks[2].data.start,4);assert.equal(blocks[3].data.start,5);assert.equal(blocks[2].children[0].data.text,'Nested');assert.equal(blocks[4].data.text,'<script>literal</script>');assert.doesNotThrow(()=>validateBlocks(blocks));assert.doesNotMatch(JSON.stringify(blocks),/tracker|onerror|javascript:|bad\(\)/);
});
test('clipboard parsing bounds the whole input and preserves details as a toggle without interpreting markup',()=>{
 const [toggle]=richBlocksFromNodes([element('details',[element('summary',['Open']),element('p',['Child'])])]);assert.equal(toggle.type,'toggle');assert.equal(toggle.data.text,'Open');assert.equal(toggle.children[0].data.text,'Child');
 assert.throws(()=>richBlocksFromNodes(Array.from({length:501},()=>element('p',['x']))),/CLIPBOARD_DOCUMENT_TOO_LARGE/);
 assert.throws(()=>richBlocksFromNodes([element('p',['x'.repeat(100001)])]),/CLIPBOARD_DOCUMENT_TOO_LARGE/);
});
test('rich inline paste replaces only the selected range and retains surrounding page references, styles and child blocks',()=>{
 const original=[{id:'source',type:'callout',data:{text:'A CUT B',icon:'💡',marks:[{start:0,end:1,styles:['italic']}],links:[{start:6,end:7,label:'B',pageId:'target'}]},children:[{id:'child',type:'paragraph',data:{text:'Keep'}}]}];
 const result=pasteInlineFragment(original,{blockId:'source',start:2,end:5,text:'bold',marks:[{start:0,end:4,styles:['bold']}]});assert.equal(result.blocks[0].data.text,'A bold B');assert.deepEqual(result.blocks[0].data.marks,[{start:0,end:1,styles:['italic']},{start:2,end:6,styles:['bold']}]);assert.equal(result.blocks[0].data.links[0].start,7);assert.equal(result.blocks[0].children[0].id,'child');assert.deepEqual(result.focus,{blockId:'source',start:6});assert.equal(original[0].data.text,'A CUT B');assert.doesNotThrow(()=>validateBlocks(result.blocks));
});
test('block duplication refreshes every subtree ID and retains same-page attachments without changing the original',()=>{
 const original=[{id:'parent',type:'toggle',data:{text:'Parent'},children:[{id:'child',type:'callout',data:{text:'Child',color:'blue',icon:'💡'}}]}];let sequence=0;
 const result=duplicateEditorBlocks(original,['parent','child'],{createId:()=> 'copy-'+ ++sequence});assert.equal(result.blocks.length,2);assert.equal(result.blocks[1].id,'copy-1');assert.equal(result.blocks[1].children[0].id,'copy-2');assert.equal(original.length,1);assert.doesNotThrow(()=>validateBlocks(result.blocks));
 assert.throws(()=>duplicateEditorBlocks(original,['parent'],{createId:()=> 'parent'}));assert.throws(()=>splitEditorBlock([{id:'math',type:'equation',data:{text:'x'}}],{blockId:'math',start:0,newId:'next'}));assert.throws(()=>mergeEditorBlock([{id:'math',type:'equation',data:{text:'x'}}],'math'));
});
test('outline, ancestry and bookmarks use stable block/page IDs and reject unsafe addresses',()=>{
 assert.deepEqual(outlineEntries([{id:'heading',type:'heading',data:{text:'Title',level:2}},{id:'parent',type:'toggle',data:{text:'Open'},children:[{id:'nested',type:'heading2',data:{text:'Nested'}}]}]),[{id:'heading',text:'Title',level:2},{id:'nested',text:'Nested',level:2}]);
 assert.deepEqual(pageAncestors([{id:'parent',parentId:null,title:'Parent'},{id:'child',parentId:'parent',title:'Child'}],'child').map(page=>page.id),['parent','child']);
 assert.equal(createBookmarkBlock('https://example.invalid','Title','bookmark').data.url,'https://example.invalid/');assert.throws(()=>createBookmarkBlock('javascript:alert(1)','Unsafe','bookmark'));
 assert.throws(()=>validateBlocks([{id:'toc',type:'table-of-contents',children:[]} ]));assert.throws(()=>validateBlocks([{id:'c',type:'callout',data:{text:'x',color:'url(evil)'}}]));
 assert.throws(()=>validatePageAppearance({...defaultPageAppearance(),icon:'\ud800'}));assert.doesNotThrow(()=>validatePageAppearance({...defaultPageAppearance(),icon:'📘'}));
});
test('new text blocks round trip through the structured room with presentation intact and plain equations',()=>{
 const base={title:'Shared',blocks:[{id:'toggle',type:'toggle',data:{text:'Open',color:'blue'},children:[{id:'callout',type:'callout',data:{text:'Hint',icon:'💡'}}]},{id:'math',type:'equation',data:{text:'x^2'}}]},doc=createStructuredRoom(base);
 try{structuredRoomText(doc,'block:callout','Updated',{base});structuredRoomText(doc,'block:math','y^2',{base});structuredRoomOperation(doc,base,{kind:'add',blockId:'new-callout',type:'callout',data:{icon:'📘',background:'blue'},parentId:null,beforeId:null});const result=validateStructuredRoom(doc,base);assert.equal(result.blocks[0].children[0].data.text,'Updated');assert.equal(result.blocks[0].children[0].data.icon,'💡');assert.equal(result.blocks[1].data.text,'y^2');assert.equal(result.blocks[2].data.icon,'📘');}finally{doc.destroy();}
 const malicious=renderToString('\\href{javascript:alert(1)}{click}',{output:'mathml',trust:false,throwOnError:false});assert.doesNotMatch(malicious,/href=|<script/);assert.match(renderToString('x^2',{output:'mathml'}),/<math/);
});
test('the per-editor equation cap rejects native and pasted oversized input without changing its previous content',t=>{
 const dom=inlineDomFixture(t),changes=[],input=createInlineEditor({text:'123',maxTextLength:4,onChange:value=>changes.push(value),onLimit:()=>changes.push('limit')});dom.select(input,3);input.dispatch('paste',{clipboardData:{getData:()=> '56'}});assert.equal(input.textContent,'123');assert.deepEqual(changes,['limit']);
 input.textContent='12345';input.dispatch('input',{});assert.equal(input.textContent,'123');assert.deepEqual(changes,['limit','limit']);
});
