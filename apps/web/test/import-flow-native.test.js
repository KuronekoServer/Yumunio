import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountImportFlow } from '../public/import-flow.js';
import { previewAppFlowyImport } from '../../../packages/importer/src/index.js';
import { prepareImportBundle, buildImportBundle } from '../../../packages/importer/src/apply-plan.js';
import { appFlowyNativeFiles, appFlowyNativeZip, APPFLOWY_FIXTURE_IDS } from '../../../packages/importer/test/fixtures/appflowy-native.js';

const actor={id:'native-account-A',emailVerified:true},workspace={id:'native-workspace',name:'Synthetic workspace'};
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const metadata=()=>({workspaceId:workspace.id,revision:0,role:'member',pages:[]});
function nativeFiles({large=false,overLimit=false}={}) {
 const files=appFlowyNativeFiles({attachment:false});if(!large&&!overLimit)return files;
 const path='collab/documents/'+APPFLOWY_FIXTURE_IDS.document+'.json',document=JSON.parse(new TextDecoder().decode(files.get(path)));
 const length=overLimit?95000:72000;
 document.meta.text_map['text-delta']=JSON.stringify([{insert:'Synthetic parent '+ 'a'.repeat(length)}]);
 document.meta.text_map['child-delta']=JSON.stringify([{insert:'Synthetic child '+ 'b'.repeat(length)}]);
 if(overLimit)for(let index=0;index<3;index++){
  const id='extra-'+index,children=id+'-children',delta=id+'-delta';
  document.blocks[id]={id,ty:'paragraph',parent:'fixture-root',children,external_id:delta,external_type:'text',data:{}};
  document.meta.children_map['fixture-root-children'].push(id);document.meta.children_map[children]=[];
  document.meta.text_map[delta]=JSON.stringify([{insert:'Synthetic extra '+ 'c'.repeat(length)}]);
 }
 files.set(path,new TextEncoder().encode(JSON.stringify(document)));return files;
}
function harness(handler) {
 const calls=[];let ids=0;
 const flow=new AccountImportFlow({prepare:prepareImportBundle,build:buildImportBundle,createId:()=> 'native-import-'+ ++ids,fetcher:async(path,options)=>{calls.push({path,options});return handler(path,options);}});
 flow.setActor(actor);return{flow,calls,posts:()=>calls.filter(call=>call.options.method==='POST'),ids:()=>ids};
}
const receipt=(body,replayed=false)=>({revision:1,importId:body.importId,rootPageId:'native-created-root',pageCount:body.pages.length,replayed});
const accepted=(path,options)=>path.endsWith('/get-session')?Response.json({user:actor}):options.method==='POST'?Response.json(receipt(JSON.parse(options.body)),{status:201}):Response.json(metadata());
async function review(h,options={}){const plan=await previewAppFlowyImport(appFlowyNativeZip(nativeFiles(options)));assert.equal(plan.source,'appflowy-native');assert.equal(plan.schemaVersion,2);await h.flow.selectWorkspace(workspace);return{plan,prepared:h.flow.prepare(plan,'AppFlowy private folder')};}
const allAcks=prepared=>Object.fromEntries(prepared.requiredAcknowledgements.map(key=>[key,true]));

test('actual native ZIP adapter requires native-subset and text-column consent before the account flow sends content',async()=>{
 const h=harness(accepted),{plan,prepared}=await review(h);assert.ok(prepared.requiredAcknowledgements.includes('nativeSubset'));assert.ok(prepared.requiredAcknowledgements.includes('csvTextTypes'));
 const acknowledgements=allAcks(prepared);delete acknowledgements.nativeSubset;
 await assert.rejects(h.flow.submit({consent:true,acknowledgements}),error=>error.code==='ACKNOWLEDGEMENT_REQUIRED');
 await assert.rejects(h.flow.submit({consent:false,acknowledgements:allAcks(prepared)}),error=>error.code==='ACKNOWLEDGEMENT_REQUIRED');assert.equal(h.posts().length,0);
 await h.flow.submit({consent:true,acknowledgements:allAcks(prepared)});assert.equal(h.posts().length,1);assert.equal(h.ids(),1);
 assert.equal(h.posts()[0].options.headers['X-Yumunio-Expected-Account'],actor.id);assert.deepEqual(JSON.parse(h.posts()[0].options.body),prepared.body);
 assert.equal(Object.isFrozen(h.flow.plan.pages[0].blocks),true);assert.equal(plan.summary.collections,1);assert.equal(prepared.body.collections[0].records.length,1);
});

