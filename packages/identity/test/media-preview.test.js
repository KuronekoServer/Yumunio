import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadAttachment,previewMediaType} from '../src/content-assets.js';
const pdf=new TextEncoder().encode('%PDF-1.4\nSynthetic PDF test bytes.\n%%EOF');
async function attachment(bytes,type){return{id:'asset',pageId:'page',profileId:'fixture',objectKey:'fixture/blob',name:'preview.pdf',mediaType:type,size:bytes.length,checksum:Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex')};}
test('PDF/audio/video previews require recognized bytes and preserve private access before each full or range response',async()=>{
 const asset=await attachment(pdf,'application/pdf'),blobStore={profileId:'fixture',async get(){return pdf;}};let checks=0;
 const full=await downloadAttachment({blobStore,attachment:asset,preview:true,authorize:async()=>{checks++;return true;}});assert.equal(full.headers.get('content-type'),'application/pdf');assert.match(full.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.match(full.headers.get('content-security-policy'),/script-src 'none'/);assert.equal(full.headers.get('cache-control'),'no-store');assert.equal(checks,1);
 const partial=await downloadAttachment({blobStore,attachment:asset,preview:true,range:'bytes=0-7',authorize:async()=>true});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 0-7/'+pdf.length);assert.deepEqual(new Uint8Array(await partial.arrayBuffer()),pdf.slice(0,8));
 const suffix=await downloadAttachment({blobStore,attachment:asset,preview:true,range:'bytes=-5',authorize:async()=>true});assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()),pdf.slice(-5));
 const invalid=await downloadAttachment({blobStore,attachment:asset,preview:true,range:'bytes=1000-2000',authorize:async()=>true});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */'+pdf.length);
 await assert.rejects(downloadAttachment({blobStore,attachment:asset,preview:true,range:'bytes=0-3',authorize:async()=>false}),error=>error.code==='CONTENT_NOT_FOUND');
 assert.equal(previewMediaType(new TextEncoder().encode('<svg onload="bad()"/>'),'image/svg+xml'),null);assert.equal(previewMediaType(new TextEncoder().encode('<html>bad</html>'),'application/pdf'),null);assert.equal(previewMediaType(pdf,'text/html'),null);
 assert.equal(previewMediaType(new TextEncoder().encode('ID3synthetic'),'audio/mpeg'),'audio/mpeg');assert.equal(previewMediaType(new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109]),'video/mp4'),'video/mp4');
});
