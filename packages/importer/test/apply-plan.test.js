import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBlocks } from '../../domain/src/index.js';
import { prepareNotionImportBundle, buildNotionImportBundle, ImportBundleError, IMPORT_BUNDLE_LIMITS } from '../src/apply-plan.js';

import { scanMarkdownLinks, resolveImportLink } from '../src/index.js';

const encoder = new TextEncoder();
const options = () => ({ expectedRevision: 7, importId: 'fixture-import-1', rootTitle: 'Imported fixture', csvMode: 'reference' });
const ack = { csvReference:true,linksUnconverted:true,excludedAssets:true };
function planFixture({ pages = [{path:'Page.md',title:'Fixture page',source:'# Fixture page\n\nPlain text',blocks:[
  {kind:'heading',text:'Fixture page',level:1},{kind:'paragraph',text:'Plain text'}]}], collections = [], assets = [], links = [], matches = [] } = {}) {
  const plan = {schemaVersion:1,source:'notion-markdown-csv',summary:{},warnings:[],entries:[],pages:[],collections:[],links:[],matches:[],unsupported:[]};
  for (const item of pages) {
    const id='page-'+(plan.pages.length+1),entryId='entry-'+(plan.entries.length+1);
    plan.entries.push({id:entryId,path:item.path,kind:'page',bytes:encoder.encode(item.source).length,modelId:id});
    plan.pages.push({id,entryId,title:item.title,sourceMarkdown:item.source,blocks:item.blocks.map((block,index)=>({id:id+'-block-'+(index+1),...block})),
      propertyCandidates:[],parentCandidateId:null});
  }
  const stems=new Map(plan.pages.map(page=>[plan.entries.find(entry=>entry.id===page.entryId).path.replace(/\.(?:md|markdown)$/i,''),page.id]));
  for(const page of plan.pages) {
    const path=plan.entries.find(entry=>entry.id===page.entryId).path,slash=path.lastIndexOf('/');
    page.parentCandidateId=slash<0?null:stems.get(path.slice(0,slash))??null;
  }
  for (const item of collections) {
    const id='collection-'+(plan.collections.length+1),entryId='entry-'+(plan.entries.length+1);
    plan.entries.push({id:entryId,path:item.path,kind:'collection',bytes:encoder.encode(JSON.stringify(item)).length,modelId:id});
    plan.collections.push({id,entryId,title:item.title,columns:item.columns.map((name,index)=>({id:'column-'+(index+1),name,type:'text',confirmed:false})),
      rows:item.rows.map((cells,index)=>({id:id+'-row-'+(index+1),cells}))});
  }
  for(const item of assets) {
    const id='entry-'+(plan.entries.length+1);
    plan.entries.push({id,path:item.path,kind:item.kind??'attachment',bytes:item.bytes??1});
    if(item.kind==='unsupported')plan.unsupported.push({entryId:id,reason:'UNSUPPORTED_HTML'});
  }
  plan.links=links.map((link,index)=>({id:'link-'+(index+1),sourceId:'page-1',label:'Fixture link',image:false,...link}));
  plan.matches=matches;
  plan.summary={entries:plan.entries.length,pages:plan.pages.length,collections:plan.collections.length,
    records:plan.collections.reduce((sum,collection)=>sum+collection.rows.length,0),attachments:plan.entries.filter(entry=>entry.kind==='attachment').length,
    links:plan.links.length,unresolvedLinks:plan.links.filter(link=>link.kind==='unresolved').length,matchingCandidates:plan.matches.length,
    unsupported:plan.unsupported.length,archiveBytes:1000,uncompressedBytes:plan.entries.reduce((sum,entry)=>sum+entry.bytes,0)};
  return plan;
}
const csv = () => ({path:'Database.csv',title:'Fixture database',columns:['Name','Note','Note'],rows:[
  ['Fixture row','line one\nline "two"','=SUM(A1:A2)'],['Other row','',' +literal'],
]});
const invalid = (code='INVALID_IMPORT_PLAN') => cause=>cause instanceof ImportBundleError&&cause.code===code;
const codeText = (page,language) => page.blocks.filter(block=>block.type==='code'&&block.data.language===language).map(block=>block.data.text).join('');

