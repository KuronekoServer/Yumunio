import test from 'node:test';
import assert from 'node:assert/strict';
import {Y,createStructuredRoom,loadStructuredRoom,validateStructuredRoom,structuredRoomOperation,structuredRoomText,structuredRoomFeatures,structuredRoomKeys,structuredRoomPaste} from '../src/index.js';
const p=(id,text=id)=>({id,type:'paragraph',data:{text}});
const group=()=>({id:'group',type:'columns',data:{widths:[600,400]},children:[{id:'left',type:'column',children:[p('a','日本語')]},{id:'right',type:'column',children:[p('b','本文')]}]});
const fork=(doc,seed)=>loadStructuredRoom(Y.encodeStateAsUpdate(doc),seed);
const find=(doc,seed,id)=>{const walk=items=>items.flatMap(block=>[block,...walk(block.children??[])]);return walk(validateStructuredRoom(doc,seed).blocks).find(block=>block.id===id);};
test('column resizing converges with concurrent Japanese text, reconnects, and undoes only the local width',()=>{
 const seed={title:'共同編集',blocks:[group()]},initial=createStructuredRoom(seed),a=fork(initial,seed),b=fork(initial,seed),origin={},undo=new Y.UndoManager([a.getArray('operations')],{trackedOrigins:new Set([origin])});
 try{structuredRoomOperation(a,seed,{kind:'column-widths',blockId:'group',columnIds:['left','right'],widths:[700,300]},{origin});structuredRoomText(b,'block:a','日本語の編集',{base:seed});const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);assert.deepEqual(validateStructuredRoom(a,seed),validateStructuredRoom(b,seed));assert.deepEqual(find(a,seed,'group').data.widths,[700,300]);assert.equal(find(a,seed,'a').data.text,'日本語の編集');undo.undo();assert.deepEqual(find(a,seed,'group').data.widths,[600,400]);assert.equal(find(a,seed,'a').data.text,'日本語の編集');undo.redo();const restored=fork(a,seed);try{assert.deepEqual(validateStructuredRoom(restored,seed),validateStructuredRoom(a,seed));}finally{restored.destroy();}assert.ok(structuredRoomFeatures(a).includes('block-layout'));
 }finally{undo.destroy();a.destroy();b.destroy();initial.destroy();}
});
test('side placement is one undo step and preserves a peer edit inside the moved subtree',()=>{
 const seed={title:'配置',blocks:[p('a','説明'),p('b','課題')]},initial=createStructuredRoom(seed),a=fork(initial,seed),b=fork(initial,seed),origin={},undo=new Y.UndoManager([a.getArray('operations')],{trackedOrigins:new Set([origin])});
 try{structuredRoomOperation(a,seed,{kind:'columns-arrange',blockIds:['a'],targetId:'b',side:'right',groupId:'layout',columnIds:['left','right']},{origin});structuredRoomText(b,'block:a','説明の続き',{base:seed});const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);assert.deepEqual(validateStructuredRoom(a,seed),validateStructuredRoom(b,seed));assert.equal(find(a,seed,'layout').children[1].children[0].data.text,'説明の続き');undo.undo();assert.deepEqual(validateStructuredRoom(a,seed).blocks.map(block=>block.id),['a','b']);assert.equal(find(a,seed,'a').data.text,'説明の続き');undo.redo();assert.equal(find(a,seed,'layout').children[1].children[0].id,'a');assert.equal(undo.canUndo(),true);undo.undo();assert.equal(undo.canUndo(),false);
 }finally{undo.destroy();a.destroy();b.destroy();initial.destroy();}
});
test('malformed width updates and protected content leave the Yjs state unchanged',()=>{
 const seed={title:'安全な配置',blocks:[group(),p('source')]};seed.blocks[1].data.purpose='import-source';const doc=createStructuredRoom(seed);
 try{for(const op of [{kind:'column-widths',blockId:'group',columnIds:['left','right'],widths:[100,900]},{kind:'column-widths',blockId:'group',columnIds:['right','left'],widths:[500,500]},{kind:'columns-arrange',blockIds:['source'],targetId:'a',side:'left',groupId:'new',columnIds:['one','two']},{kind:'column-widths',blockId:'source',columnIds:['left','right'],widths:[500,500]}]){const before=Y.encodeStateAsUpdate(doc);assert.throws(()=>structuredRoomOperation(doc,seed,op));assert.deepEqual(Y.encodeStateAsUpdate(doc),before);}}
 finally{doc.destroy();}
});
test('weighted columns can be pasted and retain editable text and layout through reload',()=>{
 const seed={title:'貼り付け',blocks:[p('intro')]},doc=createStructuredRoom(seed);
 try{structuredRoomPaste(doc,seed,[...seed.blocks,group()]);structuredRoomText(doc,'block:a','貼り付け後の入力',{base:seed});assert.deepEqual(find(doc,seed,'group').data.widths,[600,400]);assert.equal(find(doc,seed,'a').data.text,'貼り付け後の入力');assert.ok(structuredRoomKeys(doc,seed).includes('block:a'));}finally{doc.destroy();}
});

test('attachment and database display operations retain immutable source references and converge',()=>{
 const attachment={id:'image',type:'image',data:{format:'attachment-v1',text:'image.png',links:[{start:0,end:9,label:'image.png',pageId:'page',attachmentId:'asset'}]}},database={id:'database',type:'database',data:{format:'collection-view-v1',collectionId:'source',view:{name:'Table',type:'table',filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null},visiblePropertyIds:null}},seed={title:'表示',blocks:[attachment,database,p('a','本文')]},a=createStructuredRoom(seed),b=fork(a,seed);
 try{structuredRoomOperation(a,seed,{kind:'attachment-layout',blockId:'image',layout:{width:45,align:'center'}});structuredRoomOperation(b,seed,{kind:'database-presentation',blockId:'database',presentation:{title:'この場所の課題',height:300,showTitle:false}});const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);assert.deepEqual(validateStructuredRoom(a,seed),validateStructuredRoom(b,seed));assert.deepEqual(find(a,seed,'image').data.links,attachment.data.links);assert.deepEqual(find(a,seed,'database').data.view,database.data.view);assert.equal(find(a,seed,'database').data.collectionId,'source');const before=Y.encodeStateAsUpdate(a);assert.throws(()=>structuredRoomOperation(a,seed,{kind:'database-presentation',blockId:'database',presentation:{collectionId:'other'}}));assert.deepEqual(Y.encodeStateAsUpdate(a),before);}finally{a.destroy();b.destroy();}
});
