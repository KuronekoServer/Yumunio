import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionEdits, validateInlineBlockMetadata, readableLinks, editableBlockData, pageMoveTargets, mergeSavedPageAttachments, mapRoomSelection } from '../public/workspace-data.js';
const record=(id,pageId,editable=true)=>({id,pageId,title:id,values:{name:'=SUM(A1)',memo:'007\nRen'},sourceValues:{name:'=SUM(A1)',memo:'007\nRen'},capabilities:['read',...(editable?['editRecordValues']:[])]});
const envelope=()=>({revision:3,pageId:'table-page',capabilities:['read'],collection:{id:'table',workspaceId:'workspace-A',title:'Table',views:[],properties:[{id:'name',name:'Name',type:'text'},{id:'memo',name:'Memo',type:'text'}],records:[record('row-A','page-A'),record('row-B','page-B',false)]}});
const model=()=>new CollectionEdits(envelope(),{workspaceId:'workspace-A',collectionId:'table'});

test('property drafts rebase over body and unrelated property changes but preserve conflicts and revoked rights',()=>{
 const value=model();value.setRaw('row-A','memo','日本語の下書き');const fresh=envelope();fresh.revision=9;fresh.collection.records[0].title='Peer title';fresh.collection.records[0].values.name='Other property changed';const rebased=value.rebase(fresh);assert.equal(rebased.patch('row-A').expectedRevision,9);assert.deepEqual(rebased.changes('row-A'),{memo:'日本語の下書き'});assert.equal(rebased.record('row-A').values.name,'Other property changed');assert.equal(value.revision,3);
 const collision=structuredClone(fresh);collision.collection.records[0].values.memo='Peer changed this field';assert.throws(()=>value.rebase(collision),/INVALID_RECORD_EDIT/);const revoked=structuredClone(fresh);revoked.collection.records[0].capabilities=['read'];assert.throws(()=>value.rebase(revoked),/INVALID_RECORD_EDIT/);assert.equal(value.rawValue('row-A','memo'),'日本語の下書き');
});
test('record drafts preserve exact source strings and patch only changed properties',()=> {
 const value=model(); value.set('row-A','memo','0009\nMika');
 assert.deepEqual(value.changes('row-A'),{memo:'0009\nMika'});
 assert.equal(value.record('row-A').sourceValues.memo,'007\nRen');
 assert.equal(value.record('row-A').sourceValues.name,'=SUM(A1)');
 assert.equal(value.record('row-A').values.memo,'007\nRen'); assert.equal(value.dirty,true);
 value.set('row-A','memo','007\nRen'); assert.equal(value.dirty,false);
});
test('filtered rows never appear and a visible readonly row cannot be edited',()=> {
 const source=envelope(); source.collection.records=source.collection.records.slice(1);
 const value=new CollectionEdits(source,{workspaceId:'workspace-A',collectionId:'table'});
 assert.equal(value.record('row-A'),undefined); assert.equal(value.collection.records.length,1);
 assert.throws(()=>value.set('row-A','memo','bad'),/INVALID_RECORD_EDIT/);
 assert.throws(()=>value.set('row-B','memo','bad'),/INVALID_RECORD_EDIT/); assert.equal(value.dirty,false);
});
test('manual text rows have no imported source cells and retain that distinction after saving',()=> {
 const source=envelope();source.collection.sourceProperties=structuredClone(source.collection.properties);
 source.collection.records[0].sourceValues={};source.collection.records[0].sourceKind='manual';
 const value=new CollectionEdits(source,{workspaceId:'workspace-A',collectionId:'table'});
 value.set('row-A','memo','manual draft');const saved=structuredClone(source.collection.records[0]);saved.values.memo='manual draft';
 value.accept({revision:4,collectionId:'table',record:saved},'row-A');assert.equal(value.dirty,false);assert.deepEqual(value.record('row-A').sourceValues,{});
 const forged=structuredClone(saved);delete forged.sourceKind;assert.throws(()=>value.accept({revision:5,collectionId:'table',record:forged},'row-A'),/INVALID_COLLECTION/);
 source.collection.records[0].sourceValues.name='invented source';assert.throws(()=>new CollectionEdits(source,{workspaceId:'workspace-A',collectionId:'table'}),/INVALID_COLLECTION/);
});
test('imported source columns remain separate from later editable text properties and cannot change on acceptance',()=> {
 const source=envelope();source.collection.sourceProperties=structuredClone(source.collection.properties);
 source.collection.properties=[{id:'name',name:'Name',type:'text'},{id:'added',name:'Added',type:'text'}];
 source.collection.records.forEach(row=>{row.values={name:row.values.name,added:''};});
 const value=new CollectionEdits(source,{workspaceId:'workspace-A',collectionId:'table'});value.set('row-A','added','new');
 const saved=structuredClone(source.collection.records[0]);saved.values.added='new';value.accept({revision:4,collectionId:'table',record:saved},'row-A');
 assert.equal(value.record('row-A').sourceValues.memo,'007\nRen');
 saved.sourceValues.memo='changed';assert.throws(()=>value.accept({revision:5,collectionId:'table',record:saved},'row-A'),/INVALID_COLLECTION/);
 const corrupt=envelope();delete corrupt.collection.records[0].sourceValues.memo;assert.throws(()=>new CollectionEdits(corrupt,{workspaceId:'workspace-A',collectionId:'table'}),/INVALID_COLLECTION/);
});
test('409 holds drafts and blocks edits until an explicit successful reload replaces the model',()=> {
 const value=model(); value.set('row-A','name','Own draft'); value.markConflict();
 assert.equal(value.values('row-A').name,'Own draft'); assert.equal(value.dirty,true); assert.equal(value.canEdit('row-A'),false);
 assert.throws(()=>value.set('row-A','name','second'),/INVALID_RECORD_EDIT/);
 const fresh=model(); assert.equal(fresh.values('row-A').name,'=SUM(A1)'); assert.equal(value.values('row-A').name,'Own draft');
});
test('an invalid save response cannot erase a draft or change original cells',()=> {
 const value=model(); value.set('row-A','memo','draft');
 const changed=record('row-A','page-A'); changed.sourceValues.memo='tampered';
 assert.throws(()=>value.accept({revision:4,collectionId:'table',record:changed},'row-A'),/INVALID_COLLECTION/);
 assert.equal(value.values('row-A').memo,'draft'); assert.equal(value.revision,3);
 const saved=record('row-A','page-A'); saved.values.memo='draft'; value.accept({revision:4,collectionId:'table',record:saved},'row-A');
 assert.equal(value.dirty,false); assert.equal(value.revision,4); assert.equal(value.record('row-A').sourceValues.memo,'007\nRen');
});
test('only valid literal UTF16 internal spans can form readonly links',()=> {
 const data={text:'😀 project then secret',links:[{start:3,end:10,label:'project',pageId:'page-A'},{start:16,end:22,label:'secret',unavailable:true}]};
 assert.equal(readableLinks(data).length,2); assert.equal(readableLinks(data)[1].pageId,undefined);
 assert.deepEqual(readableLinks({text:'project',links:[{start:0,end:7,label:'project',pageId:'javascript:bad?'}]}),[]);
 assert.deepEqual(readableLinks({text:'project',links:[{start:0,end:8,label:'project',pageId:'page-A'}]}),[]);
 assert.deepEqual(readableLinks({text:'changed',links:[{start:0,end:7,label:'project',pageId:'page-A'}]}),[]);
});
test('changing plaintext removes stale links without altering source metadata or checked state',()=> {
 const data={text:'project',checked:true,links:[{start:0,end:7,label:'project',pageId:'page-A'}]};
 assert.deepEqual(editableBlockData(data,'project'),data);
 const changed=editableBlockData(data,'new text'); assert.equal('links' in changed,false); assert.equal(changed.checked,true);
 assert.equal(data.links.length,1); assert.equal(data.text,'project');
});

