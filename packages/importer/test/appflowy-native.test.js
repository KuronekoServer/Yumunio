import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks,importSourceText} from '../../domain/src/index.js';
import {parseAppFlowyNative,isAppFlowyNativeArchive,prepareAppFlowyNativeBundle,buildAppFlowyNativeBundle} from '../src/appflowy-native.js';
import {appFlowyNativeFiles,appFlowyNativeEntries,APPFLOWY_FIXTURE_IDS as ids} from './fixtures/appflowy-native.js';
const encoder=new TextEncoder(),decoder=new TextDecoder();
const options=()=>({expectedRevision:4,importId:'synthetic-native-import',rootTitle:'Imported workspace',csvMode:'native',rowPageMappings:[]});
const acknowledgements={nativeSubset:true,csvTextTypes:true,linksUnconverted:true,excludedAssets:true};
const read=(files,path)=>JSON.parse(decoder.decode(files.get(path)));
const write=(files,path,value)=>files.set(path,encoder.encode(JSON.stringify(value)));
const docPath='collab/documents/'+ids.document+'.json';
const databasePath='collab/databases/'+ids.database+'.json';
const parse=files=>parseAppFlowyNative(files,{entries:appFlowyNativeEntries(files)});
const source=(page,format)=>{const data=page.blocks.find(b=>b.data.sourceFormat===format)?.data;if(!data)return undefined;const s=structuredClone(data.source);if(data.sourceEncoding==='appflowy-document-tuples-v1')s.blocks=Object.fromEntries(s.blocks.map(([key,ty,parent,children,value,rest])=>[key,{...rest,id:key,ty,parent,children,data:value}]));return s;};
test('native manifest detection requires matching metadata and exact native shapes, not arbitrary JSON',async()=>{
  const files=appFlowyNativeFiles();
  assert.equal(isAppFlowyNativeArchive(files),true);
  assert.equal(isAppFlowyNativeArchive(new Map([['metadata.json',encoder.encode('{"export_info":{}}')]])),false);
  const m=read(files,'metadata.json');m.export_info.workspace_id='other-workspace';write(files,'metadata.json',m);
  assert.equal(isAppFlowyNativeArchive(files),false);
  await assert.rejects(parse(files),{code:'APPFLOWY_NATIVE_METADATA_REQUIRED'});
});
test('native documents retain nested blocks, UTF16 marks, safe links and independently preserved JSON',async()=>{
  const plan=await parse(appFlowyNativeFiles()),page=plan.pages.find(p=>p.sourceObjectId===ids.document);
  assert.equal(plan.schemaVersion,2);assert.equal(plan.source,'appflowy-native');assert.equal(plan.summary.records,1);
  assert.equal(page.blocks[0].type,'paragraph');assert.equal(page.blocks[0].data.text,'Bold 😀 and safe reference');
  assert.deepEqual(page.blocks[0].data.marks[0],{start:0,end:7,styles:['bold']});
  assert.equal(page.blocks[0].data.marks[1].href,'https://example.invalid/guide');
  assert.equal(page.blocks[0].children[0].type,'bulleted-list');assert.equal(page.blocks[0].children[0].data.text,'Nested literal <b>text</b>');
  assert.equal(page.blocks[0].data.links[0].label,' reference');
  assert.ok(plan.pages.some(p=>p.id===page.blocks[0].data.links[0].sourcePageId));
  assert.equal(page.blocks.at(-1).data.text,'');assert.equal(page.blocks.at(-1).data.purpose,'import-source');
  assert.equal(source(page,'appflowy-document-v1').blocks['fixture-text'].ty,'paragraph');
  for(const p of plan.pages)validateBlocks(p.blocks);
});
test('duplicate JSON snapshots normalize delta object order but conflicting document content stops the entire preview',async()=>{
  const files=appFlowyNativeFiles({duplicateDocument:true}),plan=await parse(files);
  assert.equal(plan.pages.filter(p=>p.sourceObjectId===ids.document).length,1);
  const path='collab/databases/'+ids.database+'/copies/'+ids.document+'.json',changed=read(files,path);
  changed.meta.text_map['text-delta']='[{"insert":"Changed text"}]';write(files,path,changed);
  await assert.rejects(parse(files),{code:'APPFLOWY_DUPLICATE_ID_CONFLICT'});
});
test('database rows map to the exact UUIDv5 document, original cells remain row-scoped, types and views are explicit subset',async()=>{
  const plan=await parse(appFlowyNativeFiles()),c=plan.collections[0],row=c.rows[0],page=plan.pages.find(p=>p.id===row.pageId),container=plan.pages.find(p=>p.id===c.pageId);
  assert.equal(page.sourceObjectId,ids.rowDocument);assert.equal(page.parentCandidateId,c.pageId);assert.equal(page.title,'Synthetic row');
  assert.deepEqual(row.cells,['Synthetic row','First']);
  assert.equal(c.columns[1].sourceFieldType,3);assert.equal(c.columns[1].type,'text');
  assert.equal(source(page,'appflowy-row-v1').cells['select-field'].data,'option-one');
  const header=source(container,'appflowy-database-v1');assert.equal('rows'in header,false);assert.equal('row_orders'in header.views[0],false);
  assert.doesNotMatch(JSON.stringify(container),/Private row content|Synthetic row|option-one.*field_type/);
  assert.ok(plan.warnings.some(w=>w.code==='NATIVE_DATABASE_TEXT'));
});
test('self-parent source views are explicitly detached and original parent metadata stays available in the plan source identity',async()=>{
  const files=appFlowyNativeFiles(),manifest=read(files,'workspace.json');manifest.views[ids.document].parent_id=ids.document;write(files,'workspace.json',manifest);
  const plan=await parse(files),page=plan.pages.find(p=>p.sourceObjectId===ids.document);
  assert.equal(page.parentCandidateId,null);assert.equal(source(page,'appflowy-document-v1').source_parent_id,ids.document);assert.ok(plan.warnings.some(w=>w.code==='NATIVE_HIERARCHY_DETACHED'&&w.count===1));
  const built=buildAppFlowyNativeBundle(plan,{...options(),acknowledgements});assert.equal(built.body.pages.find(p=>p.sourceId===page.id).parentSourceId,'import-root');
});
test('multi-page cycles, missing parents and block cycles are rejected without partial results',async()=>{
  for(const kind of ['cycle','missing','block']){
    const files=appFlowyNativeFiles(),manifest=read(files,'workspace.json');
    if(kind==='cycle'){manifest.views[ids.document].parent_id=ids.databaseView;manifest.views[ids.databaseView].parent_id=ids.document;write(files,'workspace.json',manifest);}
    else if(kind==='missing'){manifest.views[ids.document].parent_id='missing-parent';write(files,'workspace.json',manifest);}
    else{const d=read(files,docPath);d.meta.children_map['child-children']=['fixture-text'];d.blocks['fixture-text'].parent='fixture-child';write(files,docPath,d);}
    await assert.rejects(parse(files),{code:kind==='block'?'APPFLOWY_INVALID_BLOCK_TREE':'APPFLOWY_INVALID_HIERARCHY'});
  }
});
test('text blocks with missing deltas and malformed/instruction-like inserts fail or stay literal without HTML interpretation',async()=>{
  const files=appFlowyNativeFiles(),d=read(files,docPath);delete d.meta.text_map['text-delta'];write(files,docPath,d);
  await assert.rejects(parse(files),{code:'INVALID_APPFLOWY_DELTA'});
  d.meta.text_map['text-delta']=JSON.stringify([{insert:'<script>run()</script>',attributes:{href:'javascript:run()',bold:true}}]);write(files,docPath,d);
  const plan=await parse(files),block=plan.pages.find(p=>p.sourceObjectId===ids.document).blocks[0];
  assert.equal(block.data.text,'<script>run()</script>');assert.equal('href'in block.data.marks[0],false);validateBlocks([block]);
  d.meta.text_map['text-delta']=JSON.stringify([{insert:{image:'https://example.invalid/not-fetched'}}]);write(files,docPath,d);
  await assert.rejects(parse(files),{code:'INVALID_APPFLOWY_DELTA'});
});
test('native opaque block IDs can start with underscore while generated Domain IDs remain portable',async()=>{
  const files=appFlowyNativeFiles(),d=read(files,docPath),old=d.blocks['fixture-text'];
  delete d.blocks['fixture-text'];old.id='_native-text';d.blocks['_native-text']=old;d.blocks['fixture-child'].parent='_native-text';d.meta.children_map['fixture-root-children'][0]='_native-text';write(files,docPath,d);
  const plan=await parse(files);for(const p of plan.pages)validateBlocks(p.blocks);
});
test('asset links require explicit source dependency plus unique exact basename and staged IDs before bundle activation',async()=>{
  const files=appFlowyNativeFiles(),plan=await parse(files),asset=plan.entries.find(e=>e.kind==='attachment');
  const first=prepareAppFlowyNativeBundle(plan,options());assert.equal(first.summary.attachmentsIncluded,0);assert.ok(first.requiredAcknowledgements.includes('excludedAssets'));
  const built=buildAppFlowyNativeBundle(plan,{...options(),assets:[{sourceId:asset.id,assetId:'staged-asset'}],acknowledgements});
  assert.equal(built.summary.attachmentsIncluded,1);assert.equal(built.body.assets[0].assetId,'staged-asset');
  assert.deepEqual(built.body.assets[0].pageSourceIds,[plan.pages.find(p=>p.sourceObjectId===ids.document).id]);
  files.set('other/fixture.txt',encoder.encode('Different synthetic file'));
  const ambiguous=await parse(files);assert.equal(ambiguous.links.filter(l=>l.kind==='attachment').length,0);
});
test('build requires explicit subset/type/link/asset confirmations and accepts only native default portable options',async()=>{
  const plan=await parse(appFlowyNativeFiles());
  assert.throws(()=>buildAppFlowyNativeBundle(plan,options()),{code:'ACKNOWLEDGEMENT_REQUIRED'});
  assert.equal(buildAppFlowyNativeBundle(plan,{...options(),acknowledgements}).body.expectedRevision,4);
  assert.throws(()=>prepareAppFlowyNativeBundle(plan,{...options(),csvMode:'reference'}),{code:'INVALID_IMPORT_OPTIONS'});
  assert.throws(()=>prepareAppFlowyNativeBundle(plan,{...options(),rowPageMappings:[{}]}),{code:'INVALID_IMPORT_OPTIONS'});
  assert.throws(()=>prepareAppFlowyNativeBundle(plan,{...options(),rootTitle:' '}),{code:'INVALID_IMPORT_OPTIONS'});
});
test('forged plans cannot suppress counts, warnings, unresolved review or alter hidden link targets',async()=>{
  const plan=await parse(appFlowyNativeFiles());
  for(const mutate of [
    p=>p.summary.pages--,
    p=>p.summary.records++,
    p=>p.warnings[0].message='Forged instructions',
    p=>p.warnings[0].code='UNKNOWN',
    p=>p.links=[],
    p=>p.pages[0].blocks[0].data.links[0].sourcePageId='unknown',
    p=>p.collections[0].rows[0].cells.push('unexpected'),
    p=>p.unsupported=[],
    p=>p.summary.uncompressedBytes++,
  ]){const bad=structuredClone(plan);mutate(bad);assert.throws(()=>prepareAppFlowyNativeBundle(bad,options()),{code:'INVALID_APPFLOWY_NATIVE'});}
  let invoked=0;const opts=options();Object.defineProperty(opts,'rootTitle',{enumerable:true,get(){invoked++;return 'unsafe';}});
  assert.throws(()=>prepareAppFlowyNativeBundle(plan,opts),{code:'INVALID_APPFLOWY_NATIVE'});assert.equal(invoked,0);
});
test('size and page limits reject atomically with numeric capacity details; preparation captures independent input',async()=>{
  const plan=await parse(appFlowyNativeFiles({attachment:false})),prepared=prepareAppFlowyNativeBundle(plan,options());
  const before=prepared.body.pages[1].blocks[0].data.text;plan.pages[0].blocks[0].data.text='Later mutation';assert.equal(prepared.body.pages[1].blocks[0].data.text,before);
  const tooMany=await parse(appFlowyNativeFiles({attachment:false}));while(tooMany.pages.length<500)tooMany.pages.push({id:'extra-page-'+tooMany.pages.length,entryId:tooMany.entries[0].id,title:'Synthetic',parentCandidateId:null,blocks:[],sourceObjectId:'extra-object'});
  tooMany.summary.pages=tooMany.pages.length;assert.throws(()=>prepareAppFlowyNativeBundle(tooMany,options()),{code:'IMPORT_PAGE_LIMIT'});
  const large=await parse(appFlowyNativeFiles({attachment:false}));large.pages[0].blocks=Array.from({length:8},(_,i)=>({id:'large-'+i,type:'paragraph',data:{text:'x'.repeat(100000)}}));large.links=[];large.summary.links=0;
  assert.throws(()=>prepareAppFlowyNativeBundle(large,options()),error=>error.code==='IMPORT_BUNDLE_TOO_LARGE'&&error.details.bodyBytes>768000&&error.details.limitBytes===768000);
});
test('JSON byte limits and unsafe extracted metadata paths are bounded independently of ZIP transport',async()=>{
  const files=appFlowyNativeFiles();files.set('extra.json',new Uint8Array(2*1024*1024+1));await assert.rejects(parse(files),{code:'APPFLOWY_JSON_LIMIT'});
  const unsafe=appFlowyNativeFiles();unsafe.set('../outside.json',encoder.encode('{}'));await assert.rejects(parse(unsafe),{code:'UNSAFE_ZIP_PATH'});
});

