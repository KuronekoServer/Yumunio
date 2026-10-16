import test from 'node:test';
import assert from 'node:assert/strict';
import {compileFormulaProperties,evaluateFormulaRow,parseFormula,FormulaError,FORMULA_LIMITS} from '../src/formula.js';
const property=(id,type='number',extra={})=>({id,name:id,type,...extra});
const formula=(id,expression,resultType='number')=>property(id,'formula',{formula:{version:1,expression,resultType}});
const hasCode=code=>error=>error instanceof FormulaError&&error.code===code&&error.message===code;
const result=(expression,values={},base=[],type='number')=>evaluateFormulaRow([...base,formula('result',expression,type)],values);

test('bounded parser obeys precedence/unary/grouping and uses stable field IDs after rename',()=>{
  const properties=[property('price'),property('quantity'),formula('total','field("price") * field("quantity") + 2'),formula('discount','field("total") / 2')],values={price:12.5,quantity:4,total:null,discount:null};const program=compileFormulaProperties(properties),computed=evaluateFormulaRow(properties,values,{program});assert.equal(computed.values.total,52);assert.equal(computed.values.discount,26);assert.deepEqual(computed.errors,{});assert.deepEqual(values,{price:12.5,quantity:4,total:null,discount:null});properties[0].name='単価';assert.equal(evaluateFormulaRow(properties,{price:1,quantity:2}).values.total,4);assert.equal(result('-(2 + 3) * 4 + 10 % 3').values.result,-19);assert.equal(evaluateFormulaRow(properties,{price:2,quantity:2,total:999999},{program}).values.total,6);
});

test('explicit nulls, strict types and lazy branches have deterministic noncoercing semantics',()=>{
  assert.equal(result('coalesce(field("n"), 5) + 1',{},[property('n')]).values.result,6);assert.equal(result('field("n") + 1',{},[property('n')]).values.result,null);assert.equal(result('if(true, 7, 1 / 0)').values.result,7);assert.equal(result('if(null, 1, 2)').values.result,null);assert.equal(result('false && (1 / 0 > 2)',{},[],'checkbox').values.result,false);assert.equal(result('true || (1 / 0 > 2)',{},[],'checkbox').values.result,true);assert.equal(result('empty(0)',{},[],'checkbox').values.result,false);assert.equal(result('empty(false)',{},[],'checkbox').values.result,false);assert.equal(result('empty(null)',{},[],'checkbox').values.result,true);assert.throws(()=>compileFormulaProperties([formula('x','1 + "2"')]),hasCode('FORMULA_TYPE'));
});

test('text/Unicode, numeric helpers and UTC calendar functions return scalar values only',()=>{
  assert.equal(result('length("日本語😀")').values.result,4);assert.equal(result('concat(upper(trim(" hello ")), " ", toText(12))',{},[],'text').values.result,'HELLO 12');assert.equal(result('min(4, abs(-7), round(1.235, 2))').values.result,1.24);assert.equal(result('floor(3.9) + ceil(0.1)').values.result,4);assert.equal(result('toNumber("-12.5e1")').values.result,-125);assert.equal(result('dateAdd(date("2024-02-28"), 1)',{},[],'date').values.result,'2024-02-29');assert.equal(result('dateBetween(date("2024-03-01"), date("2024-02-28"))').values.result,2);assert.equal(result('dateAdd(field("date"), -1)',{date:'2026-10-15'},[property('date','date')],'date').values.result,'2026-10-14');
});

test('multi-select length is supported while raw person/relation/list operations are rejected',()=>{
  assert.equal(result('length(field("tags"))',{tags:['A','B']},[property('tags','multi_select')]).values.result,2);for(const type of ['person','relation'])assert.throws(()=>compileFormulaProperties([property('private',type),formula('x','length(field("private"))')]),hasCode('FORMULA_UNSUPPORTED_REFERENCE'));for(const expression of ['toText(field("tags"))','empty(field("tags"))','field("tags") == field("tags")','coalesce(field("tags"), null)'])assert.throws(()=>compileFormulaProperties([property('tags','multi_select'),formula('x',expression)]),error=>error instanceof FormulaError);
});