test('prepare creates one private root and preserves every CSV string and Markdown source without native collection conversion', () => {
  const plan=planFixture({collections:[csv()]});
  const prepared=prepareNotionImportBundle(plan,options());
  assert.equal(prepared.body.pages.length,3);
  assert.deepEqual(prepared.body.pages[0].sourceId,'import-root');
  assert.equal(prepared.body.pages[0].parentSourceId,null);
  assert.equal(prepared.body.pages[0].title,'Imported fixture');
  assert.ok(prepared.body.pages.slice(1).every(page=>page.parentSourceId==='import-root'));
  assert.deepEqual(JSON.parse(codeText(prepared.body.pages[2],'json')),{format:'notion-csv-reference-v1',columns:csv().columns,rows:csv().rows});
  assert.equal(codeText(prepared.body.pages[1],'markdown'),plan.pages[0].sourceMarkdown);
  assert.deepEqual(prepared.requiredAcknowledgements,['csvReference']);
  assert.equal(prepared.summary.bodyBytes,encoder.encode(JSON.stringify(prepared.body)).length);
  assert.equal(prepared.summary.records,2);
  assert.ok(prepared.warnings.some(warning=>warning.code==='CSV_REFERENCE_ONLY'));
  for(const page of prepared.body.pages)assert.doesNotThrow(()=>validateBlocks(page.blocks));
  assert.equal('collections' in prepared.body,false);
  assert.equal('grants' in prepared.body,false);
});

test('final bundle requires explicit applicable acknowledgements, not truthy strings or source preview warnings', () => {
  const plan=planFixture({collections:[csv()],assets:[{path:'image.png'},{path:'unknown.html',kind:'unsupported'}],
    links:[{kind:'unresolved',reason:'MISSING_TARGET'}]});
  const prepared=prepareNotionImportBundle(plan,options());
  assert.deepEqual(prepared.requiredAcknowledgements,['csvReference','linksUnconverted','excludedAssets']);
  assert.throws(()=>buildNotionImportBundle(plan,options()),cause=>invalid('ACKNOWLEDGEMENT_REQUIRED')(cause)&&cause.requiredAcknowledgements.length===3);
  assert.throws(()=>buildNotionImportBundle(plan,{...options(),acknowledgements:{csvReference:true,linksUnconverted:false,excludedAssets:true}}),
    cause=>invalid('ACKNOWLEDGEMENT_REQUIRED')(cause)&&assert.deepEqual(cause.requiredAcknowledgements,['linksUnconverted'])===undefined);
  assert.throws(()=>buildNotionImportBundle(plan,{...options(),acknowledgements:{csvReference:'yes'}}),invalid('INVALID_IMPORT_OPTIONS'));
  assert.deepEqual(buildNotionImportBundle(plan,{...options(),acknowledgements:ack}).body,prepared.body);
  assert.doesNotThrow(()=>buildNotionImportBundle(planFixture(),options()));
});

test('Markdown subset converts only editor-compatible primary text and keeps HTML and fenced-code text literal', () => {
  const source='# <img src=x onerror=evil()>\n\n## Heading\n\n- [x] Complete\n\n> quote\n\n'+'~~~js\nalert(1)\n~~~';
  const blocks=[{kind:'heading',text:'<img src=x onerror=evil()>',level:1},{kind:'heading',text:'Heading',level:4},
    {kind:'todo',text:'Complete',checked:true},{kind:'quote',text:'quote'},{kind:'list-item',text:'item'},{kind:'code',text:'alert(1)'}];
  const bundle=buildNotionImportBundle(planFixture({pages:[{path:'Page.md',title:'Literal fixture',source,blocks}]}),options());
  const page=bundle.body.pages[1];
  assert.deepEqual(page.blocks.map(block=>block.type),['heading','heading','checklist','quote','bulleted-list','code','code']);
  assert.equal(page.blocks[0].data.text,'<img src=x onerror=evil()>');
  assert.equal(page.blocks[1].data.level,3);
  assert.equal(page.blocks[2].data.checked,true);
  assert.equal(page.blocks[5].data.text,'alert(1)');
  assert.equal(page.blocks.at(-1).data.purpose,'import-source');
  assert.equal(codeText(page,'markdown'),source);
});

