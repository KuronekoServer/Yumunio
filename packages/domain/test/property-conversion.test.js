import test from 'node:test';
import assert from 'node:assert/strict';
import {convertTextPropertyValue,planTextPropertyConversion} from '../src/index.js';

test('explicit decimal conversion accepts exact finite decimals and keeps null and empty source values independent',()=>{
 for(const [text,value]of [['0',0],['-3',-3],['12.50',12.5],['0.1',0.1],['0.00000001',1e-8],['9007199254740991',9007199254740991]])assert.deepEqual(convertTextPropertyValue(text,'number'),{value,blank:false});
 const records=[{id:'null',values:{p:null}},{id:'empty',values:{p:''}},{id:'missing',values:{}},{id:'zero',values:{p:'0'}}],before=structuredClone(records),plan=planTextPropertyConversion(records,'p','number');assert.equal(plan.valid,true);assert.equal(plan.blankCount,3);assert.deepEqual(plan.rows.map(row=>[row.sourceValue,row.value]),[[null,null],['',null],[null,null],['0',0]]);assert.deepEqual(records,before);
});
test('decimal conversion refuses ambiguous formatting and precision loss instead of rounding or treating invalid text as blank',()=>{
 for(const text of ['001','+1','1e3','1,000',' 1','1 ',' ','0x10','NaN','Infinity','.5','1.'])assert.equal(convertTextPropertyValue(text,'number').error,'CONVERSION_INVALID_NUMBER',text);
 for(const text of ['9007199254740992','9007199254740991.1','1.0000000000000001','0.1234567890123456789','-0','-0.00','0.'+'0'.repeat(126)+'1'])assert.ok(convertTextPropertyValue(text,'number').error,text);
 const plan=planTextPropertyConversion([{id:'valid',values:{p:'12'}},{id:'invalid',values:{p:'not numeric'}}],'p','number');assert.equal(plan.valid,false);assert.equal(plan.invalidCount,1);assert.equal(plan.rows[0].value,12);assert.equal(plan.rows[1].value,null);
});
test('date conversion is calendar-checked ISO only and never guesses a locale or timezone',()=>{
 assert.deepEqual(convertTextPropertyValue('2024-02-29','date'),{value:'2024-02-29',blank:false});for(const text of ['2026-02-29','2026-02-30','2026-13-01','2026-1-01','01/02/2026','2026-01-01T00:00:00Z',' 2026-01-01'])assert.equal(convertTextPropertyValue(text,'date').error,'CONVERSION_INVALID_DATE',text);
});
test('conversion plans are bounded and never reinterpret non-text properties or duplicate rows',()=>{
 assert.equal(convertTextPropertyValue(12,'number').error,'CONVERSION_NOT_TEXT');assert.throws(()=>planTextPropertyConversion([{id:'row',values:{}},{id:'row',values:{}}],'p','number'));assert.throws(()=>planTextPropertyConversion(Array.from({length:1001},(_,index)=>({id:String(index),values:{}})),'p','number'));assert.throws(()=>convertTextPropertyValue('12','person'));
});
