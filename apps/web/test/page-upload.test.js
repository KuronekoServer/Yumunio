import test from 'node:test';
import assert from 'node:assert/strict';
import { PageUploadFlow } from '../public/page-upload.js';
const clone=value=>structuredClone(value);
async function fixture({lost=null}={}){
  let revision=1,pending=[],attachments=[],actor='a',fault=lost;const calls=[],stored=[];
  const request=async({path,method,headers,body})=>{
    calls.push({path,method,body:clone(body)});
    if(headers['X-Yumunio-Expected-Account']!==actor)throw Object.assign(new Error('CONTENT_NOT_FOUND'),{status:404});
    if(method==='GET'){
      if(path.includes('/bootstrap?'))return{user:{id:actor},page:{revision,page:{id:'page',title:'Synthetic',capabilities:['read','editBody']},document:{version:1},attachments:clone(attachments)},uploads:{revision,pageId:'page',uploads:clone(pending)},workspace:{workspaceId:'workspace',revision,attachmentsEnabled:true}};
      if(path.endsWith('/uploads'))return{revision,pageId:'page',uploads:clone(pending)};
      if(path.endsWith('/pages'))return{revision,attachmentsEnabled:true};
      return{revision,page:{id:'page',title:'Synthetic',capabilities:['read','editBody']},document:{version:1},attachments:clone(attachments)};
    }
    if(method==='POST'&&path.endsWith('/assets')){
      const existing=pending.find(row=>row.uploadId===path.split('/').at(-2));if(existing)return{revision,assetId:existing.id,status:existing.status};
      const row={id:'asset',uploadId:path.split('/').at(-2),sourceId:body.sourceId,name:body.name,mediaType:body.mediaType,size:body.size,checksum:body.checksum,status:'reserved'};pending.push(row);revision++;
      return{revision,assetId:row.id,status:row.status};
    }
    if(method==='PUT'){
      stored.push(body.slice());pending[0].status='ready';revision++;
      if(fault==='put'){fault=null;throw new Error('Lost ready ACK');}
      return{revision,assetId:'asset',status:'ready'};
    }
    if(method==='POST'&&path.endsWith('/commit')){
      const row=pending[0];attachments=[{id:row.id,name:row.name,mediaType:row.mediaType,size:row.size}];pending=[];revision++;
      if(fault==='commit'){fault=null;throw new Error('Lost commit ACK');}
      return{revision,version:1,attachment:clone(attachments[0]),replayed:false};
    }
    throw new Error('Unexpected synthetic request');
  };
  const flow=new PageUploadFlow({accountId:'a',workspaceId:'workspace',pageId:'page',request,createId:()=> 'synthetic'});await flow.review();
  return{flow,calls,stored,setActor:value=>actor=value,dropPending:()=>{pending=[];},get attachments(){return attachments;}};
}
test('page file preparation captures bytes before hashing and publishes through one reserve/upload/commit sequence',async()=>{
  const f=await fixture(),input=new Uint8Array([1,2,3]),preparing=f.flow.prepare({name:'架空.txt',mediaType:'text/plain',bytes:input});input.fill(9);await preparing;
  assert.deepEqual(f.calls.map(call=>call.method),['GET']);assert.match(f.calls[0].path,/bootstrap\?section=attachments/);assert.equal(f.flow.snapshot().state,'prepared');
  await f.flow.send();assert.equal(f.attachments.length,1);assert.deepEqual(f.stored[0],new Uint8Array([1,2,3]));assert.equal(f.flow.snapshot().file,null);
  assert.deepEqual(f.calls.filter(call=>call.method!=='GET').map(call=>call.method),['POST','PUT','POST']);
});
test('a lost ready ACK stops sending until explicit review, which resumes at commit without repeating binary upload',async()=>{
  const f=await fixture({lost:'put'});await f.flow.prepare({name:'fixture.bin',bytes:new Uint8Array([1])});await assert.rejects(f.flow.send());assert.equal(f.flow.state,'uncertain');
  const count=f.calls.length;await assert.rejects(f.flow.send());assert.equal(f.calls.length,count);assert.equal(f.flow.snapshot().file.size,1);
  await f.flow.review();assert.equal(f.flow.state,'ready');await f.flow.send();assert.equal(f.stored.length,1);assert.equal(f.attachments.length,1);
});
test('an uncertain commit is recovered from the page attachment without creating or uploading a duplicate',async()=>{
  const f=await fixture({lost:'commit'});await f.flow.prepare({name:'fixture.bin',bytes:new Uint8Array([2])});await assert.rejects(f.flow.send());
  assert.equal(f.flow.state,'uncertain');assert.equal(f.attachments.length,1);await f.flow.review();assert.equal(f.flow.state,'committed');assert.equal(f.flow.file,null);
  await assert.rejects(f.flow.send());assert.equal(f.calls.filter(call=>call.path.endsWith('/commit')).length,1);
});
test('a disappeared known reservation is never silently recreated after review errors or another explicit review',async()=>{
  const f=await fixture({lost:'put'});await f.flow.prepare({name:'fixture.bin',bytes:new Uint8Array([3])});await assert.rejects(f.flow.send());f.dropPending();
  await assert.rejects(f.flow.review(),error=>error.code==='UPLOAD_RESULT_MISSING');await assert.rejects(f.flow.review(),error=>error.code==='UPLOAD_RESULT_MISSING');
  assert.equal(f.flow.state,'blocked');assert.ok(f.flow.file);assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);f.flow.discardRetained();assert.equal(f.flow.file,null);
});
test('an account switch cannot send the previous accounts file and leaves the local bytes available for review',async()=>{
  const f=await fixture();await f.flow.prepare({name:'fixture.bin',bytes:new Uint8Array([4])});f.setActor('b');await assert.rejects(f.flow.send(),error=>error.status===404);assert.equal(f.stored.length,0);assert.ok(f.flow.file);
  await assert.rejects(f.flow.review());assert.equal(f.flow.state,'blocked');assert.equal(f.stored.length,0);
});
test('invalid metadata fails before reservation and uploaded bytes are not exposed in UI snapshots',async()=>{
  const f=await fixture();for(const name of ['..','path/file','bad\ud800'])await assert.rejects(f.flow.prepare({name,bytes:new Uint8Array([5])}));
  await f.flow.prepare({name:'safe.bin',bytes:new Uint8Array([5])});const snapshot=f.flow.snapshot();assert.equal(Object.hasOwn(snapshot.file,'bytes'),false);assert.equal(snapshot.file.size,1);assert.equal(snapshot.file.checksum.length,64);assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
});
