import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePropertyDefinitions,validatePropertyValues,validatePropertyValue,validateCollection,DomainError} from '../src/index.js';
const formula=(expression='field("amount") * 2',extra={})=>({id:'computed',name:'Computed',type:'formula',formula:{version:1,expression,resultType:'number'},...extra});
const props=()=>[{id:'amount',name:'Amount',type:'number'},formula()];
const invalid=error=>error instanceof DomainError&&error.code==='INVALID_INPUT';
test('Domain accepts versioned formula definitions and persisted null slots while rejecting authored computed values',()=>{
  assert.equal(validatePropertyDefinitions(props()).length,2);assert.deepEqual(validatePropertyValues(props(),{amount:2,computed:null}),{amount:2,computed:null});assert.throws(()=>validatePropertyValues(props(),{amount:2,computed:4}),invalid);assert.throws(()=>validatePropertyValue(formula(),0),invalid);assert.equal(validatePropertyValue(formula(),null),null);for(const definition of [formula(undefined,{required:true}),formula(undefined,{options:['A']}),formula('field("missing")'),formula('field("computed")'),{id:'a',name:'A',type:'number',formula:{version:1,expression:'1',resultType:'number'}}])assert.throws(()=>validatePropertyDefinitions([{id:'amount',name:'Amount',type:'number'},definition]),invalid);
});
test('Domain collection snapshots validate formula graphs once and preserve nullable stored records',()=>{
  const collection={id:'collection',workspaceId:'workspace',title:'Computed',properties:props(),records:[{id:'one',values:{amount:2,computed:null}},{id:'two',values:{amount:4,computed:null}}],createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z'};assert.equal(validateCollection(collection),collection);collection.records[1].values.computed=8;assert.throws(()=>validateCollection(collection),invalid);
});