test('native internal unreferenced bytes are never offered as staged attachments',async()=>{
 const files=appFlowyNativeFiles();for(const path of ['cache/internal.bin','state/collab.af','cache/noextension'])files.set(path,new Uint8Array([1,2,3]));
 const plan=await parse(files);assert.equal(plan.summary.attachments,1);for(const path of ['cache/internal.bin','state/collab.af','cache/noextension'])assert.equal(plan.entries.find(e=>e.path===path).kind,'unsupported');
 const fake=plan.entries.find(e=>e.path==='cache/internal.bin');assert.throws(()=>prepareAppFlowyNativeBundle(plan,{...options(),assets:[{sourceId:fake.id,assetId:'staged-private-cache'}]}),{code:'INVALID_IMPORT_OPTIONS'});
});

test('lossless tuple source roundtrips every original block field, optional absence, null, extra keys and CJK delta values',async()=>{
  const files=appFlowyNativeFiles(),d=read(files,docPath);
  delete d.blocks['fixture-root'].external_id;
  d.blocks['fixture-text'].extraFixture={absentDistinguished:null,text:'日本語 😀'};
  Object.defineProperty(d.blocks['fixture-text'],'__proto__',{value:{synthetic:'own data'},enumerable:true,writable:true,configurable:true});
  d.meta.text_map['text-delta']=JSON.stringify([{insert:'日本語 😀',attributes:{bold:true,underline:true}}]);write(files,docPath,d);
  const plan=await parse(files),page=plan.pages.find(p=>p.sourceObjectId===ids.document),block=page.blocks.find(b=>b.data.sourceFormat==='appflowy-document-v1');
  assert.equal(block.data.sourceEncoding,'appflowy-document-tuples-v1');
  const expected=structuredClone(d);for(const [key,value]of Object.entries(expected.meta.text_map))expected.meta.text_map[key]=JSON.parse(value);expected.source_parent_id=ids.workspace;
  assert.deepEqual(JSON.parse(importSourceText(block)),expected);
  assert.equal(Object.hasOwn(JSON.parse(importSourceText(block)).blocks['fixture-root'],'external_id'),false);
  assert.equal(Object.getPrototypeOf({}),Object.prototype);
  const bad=structuredClone(plan);bad.pages.find(p=>p.id===page.id).blocks.find(b=>b.data.sourceEncoding).data.source.blocks[0][5].id='forged';
  assert.throws(()=>prepareAppFlowyNativeBundle(bad,options()),{code:'INVALID_APPFLOWY_NATIVE'});
});
test('nonconforming source block shapes use unencoded JSON instead of guessing missing fields',async()=>{
  const files=appFlowyNativeFiles(),d=read(files,docPath);delete d.blocks['fixture-root'].data;write(files,docPath,d);
  const plan=await parse(files),page=plan.pages.find(p=>p.sourceObjectId===ids.document),block=page.blocks.find(b=>b.data.sourceFormat==='appflowy-document-v1');
  assert.equal(Object.hasOwn(block.data,'sourceEncoding'),false);
  assert.equal(Object.hasOwn(JSON.parse(importSourceText(block)).blocks['fixture-root'],'data'),false);
});

