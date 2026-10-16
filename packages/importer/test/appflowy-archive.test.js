import test from 'node:test';
import assert from 'node:assert/strict';
import {previewAppFlowyImport,previewNotionImport,extractAppFlowyAttachments,APPFLOWY_IMPORT_LIMITS} from '../src/index.js';
import {prepareImportBundle,buildImportBundle} from '../src/apply-plan.js';
import {appFlowyNativeFiles,appFlowyNativeZip} from './fixtures/appflowy-native.js';
const enc=new TextEncoder();

test('native ZIP routes through the common reviewed bundle and extracts only referenced attachment bytes',async()=>{
 const files=appFlowyNativeFiles({duplicateDocument:true}),archive=appFlowyNativeZip(files);
 const plan=await previewAppFlowyImport(archive),prepared=prepareImportBundle(plan,{expectedRevision:0,importId:'native-archive-review',csvMode:'native',rowPageMappings:[]});
 assert.equal(plan.source,'appflowy-native');assert.equal(plan.schemaVersion,2);assert.equal(plan.summary.archiveBytes,archive.length);
 assert.ok(prepared.requiredAcknowledgements.includes('nativeSubset'));assert.equal(prepared.body.collections.length,1);
 assert.ok(prepared.body.pages.some(p=>p.blocks.some(b=>b.data?.purpose==='import-source'&&b.data.source)));
 assert.throws(()=>buildImportBundle(plan,{expectedRevision:0,importId:'native-archive-review',csvMode:'native',rowPageMappings:[]}),{code:'ACKNOWLEDGEMENT_REQUIRED'});
 const assets=await extractAppFlowyAttachments(archive);assert.equal(assets.size,1);
 assert.equal(new TextDecoder().decode([...assets.values()][0]),'Synthetic attachment only.');
});

test('native archive accepts bounded collab baggage above 16 MiB without inflating or importing it',async()=>{
 const files=appFlowyNativeFiles({attachment:false}),baggage=new Uint8Array(8*1024*1024+1024);
 files.set('collab/opaque-one.collab',baggage);files.set('collab/opaque-two.collab',baggage);
 const archive=appFlowyNativeZip(files);assert.ok(archive.length>16*1024*1024);
 const plan=await previewAppFlowyImport(archive);assert.equal(plan.source,'appflowy-native');
 assert.equal(plan.summary.attachments,0);assert.ok(plan.summary.unsupported>=3);
 assert.equal(prepareImportBundle(plan,{expectedRevision:0,importId:'native-baggage'}).body.pages.length,4);
 await assert.rejects(previewNotionImport(archive),{code:'ARCHIVE_TOO_LARGE'});
 await assert.rejects(previewAppFlowyImport(archive,{limits:{archiveBytes:APPFLOWY_IMPORT_LIMITS.archiveBytes+1}}),{code:'INVALID_OPTIONS'});
});

test('portable fallback uses the same captured archive even if caller bytes change after the first await',async()=>{
 const archive=appFlowyNativeZip(new Map([['Page.md',enc.encode('# Captured page\nLiteral content')],['config.json',enc.encode('{}')]]));
 const pending=previewAppFlowyImport(archive);archive.fill(0);
 const plan=await pending;assert.equal(plan.source,'appflowy-markdown-csv');assert.equal(plan.pages[0].title,'Captured page');
 assert.equal(plan.pages[0].sourceMarkdown,'# Captured page\nLiteral content');
});

test('native JSON CRC and archive extraction capture are checked before returning private bytes',async()=>{
 const original=appFlowyNativeZip(),damaged=original.slice(),nameLength=new DataView(damaged.buffer).getUint16(26,true);
 damaged[30+nameLength]^=1;
 await assert.rejects(previewAppFlowyImport(damaged),{code:'ZIP_CRC_MISMATCH'});
 const input=original.slice(),pending=extractAppFlowyAttachments(input);input.fill(0);
 assert.equal((await pending).size,1);
});
