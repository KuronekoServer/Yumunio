import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsDomFixture} from './fixtures/settings-dom.js';
import {createCollectionValueInput,renderCollectionValue} from '../public/collection-fields.js';
import {personCandidates} from '../public/person-picker.js';
import {parseCollectionValue,validateCollectionValue} from '../public/collections-model.js';
const people=[{accountId:'a',name:'田中'},{accountId:'b',name:'山田'},{accountId:'c',name:'田中'}],t=key=>({personRemove:'Remove {name}',savedReference:'Saved reference'})[key]??key;
function fixture(context,{value=null,filter=false,disabled=false}={}){
 const f=settingsDomFixture(context),create=f.document.createElement.bind(f.document);f.document.createElement=tag=>{const node=create(tag);Object.defineProperty(node,'children',{get:()=>node.childNodes.filter(child=>child.nodeType===1)});node.dispatchEvent=event=>{node.dispatch(event.type,{target:node});return true;};return node;};
 const root=createCollectionValueInput({document:f.document,property:{id:'assignee',name:'担当者',type:'person'},value,filter,disabled,people,t});f.document.body.append(root);const input=root.querySelector('input'),list=root.querySelector('[role=listbox]');const key=(key,extra={})=>root.dispatch('keydown',{target:input,key,...extra});
 const type=value=>{input.value=value;input.dispatch('input');};const focus=()=>{input.focus();input.dispatch('focus');};return{...f,root,input,list,key,type,focus};
}
test('hundreds of authorized members produce bounded, normalized name suggestions and never duplicate selected IDs',()=>{
 const many=Array.from({length:700},(_,index)=>({accountId:'person-'+index,name:'Member '+index}));assert.equal(personCandidates(many,'').people.length,20);assert.equal(personCandidates(many,'').total,700);assert.equal(personCandidates(many,'＠Ｍｅｍｂｅｒ ６９９').people[0].accountId,'person-699');assert.equal(personCandidates([...people,people[0]],'@田中',['a']).people[0].accountId,'c');assert.equal(personCandidates(people,'nobody').total,0);
});
test('selection commits multiple people once, query text never becomes a value, and chips can be removed by keyboard',context=>{
 const f=fixture(context,{value:'a'});let inputs=0,changes=0;f.root.addEventListener('input',()=>inputs++);f.root.addEventListener('change',()=>changes++);f.focus();f.type('@山');assert.equal(inputs,0);assert.equal(f.root.readValue(),'a');assert.equal(f.list.children.length,1);f.key('Enter');assert.deepEqual(f.root.readValue(),['a','b']);assert.equal(inputs,1);assert.equal(changes,1);assert.equal(f.input.value,'');assert.equal(f.document.activeElement,f.input);f.key('Backspace');assert.deepEqual(f.root.readValue(),['a']);assert.equal(inputs,2);f.key('Backspace');assert.deepEqual(f.root.readValue(),[]);
});
test('IME, Escape, disabled controls and single-value person filters preserve their boundaries',async context=>{
 const f=fixture(context);f.focus();f.input.dispatch('compositionstart');f.type('田中');f.key('Enter',{isComposing:true,keyCode:229});assert.equal(f.root.readValue(),null);f.input.dispatch('compositionend');await Promise.resolve();assert.equal(f.input.getAttribute('aria-expanded'),'true');f.key('ArrowDown');f.key('Enter');assert.deepEqual(f.root.readValue(),['c']);f.key('Escape');assert.equal(f.input.getAttribute('aria-expanded'),'false');assert.equal(f.document.activeElement,f.input);f.root.disabled=true;f.key('Backspace');assert.deepEqual(f.root.readValue(),['c']);assert.equal(f.input.disabled,true);
 const single=fixture(context,{filter:true});single.focus();single.type('@山');single.key('Enter');assert.equal(single.root.readValue(),'b');assert.equal(single.input.getAttribute('aria-expanded'),'false');single.key('Backspace');assert.equal(single.root.readValue(),null);
});
test('typed person lists reject duplicate, forged and oversized references, preserve legacy values and render names as text',context=>{
 assert.equal(parseCollectionValue({type:'person'},'a'),'a');assert.deepEqual(parseCollectionValue({type:'person'},['a','b']),['a','b']);assert.deepEqual(validateCollectionValue({type:'person'},['a','b']),['a','b']);
 for(const value of [['a','a'],['invalid/id'],[{}],Array.from({length:1001},(_,i)=>'a'+i)]){assert.throws(()=>parseCollectionValue({type:'person'},value));assert.throws(()=>validateCollectionValue({type:'person'},value));}assert.throws(()=>parseCollectionValue({type:'person'},['a'],{filter:true}));
 const f=fixture(context,{value:['a','b']});const raw=f.root.rawValue();raw.push('c');assert.deepEqual(f.root.readValue(),['a','b']);const display=renderCollectionValue({document:f.document,property:{type:'person'},value:['a','unknown'],people:[{accountId:'a',name:'<img src=x>'}],t});assert.match(display.textContent,/<img src=x>/);assert.match(display.textContent,/Saved reference/);assert.doesNotMatch(display.textContent,/unknown/);
});
