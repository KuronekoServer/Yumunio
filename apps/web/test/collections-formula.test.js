import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePropertyType,parseCollectionValue,validateCollectionEnvelope,recordPatch,formulaFieldCandidates,formulaErrorCode,validateFormulaPreview} from '../public/collections-model.js';
const formula=(resultType='number')=>({id:'calculated',name:'Calculated <b>literal</b>',type:'formula',formula:{version:1,expression:'field("cost") * 2',resultType}});
const envelope=()=>({revision:3,pageId:'container',capabilities:['read','manage'],collection:{id:'collection',workspaceId:'workspace',title:'Computed',properties:[{id:'cost',name:'Cost',type:'number'},formula()],views:[],records:[{id:'record',pageId:'row',title:'Record',values:{cost:4,calculated:8},sourceValues:{cost:'004'},capabilities:['read','editRecordValues']}]}});
const options={workspaceId:'workspace',collectionId:'collection'};

test('formula outputs resolve effective types while direct values including null are readonly',()=>{
  for(const [type,value] of [['number',0],['checkbox',false],['date','2026-10-15'],['text','<script>literal</script>']]){
    const property=formula(type);assert.equal(effectivePropertyType(property),type);
    assert.equal(parseCollectionValue(property,value,{computed:true}),value);
    assert.equal(parseCollectionValue(property,value,{filter:true}),value);
    assert.throws(()=>parseCollectionValue(property,value),/computedReadOnly/);
    assert.throws(()=>parseCollectionValue(property,null),/computedReadOnly/);
  }
});

test('empty computed text remains an exact string rather than an unset value',()=>{const source=envelope();source.collection.properties[1]=formula('text');source.collection.records[0].values.calculated='';assert.equal(validateCollectionEnvelope(source,options).collection.records[0].values.calculated,'');});

test('formula envelope retains typed results and source cells without writable computed values',()=>{
  const source=envelope(),value=validateCollectionEnvelope(source,options);
  assert.equal(value.collection.records[0].values.calculated,8);assert.equal(value.collection.records[0].sourceValues.cost,'004');
  value.collection.records[0].values.calculated=99;assert.equal(source.collection.records[0].values.calculated,8);
  source.collection.records[0].values.calculated='8';assert.throws(()=>validateCollectionEnvelope(source,options),/invalidResponse/);
  const record=envelope().collection.records[0];
  assert.deepEqual(recordPatch(record,{expectedRevision:3,title:'Record',values:{cost:5},dirtyPropertyIds:['cost'],properties:envelope().collection.properties}),{expectedRevision:3,values:{cost:5}});
  assert.throws(()=>recordPatch(record,{expectedRevision:3,title:'Record',values:{calculated:null},dirtyPropertyIds:['calculated'],properties:envelope().collection.properties}),/computedReadOnly/);
});

test('formula errors expose only safe codes for formula fields with null results',()=>{
  const source=envelope(),record=source.collection.records[0];record.values.calculated=null;record.formulaErrors={calculated:{code:'FORMULA_REDACTED_INPUT'}};
  assert.equal(validateCollectionEnvelope(source,options).collection.records[0].formulaErrors.calculated.code,'FORMULA_REDACTED_INPUT');
  record.redactedProperties=['calculated'];assert.doesNotThrow(()=>validateCollectionEnvelope(source,options));delete record.redactedProperties;
  assert.equal(formulaErrorCode(record.formulaErrors.calculated),'FORMULA_REDACTED_INPUT');
  assert.equal(formulaErrorCode({code:'FORMULA_FUTURE_SAFE_CODE'}),'FORMULA_UNAVAILABLE');
  record.formulaErrors.calculated.input='hidden string';assert.throws(()=>validateCollectionEnvelope(source,options));delete record.formulaErrors.calculated.input;
  record.values.calculated=7;assert.throws(()=>validateCollectionEnvelope(source,options));record.values.calculated=null;
  record.formulaErrors={cost:{code:'FORMULA_INPUT_TYPE'}};assert.throws(()=>validateCollectionEnvelope(source,options));
});

test('formula date outputs can supply calendar and timeline views',()=>{
  const source=envelope();source.collection.properties[1]=formula('date');source.collection.records[0].values.calculated='2026-10-15';
  source.collection.views=[{id:'calendar',name:'Calendar',type:'calendar',filters:[],sorts:[],datePropertyId:'calculated'}];
  assert.doesNotThrow(()=>validateCollectionEnvelope(source,options));
  source.collection.views[0]={id:'timeline',name:'Timeline',type:'timeline',filters:[],sorts:[],datePropertyId:'calculated',endDatePropertyId:'calculated'};
  assert.doesNotThrow(()=>validateCollectionEnvelope(source,options));
  source.collection.properties[1]=formula('number');source.collection.records[0].values.calculated=8;assert.throws(()=>validateCollectionEnvelope(source,options));
});

test('formula definitions reject unsupported versions, required results and overlong expressions',()=>{
  for(const change of [{required:true},{options:[]},{formula:{version:2,expression:'1',resultType:'number'}},{formula:{version:1,expression:'',resultType:'number'}},{formula:{version:1,expression:'   ',resultType:'number'}},{formula:{version:1,expression:'x'.repeat(2001),resultType:'number'}},{formula:{version:1,expression:'1',resultType:'person'}}]){
    const source=envelope();source.collection.properties[1]={...formula(),...change};assert.throws(()=>validateCollectionEnvelope(source,options));
  }
});

test('field suggestions use stable IDs and exclude person, relation and the current formula',()=>{
  const properties=[{id:'safe-id',name:'<script>Same title</script>',type:'text'},{id:'p',name:'Person',type:'person'},{id:'r',name:'Relation',type:'relation'},{id:'tags',name:'Tags',type:'multi_select'},formula()];
  const result=formulaFieldCandidates(properties,'calculated');assert.deepEqual(result.map(value=>value.id),['safe-id','tags']);
  assert.equal(result[0].reference,'field("safe-id")');assert.equal(result[0].name,'<script>Same title</script>');
});

test('preview is bound to the reviewed revision, field and visible row with strict typed result',()=>{
  const property=formula(),value={revision:3,propertyId:'calculated',valid:true,result:{recordId:'record',value:8}};
  assert.deepEqual(validateFormulaPreview(value,{revision:3,property,recordId:'record'}),value);
  for(const change of [{revision:4},{propertyId:'other'},{result:{recordId:'hidden',value:8}},{result:{recordId:'record',value:'8'}},{result:{recordId:'record',value:null,error:{code:'FORMULA_INPUT_TYPE',input:'secret'}}}])assert.throws(()=>validateFormulaPreview({...value,...change},{revision:3,property,recordId:'record'}));
  assert.throws(()=>validateFormulaPreview(value,{revision:3,property,recordId:null}));
  assert.doesNotThrow(()=>validateFormulaPreview({revision:3,propertyId:'calculated',valid:true},{revision:3,property}));
  assert.doesNotThrow(()=>validateFormulaPreview({...value,result:{recordId:'record',value:null,error:{code:'FORMULA_DIVISION_BY_ZERO'}}},{revision:3,property,recordId:'record'}));
});
