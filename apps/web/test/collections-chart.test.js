import test from 'node:test';
import assert from 'node:assert/strict';
import {barLayout,donutSegments} from '../public/collections-chart.js';
import {validateCollectionEnvelope} from '../public/collections-model.js';
const view={id:'chart-view',name:'Chart',type:'chart',filters:[],sorts:[],groupBy:'status',datePropertyId:null,endDatePropertyId:null,chart:{type:'bar',aggregation:'count',valuePropertyId:null}};
const envelope=()=>({revision:1,pageId:'container',capabilities:['read'],view,chart:{status:'available',groups:[{value:'<svg onload=alert(1)>',count:1,numericCount:0,result:1}]},collection:{id:'collection',workspaceId:'workspace',title:'Chart',properties:[{id:'status',name:'Status',type:'text'}],views:[view],records:[{id:'row',pageId:'row-page',title:'Row',values:{status:'<svg onload=alert(1)>'},sourceValues:{},capabilities:['read']}]}});
test('bar geometry keeps negative/zero/positive values within the plot and donut fractions do not overflow large totals',()=>{
 const layout=barLayout([{result:-10},{result:0},{result:20}]);assert.ok(layout.zero>180&&layout.zero<580);for(const bar of layout.bars){assert.ok(Number.isFinite(bar.x)&&Number.isFinite(bar.width));assert.ok(bar.x>=180&&bar.x+bar.width<=580.000001);}
 const arcs=donutSegments([{result:Number.MAX_SAFE_INTEGER},{result:Number.MAX_SAFE_INTEGER},{result:0}]);assert.deepEqual(arcs.map(item=>item.fraction),[.5,.5,0]);assert.equal(arcs[1].offset,.5);assert.deepEqual(donutSegments([{result:0}]),[]);
});
test('browser chart projection rejects missing totals, partial unavailable data and malformed saved definitions',()=>{
 const value=envelope();assert.equal(validateCollectionEnvelope(value,{workspaceId:'workspace',collectionId:'collection'}).chart.groups[0].value,'<svg onload=alert(1)>');
 for(const alter of [value=>delete value.chart,value=>value.chart={status:'unavailable',reason:'CHART_INPUT_UNAVAILABLE',groups:[]},value=>value.view.chart.valuePropertyId='status',value=>value.chart.groups[0].result=Infinity]){const changed=structuredClone(value);alter(changed);assert.throws(()=>validateCollectionEnvelope(changed,{workspaceId:'workspace',collectionId:'collection'}));}
});