test('exact source folder hierarchy is retained across Markdown and CSV reference pages; title matches never create parents', () => {
  const pages=[
    {path:'Root.md',title:'Root',source:'# Root',blocks:[{kind:'heading',text:'Root',level:1}]},
    {path:'Root/Child.md',title:'Child',source:'# Child',blocks:[{kind:'heading',text:'Child',level:1}]},
    {path:'Root/Database/Row.md',title:'Fixture row',source:'# Fixture row',blocks:[{kind:'heading',text:'Fixture row',level:1}]},
    {path:'Different folder/Separate.md',title:'Fixture row',source:'# Fixture row',blocks:[{kind:'heading',text:'Fixture row',level:1}]},
  ];
  const collection={...csv(),path:'Root/Database.csv'};
  const bundle=buildNotionImportBundle(planFixture({pages,collections:[collection]}),{...options(),acknowledgements:ack});
  const byId=new Map(bundle.body.pages.map(page=>[page.sourceId,page]));
  assert.equal(byId.get('markdown-1').parentSourceId,'import-root');
  assert.equal(byId.get('markdown-2').parentSourceId,'markdown-1');
  assert.equal(byId.get('csv-1').parentSourceId,'markdown-1');
  assert.equal(byId.get('markdown-3').parentSourceId,'csv-1');
  assert.equal(byId.get('markdown-4').parentSourceId,'import-root');
});

test('duplicate titles remain distinct, IDs and payload are deterministic and revision-only retry preserves the pages', () => {
  const pages=['A.md','B.md'].map(path=>({path,title:'Same',source:'# Same',blocks:[{kind:'heading',text:'Same',level:1}]}));
  const plan=planFixture({pages});
  const first=buildNotionImportBundle(plan,options()),again=buildNotionImportBundle(plan,options());
  assert.deepEqual(first,again);
  assert.equal(new Set(first.body.pages.map(page=>page.sourceId)).size,3);
  assert.deepEqual(buildNotionImportBundle(plan,{...options(),expectedRevision:8}).body.pages,first.body.pages);
});

test('source chunking stays within the text limit and never splits a UTF-16 surrogate pair', () => {
  const source='x'.repeat(99999)+'😀';
  const bundle=buildNotionImportBundle(planFixture({pages:[{path:'Page.md',title:'Chunked',source,blocks:[{kind:'paragraph',text:source}]}]}),options());
  const page=bundle.body.pages[1],codes=page.blocks.filter(block=>block.type==='code');
  assert.equal(codes.length,2);
  assert.deepEqual(codes.map(block=>block.data.sourcePart),[1,2]);
  assert.ok(page.blocks.every(block=>block.data.text.length<=IMPORT_BUNDLE_LIMITS.textChars));
  assert.equal(codeText(page,'markdown'),source);
  assert.equal(codes[0].data.text.endsWith('\ud83d'),false);
  assert.equal(codes[1].data.text.startsWith('😀'),true);
});

test('request UTF-8 size and root-inclusive page count reject the complete bundle rather than dropping pages', () => {
  const source='あ'.repeat(50000);
  assert.throws(()=>buildNotionImportBundle(planFixture({pages:[{path:'Page.md',title:'Large',source,blocks:[{kind:'paragraph',text:source}]}]}),options()),invalid('IMPORT_BUNDLE_TOO_LARGE'));
  const pages=Array.from({length:99},(_,index)=>({path:'Page'+index+'.md',title:'Page '+index,source:'# Page',blocks:[{kind:'heading',text:'Page',level:1}]}));
  assert.equal(buildNotionImportBundle(planFixture({pages}),options()).body.pages.length,100);
  pages.push({path:'Extra.md',title:'Extra',source:'# Extra',blocks:[]});
  assert.throws(()=>buildNotionImportBundle(planFixture({pages}),options()),invalid('TOO_MANY_IMPORT_PAGES'));
});

test('plan validation rejects forged references, fields, CSV types, summary, hierarchy and executable block kinds', () => {
  const base=planFixture({collections:[csv()]});
  const corruptions=[
    plan=>{plan.grants=[];},
    plan=>{plan.summary.pages=999;},
    plan=>{plan.pages[0].parentCandidateId='page-1';},
    plan=>{plan.pages[0].blocks[0].kind='iframe';},
    plan=>{plan.pages[0].blocks[0].html='<script>';},
    plan=>{plan.entries[0].path='../Page.md';},
    plan=>{plan.entries[1].id=plan.entries[0].id;},
    plan=>{plan.entries[0].modelId='unknown';},
    plan=>{plan.collections[0].rows[0].cells[0]=123;},
    plan=>{plan.collections[0].rows[0].cells.pop();},
    plan=>{plan.collections[0].columns[0].type='formula';},
    plan=>{plan.collections[0].columns[0].confirmed=true;},
  ];
  for(const corrupt of corruptions) {const plan=structuredClone(base);corrupt(plan);assert.throws(()=>prepareNotionImportBundle(plan,options()),invalid());}
  const cyclic=structuredClone(base);cyclic.pages[0].extra=cyclic;
  assert.throws(()=>prepareNotionImportBundle(cyclic,options()),invalid());
});

