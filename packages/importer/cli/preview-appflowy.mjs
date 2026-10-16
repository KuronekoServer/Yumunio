import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {previewAppFlowyImport,APPFLOWY_IMPORT_LIMITS} from '../src/index.js';
import {prepareImportBundle} from '../src/apply-plan.js';

class PreviewError extends Error {constructor(code){super('The backup could not be inspected.');this.code=code;}}
async function readArchive(filename){
  let handle;
  try{
    handle=await open(filename,'r');
    const before=await handle.stat();
    if(!before.isFile()||before.size>APPFLOWY_IMPORT_LIMITS.archiveBytes)throw new PreviewError('ARCHIVE_TOO_LARGE');
    const bytes=new Uint8Array(before.size+1);let size=0;
    while(size<bytes.length){const result=await handle.read(bytes,size,bytes.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}
    const after=await handle.stat();
    if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new PreviewError('INPUT_CHANGED');
    return bytes.slice(0,size);
  }finally{await handle?.close();}
}
/** Read-only: never creates a request, copies the ZIP or writes private content. */
export async function main(args){
  if(args.length===1&&args[0]==='--help'){process.stdout.write('Usage: node packages/importer/cli/preview-appflowy.mjs --file <backup.zip>\n');return;}
  if(args.length!==2||args[0]!=='--file'||!args[1]||args[1].startsWith('--'))throw new PreviewError('INVALID_ARGUMENTS');
  const plan=await previewAppFlowyImport(await readArchive(args[1]),{inflateRaw:(bytes,{maxOutputBytes})=>inflateRawSync(bytes,{maxOutputLength:Math.max(1,maxOutputBytes)})});
  let conversion;
  try{
    const prepared=prepareImportBundle(plan,{expectedRevision:0,importId:'read-only-capacity-check',rootTitle:'AppFlowy import',csvMode:'native',rowPageMappings:[]});
    conversion={summary:prepared.summary,requiredAcknowledgements:prepared.requiredAcknowledgements};
  }catch(error){conversion={error:typeof error?.code==='string'?error.code:'CONVERSION_UNAVAILABLE'};}
  process.stdout.write(JSON.stringify({source:plan.source,summary:plan.summary,warningCodes:plan.warnings.map(({code,count})=>({code,count})),conversion})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{await main(process.argv.slice(2));}
  catch(error){process.stderr.write('AppFlowy preview failed ('+(/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'PREVIEW_UNAVAILABLE')+').\n');process.exitCode=1;}
}
