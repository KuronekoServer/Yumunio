import test from 'node:test';
import assert from 'node:assert/strict';
import {mentionQuery,mentionCandidates,validMentionDate,localMentionDate} from '../public/mention-picker-model.js';
import {createInlineEditor,insertInlineMention,patchInlineEditor} from '../public/inline-editor.js';
import {editableBlockData,validateInlineBlockMetadata} from '../public/workspace-data.js';
import {inlineDomFixture} from './fixtures/inline-dom.js';
test('mention discovery accepts Japanese and dates but leaves email, selected text and existing entities alone',()=>{
 assert.deepEqual(mentionQuery('担当 @あおい',{start:7,end:7}),{start:3,end:7,query:'あおい',expectedText:'担当 @あおい'});
 for(const value of ['a@example.invalid','abc@','@@name'])assert.equal(mentionQuery(value,{start:value.length,end:value.length}),null);
 assert.equal(mentionQuery('@name',{start:1,end:4}),null);
 assert.equal(mentionQuery('@name',{start:5,end:5},[{start:0,end:5}]),null);
 assert.equal(mentionQuery('(@2026-10-16',{start:12,end:12})?.query,'2026-10-16');
});
test('candidate search is normalized, bounded and only produces ID/date targets',()=>{
 const result=mentionCandidates([{kind:'person',accountId:'a',label:'Alice'},{kind:'page',pageId:'p',label:'ＡＢＣ ノート'}],'abc');
 assert.deepEqual(result,[{label:'ＡＢＣ ノート',text:'@ＡＢＣ ノート',target:{kind:'page',pageId:'p'}}]);
 assert.throws(()=>mentionCandidates([{kind:'person',accountId:'private',label:'secret\nname'}],''));
 assert.throws(()=>mentionCandidates([{kind:'page',pageId:'p',label:'one'},{kind:'page',pageId:'p',label:'two'}],''));
 assert.equal(mentionCandidates(Array.from({length:50},(_,i)=>({kind:'page',pageId:'p'+i,label:'Page '+i})),'',{limit:10}).length,10);
});
test('date suggestions use calendar dates including leap days and local month rollover',()=>{
 assert.equal(validMentionDate('2024-02-29'),true);for(const value of ['2026-02-29','0000-01-01','2026-13-01','2026-10-16T00:00:00Z'])assert.equal(validMentionDate(value),false);
 assert.equal(localMentionDate(new Date(2026,11,31,12),1),'2027-01-01');
 assert.equal(mentionCandidates([],'2026-10-16')[0].target.date,'2026-10-16');
});
test('inserting a person mention replaces only the live query and retains surrounding rich text',t=>{
 const dom=inlineDomFixture(t),changes=[],input=createInlineEditor({text:'Before @al after',marks:[{start:0,end:6,styles:['bold']}],onChange:(text,meta)=>changes.push({text,meta})});
 dom.select(input,10);
 assert.equal(insertInlineMention(input,{start:7,end:10,text:'@Alice',target:{kind:'person',accountId:'alice'},expectedText:'Before @al after'}),true);
 assert.equal(input.textContent,'Before @Alice after');assert.deepEqual(changes[0].meta.mentions,[{kind:'person',accountId:'alice',start:7,end:13}]);assert.equal(changes[0].meta.kind,'mention');assert.deepEqual(changes[0].meta.marks,[{start:0,end:6,styles:['bold']}]);
 assert.equal(input.childNodes[1].nodeName,'#text');assert.ok(input.childNodes.some(node=>node.className==='inline-mention inline-mention-person'));
 assert.equal(insertInlineMention(input,{start:7,end:10,text:'@Other',target:{kind:'person',accountId:'other'},expectedText:'Before @al after'}),false);assert.equal(changes.length,1);
});
test('read-only and composing input refuse insertion without changing content',t=>{
 const dom=inlineDomFixture(t);
 for(const readOnly of [true,false]){const input=createInlineEditor({text:'@a',readOnly});dom.select(input,2);if(!readOnly)input.dispatch('compositionstart');assert.equal(insertInlineMention(input,{start:0,end:2,text:'@A',target:{kind:'page',pageId:'a'},expectedText:'@a'}),false);assert.equal(input.textContent,'@a');}
});
test('pasted and remote text changes rebase or remove whole entity ranges and never render stored HTML',t=>{
 const dom=inlineDomFixture(t),input=createInlineEditor({text:'@Alice end',mentions:[{kind:'person',accountId:'a',start:0,end:6}]});
 assert.equal(patchInlineEditor(input,{text:'X @Alice end'}).applied,true);assert.deepEqual(input.getInlineState().mentions,[{kind:'person',accountId:'a',start:2,end:8}]);
 dom.select(input,4,6);input.dispatch('paste',{clipboardData:{getData:()=>'<b>'}});
 assert.equal(input.textContent,'X @A<b>ce end');assert.deepEqual(input.getInlineState().mentions,[]);assert.equal(input.childNodes.length,1);
 const before=input.getInlineState();assert.equal(patchInlineEditor(input,{text:before.text,mentions:[{kind:'page',start:0,end:100,pageId:'p'}]}).applied,false);assert.deepEqual(input.getInlineState(),before);
});
test('page/date/unavailable references render literal semantic nodes without leaking target IDs',t=>{
 inlineDomFixture(t);const input=createInlineEditor({text:'<x> date gone',readOnly:true,mentions:[{kind:'page',start:0,end:3,pageId:'p'},{kind:'date',start:4,end:8,date:'2026-10-16'},{kind:'person',start:9,end:13,unavailable:true}],pageHref:ref=>'/workspace.html?page='+ref.pageId});
 assert.equal(input.childNodes[0].nodeName,'A');assert.equal(input.childNodes[0].textContent,'<x>');assert.equal(input.childNodes[2].nodeName,'TIME');assert.equal(input.childNodes[2].getAttribute('datetime'),'2026-10-16');assert.equal(input.childNodes[4].nodeName,'SPAN');assert.equal(input.childNodes[4].getAttribute('data-account-id'),null);
});
test('workspace metadata retains dates through text changes and rejects malformed read projections',()=>{
 const original={text:'@day end',mentions:[{kind:'date',start:0,end:4,date:'2026-10-16'}],opaque:'retained'};
 assert.deepEqual(editableBlockData(original,'X @day end').mentions,[{kind:'date',start:2,end:6,date:'2026-10-16'}]);assert.equal(editableBlockData(original,'@other end').mentions,undefined);assert.equal(editableBlockData(original,'@day end').opaque,'retained');
 assert.throws(()=>validateInlineBlockMetadata([{id:'a',type:'paragraph',data:{text:'bad',mentions:[{kind:'person',start:0,end:3,accountId:'hidden',membershipId:'not-for-client'}]}}]));
});

test('server mention projections on code or import-source are refused before replacing a held draft',()=>{for(const[type,purpose]of [['code',undefined],['paragraph','import-source'],['divider',undefined],['unknown',undefined]])assert.throws(()=>validateInlineBlockMetadata([{id:'a',type,data:{text:'@day',mentions:[{kind:'date',start:0,end:4,date:'2026-10-16'}],...(purpose?{purpose}:{})}}]));});
