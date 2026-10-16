import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountImportAssets, ImportAssetError } from '../public/import-assets.js';
import { sha256 } from '../../../packages/adapters/src/blob.js';

function fixture() {
  const rows=new Map(), blobs=new Map(), calls=[];
  let revision=0, account='account-a', sequence=0, lose='', conflict=false;
  const reply=(body,status=200)=>Response.json(body,{status});
  const error=(status,code)=>reply({error:{code}},status);
  const fetcher=async(path,init)=>{
    calls.push({path,method:init.method,headers:structuredClone(init.headers),body:init.body instanceof Uint8Array?init.body.slice():init.body});
    assert.equal(init.credentials,'same-origin');assert.equal(init.mode,'same-origin');assert.equal(init.redirect,'error');
    if(init.headers['X-Yumunio-Expected-Account']!==account)return error(404,'CONTENT_NOT_FOUND');
    if(init.method==='GET')return reply({revision,assets:[...rows.values()]});
    if(conflict){conflict=false;revision++;return error(409,'CONTENT_CONFLICT');}
    if(init.method==='POST'){
      const body=JSON.parse(init.body),existing=[...rows.values()].find(row=>row.sourceId===body.sourceId);
      if(existing)return reply({revision,assetId:existing.assetId,status:existing.status});
      if(body.expectedRevision!==revision)return error(409,'CONTENT_CONFLICT');
      const {expectedRevision,...metadata}=body,assetId='asset-'+ ++sequence;
      const row={...metadata,assetId,status:'reserved'}; rows.set(assetId,row);revision++;
      if(lose==='POST'){lose='';throw Error('Lost reservation response');}
      return reply({revision,assetId,status:'reserved'},201);
    }
    const assetId=path.split('/').at(-1),row=rows.get(assetId);
    if(!row)return error(404,'CONTENT_NOT_FOUND');
    if(init.headers['X-Yumunio-Expected-Revision']!==String(revision))return error(409,'CONTENT_CONFLICT');
    if(init.method==='PUT'){
      assert.equal(init.headers['Content-Type'],'application/octet-stream');
      assert.equal(await sha256(init.body),row.checksum);assert.equal(init.body.length,row.size);
      blobs.set(assetId,init.body.slice());row.status='ready';revision++;
      if(lose==='PUT'){lose='';throw Error('Lost binary response');}
      return reply({revision,assetId,status:'ready'});
    }
    if(init.method==='DELETE'){
      assert.deepEqual(JSON.parse(init.body),{expectedRevision:revision});
      assert.equal(init.headers['Content-Type'],'application/json');
      row.status='deleting';revision++;blobs.delete(assetId);rows.delete(assetId);revision++;
      if(lose==='DELETE'){lose='';throw Error('Lost deletion response');}
      return reply({revision,removed:true});
    }
    return error(405,'METHOD_NOT_ALLOWED');
  };
  const flow=new AccountImportAssets({fetcher});
  const assets=[{sourceId:'entry-1',name:'資料.txt',bytes:new TextEncoder().encode('Private fixture only')}];
  const prepare=()=>flow.prepare({workspaceId:'workspace-a',accountId:'account-a',importId:'import-a',revision:0,assets});
  return {flow,assets,prepare,calls,rows,blobs,setLose:value=>{lose=value;},switchAccount:value=>{account=value;},setConflict:()=>{conflict=true;}};
}

test('attachment preparation captures private bytes and produces only server asset references',async()=>{
  const f=fixture(),pending=f.prepare();f.assets[0].bytes.fill(0);await pending;
  assert.equal(f.calls.length,0);assert.equal(f.flow.snapshot().count,1);
  const result=await f.flow.upload();
  assert.deepEqual(result,{revision:2,assets:[{sourceId:'entry-1',assetId:'asset-1'}]});
  assert.equal(new TextDecoder().decode(f.blobs.get('asset-1')),'Private fixture only');
  assert.ok(!JSON.stringify(result).includes('Private fixture'));assert.equal(f.flow.snapshot().ready,1);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);
  f.flow.markCommitted();await assert.rejects(f.flow.cancel(),ImportAssetError);
});
for(const method of ['POST','PUT'])test('lost '+method+' response recovers the same reservation without duplicate blobs',async()=>{
  const f=fixture();await f.prepare();f.setLose(method);
  await assert.rejects(f.flow.upload(),error=>error.code==='ASSETS_NETWORK_UNCERTAIN');
  assert.equal(f.flow.phase,'uncertain');assert.equal(f.flow.locked,true);
  await assert.rejects(f.prepare(),error=>error.code==='ASSETS_LOCKED');
  const result=await f.flow.upload();assert.equal(result.assets[0].assetId,'asset-1');assert.equal(f.rows.size,1);assert.equal(f.blobs.size,1);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);
});
test('409 requires explicit recheck and never silently starts a fresh import',async()=>{
  const f=fixture();await f.prepare();f.setConflict();
  await assert.rejects(f.flow.upload(),error=>error.status===409);assert.equal(f.flow.phase,'conflict');
  await assert.rejects(f.flow.upload(),error=>error.code==='ASSETS_RECHECK_REQUIRED');
  await f.flow.recheck();const result=await f.flow.upload();
  assert.equal(result.assets[0].assetId,'asset-1');assert.ok(f.calls.every(call=>call.path.includes('/imports/import-a/assets')));
});
test('server expected-account checks prevent a cookie switch from transferring bytes into another account',async()=>{
  const f=fixture();await f.prepare();f.switchAccount('account-b');
  await assert.rejects(f.flow.upload(),error=>error.status===404);assert.equal(f.rows.size,0);assert.equal(f.blobs.size,0);
  assert.equal(f.flow.phase,'forbidden');assert.equal(f.flow.locked,true);
  f.switchAccount('account-a');await f.flow.recheck();await f.flow.upload();
  assert.equal(f.blobs.size,1);assert.ok(f.calls.every(call=>call.headers['X-Yumunio-Expected-Account']==='account-a'));
});
test('cancel recovers after a lost deletion response and cannot leave a prepared bundle unlocked early',async()=>{
  const f=fixture();await f.prepare();await f.flow.upload();f.setLose('DELETE');
  await assert.rejects(f.flow.cancel(),error=>error.code==='ASSETS_NETWORK_UNCERTAIN');assert.equal(f.flow.phase,'cancel-uncertain');assert.equal(f.flow.locked,true);
  await f.flow.cancel();assert.equal(f.rows.size,0);assert.equal(f.blobs.size,0);assert.equal(f.flow.phase,'cancelled');assert.equal(f.flow.locked,false);
});
test('stale or forged reservation metadata is rejected before sending any binary content',async()=>{
  const f=fixture();await f.prepare();f.setLose('POST');await assert.rejects(f.flow.upload());
  f.rows.get('asset-1').checksum='0'.repeat(64);
  await assert.rejects(f.flow.upload(),error=>error.code==='ASSET_CONTEXT_CHANGED');assert.equal(f.blobs.size,0);
});
test('asset limits and names fail before reservation and no bytes enter JSON requests',async()=>{
  const f=fixture();f.assets[0].name='../escape';await assert.rejects(f.prepare(),error=>error.code==='INVALID_ASSET_PLAN');assert.equal(f.calls.length,0);
  f.assets[0].name='file.txt';f.assets[0].bytes=new Uint8Array(16*1024*1024+1);await assert.rejects(f.prepare(),error=>error.code==='INVALID_ASSET_PLAN');assert.equal(f.calls.length,0);
});
