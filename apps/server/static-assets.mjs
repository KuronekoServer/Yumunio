import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {brotliCompress,gzip,constants} from 'node:zlib';
const br=promisify(brotliCompress),gz=promisify(gzip);
function acceptedEncoding(header){
 const encodings=String(header||'').split(',').map(value=>{const[name,...parameters]=value.trim().toLowerCase().split(';');const q=parameters.find(value=>value.trim().startsWith('q='));return{name,q:q===undefined?1:Number(q.trim().slice(2))};}).filter(value=>Number.isFinite(value.q)&&value.q>0&&value.q<=1);
 return encodings.filter(value=>['br','gzip'].includes(value.name)).sort((a,b)=>b.q-a.q||(a.name==='br'?-1:1))[0]?.name||null;
}
/** Only public build files reach this cache. API responses, sessions and page contents never do. */
export class StaticAssetCache{
 constructor(){this.files=new Map();}
 async response(path,info,headers,{compress=false,immutable=false}={}){
  const signature=info.size+':'+info.mtimeMs+':'+info.ctimeMs;let file=this.files.get(path);
  if(!file||file.signature!==signature){const body=await readFile(path);file={signature,body,digest:createHash('sha256').update(body).digest('base64url'),encoded:new Map()};this.files.delete(path);if(body.length<=4*1024*1024)this.files.set(path,file);}
  const encoding=compress&&file.body.length>=1024?acceptedEncoding(headers['accept-encoding']):null;
  let body=file.body;
  if(encoding){if(!file.encoded.has(encoding))file.encoded.set(encoding,await(encoding==='br'?br(body,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}):gz(body,{level:6})));body=file.encoded.get(encoding);}
  this.files.delete(path);if(file.body.length<=4*1024*1024)this.files.set(path,file);
  let bytes=[...this.files.values()].reduce((sum,item)=>sum+item.body.length+[...item.encoded.values()].reduce((total,value)=>total+value.length,0),0);
  while(this.files.size>64||bytes>24*1024*1024){const key=this.files.keys().next().value,item=this.files.get(key);bytes-=item.body.length+[...item.encoded.values()].reduce((sum,value)=>sum+value.length,0);this.files.delete(key);}
  const tag='"'+file.digest+'-'+(encoding||'identity')+'"',conditional=String(headers['if-none-match']||'').split(',').map(value=>value.trim().replace(/^W\//,''));
  return{status:conditional.includes(tag)||conditional.includes('*')?304:200,body,headers:{ETag:tag,Vary:'Accept-Encoding','Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache',...(encoding?{'Content-Encoding':encoding}:{})}};
 }
}