test('attachment links require validated IDs and unavailable links reveal no target metadata',()=> {
 assert.deepEqual(readableLinks({text:'file',links:[{start:0,end:4,label:'file',pageId:'page-A',attachmentId:'attachment-A'}]})[0],{start:0,end:4,label:'file',pageId:'page-A',attachmentId:'attachment-A'});
 assert.deepEqual(readableLinks({text:'file',links:[{start:0,end:4,label:'file',pageId:'page-A',attachmentId:'../../blob'}]}),[]);
 assert.deepEqual(readableLinks({text:'file',links:[{start:0,end:4,label:'file',unavailable:true,pageId:'private',attachmentId:'private'}]})[0],{start:0,end:4,label:'file',unavailable:true});
});

test('move destinations reject cycles, hidden ancestry and unmanageable targets',()=>{
 const p=(id,parentId=null,capabilities=['read','manage'])=>({id,parentId,title:id,trashedAt:null,capabilities});
 const pages=[p('source'),p('child','source'),p('grandchild','child'),p('target'),p('readonly',null,['read']),p('hidden-parent-child','missing'),p('trashed')];pages.at(-1).trashedAt='2026-10-15T00:00:00.000Z';
 assert.deepEqual(pageMoveTargets(pages,'source').map(page=>page.id),['target']);
});
test('row pages cannot move out of their collection through the generic move picker',()=>{
 const pages=[{id:'row',parentId:'container',recordId:'record',trashedAt:null,capabilities:['read','manage']},{id:'container',parentId:null,trashedAt:null,capabilities:['read','manage']}];
 assert.deepEqual(pageMoveTargets(pages,'row'),[]);
});