test('native schema two carries a real ZIP-derived payload above 256000 and below 768000 bytes once without widening legacy conversion',async()=>{
 const h=harness(accepted),{prepared}=await review(h,{large:true});assert.ok(size(prepared.body)>256000);assert.ok(size(prepared.body)<=768000);
 await h.flow.submit({consent:true,acknowledgements:allAcks(prepared)});assert.equal(h.posts().length,1);assert.equal(h.posts()[0].options.body,JSON.stringify(prepared.body));
 await assert.rejects(h.flow.submit({consent:true,acknowledgements:allAcks(prepared)}),error=>error.code==='IMPORT_BUSY');assert.equal(h.posts().length,1);
});

test('a lost native ACK freezes the reviewed request and an explicit retry keeps the exact import ID body and actor guard',async()=>{
 let posts=0;
 const h=harness((path,options)=>{if(path.endsWith('/get-session'))return Response.json({user:actor});if(options.method!=='POST')return Response.json(metadata());if(++posts===1)throw new TypeError('Synthetic lost response');return Response.json(receipt(JSON.parse(options.body),true));});
 const {prepared}=await review(h,{large:true}),body=JSON.stringify(h.flow.body);
 await assert.rejects(h.flow.submit({consent:true,acknowledgements:allAcks(prepared)}),error=>error.code==='NETWORK_UNCERTAIN');assert.equal(h.flow.phase,'uncertain');
 await new Promise(setImmediate);assert.equal(h.posts().length,1);assert.throws(()=>h.flow.invalidate(),/IMPORT_LOCKED/);
 assert.throws(()=>{h.flow.body.pages[0].title='Replace reviewed body';},TypeError);assert.throws(()=>h.flow.setActor({id:'native-account-B',emailVerified:true}),/ACCOUNT_CHANGED/);
 assert.equal(JSON.stringify(h.flow.body),body);h.flow.setActor(actor);
 const result=await h.flow.submit({consent:true,acknowledgements:allAcks(prepared)});assert.equal(result.replayed,true);assert.equal(h.ids(),1);assert.equal(h.posts().length,2);
 assert.equal(h.posts()[0].options.body,h.posts()[1].options.body);assert.equal(h.posts()[1].options.headers['X-Yumunio-Expected-Account'],actor.id);
});

test('native content is not posted after the trusted account changes between review and submission',async()=>{
 const h=harness((path,options)=>path.endsWith('/get-session')?Response.json({user:{id:'native-account-B',emailVerified:true}}):accepted(path,options));
 const {prepared}=await review(h);await assert.rejects(h.flow.submit({consent:true,acknowledgements:allAcks(prepared)}),error=>error.code==='ACCOUNT_CHANGED');
 assert.equal(h.posts().length,0);assert.equal(h.flow.phase,'account-changed');assert.equal(h.flow.attempted,false);
});

test('a real native JSON snapshot exceeding the bounded request capacity stops at preparation without sending content',async()=>{
 const h=harness(accepted),plan=await previewAppFlowyImport(appFlowyNativeZip(nativeFiles({overLimit:true})));const original=JSON.stringify(plan);
 await h.flow.selectWorkspace(workspace);assert.throws(()=>h.flow.prepare(plan,'Oversized private folder'),error=>error.code==='IMPORT_BUNDLE_TOO_LARGE');
 assert.equal(h.flow.body,null);assert.equal(h.flow.prepared,null);assert.equal(h.posts().length,0);assert.equal(JSON.stringify(plan),original);
});