test('validation never invokes getters and returned values do not retain mutable references to the preview', () => {
  const plan=planFixture({collections:[csv()]});
  let invoked=false;
  Object.defineProperty(plan.pages[0],'title',{enumerable:true,get(){invoked=true;return 'unsafe';}});
  assert.throws(()=>prepareNotionImportBundle(plan,options()),invalid());
  assert.equal(invoked,false);
  const valid=planFixture({collections:[csv()]}),prepared=prepareNotionImportBundle(valid,options());
  valid.pages[0].blocks[0].text='Changed';
  valid.collections[0].rows[0].cells[0]='Changed';
  assert.equal(prepared.body.pages[1].blocks[0].data.text,'Fixture page');
  assert.equal(JSON.parse(codeText(prepared.body.pages[2],'json')).rows[0][0],'Fixture row');
});

test('links are retained as original strings without guessed server URLs and same-title row candidates never merge documents', () => {
  const plan=planFixture({collections:[csv()],links:[{kind:'collection',targetId:'collection-1'}],
    matches:[{collectionId:'collection-1',rowId:'collection-1-row-1',pageId:'page-1',method:'exact-title-in-cell',confirmed:false,ambiguous:false}]});
  plan.pages[0].sourceMarkdown='[Database](Database.csv)';
  plan.pages[0].blocks=[{id:'block-1',kind:'paragraph',text:'[Database](Database.csv)'}];
  plan.entries[0].bytes=encoder.encode(plan.pages[0].sourceMarkdown).length;
  plan.summary.uncompressedBytes=plan.entries.reduce((sum,entry)=>sum+entry.bytes,0);
  const bundle=buildNotionImportBundle(plan,{...options(),acknowledgements:ack});
  assert.equal(bundle.summary.unconvertedLinks,1);
  assert.equal(bundle.body.pages.length,3);
  assert.equal(bundle.body.pages[1].blocks[0].data.text,'[Database](Database.csv)');
  assert.doesNotMatch(JSON.stringify(bundle.body),/\/workspace\.html|workspaceId|accountId/);
  assert.ok(bundle.warnings.some(warning=>warning.code==='MATCHES_NOT_MERGED'));
});

test('root options and acknowledgement keys are bounded and asset-only plans cannot silently create an empty import', () => {
  for(const value of [{...options(),rootTitle:''},{...options(),rootTitle:'x'.repeat(241)},{...options(),importId:'../bad'},
    {...options(),expectedRevision:-1},{...options(),expectedRevision:Number.MAX_SAFE_INTEGER}]) {
    assert.throws(()=>prepareNotionImportBundle(planFixture(),value),invalid('INVALID_IMPORT_OPTIONS'));
  }
  assert.throws(()=>buildNotionImportBundle(planFixture(),{...options(),acknowledgements:{all:true}}),invalid());
  assert.throws(()=>prepareNotionImportBundle(planFixture({pages:[],assets:[{path:'unsupported.html',kind:'unsupported'}]}),options()),invalid('NO_IMPORTABLE_CONTENT'));
  assert.equal(buildNotionImportBundle(planFixture(),{...options(),importId:'a'.repeat(128)}).body.importId.length,128);
});

test('a Markdown parent wins over a CSV reference with the same stem and every generated page reaches the single root', () => {
  const pages=[
    {path:'Parent.md',title:'Parent',source:'# Parent',blocks:[{kind:'heading',text:'Parent',level:1}]},
    {path:'Parent/Child.md',title:'Child',source:'# Child',blocks:[{kind:'heading',text:'Child',level:1}]},
  ];
  const prepared=prepareNotionImportBundle(planFixture({pages,collections:[{...csv(),path:'Parent.csv'}]}),options());
  assert.equal(prepared.body.pages.find(page=>page.sourceId==='markdown-2').parentSourceId,'markdown-1');
  assert.equal(prepared.body.pages.find(page=>page.sourceId==='csv-1').parentSourceId,'import-root');
  const byId=new Map(prepared.body.pages.map(page=>[page.sourceId,page]));
  assert.equal(prepared.body.pages.filter(page=>page.parentSourceId===null).length,1);
  for(const page of prepared.body.pages) {
    const visited=new Set();
    let current=page;
    while(current.parentSourceId!==null) {
      assert.equal(visited.has(current.sourceId),false);
      visited.add(current.sourceId);current=byId.get(current.parentSourceId);assert.ok(current);
    }
    assert.equal(current.sourceId,'import-root');
  }
});

