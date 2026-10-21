import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRooms} from '../src/content-room.js';
import {Y,createStructuredRoom,toBase64} from '../../collaboration/src/index.js';

test('automatic rooms are bounded by their pages and storage rather than the first eight visited pages',()=>{
 const seed={title:'ページ',blocks:[]},doc=createStructuredRoom(seed);
 try{
  const pages=new Map(),payload={rooms:[]};
  for(let n=0;n<12;n++){const pageId='page-'+n;pages.set(pageId,{document:{version:1}});payload.rooms.push({pageId,epoch:'epoch-'+n,sequence:1,documentVersion:1,state:toBase64(Y.encodeStateAsUpdate(doc)),checkpointed:false,protocol:2,seed});}
  assert.doesNotThrow(()=>validateRooms(payload,pages));
  payload.rooms[11].pageId='page-0';assert.throws(()=>validateRooms(payload,pages));
  payload.rooms[11].pageId='missing-page';assert.throws(()=>validateRooms(payload,pages));
 }finally{doc.destroy();}
});