test('older save envelopes retain only the same page attachment metadata while explicit empty lists remain authoritative', () => {
  const current = { page: { id: 'page-a', workspaceId: 'workspace-a' }, attachments: [{ id: 'asset-a', name: 'source.txt', mediaType: 'application/octet-stream', size: 7 }] };
  const saved = { page: { ...current.page }, revision: 4 };
  const merged = mergeSavedPageAttachments(current, saved);
  assert.deepEqual(merged.attachments, current.attachments);
  merged.attachments[0].name = 'changed by caller';
  assert.equal(current.attachments[0].name, 'source.txt');
  assert.equal(saved.attachments, undefined);
  assert.deepEqual(mergeSavedPageAttachments(current, { ...saved, attachments: [] }).attachments, []);
  assert.equal(mergeSavedPageAttachments(current, { ...saved, page: { id: 'page-b', workspaceId: 'workspace-a' } }).attachments, undefined);
  assert.equal(mergeSavedPageAttachments(current, { ...saved, page: { id: 'page-a', workspaceId: 'workspace-b' } }).attachments, undefined);
});

test('room selection mapping keeps a caret after remote insertions and clamps ranges deleted remotely without mutating drafts', () => {
  const before = { title: 'Title', blocks: [{ id: 'a', type: 'paragraph', data: { text: 'hello world' } }] };
  const after = structuredClone(before); after.blocks[0].data.text = 'REMOTE hello world';
  const selection = { blockId: 'a', start: 6, end: 11 };
  assert.deepEqual(mapRoomSelection(before, after, selection), { blockId: 'a', start: 13, end: 18 });
  assert.deepEqual(selection, { blockId: 'a', start: 6, end: 11 });
  assert.equal(before.blocks[0].data.text, 'hello world');
  assert.deepEqual(mapRoomSelection({ title: 'ABCD' }, { title: 'AD' }, { title: true, start: 2, end: 3 }), { title: true, start: 1, end: 1 });
});
test('room selection uses UTF16 offsets for emoji and refuses a missing block target', () => {
  const before = { title: 'A😀B', blocks: [] }, after = { title: '+A😀B', blocks: [] };
  assert.deepEqual(mapRoomSelection(before, after, { title: true, start: 3, end: 3 }), { title: true, start: 4, end: 4 });
  assert.equal(mapRoomSelection(before, after, { blockId: 'hidden', start: 0, end: 0 }), null);
});


