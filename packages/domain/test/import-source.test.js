import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks,importSourceText} from '../src/index.js';

test('structured native source retains original JSON and formats it as literal readonly text',()=>{
 const original={blocks:{root:{type:'<script>literal</script>',delta:[{insert:'😀\n日本語',attributes:{bold:true}}]}}}; const block={id:'source',type:'code',data:{text:'',purpose:'import-source',language:'json',source:original}};
 validateBlocks([block]);const before=JSON.stringify(block),text=importSourceText(block);
 assert.deepEqual(JSON.parse(text),original);assert.match(text,/<script>literal<\/script>/);assert.match(text,/日本語/);
 assert.equal(JSON.stringify(block),before);assert.equal(block.data.source,original);
});
test('legacy source text remains exact and regular code is not mistaken for import source',()=>{
 const text=String.fromCharCode(96).repeat(3)+' <literal>\nunchanged\r\n';
 assert.equal(importSourceText({type:'code',data:{purpose:'import-source',text}}),text);
 assert.equal(importSourceText({type:'code',data:{text,source:{mustNotReplace:'code'}}}),null);
 assert.equal(importSourceText({type:'paragraph',data:{purpose:'import-source',text,source:{}}}),null);
 assert.equal(importSourceText(null),null);
});

test('compact AppFlowy source expands every field without prototype mutation or changing null and absent fields',()=>{
 const rest=Object.fromEntries([['external_id',null],['unknown',{literal:'日本語 😀'}],['__proto__',{literal:'own data'}]]);
 const source={page_id:'root',blocks:[['root','page','','children',{},rest]],meta:{children_map:{children:[]},text_map:{}}};
 const block={type:'code',data:{purpose:'import-source',text:'',sourceEncoding:'appflowy-document-tuples-v1',source}};
 const before=JSON.stringify(block),expanded=JSON.parse(importSourceText(block));
 assert.equal(expanded.blocks.root.id,'root');assert.equal(expanded.blocks.root.external_id,null);
 assert.equal(Object.hasOwn(expanded.blocks.root,'external_type'),false);assert.equal(Object.hasOwn(expanded.blocks.root,'__proto__'),true);
 assert.equal(expanded.blocks.root.__proto__.literal,'own data');assert.deepEqual(expanded.blocks.root.unknown,{literal:'日本語 😀'});
 assert.equal(Object.getPrototypeOf(expanded.blocks.root),Object.prototype);assert.equal({}.literal,undefined);
 assert.equal(JSON.stringify(block),before);
});
test('malformed or unknown compact encodings remain literal reference data',()=>{
 const source={blocks:[['x','page','','children',{}, {id:'conflicting'}]]};
 const block={type:'code',data:{purpose:'import-source',text:'',sourceEncoding:'appflowy-document-tuples-v1',source}};
 assert.deepEqual(JSON.parse(importSourceText(block)),source);
 block.data.sourceEncoding='future-format';assert.deepEqual(JSON.parse(importSourceText(block)),source);
});
