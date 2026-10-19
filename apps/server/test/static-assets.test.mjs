import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {request} from 'node:http';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {createAppServer} from '../server.mjs';
test('static assets negotiate compression, validate caches and pick up an updated build without caching private APIs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yumunio-asset-cache-')),source='export const content='+JSON.stringify('静的な画面の配信を確認します。'.repeat(400))+';';await writeFile(join(root,'fixture.js'),source);
 let runtimeReads=0;const server=createAppServer({root,runtimeProvider:async()=>{runtimeReads++;return{accessKey:'',publicOrigin:null,identity:null,instanceEnvironment:{}};}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));const target=await realpath(root);assert.equal(dirname(target).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.match(basename(target),/^yumunio-asset-cache-/);await rm(target,{recursive:true,force:true});});
 const get=(path,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,headers},res=>{const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));});req.on('error',reject);req.end();});
 const first=await get('/fixture.js',{'Accept-Encoding':'gzip'});assert.equal(first.headers['content-encoding'],'gzip');assert.equal(gunzipSync(first.body).toString(),source);assert.ok(first.body.length<Buffer.byteLength(source)/5);assert.equal(first.headers.vary,'Accept-Encoding');
 const cached=await get('/fixture.js',{'Accept-Encoding':'gzip','If-None-Match':first.headers.etag});assert.equal(cached.status,304);assert.equal(cached.body.length,0);
 const brotli=await get('/fixture.js',{'Accept-Encoding':'gzip;q=0.5, br;q=1'});assert.equal(brotli.headers['content-encoding'],'br');assert.equal(brotliDecompressSync(brotli.body).toString(),source);
 const plain=await get('/fixture.js',{'Accept-Encoding':'gzip;q=0, br;q=0'});assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.body.toString(),source);assert.notEqual(plain.headers.etag,first.headers.etag);
 await writeFile(join(root,'fixture.js'),source+'\n// updated build');const changed=await get('/fixture.js',{'Accept-Encoding':'gzip','If-None-Match':first.headers.etag});assert.equal(changed.status,200);assert.notEqual(changed.headers.etag,first.headers.etag);assert.match(gunzipSync(changed.body).toString(),/updated build/);
 assert.equal(runtimeReads,0,'public JS must not acquire an identity runtime');const api=await get('/api/auth/get-session',{'Accept-Encoding':'gzip'});assert.equal(api.headers['cache-control'],'no-store');assert.equal(api.headers.etag,undefined);assert.equal(api.headers['content-encoding'],undefined);assert.equal(runtimeReads,1);
});