test('text edits rebase optional inline styles while preserving readonly source metadata and unchanged internal references',()=>{
 const original={text:'Alpha beta',checked:true,marks:[{start:0,end:5,styles:['bold']}],links:[{start:6,end:10,label:'beta',pageId:'p'}],sourceKind:'manual'};
 const changed=editableBlockData(original,'XAlpha beta');
 assert.deepEqual(changed.marks,[{start:1,end:6,styles:['bold']}]); assert.deepEqual(changed.links,[{start:7,end:11,label:'beta',pageId:'p'}]);assert.equal(changed.sourceKind,'manual');
 const formatted=editableBlockData(original,original.text,[{start:0,end:5,styles:['italic']}]);assert.equal(formatted.links.length,1);
 assert.deepEqual(original.marks,[{start:0,end:5,styles:['bold']}]);
 assert.throws(()=>editableBlockData(original,'short',[{start:0,end:6,styles:['bold']}]));
});


test('malformed server inline metadata is rejected before a caller can accept it over held drafts',()=>{
 const blocks=[{id:'b',type:'paragraph',data:{text:'abc',marks:[{start:0,end:3,styles:['bold']}]}}];
 assert.equal(validateInlineBlockMetadata(blocks),blocks);
 for(const data of [{text:'abc',marks:[{start:0,end:4,styles:['bold']}]},{text:'abc',marks:[{start:0,end:3,styles:[],href:'javascript:alert(1)'}]},{text:'abc',purpose:'import-source',marks:[]}]) assert.throws(()=>validateInlineBlockMetadata([{id:'b',type:'paragraph',data}]));
 assert.throws(()=>validateInlineBlockMetadata([{id:'b',type:'code',data:{text:'abc',marks:[]}}]));
});