test('links to excluded HTML remain literal and still require asset and link acknowledgements', () => {
  const plan=planFixture({assets:[{path:'excluded.html',kind:'unsupported'}],links:[{kind:'unsupported',targetId:'entry-2'}]});
  const prepared=prepareNotionImportBundle(plan,options());
  assert.deepEqual(prepared.requiredAcknowledgements,['linksUnconverted','excludedAssets']);
  assert.equal(prepared.summary.unsupportedExcluded,1);
  assert.equal(prepared.body.pages.length,2);
  assert.throws(()=>buildNotionImportBundle(plan,{...options(),acknowledgements:{linksUnconverted:true}}),
    cause=>invalid('ACKNOWLEDGEMENT_REQUIRED')(cause)&&cause.requiredAcknowledgements.includes('excludedAssets'));
});

function withLocatedLinks(plan) {
  const byPath=new Map(plan.entries.map(entry=>[entry.path,entry]));
  const links=[];
  for(const page of plan.pages) {
    const entry=plan.entries.find(entry=>entry.id===page.entryId);
    for(const block of page.blocks.filter(block=>block.kind!=='code'))for(const match of scanMarkdownLinks(block.text)) {
      const {href,...span}=match;
      links.push({id:'link-'+(links.length+1),sourceId:page.id,blockId:block.id,...span,rawHref:href,...resolveImportLink(href,entry.path,byPath)});
    }
  }
  plan.links=links;plan.summary.links=links.length;plan.summary.unresolvedLinks=links.filter(link=>link.kind==='unresolved').length;
  return plan;
}
const nativeOptions=()=>({...options(),csvMode:'native',acknowledgements:{csvTextTypes:true,linksUnconverted:true,excludedAssets:true}});

test('native CSV is the default and preserves duplicate/empty headers, blank cells and immutable source strings without inference',()=>{
  const collection={...csv(),columns:['','Note','Note'],rows:[['','line\nbreak','=SUM(A1:A2)'],['123','false','2026-01-01']]};
  const plan=planFixture({collections:[collection]});
  const optionsWithoutMode={expectedRevision:7,importId:'native-default',acknowledgements:{csvTextTypes:true}};
  const result=buildNotionImportBundle(plan,optionsWithoutMode);
  assert.equal(result.summary.nativeCollections,1);
  assert.equal(result.summary.csvReferencePages,0);
  assert.equal(result.summary.recordPages,2);
  assert.equal(result.body.pages.length,5);
  const native=result.body.collections[0];
  assert.deepEqual(native.properties.map(property=>property.type),['text','text','text']);
  assert.deepEqual(native.properties.map(property=>property.sourceName),collection.columns);
  assert.deepEqual(native.properties.map(property=>property.name),['Column 1','Note','Note']);
  assert.deepEqual(native.records[0].values,{'column-1':'','column-2':'line\nbreak','column-3':'=SUM(A1:A2)'});
  assert.equal(native.records[1].values['column-1'],'123');
  assert.equal(native.records[1].values['column-2'],'false');
  assert.equal(result.body.pages.find(page=>page.sourceId===native.records[0].pageSourceId).title,'Row 1');
  assert.equal('rows' in JSON.parse(codeText(result.body.pages.find(page=>page.sourceId==='csv-1'),'json')),false);
  assert.equal(JSON.parse(codeText(result.body.pages.find(page=>page.sourceId===native.records[0].pageSourceId),'json')).cells[0],'');
  assert.deepEqual(result.requiredAcknowledgements,['csvTextTypes']);
});

test('same-title rows create separate pages until an explicit one-to-one row mapping is supplied',()=>{
  const plan=planFixture({pages:[{path:'A.md',title:'Fixture row',source:'# Fixture row',blocks:[{kind:'heading',text:'Fixture row',level:1}]}],collections:[csv()]});
  const separate=buildNotionImportBundle(plan,nativeOptions());
  assert.equal(separate.summary.mappedRows,0);
  assert.notEqual(separate.body.collections[0].records[0].pageSourceId,'markdown-1');
  const mapped=buildNotionImportBundle(plan,{...nativeOptions(),rowPageMappings:[{collectionId:'collection-1',rowId:'collection-1-row-1',pageId:'page-1'}]});
  assert.equal(mapped.summary.mappedRows,1);
  assert.equal(mapped.body.pages.length,separate.body.pages.length-1);
  assert.equal(mapped.body.collections[0].records[0].pageSourceId,'markdown-1');
  assert.equal(mapped.body.pages.find(page=>page.sourceId==='markdown-1').parentSourceId,'csv-1');
  assert.equal(codeText(mapped.body.pages.find(page=>page.sourceId==='markdown-1'),'markdown'),'# Fixture row');
});

