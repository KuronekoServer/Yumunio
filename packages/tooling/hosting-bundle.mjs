import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
export const HOSTING_BUNDLE_FILES=Object.freeze({'compose.yaml':'compose.yaml','compose.https.yaml':'compose.https.yaml','deploy/Caddyfile':'deploy/Caddyfile','.env':'.env.example','README.md':'deploy/README.hosting.md','LICENSE':'LICENSE'});
async function plainFile(path){const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.size>1048576)throw Error('Invalid hosting bundle file.');return readFile(path);}
/** Explicit allowlist: never package the operator's .env, database, logs or attachment data. */
export async function createHostingBundle(root=projectRoot){
 for(const folder of [root,join(root,'deploy')])if((await lstat(folder)).isSymbolicLink())throw Error('Bundle sources must not be symbolic links.');
 const locals=[],central=[];let offset=0;
 for(const[name,source]of Object.entries(HOSTING_BUNDLE_FILES)){
  const bytes=await plainFile(join(root,source)),entry=Buffer.from(name),checksum=crc32(bytes),header=Buffer.alloc(30),index=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(entry.length,26);
  index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x800,8);index.writeUInt16LE(33,14);index.writeUInt32LE(checksum,16);index.writeUInt32LE(bytes.length,20);index.writeUInt32LE(bytes.length,24);index.writeUInt16LE(entry.length,28);index.writeUInt32LE(offset,42);
  locals.push(header,entry,bytes);central.push(index,entry);offset+=header.length+entry.length+bytes.length;
 }
 const table=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);
 const archive=Buffer.concat([...locals,table,end]),directory=join(root,'.build');
 try{if((await lstat(directory)).isSymbolicLink())throw Error('Bundle output must not be a symbolic link.');}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir(directory,{recursive:true});const bundle=join(directory,'yumunio-hosting.zip'),checksum=bundle+'.sha256';
 for(const path of [bundle,checksum])try{await plainFile(path);}catch(error){if(error.code!=='ENOENT')throw error;}
 const sha256=createHash('sha256').update(archive).digest('hex');await writeFile(bundle,archive);await writeFile(checksum,sha256+'  yumunio-hosting.zip\n');
 return{bundle,checksum,sha256,bytes:archive.length,files:Object.keys(HOSTING_BUNDLE_FILES)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await createHostingBundle()));}catch(error){console.error(error.message);process.exitCode=1;}}