const typedEnvelope=()=>({revision:8,pageId:'container',capabilities:['read','manage'],collection:{id:'typed',workspaceId:'workspace-A',title:'Typed',views:[],sourceProperties:[{id:'original',name:'CSV original',type:'text'}],properties:[
 {id:'text',name:'Text',type:'text'},{id:'number',name:'Number',type:'number'},{id:'check',name:'Check',type:'checkbox'},{id:'date',name:'Date',type:'date'},{id:'select',name:'Select',type:'select',options:['A','B']},{id:'multi',name:'Multi',type:'multi_select',options:['A','B']},{id:'person',name:'Person',type:'person'},{id:'relation',name:'Relation',type:'relation'},
 {id:'formula',name:'Formula',type:'formula',formula:{version:1,expression:'1',resultType:'number'}},{id:'rollup',name:'Rollup',type:'rollup',rollup:{version:1,relationPropertyId:'relation',targetCollectionId:'other',targetPropertyId:'amount',operation:'sum',resultType:'number'}}
],records:[{id:'typed-row',pageId:'typed-page',title:'Body title',capabilities:['read','editBody','editRecordValues'],values:{text:'',number:0,check:false,date:'2026-10-15',select:'A',multi:['A'],person:'person-A',relation:['record-page'],formula:1,rollup:5},sourceValues:{original:'000\n=SUM(A1)'}}]}});
const typedModel=source=>new CollectionEdits(source??typedEnvelope(),{workspaceId:'workspace-A',collectionId:'typed'});
test('typed record drafts preserve raw intermediate numbers and parse only explicit dirty patches',()=>{
 const model=typedModel();model.setRaw('typed-row','number','-');model.setRaw('typed-row','text','Own note');assert.equal(model.rawValue('typed-row','number'),'-');assert.throws(()=>model.patch('typed-row'),/invalidNumber/);assert.equal(model.rawValue('typed-row','text'),'Own note');
 model.setRaw('typed-row','number','1e-');assert.throws(()=>model.changes('typed-row'),/invalidNumber/);assert.deepEqual(model.dirtyPropertyIds('typed-row'),['number','text']);
 model.setRaw('typed-row','number','12.5');assert.deepEqual(model.patch('typed-row'),{expectedRevision:8,values:{number:12.5,text:'Own note'}});assert.equal(model.record('typed-row').values.number,0);assert.equal(model.record('typed-row').sourceValues.original,'000\n=SUM(A1)');
 model.setRaw('typed-row','number','0');model.setRaw('typed-row','text','');assert.equal(model.dirty,false);
});
test('typed values retain empty text, null, false, zero and exact arrays without shallow dirty comparisons',()=>{
 const source=typedEnvelope();source.collection.records[0].values.text=null;const model=typedModel(source);assert.equal(model.values('typed-row').text,null);model.setRaw('typed-row','text','');model.set('typed-row','check',false);model.set('typed-row','multi',['A']);assert.deepEqual(model.patch('typed-row'),{expectedRevision:8,values:{text:''}});
 model.setRaw('typed-row','multi',['B','A']);assert.deepEqual(model.changes('typed-row').multi,['B','A']);const raw=model.rawValue('typed-row','multi');raw.push('changed outside');assert.deepEqual(model.rawValue('typed-row','multi'),['B','A']);assert.throws(()=>model.set('typed-row','number','12'),/INVALID_RECORD_EDIT/);
});
test('computed and redacted properties stay readonly and cannot be smuggled into partial writes',()=>{
 const source=typedEnvelope(),row=source.collection.records[0];row.values.person=null;row.values.relation=[];row.redactedProperties=['person','relation'];const model=typedModel(source);
 for(const id of ['person','relation','formula','rollup']){assert.equal(model.canEdit('typed-row',id),false);assert.throws(()=>model.setRaw('typed-row',id,''),/INVALID_RECORD_EDIT/);}
 model.setRaw('typed-row','text','Visible edit');assert.deepEqual(model.patch('typed-row'),{expectedRevision:8,values:{text:'Visible edit'}});assert.equal(model.record('typed-row').values.formula,1);assert.deepEqual(model.record('typed-row').values.relation,[]);
});
test('unknown or conflicting saves retain raw invalid input until an explicit fresh model is chosen',()=>{
 for(const method of ['markUnknown','markConflict']){const model=typedModel();model.setRaw('typed-row','number','1e-');model[method]();assert.equal(model.rawValue('typed-row','number'),'1e-');assert.equal(model.dirty,true);assert.throws(()=>model.patch('typed-row'),/INVALID_RECORD_EDIT/);assert.throws(()=>model.setRaw('typed-row','number','2'),/INVALID_RECORD_EDIT/);assert.equal(typedModel().values('typed-row').number,0);}
 const model=typedModel();model.setRaw('typed-row','number','-');const response={revision:9,collectionId:'typed',record:structuredClone(model.record('typed-row'))};response.record.values.number='forged';assert.throws(()=>model.accept(response,'typed-row'),/INVALID_COLLECTION/);assert.equal(model.rawValue('typed-row','number'),'-');assert.equal(model.revision,8);
});
test('own body saves advance only an exact known basis and title without changing values, sources or drafts',()=>{
 const model=typedModel();model.setRaw('typed-row','number','-');model.advanceDocumentBasis({expectedRevision:8,revision:9,pageId:'typed-page',title:'New body title'});assert.equal(model.record('typed-row').title,'New body title');assert.equal(model.revision,9);assert.equal(model.rawValue('typed-row','number'),'-');assert.equal(model.record('typed-row').sourceValues.original,'000\n=SUM(A1)');
 const before=structuredClone(model.envelope);for(const change of [{expectedRevision:8,revision:10,pageId:'typed-page',title:'wrong basis'},{expectedRevision:9,revision:10,pageId:'other-page',title:'wrong page'},{expectedRevision:9,revision:9,pageId:'typed-page',title:'wrong revision'},{expectedRevision:9,revision:10,pageId:'typed-page',title:'x'.repeat(241)}]){assert.throws(()=>model.advanceDocumentBasis(change),/INVALID_COLLECTION/);assert.deepEqual(model.envelope,before);}
 model.setRaw('typed-row','number','2');assert.deepEqual(model.patch('typed-row'),{expectedRevision:9,values:{number:2}});model.advanceDocumentBasis({expectedRevision:9,revision:10,pageId:'container',title:'Renamed collection'});assert.equal(model.collection.title,'Renamed collection');
});
test('typed manual rows keep empty source cells and imported source baselines cannot change in acknowledgements',()=>{
 const source=typedEnvelope();source.collection.records[0].sourceKind='manual';source.collection.records[0].sourceValues={};const model=typedModel(source);model.setRaw('typed-row','number','3');const row=structuredClone(model.record('typed-row'));row.values.number=3;model.accept({revision:9,collectionId:'typed',record:row},'typed-row');assert.deepEqual(model.record('typed-row').sourceValues,{});assert.equal(model.dirty,false);
 const imported=typedModel();imported.setRaw('typed-row','number','4');const bad=structuredClone(imported.record('typed-row'));bad.values.number=4;bad.sourceValues.original='changed';assert.throws(()=>imported.accept({revision:9,collectionId:'typed',record:bad},'typed-row'),/INVALID_COLLECTION/);assert.equal(imported.rawValue('typed-row','number'),'4');
});

