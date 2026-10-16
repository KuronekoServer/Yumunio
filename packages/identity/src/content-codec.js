import {assertJsonSerializable,assertPlainObject} from '@yumunio/domain';

export const CONTENT_STORAGE_LIMITS=Object.freeze({legacyBytes:900000,logicalBytes:8000000,chunkBytes:256000,chunks:32});
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true}),marker='$yumunioContent';
const fail=()=>{throw new TypeError('INVALID_CONTENT_STORAGE');};
const integer=value=>Number.isSafeInteger(value)&&value>=1&&value<=Number.MAX_SAFE_INTEGER;
export function contentPayloadText(value){
 assertPlainObject(value);assertJsonSerializable(value);if(Object.hasOwn(value,marker))fail();
 const text=JSON.stringify(value);if(encoder.encode(text).length>CONTENT_STORAGE_LIMITS.logicalBytes)fail();return text;
}
export function contentHead(text){
 if(typeof text!=='string'||encoder.encode(text).length>CONTENT_STORAGE_LIMITS.legacyBytes)fail();
 let value;try{value=JSON.parse(text);}catch{fail();}assertPlainObject(value);
 if(!Object.hasOwn(value,marker))return null;
 if(Object.keys(value).length!==4||value[marker]!==1||!integer(value.revision)||!Number.isSafeInteger(value.chunks)||value.chunks<1||value.chunks>CONTENT_STORAGE_LIMITS.chunks||!Number.isSafeInteger(value.bytes)||value.bytes<=CONTENT_STORAGE_LIMITS.legacyBytes||value.bytes>CONTENT_STORAGE_LIMITS.logicalBytes)fail();
 return value;
}
export function encodeContentPayload(value,revision){
 if(!integer(revision))fail();const text=contentPayloadText(value),bytes=encoder.encode(text);
 if(bytes.length<=CONTENT_STORAGE_LIMITS.legacyBytes)return{head:text,chunks:[]};
 const chunks=[];
 for(let start=0;start<bytes.length;){let end=Math.min(start+CONTENT_STORAGE_LIMITS.chunkBytes,bytes.length);if(end<bytes.length)while((bytes[end]&192)===128)end--;if(end<=start)fail();chunks.push(decoder.decode(bytes.subarray(start,end)));start=end;}
 if(chunks.length>CONTENT_STORAGE_LIMITS.chunks)fail();
 return{head:JSON.stringify({[marker]:1,revision,chunks:chunks.length,bytes:bytes.length}),chunks};
}
export function decodeContentPayload(text,rows=[],revision){
 const head=contentHead(text);
 if(!head){if(rows.length)fail();const value=JSON.parse(text);contentPayloadText(value);return value;}
 if(!integer(revision)||head.revision!==revision||!Array.isArray(rows)||rows.length!==head.chunks)fail();
 let bytes=0;const parts=rows.map((row,index)=>{const r=typeof row.revision==='bigint'||typeof row.revision==='string'?Number(row.revision):row.revision,o=typeof row.ordinal==='bigint'||typeof row.ordinal==='string'?Number(row.ordinal):row.ordinal;if(r!==revision||o!==index||typeof row.payload_text!=='string')fail();const length=encoder.encode(row.payload_text).length;if(!length||length>CONTENT_STORAGE_LIMITS.chunkBytes)fail();bytes+=length;return row.payload_text;});
 if(bytes!==head.bytes)fail();let value;try{value=JSON.parse(parts.join(''));}catch{fail();}contentPayloadText(value);return value;
}
function sql(dialect){const params=[],bind=value=>{params.push(value);return dialect==='postgres'?'$'+params.length:'?';},equal=(a,b)=>dialect==='mysql'?'BINARY '+a+'=BINARY '+b:a+'='+b;return{params,bind,equal};}
export function contentChunkCommands(dialect,{workspaceId,revision,chunks=[]}){
 const commands=chunks.map((text,ordinal)=>{const s=sql(dialect);return{sql:'INSERT INTO yumunio_content_chunks(workspace_id,revision,ordinal,payload_text) VALUES('+[workspaceId,revision,ordinal,text].map(s.bind).join(',')+')',params:s.params};});
 const s=sql(dialect);commands.push({sql:'DELETE FROM yumunio_content_chunks WHERE '+s.equal('workspace_id',s.bind(workspaceId))+' AND revision<>'+s.bind(revision),params:s.params});return commands;
}
export async function readContentPayload(query,dialect,workspaceId,revision,text){
 if(!contentHead(text))return decodeContentPayload(text);
 const s=sql(dialect),result=await query('SELECT k.revision,k.ordinal,k.payload_text FROM yumunio_content_chunks k JOIN yumunio_account_content c ON '+s.equal('c.workspace_id','k.workspace_id')+' AND c.revision=k.revision WHERE '+s.equal('k.workspace_id',s.bind(workspaceId))+' AND k.revision='+s.bind(revision)+' ORDER BY k.ordinal LIMIT '+(CONTENT_STORAGE_LIMITS.chunks+1),s.params);
 return decodeContentPayload(text,result.rows,revision);
}
