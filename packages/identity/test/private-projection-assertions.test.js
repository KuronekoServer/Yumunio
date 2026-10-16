import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoPrivateJsonLiterals} from './fixtures/assert-private-projection.js';

const privateLiterals=['hidden-record','hidden-page','Hidden','Private',999,'999',1998,'1998',9990,'9990'];
test('privacy assertions accept readable UUIDs and numbers containing private numeric substrings',()=>{
 const projection={collection:{records:[{id:'visible-record',pageId:'4b8b064f-3bd3-4999-b86c-e9fd32aa3e80',title:'Visible',values:{amount:1999}}]},otherPageId:'7bb11998-93f4-4a20-a9ac-74148f1f0111',formulaPageId:'ddbc9990-8546-49d4-a0a8-5125078f3a8b',literal:'Privateer',label:'value-999',arrayIndices:Array(1000).fill(null)};
 assert.doesNotThrow(()=>assertNoPrivateJsonLiterals(projection,privateLiterals));
});
test('privacy assertions reject exact private IDs, titles, numeric values and numeric string leaves anywhere',()=>{
 for(const value of privateLiterals)assert.throws(()=>assertNoPrivateJsonLiterals({collection:{records:[]},metadata:[{nested:value}]},privateLiterals),{code:'ERR_ASSERTION'});
 for(const key of ['hidden-page','Private','999'])assert.throws(()=>assertNoPrivateJsonLiterals({metadata:{[key]:null}},privateLiterals),{code:'ERR_ASSERTION'});
});