test('duplicate mappings, absent rows and mapping-induced parent cycles reject the whole bundle',()=>{
  const plan=planFixture({pages:[{path:'Parent.md',title:'Parent',source:'# Parent',blocks:[]}],collections:[{...csv(),path:'Parent/Database.csv'}]});
  const mapping={collectionId:'collection-1',rowId:'collection-1-row-1',pageId:'page-1'};
  assert.throws(()=>prepareNotionImportBundle(plan,{...nativeOptions(),acknowledgements:undefined,rowPageMappings:[mapping]}),invalid());
  const settings={...options(),csvMode:'native'};
  assert.throws(()=>prepareNotionImportBundle(plan,{...settings,rowPageMappings:[mapping]}),invalid('INVALID_ROW_MAPPING'));
  assert.throws(()=>prepareNotionImportBundle(plan,{...settings,rowPageMappings:[mapping,mapping]}),invalid('INVALID_ROW_MAPPING'));
  assert.throws(()=>prepareNotionImportBundle(plan,{...settings,rowPageMappings:[{...mapping,rowId:'missing'}]}),invalid('INVALID_ROW_MAPPING'));
});

test('parser-derived locations transform only exact internal markup into label spans, using prefix-free quote/list types and retaining raw Markdown',()=>{
  const source='😀 before [One](Other.md#part%20one) and [Two](Database.csv)';
  const plan=withLocatedLinks(planFixture({pages:[
    {path:'Page.md',title:'Page',source,blocks:[{kind:'quote',text:source}]},
    {path:'Other.md',title:'Other',source:'# Other',blocks:[]},
  ],collections:[csv()]}));
  const result=buildNotionImportBundle(plan,nativeOptions()),page=result.body.pages.find(page=>page.sourceId==='markdown-1');
  const primary=page.blocks[0];
  assert.equal(primary.data.text,'😀 before One and Two');
  assert.equal(primary.data.links.length,2);
  assert.deepEqual(primary.data.links[0],{start:10,end:13,label:'One',sourcePageId:'markdown-2',fragment:'part one'});
  assert.equal(primary.data.links[1].sourceCollectionId,'native-collection-1');
  for(const link of primary.data.links)assert.equal(primary.data.text.slice(link.start,link.end),link.label);
  assert.equal(codeText(page,'markdown'),source);
  assert.equal(result.summary.convertedLinks,2);
  assert.equal(result.summary.unconvertedLinks,0);
  assert.deepEqual(result.requiredAcknowledgements,['csvTextTypes']);
});

