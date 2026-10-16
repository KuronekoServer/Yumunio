import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobStoreError, MAX_BLOB_BYTES, blobKey, boundedBlobBytes, createR2BlobStore, createS3BlobStore, readBlobConfig, sha256, signS3Request, storageProfile } from '../src/blob.js';

const s3env = { YUMUNIO_BLOB_DRIVER: 's3', YUMUNIO_S3_ENDPOINT: 'https://s3.storage.example', YUMUNIO_S3_REGION: 'test-1',
  YUMUNIO_S3_BUCKET: 'fixture-private', YUMUNIO_S3_PREFIX: 'yumunio/', YUMUNIO_S3_ACCESS_KEY_ID: 'FIXTUREKEY', YUMUNIO_S3_SECRET_ACCESS_KEY: 'fixture-secret-only' };
const bytes = new TextEncoder().encode('Independent attachment fixture');
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof BlobStoreError && (!code || error.code === code));

test('blob settings are explicit and disabled storage does not read credentials', () => {
  assert.deepEqual(readBlobConfig({ get YUMUNIO_S3_SECRET_ACCESS_KEY() { throw Error('must not read'); } }), { driver: 'disabled' });
  assert.equal(readBlobConfig(s3env).pathStyle, true);
  assert.deepEqual(readBlobConfig({ YUMUNIO_BLOB_DRIVER: 'r2' }, { runtime: 'worker' }), { driver: 'r2', binding: 'BLOBS' });
  for (const patch of [{YUMUNIO_S3_ENDPOINT:'http://s3.example'}, {YUMUNIO_S3_ENDPOINT:'https://s3.example/path'},
    {YUMUNIO_S3_ENDPOINT:'https://user:secret@s3.example'}, {YUMUNIO_S3_ENDPOINT:'https://s3.example?token=value'},
    {YUMUNIO_S3_PREFIX:'../'}, {YUMUNIO_S3_PREFIX:''}, {YUMUNIO_S3_FORCE_PATH_STYLE:'yes'}, {YUMUNIO_S3_REGION:'bad/region'},
    {YUMUNIO_S3_ACCESS_KEY_ID:''}, {YUMUNIO_S3_SECRET_ACCESS_KEY:''}, {YUMUNIO_S3_BUCKET:'../bucket'}])
    assert.throws(() => readBlobConfig({...s3env,...patch}), BlobStoreError);
  assert.throws(() => readBlobConfig({YUMUNIO_BLOB_DRIVER:'local'}, {runtime:'worker'}), BlobStoreError);
  assert.throws(() => readBlobConfig({YUMUNIO_BLOB_DRIVER:'r2'}), BlobStoreError);
  for (const value of ['../key','/key','a//key','a\\key','a.key','a/key?token=secret']) assert.throws(() => blobKey(value), BlobStoreError);
});

test('SigV4 matches the published AWS single-chunk GET signature vector', async () => {
  const headers = await signS3Request({url:'https://examplebucket.s3.amazonaws.com/test.txt',method:'GET',region:'us-east-1',
    accessKeyId:'AKIAIOSFODNN7EXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    headers:{Range:'bytes=0-9'},now:new Date('2013-05-24T00:00:00.000Z')});
  assert.equal(headers.get('authorization'), 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('S3 proxy signs a captured payload, never follows redirects and confines requests to its prefix', async () => {
  const config=readBlobConfig(s3env), objects=new Map(), calls=[];
  const store=await createS3BlobStore(config,{fetcher:async(url,init)=>{
    calls.push({url,init}); const key=new URL(url).pathname;
    assert.equal(init.redirect,'manual'); assert.ok(init.headers.get('authorization').startsWith('AWS4-HMAC-SHA256 '));
    assert.ok(init.headers.get('x-amz-content-sha256')); assert.equal(new URL(url).search,'');
    if(init.method==='PUT'){assert.equal(init.headers.get('if-none-match'),'*'); if(objects.has(key))return new Response(null,{status:412}); objects.set(key,init.body.slice());return new Response(null,{status:200});}
    if(init.method==='DELETE'){objects.delete(key);return new Response(null,{status:204});}
    return objects.has(key)?new Response(objects.get(key)):new Response(null,{status:404});
  }});
  assert.equal(await store.get('workspace/fixture'),null);
  assert.deepEqual(await store.put('workspace/fixture',bytes),{size:bytes.length,checksum:await sha256(bytes)});
  assert.deepEqual(await store.get('workspace/fixture'),bytes);
  await rejects(store.put('workspace/fixture',bytes),'BLOB_EXISTS');
  await store.delete('workspace/fixture');assert.equal(await store.get('workspace/fixture'),null);
  assert.ok(calls.every(call=>call.url==='https://s3.storage.example/fixture-private/yumunio/workspace/fixture'));
  const bad=await createS3BlobStore(config,{fetcher:async()=>new Response('Private provider error with fixture-secret-only',{status:307,headers:{Location:'https://elsewhere.example'}})});
  await rejects(bad.get('valid'),'BLOB_UNAVAILABLE');
  assert.equal(store.profileId,await storageProfile({...config,secretAccessKey:'rotated-secret'}));
  assert.notEqual(store.profileId,await storageProfile({...config,bucket:'other-bucket'}));
});

test('R2 keeps writes conditional, verifies byte limits and does not expose provider errors', async () => {
  const objects=new Map();
  const store=await createR2BlobStore({
    async put(key,value,options){assert.equal(options.onlyIf.etagDoesNotMatch,'*');assert.equal(options.sha256,await sha256(value));if(objects.has(key))return null;objects.set(key,value.slice());return{size:value.length};},
    async get(key){return objects.has(key)?{size:objects.get(key).length,body:new Response(objects.get(key)).body}:null;},
    async delete(key){objects.delete(key);}
  });
  assert.equal(await store.get('valid'),null);await store.put('valid',bytes);assert.deepEqual(await store.get('valid'),bytes);
  await rejects(store.put('valid',bytes),'BLOB_EXISTS');await store.delete('valid');assert.equal(await store.get('valid'),null);
  await rejects(store.put('valid',new Uint8Array(MAX_BLOB_BYTES+1)),'BLOB_TOO_LARGE');
  const broken=await createR2BlobStore({put:async()=>{throw Error('private R2 diagnostics');},get:async()=>{throw Error('private R2 diagnostics');},delete:async()=>{throw Error('private R2 diagnostics');}});
  await rejects(broken.put('valid',bytes),'BLOB_UNAVAILABLE');await rejects(broken.get('valid'),'BLOB_UNAVAILABLE');await rejects(broken.delete('valid'),'BLOB_UNAVAILABLE');
  await rejects(boundedBlobBytes(new Response(bytes).body,1),'BLOB_TOO_LARGE');
});