test('single-select text columns use one exact option name while raw IDs and field options remain in readonly source',async()=>{
  const plan=await parse(appFlowyNativeFiles()),c=plan.collections[0],row=c.rows[0],page=plan.pages.find(p=>p.id===row.pageId);
  assert.equal(row.cells[1],'First');assert.equal(c.columns[1].type,'text');
  assert.equal(source(page,'appflowy-row-v1').cells['select-field'].data,'option-one');
  const built=buildAppFlowyNativeBundle(plan,{...options(),acknowledgements});
  assert.equal(built.body.collections[0].records[0].values['column-2'],'First');
  assert.ok(plan.warnings.some(w=>w.code==='NATIVE_SELECT_LABELS'&&w.count===1));
});
test('multi-select labels preserve selected ID order and literal CJK/emoji/HTML names without native type inference',async()=>{
  const files=appFlowyNativeFiles(),d=read(files,databasePath),f=d.fields[1],cell=d.rows[0].cells[f.id];
  f.field_type=4;f.type_options={'4':{content:JSON.stringify({options:[{id:'one',name:'日本語 😀'},{id:'two',name:'<b>Literal</b>'}]})}};
  cell.field_type=4;cell.data='two,one';write(files,databasePath,d);
  const plan=await parse(files),c=plan.collections[0],row=c.rows[0];
  assert.equal(row.cells[1],'<b>Literal</b>, 日本語 😀');assert.equal(c.columns[1].type,'text');
  assert.equal(source(plan.pages.find(p=>p.id===row.pageId),'appflowy-row-v1').cells[f.id].data,'two,one');
});
test('unknown IDs, duplicate option IDs, multiple single-select IDs and stale cell types preserve the entire raw cell',async()=>{
  for(const kind of ['unknown','duplicate','single-many','stale-type','invalid-json','missing-options']){
    const files=appFlowyNativeFiles(),d=read(files,databasePath),f=d.fields[1],cell=d.rows[0].cells[f.id];
    if(kind==='unknown'){f.field_type=4;cell.field_type=4;f.type_options['4']=f.type_options['3'];cell.data='option-one,not-known';}
    if(kind==='duplicate')f.type_options['3'].content=JSON.stringify({options:[{id:'option-one',name:'First'},{id:'option-one',name:'Different'}]});
    if(kind==='single-many')cell.data='option-one,option-one';
    if(kind==='stale-type')cell.field_type=4;
    if(kind==='invalid-json')f.type_options['3'].content='{invalid';
    if(kind==='missing-options')f.type_options['3'].content='{}';
    write(files,databasePath,d);const plan=await parse(files);
    assert.equal(plan.collections[0].rows[0].cells[1],cell.data,kind);
    assert.ok(plan.warnings.some(w=>w.code==='NATIVE_SELECT_UNRESOLVED'&&w.count===1),kind);
    assert.equal(plan.warnings.some(w=>w.code==='NATIVE_SELECT_LABELS'),false,kind);
  }
});
test('empty selection remains an empty string and malformed multi-select JSON or whitespace IDs are not coerced',async()=>{
  for(const data of ['',JSON.stringify({options:[{id:'option-one',name:'First'}],selected_option_ids:['option-one']}),' option-one']){
    const files=appFlowyNativeFiles(),d=read(files,databasePath),f=d.fields[1];
    f.field_type=4;f.type_options['4']=f.type_options['3'];d.rows[0].cells[f.id]={field_type:4,data};write(files,databasePath,d);
    const plan=await parse(files);assert.equal(plan.collections[0].rows[0].cells[1],data);
    assert.equal(plan.warnings.some(w=>w.code==='NATIVE_SELECT_UNRESOLVED'),data!=='');
  }
});
test('option dictionaries and expanded label output remain bounded and never erase raw IDs on overflow',async()=>{
  for(const kind of ['oversized','many','empty-name','nul-name']){
    const files=appFlowyNativeFiles(),d=read(files,databasePath),f=d.fields[1],cell=d.rows[0].cells[f.id];
    let names=[{id:'option-one',name:'First'}];
    if(kind==='oversized'){f.field_type=4;cell.field_type=4;names=[{id:'option-one',name:'x'.repeat(99900)}];cell.data='option-one,option-one';}
    if(kind==='many')names=Array.from({length:1001},(_,i)=>({id:'option-'+i,name:'Synthetic'}));
    if(kind==='empty-name')names[0].name='';
    if(kind==='nul-name')names[0].name='\0';
    f.type_options[String(f.field_type)]={content:JSON.stringify({options:names})};write(files,databasePath,d);
    const plan=await parse(files);assert.equal(plan.collections[0].rows[0].cells[1],cell.data);
    assert.ok(plan.warnings.some(w=>w.code==='NATIVE_SELECT_UNRESOLVED'));
  }
});
