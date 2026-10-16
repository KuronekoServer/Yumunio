import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalWorkspaceStore,STORAGE_KEY,parseWorkspaceJSON} from '../public/store.js';
import {validateSnapshot} from '../../../packages/prototype/src/snapshot.js';
import {buildWorkspaceExport} from '../../../packages/prototype/src/export.js';
import {EditorHistory} from '../public/editor-model.js';

function fixture(t){
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const store=new LocalWorkspaceStore({storage});t.after(()=>store.flush());return{store,values,storage};
}
const block=(id,type,text='',extra={})=>({id,type,text,checked:false,...extra});
function typedBlocks(){return[
 block('md-p','paragraph','Plain <script> **literal**'),
 block('md-h1','heading1','One'),block('md-h2','heading2','Two'),block('md-h3','heading3','Three'),
 block('md-check','checklist','Done',{checked:true}),block('md-bullet','bulleted-list','Bullet\ncontinued'),
 block('md-number','numbered-list','Number',{start:37,marks:[{start:0,end:6,styles:['bold']}]}),
 block('md-quote','quote','Quote\nnext'),block('md-divider','divider'),
 block('md-code','code','const raw = "```";\n<script>literal</script>',{language:'c++'})
];}

test('page creation starts with a writable paragraph and preserves its identity through direct typing and undo',t=>{
 const{store}=fixture(t),page=store.createPage('Direct writing');
 assert.deepEqual(page.blocks.map(item=>[item.type,item.text]),[['paragraph','']]);
 const id=page.blocks[0].id,history=new EditorHistory({title:page.title,blocks:page.blocks});
 store.updateBlock(page.id,id,{text:'Start writing'});history.record({title:page.title,blocks:page.blocks});
 assert.equal(page.blocks.length,1);assert.equal(page.blocks[0].id,id);
 store.setPageDocument(page.id,history.undo().draft);assert.equal(page.blocks[0].text,'');assert.equal(page.blocks[0].id,id);
 store.setPageDocument(page.id,history.redo().draft);assert.equal(page.blocks[0].text,'Start writing');
});

test('all flat Markdown block types roundtrip through local storage, portable validation, server validation and native export',async t=>{
 const{store,values,storage}=fixture(t),page=store.getPage('page-spec'),blocks=typedBlocks();
 store.setPageDocument(page.id,{title:page.title,blocks});assert.deepEqual(page.blocks,blocks);store.flush();
 const portable=parseWorkspaceJSON(values.get(STORAGE_KEY));assert.deepEqual(validateSnapshot(portable),portable);
 const restored=new LocalWorkspaceStore({storage});t.after(()=>restored.flush());assert.equal(restored.preserveUnreadableData,false);assert.deepEqual(restored.getPage(page.id).blocks,blocks);
 const exported=await buildWorkspaceExport(portable,{format:'native-json'}),native=JSON.parse(new TextDecoder().decode(exported.bytes));
 assert.deepEqual(native.pages.find(item=>item.id===page.id).blocks,blocks);
 assert.equal(native.schemaVersion,1);
});

test('invalid list starts, code languages, divider text and nested data fail both validators before any mutation',t=>{
 const{store}=fixture(t),page=store.getPage('page-spec'),before=store.snapshot(),revision=store.contentRevision;
 const invalid=[
  block('bad','numbered-list','item',{start:0}),block('bad','numbered-list','item',{start:1000000000}),
  block('bad','numbered-list','item',{start:1.5}),block('bad','numbered-list','item',{start:'1'}),
  block('bad','paragraph','item',{start:1}),block('bad','paragraph','item',{language:'js'}),
  block('bad','code','text',{language:'js\n```'}),block('bad','code','text',{language:'a'.repeat(101)}),
  block('bad','code','text',{language:''}),block('bad','divider','keep this text'),
  block('bad','paragraph','parent',{children:[block('child','paragraph','child')]}),
 ];
 for(const item of invalid){
  const snapshot=structuredClone(before);snapshot.pages.find(candidate=>candidate.id===page.id).blocks=[item];
  assert.throws(()=>validateSnapshot(snapshot),{code:'INVALID_SNAPSHOT'});assert.throws(()=>parseWorkspaceJSON(JSON.stringify(snapshot)));
  assert.throws(()=>store.setPageDocument(page.id,{title:page.title,blocks:[item]}));
  assert.deepEqual(store.snapshot(),before);assert.equal(store.contentRevision,revision);
 }
});

test('optional metadata accepts bounded tokens and conversion removes fields that do not belong to the new type',t=>{
 const{store}=fixture(t),page=store.getPage('page-spec');
 const blocks=[block('md-upper','numbered-list','Number',{start:999999999}),block('md-language','code','Code',{language:'a'.repeat(100)})];
 store.setPageDocument(page.id,{title:page.title,blocks});assert.deepEqual(validateSnapshot(store.snapshot()).pages.find(item=>item.id===page.id).blocks,blocks);
 store.updateBlock(page.id,'md-upper',{type:'paragraph'});store.updateBlock(page.id,'md-language',{type:'paragraph'});
 assert.equal(page.blocks[0].start,undefined);assert.equal(page.blocks[1].language,undefined);
 const before=store.snapshot(),revision=store.contentRevision;
 assert.throws(()=>store.updateBlock(page.id,'md-upper',{type:'divider'}));assert.throws(()=>store.addBlock(page.id,'divider',0,'must remain visible'));
 assert.deepEqual(store.snapshot(),before);assert.equal(store.contentRevision,revision);
});
