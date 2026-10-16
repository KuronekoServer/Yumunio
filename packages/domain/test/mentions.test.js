import test from 'node:test';
import assert from 'node:assert/strict';
import {MENTION_LIMITS,validateMentions,isMentionBoundary,replaceMentions,rebaseMentions,removeMentions,setMention,splitMentions,joinMentions,validateDocument,validateBlocks} from '../src/index.js';
const options={allowUnavailable:true,allowMembershipIds:true};
const person=(start=0,end=4)=>({kind:'person',accountId:'person',start,end});
const page=(start=0,end=4)=>({kind:'page',pageId:'target',start,end});
const date=(start=0,end=4,value='2024-02-29')=>({kind:'date',date:value,start,end});

test('mentions keep only ID/date authority, validate calendar dates and distinguish input, stored bindings and redacted output',()=>{
 const values=[person(0,4),page(5,9),date(10,14)];assert.deepEqual(validateMentions('Name Page Date',values),values);
 const bound={...person(),membershipId:'generation'};assert.throws(()=>validateMentions('Name',[bound]));assert.deepEqual(validateMentions('Name',[bound],options),[bound]);
 const hidden={kind:'person',start:0,end:4,unavailable:true};assert.throws(()=>validateMentions('Name',[hidden]));assert.deepEqual(validateMentions('Name',[hidden],{allowUnavailable:true}),[hidden]);
 for(const invalid of [{...person(),name:'Forged display name'},{...person(),pageId:'target'},{...person(),accountId:'../private'},{...page(),unavailable:true},{kind:'date',start:0,end:4,unavailable:true},date(0,4,'2025-02-29'),date(0,4,'2024-04-31'),date(0,4,'0000-01-01'),date(0,4,'2024-2-29'),date(0,4,'2024-02-29T00:00:00Z')])assert.throws(()=>validateMentions('Name',[invalid],options));
 assert.doesNotThrow(()=>validateMentions('Date',[date(0,4,'0001-01-01')]));
});

test('range validation is bounded, rejects overlap and surrogate splits, and never executes input getters',()=>{
 const text='A\ud83d\ude08BC';assert.equal(isMentionBoundary(text,2),false);assert.equal(isMentionBoundary(text,3),true);for(const item of [person(1,2),person(2,3),person(-1,1),person(2,2),person(0,6)])assert.throws(()=>validateMentions(text,[item]));
 assert.throws(()=>validateMentions('abcdef',[person(0,4),page(3,6)]));assert.throws(()=>validateMentions('abcdef',[page(4,6),person(0,2)]));
 assert.throws(()=>validateMentions('x'.repeat(MENTION_LIMITS.text+1),[]));assert.throws(()=>validateMentions('x'.repeat(101),Array.from({length:101},(_,start)=>person(start,start+1))));
 let called=false;const getter=Object.defineProperty(person(),'accountId',{enumerable:true,get(){called=true;return'person';}});assert.throws(()=>validateMentions('Name',[getter]));assert.equal(called,false);
 const array=[person()];Object.defineProperty(array,'0',{enumerable:true,get(){called=true;return person();}});assert.throws(()=>validateMentions('Name',array));assert.equal(called,false);
});

test('text replacement keeps boundary insertions outside entities, drops intersected references whole and preserves membership bindings',()=>{
 const text='@Name and @Page',values=[{...person(0,5),membershipId:'generation'},page(10,15)],original=structuredClone(values);
 assert.deepEqual(replaceMentions(text,values,0,0,'X '),[{...values[0],start:2,end:7},{...values[1],start:12,end:17}]);
 assert.deepEqual(replaceMentions(text,values,5,5,'!'),[values[0],{...values[1],start:11,end:16}]);
 assert.deepEqual(replaceMentions(text,values,1,2,'x'),[values[1]]);assert.deepEqual(replaceMentions(text,values,0,5,'Other'),[values[1]]);assert.deepEqual(values,original);
});

test('IME and external single-diff rebasing never resurrect an edited or ambiguous mention',()=>{
 const values=[person(2,7),page(12,17)];assert.deepEqual(rebaseMentions('a @Name and @Page z','prefix a @Name and @Page z',values),[{...values[0],start:9,end:14},{...values[1],start:19,end:24}]);
 assert.deepEqual(rebaseMentions('a @Name and @Page z','a @Other and @Page z',values),[{...values[1],start:13,end:18}]);
 assert.deepEqual(rebaseMentions('a @Name z','b @Name y',[person(2,7)]),[]);
 assert.deepEqual(rebaseMentions('\ud83d\ude08 @Name','\ud83d\ude3a @Name',[person(3,8)]),[person(3,8)]);
});

test('split, join, set and remove preserve whole references without turning plain labels into authority',()=>{
 const text='@Name @Page',values=[person(0,5),page(6,11)],split=splitMentions(text,values,5,6);assert.deepEqual(split,{beforeMentions:[person(0,5)],afterMentions:[page(0,5)]});assert.deepEqual(joinMentions('@Name',split.beforeMentions,'@Page',split.afterMentions),[person(0,5),page(5,10)]);
 assert.deepEqual(splitMentions(text,values,2,3),{beforeMentions:[],afterMentions:[page(3,8)]});assert.deepEqual(removeMentions(text,values,1,2),[values[1]]);
 assert.deepEqual(setMention(text,values,0,5,{kind:'date',date:'2026-10-16'}),[date(0,5,'2026-10-16'),values[1]]);assert.throws(()=>setMention(text,values,0,5,{kind:'person',accountId:'person',displayName:'Fake'}));
});

test('document validation permits mentions on editable prose and rejects executable/code/source or malformed references',()=>{
 const block={id:'body',type:'paragraph',data:{text:'Name',mentions:[person()]}};const document={pageId:'page',workspaceId:'workspace',version:1,updatedAt:'2026-10-16T00:00:00.000Z',blocks:[block]};assert.equal(validateDocument(document),document);
 for(const type of ['code','divider','database'])assert.throws(()=>validateBlocks([{...block,type}]));assert.throws(()=>validateBlocks([{...block,data:{...block.data,purpose:'import-source'}}]));assert.throws(()=>validateBlocks([{...block,data:{text:'Name',mentions:[{...person(),label:'Spoof'}]}}]));
});

test('column wrappers require two or three direct columns, empty data and globally unique IDs without restricting unrelated unknown types',()=>{
 const column=id=>({id,type:'column',children:[]}),group={id:'columns',type:'columns',children:[column('left'),column('right')]};assert.equal(validateBlocks([group])[0],group);assert.doesNotThrow(()=>validateBlocks([{id:'future',type:'future-block',data:{custom:'kept'}}]));
 for(const blocks of [[column('loose')],[{...group,children:[column('one')]}],[{...group,children:[column('a'),column('b'),column('c'),column('d')]}],[{...group,children:[{id:'plain',type:'paragraph'},column('right')]}],[{...group,data:{width:2}}],[{...group,children:[{...column('left'),data:{text:'wrapper'}},column('right')]}],[{...group,children:[{...column('left'),children:[{...group,id:'nested',children:[column('nl'),column('nr')]}]},column('right')]}],[{...group,children:[column('same'),column('same')]}]])assert.throws(()=>validateBlocks(blocks));
});
