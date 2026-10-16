import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionValueInput,renderCollectionValue,renderRecordCollectionValue,collectionFieldHint} from '../public/collection-fields.js';
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this._value='';this._text='';this.multiple=false;this.selected=false;}
 set innerHTML(_value){throw new Error('HTML parsing forbidden');}
 append(...nodes){this.children.push(...nodes);}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
 set value(value){this._value=String(value);if(this.tagName==='select'&&!this.multiple)for(const option of this.options)option.selected=option.value===this._value;}
 get value(){return this.tagName==='select'?this.options.find(option=>option.selected)?.value??'':this._value;}
 get options(){return this.children.filter(node=>node.tagName==='option');}
 get selectedOptions(){return this.options.filter(option=>option.selected);}
}
const document={createElement:tag=>new Element(tag)},t=key=>({empty:'Unset',savedReference:'Saved reference',emptyText:'Empty text',formulaEmptyText:'Empty computed text',relatedRecord:'Related record',unavailableReference:'Unavailable',yes:'Yes',no:'No'})[key]??key;
const input=(property,value,options={})=>createCollectionValueInput({document,property,value,t,...options});
test('shared fields keep raw incomplete numeric drafts and empty literal text without coercing until explicit read',()=>{
 const number=input({type:'number'},'-');assert.equal(number.type,'text');assert.equal(number.inputMode,'decimal');assert.equal(number.rawValue(),'-');assert.throws(()=>number.readValue(),/invalidNumber/);assert.equal(number.rawValue(),'-');number.value='1e-';assert.throws(()=>number.readValue());number.value='0';assert.equal(number.readValue(),0);number.value='';assert.equal(number.readValue(),null);
 const text=input({type:'text'},'');assert.equal(text.readValue(),'');const checkbox=input({type:'checkbox'},'false');assert.equal(checkbox.readValue(),false);checkbox.value='';assert.equal(checkbox.readValue(),null);
});
test('saved person and relation selections absent from current ACL options remain selected until explicitly changed',()=>{
 const person=input({type:'person'},'saved-person',{people:[{accountId:'other-person',name:'Other'}]});assert.equal(person.readValue(),'saved-person');assert.equal(person.selectedOptions[0].textContent,'Saved reference');assert.equal(person.options.some(option=>option.value==='saved-person'),true);
 const relation=input({type:'relation'},['saved-record','visible-record'],{pages:[{id:'visible-record',recordId:'record',title:'Visible'},{id:'ordinary-page',title:'Not a row'}]});assert.deepEqual(relation.readValue(),['saved-record','visible-record']);assert.equal(relation.options.some(option=>option.value==='ordinary-page'),false);assert.deepEqual(new Set(relation.readValue()),new Set(['saved-record','visible-record']));
 for(const option of relation.options)option.selected=option.value==='saved-record';assert.deepEqual(relation.readValue(),['saved-record']);
});
test('all ten property kinds render literal projected values and readonly errors without HTML or hidden IDs',()=>{
 const malicious='<img src=x onerror=alert(1)>',text=renderCollectionValue({document,property:{type:'text'},value:malicious,t});assert.equal(text.tagName,'span');assert.equal(text.textContent,malicious);assert.equal(text.children.length,0);
 const empty=renderCollectionValue({document,property:{type:'text'},value:'',t}),unset=renderCollectionValue({document,property:{type:'text'},value:null,t});assert.equal(empty.textContent,'Empty text');assert.equal(unset.textContent,'Unset');
 const properties=[{id:'text',type:'text'},{id:'number',type:'number'},{id:'check',type:'checkbox'},{id:'date',type:'date'},{id:'select',type:'select'},{id:'multi',type:'multi_select'},{id:'person',type:'person'},{id:'relation',type:'relation'},{id:'formula',type:'formula',formula:{resultType:'number'}},{id:'rollup',type:'rollup',rollup:{resultType:'number'}}],values=[malicious,0,false,'2026-10-15','A',['A'],'person-A',['row-A'],1,2];
 for(const[property,index]of properties.map((p,i)=>[p,i]))assert.equal(renderRecordCollectionValue({document,property,record:{values:{[property.id]:values[index]}},t}).tagName,'span');
 const property=properties[6],record={values:{person:null},redactedProperties:['person']};assert.equal(renderRecordCollectionValue({document,property,record,t}).textContent,'Unavailable');assert.equal(collectionFieldHint(property,{record,t}),'redactedValue');
 const formula=properties[8];assert.throws(()=>input(formula,1),/computedReadOnly/);assert.equal(renderRecordCollectionValue({document,property:formula,record:{values:{formula:null},formulaErrors:{formula:{code:'FORMULA_REDACTED_INPUT'}}},t}).textContent,'FORMULA_REDACTED_INPUT');
});
test('typed controls keep multi-select strings and dates, with disabled fields explicit and filter computed values separately allowed',()=>{
 const multi=input({type:'multi_select',options:['A','B']},['B']);assert.deepEqual(multi.readValue(),['B']);const date=input({type:'date'},'2026-10-15',{disabled:true});assert.equal(date.disabled,true);assert.equal(date.readValue(),'2026-10-15');
 const computed={type:'formula',formula:{version:1,expression:'1',resultType:'number'}};const filter=input(computed,'12',{filter:true});assert.equal(filter.readValue(),12);const textarea=input({type:'text'},'<svg>');assert.equal(textarea.value,'<svg>');assert.equal(textarea.children.length,0);
});
