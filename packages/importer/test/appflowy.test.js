import test from 'node:test';
import assert from 'node:assert/strict';
import { previewAppFlowyImport, previewNotionImport, extractMarkdownCsvAttachments } from '../src/index.js';
import { prepareImportBundle, buildImportBundle } from '../src/apply-plan.js';

const utf8 = new TextEncoder();
function crc(bytes) { let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0; }
function zip(files) {
 const locals=[],headers=[];let offset=0;
 for(const [path,text] of files){const name=utf8.encode(path),bytes=typeof text==='string'?utf8.encode(text):text,local=new Uint8Array(30+name.length+bytes.length),head=new Uint8Array(46+name.length),lv=new DataView(local.buffer),hv=new DataView(head.buffer);
 lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint32(14,crc(bytes),true);lv.setUint32(18,bytes.length,true);lv.setUint32(22,bytes.length,true);lv.setUint16(26,name.length,true);local.set(name,30);local.set(bytes,30+name.length);
 hv.setUint32(0,0x02014b50,true);hv.setUint16(4,20,true);hv.setUint16(6,20,true);hv.setUint16(8,0x800,true);hv.setUint32(16,crc(bytes),true);hv.setUint32(20,bytes.length,true);hv.setUint32(24,bytes.length,true);hv.setUint16(28,name.length,true);hv.setUint32(42,offset,true);head.set(name,46);locals.push(local);headers.push(head);offset+=local.length;}
 const central=offset,total=offset+headers.reduce((sum,item)=>sum+item.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,total-central,true);ev.setUint32(16,central,true);const output=new Uint8Array(total+22);offset=0;for(const part of [...locals,...headers,end]){output.set(part,offset);offset+=part.length;}return output;
}
const options={expectedRevision:4,importId:'synthetic-appflowy-import'};
const acknowledgements={csvTextTypes:true,csvReference:true,linksUnconverted:true,excludedAssets:true};

test('AppFlowy portable ZIP preserves hexadecimal filename suffixes and identifies the real source',async()=>{
 const suffix='0123456789abcdef0123456789abcdef',archive=zip([['Project '+suffix+'.md','Plain page'],['Table '+suffix+'.csv','Name\nAoi\n']]);
 const appflowy=await previewAppFlowyImport(archive),notion=await previewNotionImport(archive);
 assert.equal(appflowy.source,'appflowy-markdown-csv');assert.equal(appflowy.pages[0].title,'Project '+suffix);assert.equal(appflowy.collections[0].title,'Table '+suffix);assert.equal(appflowy.entries[0].path,'Project '+suffix+'.md');
 assert.equal(notion.source,'notion-markdown-csv');assert.equal(notion.pages[0].title,'Project');assert.equal(notion.collections[0].title,'Table');
 const bundle=buildImportBundle(appflowy,{...options,acknowledgements});assert.equal(bundle.body.pages[0].title,'AppFlowyからの取込み');assert.match(bundle.body.pages[0].blocks[0].data.text,/^AppFlowy import/);assert.doesNotMatch(JSON.stringify(bundle.body),/notion-csv/);
});

test('AppFlowy nested Markdown, native CSV rows and literal original cells share the existing atomic bundle contract',async()=>{
 const archive=zip([['Parent.md','# Parent\n[Child](Parent/Child.md)\n[Table](Table.csv)'],['Parent/Child.md','# Aoi\n- [x] Done'],['Table.csv','Name,Owner\nAoi,=SUM(A1)\nRen,Mika\n']]);
 const plan=await previewAppFlowyImport(archive);assert.equal(plan.pages[1].parentCandidateId,plan.pages[0].id);assert.equal(plan.matches.length,1);
 const bundle=buildImportBundle(plan,{...options,rowPageMappings:[{collectionId:plan.collections[0].id,rowId:plan.collections[0].rows[0].id,pageId:plan.pages[1].id}],acknowledgements});
 assert.equal(bundle.summary.pages,5);assert.equal(bundle.summary.nativeCollections,1);assert.equal(bundle.summary.mappedRows,1);assert.equal(bundle.summary.convertedLinks,2);assert.equal(bundle.body.collections[0].records[0].values['column-2'],'=SUM(A1)');assert.ok(bundle.body.collections[0].properties.every(property=>property.type==='text'));
 const container=bundle.body.pages.find(page=>page.sourceId==='csv-1');assert.doesNotMatch(JSON.stringify(container),/=SUM/);const row=bundle.body.pages.find(page=>page.sourceId==='markdown-2');assert.match(JSON.stringify(row),/appflowy-csv-row-v1/);assert.match(JSON.stringify(row),/=SUM/);
});

test('AppFlowy metadata and unreferenced internal bytes are excluded instead of offered as attachments',async()=>{
 const archive=zip([['Page.md','# Sample\n[file](assets/note.txt)\n[config](config.json)'],['assets/note.txt','synthetic file'],['config.json','{"privateFixture":"internal"}'],['workspace.collab',new Uint8Array([1,2,3])],['unknown.bin',new Uint8Array([4,5])],['unused.png',new Uint8Array([6,7])]]);
 const plan=await previewAppFlowyImport(archive);assert.equal(plan.summary.attachments,1);assert.equal(plan.summary.unsupported,4);assert.equal(plan.entries.find(entry=>entry.path==='unknown.bin').kind,'unsupported');assert.ok(plan.warnings.some(warning=>warning.code==='APPFLOWY_UNREFERENCED_FILES'&&warning.count===2));
 const asset=plan.entries.find(entry=>entry.kind==='attachment'),bundle=buildImportBundle(plan,{...options,assets:[{sourceId:asset.id,assetId:'staged-fixture-file'}],acknowledgements});assert.equal(bundle.summary.attachmentsIncluded,1);assert.equal(bundle.summary.convertedLinks,1);assert.equal(bundle.summary.unconvertedLinks,1);assert.equal(bundle.summary.unsupportedExcluded,4);
 const excluded=plan.entries.find(entry=>entry.path==='unknown.bin');assert.throws(()=>prepareImportBundle(plan,{...options,assets:[{sourceId:excluded.id,assetId:'not-allowed'}]}),{code:'INVALID_IMPORT_OPTIONS'});
 const extracted=await extractMarkdownCsvAttachments(archive);assert.equal(new TextDecoder().decode(extracted.get(asset.id)),'synthetic file');
});

test('native-only AppFlowy backups fail clearly and unsafe ZIP paths retain the common safety boundary',async()=>{
 await assert.rejects(previewAppFlowyImport(zip([['manifest.json','{"version":1}'],['workspace.collab',new Uint8Array([0,1,2])]])),{code:'APPFLOWY_PORTABLE_CONTENT_REQUIRED'});
 await assert.rejects(previewAppFlowyImport(zip([['../outside.md','No'] ])),{code:'UNSAFE_ZIP_PATH'});
 const plan=await previewAppFlowyImport(zip([['Note.md','Text']]));plan.source='appflowy-native';assert.throws(()=>prepareImportBundle(plan,options),{code:'INVALID_IMPORT_PLAN'});
});