test('external, blocked, excluded attachment and positionless legacy links stay literal without automatic anchors',()=>{
  const source='[Safe](https://example.invalid) [Bad](javascript:bad) ![Asset](image.png)';
  const plan=withLocatedLinks(planFixture({pages:[{path:'Page.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]}],assets:[{path:'image.png'}]}));
  const result=buildNotionImportBundle(plan,nativeOptions());
  assert.equal(result.summary.convertedLinks,0);
  assert.equal(result.summary.unconvertedLinks,3);
  assert.equal(result.body.pages[1].blocks[0].data.text,source);
  assert.equal('links' in result.body.pages[1].blocks[0].data,false);
  const legacy=planFixture({links:[{kind:'page',targetId:'page-1'}]});
  assert.equal(buildNotionImportBundle(legacy,nativeOptions()).summary.convertedLinks,0);
});

test('tampered spans, substituted targets and overlapping location claims cannot drive text replacements',()=>{
  const source='[Link](Other.md)';
  const base=withLocatedLinks(planFixture({pages:[
    {path:'Page.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]},
    {path:'Other.md',title:'Other',source:'# Other',blocks:[]},
  ]}));
  for(const corrupt of [
    plan=>{plan.links[0].start=1;},plan=>{plan.links[0].label='Other';},plan=>{plan.links[0].rawHref='Page.md';},
    plan=>{plan.links[0].targetId='page-1';},plan=>{plan.links[0].blockId='unknown';},
  ]){const plan=structuredClone(base);corrupt(plan);assert.throws(()=>prepareNotionImportBundle(plan,{...options(),csvMode:'native'}),invalid());}
});

test('link spans survive text chunk boundaries and native rows count toward the complete 100-page limit',()=>{
  const source='x'.repeat(99998)+'[Link](Other.md)';
  const plan=withLocatedLinks(planFixture({pages:[
    {path:'Page.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]},
    {path:'Other.md',title:'Other',source:'# Other',blocks:[]},
  ]}));
  const result=buildNotionImportBundle(plan,nativeOptions());
  const linked=result.body.pages[1].blocks.filter(block=>block.data.links?.length);
  assert.equal(linked.length,1);
  assert.equal(linked[0].data.text.slice(linked[0].data.links[0].start,linked[0].data.links[0].end),'Link');
  const rows=Array.from({length:98},(_,index)=>['Row '+index,'','']);
  const big=planFixture({pages:[],collections:[{...csv(),rows}]});
  assert.equal(buildNotionImportBundle(big,nativeOptions()).body.pages.length,100);
  rows.push(['Extra','','']);
  assert.throws(()=>buildNotionImportBundle(planFixture({pages:[],collections:[{...csv(),rows}]}),nativeOptions()),invalid('TOO_MANY_IMPORT_PAGES'));
});


test('native collection source blocks expose headers only and isolate each CSV row including mapped Markdown rows',()=>{
  const plan=planFixture({pages:[{path:'Mapped.md',title:'Mapped',source:'# Mapped',blocks:[]}],
    collections:[{...csv(),rows:[['First','PRIVATE-FIRST',''],['Second','PRIVATE-SECOND','']]}]});
  const result=buildNotionImportBundle(plan,{...nativeOptions(),rowPageMappings:[
    {collectionId:'collection-1',rowId:'collection-1-row-1',pageId:'page-1'},
  ]});
  const container=result.body.pages.find(page=>page.sourceId==='csv-1');
  assert.equal(JSON.stringify(container).includes('PRIVATE-FIRST'),false);
  assert.equal(JSON.stringify(container).includes('PRIVATE-SECOND'),false);
  const first=result.body.pages.find(page=>page.sourceId==='markdown-1');
  const second=result.body.pages.find(page=>page.sourceId==='csv-row-1-2');
  assert.equal(codeText(first,'markdown'),'# Mapped');
  assert.deepEqual(JSON.parse(codeText(first,'json')).cells,['First','PRIVATE-FIRST','']);
  assert.equal(JSON.stringify(first).includes('PRIVATE-SECOND'),false);
  assert.deepEqual(JSON.parse(codeText(second,'json')).cells,['Second','PRIVATE-SECOND','']);
  assert.equal(JSON.stringify(second).includes('PRIVATE-FIRST'),false);
});

test('staged attachments bind to every exact referencing page, retain original Markdown, and use a filename for an empty image label',()=>{
  const source='![](image.png) and [Download](image.png)';
  const plan=withLocatedLinks(planFixture({pages:[
    {path:'Page.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]},
    {path:'Mapped.md',title:'Mapped',source:'[Again](image.png)',blocks:[{kind:'paragraph',text:'[Again](image.png)'}]},
  ],collections:[{...csv(),rows:[['Mapped','','']]}],assets:[{path:'image.png'},{path:'unused.bin'}]}));
  const result=buildNotionImportBundle(plan,{...nativeOptions(),
    rowPageMappings:[{collectionId:'collection-1',rowId:'collection-1-row-1',pageId:'page-2'}],
    assets:[{sourceId:'entry-4',assetId:'staged-image'},{sourceId:'entry-5',assetId:'staged-unused'}]});
  assert.deepEqual(result.body.assets,[
    {sourceId:'entry-4',assetId:'staged-image',pageSourceIds:['markdown-1','markdown-2']},
    {sourceId:'entry-5',assetId:'staged-unused',pageSourceIds:['import-root']},
  ]);
  assert.equal(result.summary.attachmentsIncluded,2);
  assert.equal(result.summary.attachmentsExcluded,0);
  assert.equal(result.summary.convertedLinks,3);
  assert.deepEqual(result.requiredAcknowledgements,['csvTextTypes']);
  const page=result.body.pages.find(page=>page.sourceId==='markdown-1');
  assert.equal(page.blocks[0].data.text,'image.png and Download');
  assert.deepEqual(page.blocks[0].data.links.map(link=>link.sourceAssetId),['entry-4','entry-4']);
  for(const link of page.blocks[0].data.links)assert.equal(page.blocks[0].data.text.slice(link.start,link.end),link.label);
  assert.equal(codeText(page,'markdown'),source);
  assert.equal(result.body.pages.find(page=>page.sourceId==='markdown-2').parentSourceId,'csv-1');
});

test('only staged attachment entries reduce exclusion acknowledgements, and invalid source/asset identities reject',()=>{
  const source='[Saved](image.png) [Not saved](other.bin)';
  const plan=withLocatedLinks(planFixture({pages:[{path:'Page.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]}],
    assets:[{path:'image.png'},{path:'other.bin'},{path:'unsupported.html',kind:'unsupported'}]}));
  const opts={...options(),csvMode:'native',assets:[{sourceId:'entry-2',assetId:'staged-image'}]};
  const partial=prepareNotionImportBundle(plan,opts);
  assert.equal(partial.summary.attachmentsIncluded,1);
  assert.equal(partial.summary.attachmentsExcluded,1);
  assert.equal(partial.summary.unsupportedExcluded,1);
  assert.deepEqual(partial.requiredAcknowledgements,['linksUnconverted','excludedAssets']);
  assert.equal(partial.body.pages[1].blocks[0].data.text,'Saved [Not saved](other.bin)');
  for(const assets of [
    [{sourceId:'entry-1',assetId:'staged-page'}],
    [{sourceId:'entry-4',assetId:'staged-unsupported'}],
    [{sourceId:'entry-2',assetId:'same'},{sourceId:'entry-3',assetId:'same'}],
    [{sourceId:'entry-2',assetId:'one'},{sourceId:'entry-2',assetId:'two'}],
    [{sourceId:'missing',assetId:'unknown'}],
  ])assert.throws(()=>prepareNotionImportBundle(plan,{...opts,assets}),invalid('INVALID_IMPORT_OPTIONS'));
});

test('native imports accept all 128 CSV columns and chunk more than 1000 structured links without exceeding block bounds',()=>{
  const columns=Array.from({length:128},(_,index)=>'Column '+index);
  const wide=buildNotionImportBundle(planFixture({pages:[],collections:[{...csv(),columns,rows:[columns.map(()=>'')]}]}),nativeOptions());
  assert.equal(wide.body.collections[0].properties.length,128);
  assert.deepEqual(Object.values(wide.body.collections[0].records[0].values),columns.map(()=>''));
  const source=Array.from({length:1001},()=> '[X](Other.md)').join(' ');
  const many=buildNotionImportBundle(withLocatedLinks(planFixture({pages:[
    {path:'Page.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]},
    {path:'Other.md',title:'Other',source:'# Other',blocks:[]},
  ]})),nativeOptions());
  const primary=many.body.pages[1].blocks.filter(block=>block.type!=='code');
  assert.deepEqual(primary.map(block=>block.data.links?.length),[1000,1]);
  assert.equal(primary.map(block=>block.data.text).join(''),Array.from({length:1001},()=> 'X').join(' '));
  for(const block of primary)for(const link of block.data.links)assert.equal(block.data.text.slice(link.start,link.end),link.label);
});

test('staged asset count and total page bindings are bounded before an import request is returned',()=>{
  const plan=planFixture({assets:Array.from({length:101},(_,index)=>({path:'asset-'+index+'.bin'}))});
  assert.throws(()=>prepareNotionImportBundle(plan,{...options(),assets:plan.entries.filter(entry=>entry.kind==='attachment').map((entry,index)=>({sourceId:entry.id,assetId:'staged-'+index}))}),invalid());
  const source=Array.from({length:11},(_,index)=>'[A](asset-'+index+'.bin)').join(' ');
  const pages=Array.from({length:92},(_,index)=>({path:'Page'+index+'.md',title:'Page',source,blocks:[{kind:'paragraph',text:source}]}));
  const large=withLocatedLinks(planFixture({pages,assets:Array.from({length:11},(_,index)=>({path:'asset-'+index+'.bin'}))}));
  assert.throws(()=>prepareNotionImportBundle(large,{...options(),assets:large.entries.filter(entry=>entry.kind==='attachment').map((entry,index)=>({sourceId:entry.id,assetId:'staged-'+index}))}),invalid('TOO_MANY_ASSET_BINDINGS'));
});