test('static dependency and result type checks reject missing fields, cycles, unknown functions and wrong arity',()=>{
  assert.throws(()=>compileFormulaProperties([formula('x','field("missing")')]),hasCode('FORMULA_REFERENCE'));assert.throws(()=>compileFormulaProperties([formula('x','field("x")')]),hasCode('FORMULA_CYCLE'));assert.throws(()=>compileFormulaProperties([formula('a','field("b")'),formula('b','field("a")')]),hasCode('FORMULA_CYCLE'));assert.throws(()=>compileFormulaProperties([formula('x','"text"')]),hasCode('FORMULA_TYPE'));assert.throws(()=>compileFormulaProperties([formula('x','random()')]),hasCode('FORMULA_FUNCTION'));assert.throws(()=>compileFormulaProperties([formula('x','round()')]),hasCode('FORMULA_ARITY'));assert.throws(()=>compileFormulaProperties([formula('x','field(3)')]),hasCode('FORMULA_REFERENCE'));
});

test('runtime zero division/invalid date/number overflow become data-free per-cell errors and preserve unrelated values',()=>{
  for(const[expression,expected,type]of[['1 / 0','FORMULA_DIVISION_BY_ZERO','number'],['1 % 0','FORMULA_DIVISION_BY_ZERO','number'],['1e308 * 1e308','FORMULA_NUMBER_RANGE','number'],['toNumber("private-password")','FORMULA_NUMBER_FORMAT','number'],['date("2026-02-30")','FORMULA_DATE','date'],['round(2, 7)','FORMULA_NUMBER_RANGE','number']]){const value=result(expression,{untouched:'kept'},[],type);assert.equal(value.values.result,null);assert.equal(value.values.untouched,'kept');assert.deepEqual(value.errors.result,{code:expected});assert.doesNotMatch(JSON.stringify(value.errors),/private-password|expression|stack|cause/);}
  const properties=[formula('a','1 / 0'),formula('b','field("a") + 1'),formula('c','3')],value=evaluateFormulaRow(properties,{});assert.equal(value.values.a,null);assert.equal(value.values.b,null);assert.equal(value.values.c,3);assert.equal(value.errors.b.code,'FORMULA_DIVISION_BY_ZERO');
});

test('redacted input taints transitive formulas including branches that would otherwise hide the dependency',()=>{
  const properties=[property('secret'),formula('a','if(false, field("secret"), 0)'),formula('b','coalesce(field("a"), 99)')],values={secret:null};const result=evaluateFormulaRow(properties,values,{redactedProperties:['secret']});assert.deepEqual(result.errors,{a:{code:'FORMULA_REDACTED_INPUT'},b:{code:'FORMULA_REDACTED_INPUT'}});assert.equal(result.values.a,null);assert.equal(result.values.b,null);assert.deepEqual(values,{secret:null});assert.equal(evaluateFormulaRow(properties,{secret:2}).values.b,0);
});

test('injection/member access/loops and executable JavaScript are outside the grammar',()=>{
  for(const expression of ['globalThis.fetch("https://outside.invalid")','field("x").constructor','({}).constructor("return process")()','while(true){}','[1,2,3]','1; 2','x => x','"unterminated','1 +','field("x")[0]'])assert.throws(()=>parseFormula(expression),error=>error instanceof FormulaError);assert.throws(()=>compileFormulaProperties([formula('x','constructor("private")')]),hasCode('FORMULA_FUNCTION'));
});

test('expression/token/depth/formula/output and input bounds fail without exposing row data',()=>{
  assert.throws(()=>parseFormula('1'.repeat(FORMULA_LIMITS.expression+1)),hasCode('FORMULA_EXPRESSION_LIMIT'));assert.throws(()=>parseFormula('('.repeat(30)+'1'+')'.repeat(30)),hasCode('FORMULA_DEPTH_LIMIT'));assert.throws(()=>compileFormulaProperties(Array.from({length:33},(_,index)=>formula('x'+index,'1'))),hasCode('FORMULA_COUNT_LIMIT'));const value=result('upper(field("text"))',{text:'x'.repeat(FORMULA_LIMITS.string+1)},[property('text','text')],'text');assert.deepEqual(value.errors.result,{code:'FORMULA_STRING_LIMIT'});const wrong=result('field("n") + 1',{n:'private text'},[property('n')]);assert.deepEqual(wrong.errors.result,{code:'FORMULA_INPUT_TYPE'});assert.doesNotMatch(JSON.stringify(wrong.errors),/private text/);
});