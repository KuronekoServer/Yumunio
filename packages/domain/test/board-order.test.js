import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBoardOrder,orderedBoardIds,mergeVisibleBoardOrder,moveVisibleBoardRecord} from '../src/board-order.js';
test('optional saved order appends new records without reviving removed IDs and rejects malformed permutations',()=>{
 assert.deepEqual(orderedBoardIds(['a','b','new'],{recordIds:['gone','b','a']}),['b','a','new']);assert.deepEqual(orderedBoardIds(['a','b']),['a','b']);
 for(const value of [{recordIds:['a','a']},{recordIds:['bad id']},{recordIds:[],extra:true},[],{recordIds:Array.from({length:1001},(_,i)=>'a'+i)}])assert.throws(()=>validateBoardOrder(value));
});
test('visible reorder preserves hidden and filtered slots and requires an exact visible permutation',()=>{
 assert.deepEqual(mergeVisibleBoardOrder(['a','hidden','b','filtered','c'],['a','b','c'],['c','a','b']),['c','hidden','a','filtered','b']);
 for(const desired of [['b','a'],['a','a','c'],['a','hidden','b'],['a','b','new']])assert.throws(()=>mergeVisibleBoardOrder(['a','hidden','b','c'],['a','b','c'],desired));
});
test('column anchors preserve typed groups, support same-column movement and append to empty columns',()=>{
 const rows=[['a',false],['b',false],['c',0],['d',null],['e','']].map(([id,value])=>({id,values:{group:value}}));
 assert.deepEqual(moveVisibleBoardRecord(rows,{recordId:'b',targetValue:false,beforeRecordId:'a',groupBy:'group'}),['b','a','c','d','e']);
 assert.deepEqual(moveVisibleBoardRecord(rows,{recordId:'a',targetValue:0,beforeRecordId:'c',groupBy:'group'}),['b','a','c','d','e']);
 assert.deepEqual(moveVisibleBoardRecord(rows,{recordId:'a',targetValue:'empty group',beforeRecordId:null,groupBy:'group'}),['b','c','d','e','a']);
 for(const beforeRecordId of ['a','unknown','c'])assert.throws(()=>moveVisibleBoardRecord(rows,{recordId:'a',targetValue:false,beforeRecordId,groupBy:'group'}));
});