test('a well-shaped but mismatched save acknowledgement cannot clear property drafts or replace the body title',()=>{
 const model=typedModel();model.setRaw('typed-row','number','42');const row=structuredClone(model.record('typed-row'));
 assert.throws(()=>model.accept({revision:9,collectionId:'typed',record:row},'typed-row'),/INVALID_COLLECTION/);assert.equal(model.rawValue('typed-row','number'),'42');assert.equal(model.revision,8);
 row.values.number=42;row.title='Unrequested title';assert.throws(()=>model.accept({revision:9,collectionId:'typed',record:row},'typed-row'),/INVALID_COLLECTION/);assert.equal(model.record('typed-row').title,'Body title');
 row.title='Body title';model.accept({revision:9,collectionId:'typed',record:row},'typed-row');assert.equal(model.dirty,false);assert.equal(model.record('typed-row').values.number,42);
});

test('empty and whitespace body or container titles retain raw property drafts and advance the next title-free property CAS',()=>{
 for(const pageId of ['typed-page','container'])for(const title of ['','   ']){
  const model=typedModel(),source=structuredClone(model.record('typed-row').sourceValues);
  model.setRaw('typed-row','number','1e-');model.setRaw('typed-row','text','Keep property draft');
  model.advanceDocumentBasis({expectedRevision:8,revision:9,pageId,title});
  assert.equal(model.revision,9);assert.equal(pageId==='container'?model.collection.title:model.record('typed-row').title,title);
  assert.equal(model.rawValue('typed-row','number'),'1e-');assert.equal(model.rawValue('typed-row','text'),'Keep property draft');assert.equal(model.dirty,true);assert.deepEqual(model.record('typed-row').sourceValues,source);assert.throws(()=>model.patch('typed-row'),/invalidNumber/);
  model.setRaw('typed-row','number','12.5');const patch=model.patch('typed-row');assert.deepEqual(patch,{expectedRevision:9,values:{number:12.5,text:'Keep property draft'}});assert.equal(Object.hasOwn(patch,'title'),false);
  const record=structuredClone(model.record('typed-row'));record.values={...record.values,...patch.values};model.accept({revision:10,collectionId:'typed',record},'typed-row');
  assert.equal(model.revision,10);assert.equal(model.dirty,false);assert.deepEqual(model.record('typed-row').sourceValues,source);assert.equal(pageId==='container'?model.collection.title:model.record('typed-row').title,title);
 }
});
