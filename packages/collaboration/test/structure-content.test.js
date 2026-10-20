import test from 'node:test';
import assert from 'node:assert/strict';
import {createSimpleTable,insertSimpleTableRow,deleteSimpleTableColumn,setSimpleTableCell} from '@yumunio/domain';
import {Y,createStructuredRoom,loadStructuredRoom,validateStructuredRoom,structuredRoomKeys,structuredRoomTableEdit,structuredRoomPaste,structuredRoomFeatures,structuredRoomTableKey,structuredRoomText,inspectUpdate} from '../src/index.js';
const paragraph=(id,text)=>({id,type:'paragraph',data:{text}});
const base=()=>({title:'共同編集',blocks:[paragraph('intro','説明'),{id:'table',type:'table',data:createSimpleTable({rows:[['名前','内容'],['課題','共有']]})},paragraph('after','続き') ]});
const fork=(doc,seed)=>loadStructuredRoom(Y.encodeStateAsUpdate(doc),seed);
const table=(doc,seed)=>validateStructuredRoom(doc,seed).blocks.find(block=>block.id==='table').data;
test('concurrent Japanese cell edits converge without duplicating the seed and selective undo retains peer text',()=>{
 const seed=base(),initial=createStructuredRoom(seed),a=fork(initial,seed),b=fork(initial,seed),origin={};
 const undo=new Y.UndoManager([a.getArray('operations'),...structuredRoomKeys(a,seed).map(key=>a.getText(key))],{trackedOrigins:new Set([origin])});
 try{structuredRoomTableEdit(a,seed,{blockId:'table',data:setSimpleTableCell(table(a,seed),1,1,'共有の文章'),change:{kind:'text',row:1,column:1}},{origin});structuredRoomTableEdit(b,seed,{blockId:'table',data:setSimpleTableCell(table(b,seed),1,1,'共同の共有'),change:{kind:'text',row:1,column:1}});
  const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);inspectUpdate(ua,{state:true,protocol:2});Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);Y.applyUpdate(a,ub);assert.deepEqual(validateStructuredRoom(a,seed),validateStructuredRoom(b,seed));assert.equal(table(a,seed).rows[1][1],'共同の共有の文章');undo.undo();assert.equal(table(a,seed).rows[1][1],'共同の共有');undo.redo();assert.equal(table(a,seed).rows[1][1],'共同の共有の文章');
 }finally{undo.destroy();a.destroy();b.destroy();initial.destroy();}
});
test('stable table row identities retain edits through concurrent insertion, column removal and reconnection',()=>{
 const seed=base(),initial=createStructuredRoom(seed),a=fork(initial,seed),b=fork(initial,seed);
 try{structuredRoomTableEdit(a,seed,{blockId:'table',data:insertSimpleTableRow(table(a,seed),1),change:{kind:'structure',focus:{row:1,column:0}}});structuredRoomTableEdit(b,seed,{blockId:'table',data:setSimpleTableCell(table(b,seed),1,1,'再接続後も保持'),change:{kind:'text',row:1,column:1}});
  const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);assert.equal(table(a,seed).rows[2][1],'再接続後も保持');assert.deepEqual(table(a,seed),table(b,seed));
  structuredRoomTableEdit(a,seed,{blockId:'table',data:deleteSimpleTableColumn(table(a,seed),0),change:{kind:'structure',axis:'column',index:0,focus:{row:0,column:0}}});const restored=fork(a,seed);try{assert.deepEqual(table(restored,seed),table(a,seed));assert.equal(table(restored,seed).rows[2][0],'再接続後も保持');assert.ok(structuredRoomFeatures(restored).includes('content-blocks'));}finally{restored.destroy();}
 }finally{a.destroy();b.destroy();initial.destroy();}
});
test('a pasted forest preserves headings, marks, columns, tables and attachments and survives duplicate delivery',()=>{
 const seed=base(),initial=createStructuredRoom(seed),a=fork(initial,seed),b=fork(initial,seed),added=[{id:'heading',type:'heading',data:{text:'見出し',level:2,marks:[{start:0,end:3,styles:['bold']}]}},{id:'columns',type:'columns',data:{},children:[{id:'left',type:'column',data:{},children:[paragraph('nested','左の段落')]},{id:'right',type:'column',data:{},children:[paragraph('nested-two','右の段落')]}]},{id:'file',type:'file',data:{format:'attachment-v1',text:'manual.pdf',links:[{start:0,end:10,label:'manual.pdf',pageId:'page',attachmentId:'asset'}]}}];
 try{const after=[...seed.blocks,...added];assert.deepEqual(structuredRoomPaste(a,seed,after).blocks,after);const update=Y.encodeStateAsUpdate(a);inspectUpdate(update,{state:true,protocol:2});Y.applyUpdate(b,update);Y.applyUpdate(b,update);assert.deepEqual(validateStructuredRoom(b,seed).blocks,after);assert.equal(b.getMap('nodes').size,7);
  const cell=structuredRoomTableKey(b,seed,{blockId:'table',row:1,column:1});structuredRoomText(b,cell,'更新',{base:seed});assert.equal(table(b,seed).rows[1][1],'更新');
 }finally{a.destroy();b.destroy();initial.destroy();}
});
