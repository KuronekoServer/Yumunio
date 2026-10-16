import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateChart,validateChartDefinition,validateChartResult,chartInputsAvailable} from '../src/charts.js';
const properties=[{id:'status',type:'select'},{id:'amount',type:'number'},{id:'check',type:'checkbox'},{id:'formula',type:'formula',formula:{resultType:'number'}},{id:'label',type:'text'}];
const view=(aggregation='count',extra={})=>({type:'chart',groupBy:'status',datePropertyId:null,endDatePropertyId:null,filters:[],sorts:[],chart:{type:'bar',aggregation,valuePropertyId:aggregation==='count'?null:'amount'},...extra});
const rows=values=>values.map(([status,amount])=>({values:{status,amount}}));
test('saved chart definitions require stable compatible group and effective numeric IDs and exact config',()=>{
 for(const aggregation of ['count','sum','average'])assert.doesNotThrow(()=>validateChartDefinition(view(aggregation),properties));
 assert.doesNotThrow(()=>validateChartDefinition(view('sum',{chart:{type:'donut',aggregation:'sum',valuePropertyId:'formula'}}),properties));
 for(const patch of [{groupBy:'amount'},{groupBy:'missing'},{datePropertyId:'date'},{type:'table'},{chart:{type:'pie',aggregation:'count',valuePropertyId:null}},{chart:{type:'bar',aggregation:'count',valuePropertyId:'amount'}},{chart:{type:'bar',aggregation:'sum',valuePropertyId:'label'}},{chart:{type:'bar',aggregation:'sum',valuePropertyId:'amount',secret:'unknown'}}])assert.throws(()=>validateChartDefinition(view('count',patch),properties));
});
test('count, compensated sums and averages preserve zero, false, blank group and null denominators',()=>{
 const records=rows([['A',2],['A',null],['A',4],['',0],[null,null],['B',null]]);
 assert.deepEqual(aggregateChart(records,view(),properties).groups.map(g=>[g.value,g.result]),[[null,2],['A',3],['B',1]]);
 assert.deepEqual(aggregateChart(records,view('sum'),properties).groups.map(g=>[g.value,g.result,g.numericCount]),[[null,0,1],['A',6,2],['B',0,0]]);
 assert.deepEqual(aggregateChart(records,view('average'),properties).groups.map(g=>[g.value,g.result]),[[null,0],['A',3],['B',null]]);
 assert.deepEqual(aggregateChart([{values:{check:false}},{values:{check:true}},{values:{check:null}}],view('count',{groupBy:'check'}),properties).groups.map(g=>g.value),[null,false,true]);
});
test('hidden values and computed errors return no counts or partial aggregates, even filter/sort errors',()=>{
 for(const error of [{redactedProperties:['amount']},{formulaErrors:{amount:{code:'FORMULA_DIVISION_BY_ZERO'}}},{rollupErrors:{amount:{code:'ROLLUP_REDACTED_INPUT'}}}]){const records=rows([['A',3],['B',null]]);Object.assign(records[1],error);assert.deepEqual(aggregateChart(records,view('sum'),properties),{status:'unavailable',reason:'CHART_INPUT_UNAVAILABLE'});}
 const records=rows([['A',2]]);records[0].formulaErrors={label:{code:'FORMULA_UNAVAILABLE'}};const filtered=view('sum',{filters:[{propertyId:'label',operator:'empty'}]});assert.equal(chartInputsAvailable(records,filtered),false);assert.equal(chartInputsAvailable(records,view('sum')),true);
 assert.deepEqual(aggregateChart([],view('sum'),properties,{inputsAvailable:false}),{status:'unavailable',reason:'CHART_INPUT_UNAVAILABLE'});
});
test('bounded groups/numbers and negative donuts fail entirely while negative bars and zero donuts remain exact',()=>{
 assert.equal(aggregateChart(rows(Array.from({length:129},(_,i)=>[String(i),1])),view(),properties).reason,'CHART_GROUP_LIMIT');
 assert.equal(aggregateChart(rows([['A',Number.MAX_SAFE_INTEGER],['A',1]]),view('sum'),properties).reason,'CHART_NUMBER_RANGE');
 const donut=view('sum',{chart:{type:'donut',aggregation:'sum',valuePropertyId:'amount'}});assert.equal(aggregateChart(rows([['A',-1],['B',10]]),donut,properties).reason,'CHART_NEGATIVE_DONUT');
 assert.equal(aggregateChart(rows([['A',-1]]),view('sum'),properties).groups[0].result,-1);assert.equal(aggregateChart(rows([['A',0]]),donut,properties).groups[0].result,0);
});
test('strict public result rejects partial unavailable totals, duplicate labels and invalid computed values',()=>{
 const v=view('average'),result=aggregateChart(rows([['A',2],['B',null]]),v,properties);assert.deepEqual(validateChartResult(result,v,properties),result);
 for(const bad of [{status:'unavailable',reason:'CHART_INPUT_UNAVAILABLE',groups:[]},{status:'available',groups:[...result.groups,result.groups[0]]},{status:'available',groups:[{value:'A',count:1,numericCount:0,result:0}]},{status:'available',groups:[{value:'A',count:1,numericCount:1,result:Infinity}]}])assert.throws(()=>validateChartResult(bad,v,properties));
});
