import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePageLinks,replacePageLinks,rebasePageLinks,setPageLink,removePageLinks,splitPageLinks,joinPageLinks,MAX_PAGE_LINKS} from '../src/page-links.js';
import {validateBlocks} from '../src/index.js';
const reference={start:3,end:7,label:'計画書A',pageId:'page-A'};
const text='🙂 計画書A とメモ';
test('canonical UTF16 page links reject overlaps, forged labels, surrogate splits and executable targets',()=>{
 assert.deepEqual(validatePageLinks(text,[reference]),[reference]);
 for(const links of [[{...reference,start:1}],[{...reference,label:'other'}],[reference,{...reference}],[{...reference,pageId:'../x'}],[{...reference,href:'https://example.invalid'}],[{...reference,fragment:'\n'}]])assert.throws(()=>validatePageLinks(text,links),/INVALID_PAGE_LINKS/);
 const projected={start:3,end:7,label:'計画書A',unavailable:true};assert.throws(()=>validatePageLinks(text,[projected]));assert.deepEqual(validatePageLinks(text,[projected],{allowUnavailable:true}),[projected]);assert.throws(()=>validatePageLinks(text,[{...projected,pageId:'hidden'}],{allowUnavailable:true}));
 let invoked=false;assert.throws(()=>validatePageLinks(text,[{get start(){invoked=true;return 3;}}]));assert.equal(invoked,false);
});
test('known replacement rebases surviving references and removes an intersected span as a whole',()=>{
 assert.deepEqual(replacePageLinks(text,[reference],0,0,'前'),[{...reference,start:4,end:8}]);
 assert.deepEqual(replacePageLinks(text,[reference],3,3,'前'),[{...reference,start:4,end:8}]);
 assert.deepEqual(replacePageLinks(text,[reference],7,7,'後'),[reference]);
 assert.deepEqual(replacePageLinks(text,[reference],4,4,'x'),[]);
 assert.deepEqual(replacePageLinks(text,[reference],4,5,'x'),[]);
 assert.deepEqual(replacePageLinks(text,[reference],7,text.length,''),[reference]);
 assert.deepEqual(rebasePageLinks(text,'前'+text,[reference]),[{...reference,start:4,end:8}]);
 assert.deepEqual(rebasePageLinks(text,text.replace('画','劃'),[reference]),[]);
 assert.deepEqual(rebasePageLinks(text,text,[reference]),[reference]);
});
test('authoring replaces conflicting references without mutating styles or source arrays',()=>{
 const links=[reference];const added=setPageLink(text,links,3,7,'page-B');assert.deepEqual(added,[{...reference,pageId:'page-B'}]);assert.equal(links[0].pageId,'page-A');assert.deepEqual(removePageLinks(text,added,4,5),[]);assert.deepEqual(removePageLinks(text,added,0,3),added);assert.throws(()=>setPageLink(text,[],1,2,'page-B'));assert.throws(()=>setPageLink(text,[],3,3,'page-B'));
});
test('split and merge retain complete spans and drop references cut across the split',()=>{
 assert.deepEqual(splitPageLinks(text,[reference],3,3),{beforeLinks:[],afterLinks:[{...reference,start:0,end:4}]});
 assert.deepEqual(splitPageLinks(text,[reference],5,5),{beforeLinks:[],afterLinks:[]});
 const split=splitPageLinks(text,[reference],7,7);assert.deepEqual(joinPageLinks(text.slice(0,7),split.beforeLinks,text.slice(7),split.afterLinks),[reference]);
});
test('source refs are import-only, cap is bounded, and Domain rejects malformed reserved metadata',()=>{
 const source={start:0,end:1,label:'a',sourcePageId:'source-A'};assert.throws(()=>validatePageLinks('a',[source]));assert.deepEqual(validatePageLinks('a',[source],{allowSourceReferences:true}),[source]);
 const long='a'.repeat(MAX_PAGE_LINKS+1),links=Array.from({length:MAX_PAGE_LINKS+1},(_,start)=>({start,end:start+1,label:'a',pageId:'p'}));assert.throws(()=>validatePageLinks(long,links));
 validateBlocks([{id:'b',type:'paragraph',data:{text,links:[reference]}}]);assert.throws(()=>validateBlocks([{id:'b',type:'paragraph',data:{text,links:[{...reference,label:'bad'}]}}]));
});