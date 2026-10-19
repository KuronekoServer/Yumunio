import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,parse,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isIP} from 'node:net';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const defaultImage='docker.io/kuronekoserver/yumunio:latest';
const docs='https://github.com/KuronekoServer/Yumunio/blob/master/docs/hosting/docker.md';
export function hostingOrigin(value,{https=false}={}){
 if(value===undefined||value===''){if(https)throw Error('HTTPS hosting needs --origin https://your-domain.example');return null;}
 if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value))throw Error('Enter a public URL without spaces.');
 let url;try{url=new URL(value);}catch{throw Error('Enter a valid public URL.');}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(!isIP(host)&&(host.length>253||host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))throw Error('Enter a valid domain name.');
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!local)throw Error('Use an HTTPS origin without a path, credentials or query. HTTP is available on loopback only.');
 if(url.protocol==='http:'&&url.port!=='8788')throw Error('The local Docker listener uses port 8788.');
 if(https&&(url.protocol!=='https:'||local||isIP(url.hostname.replace(/^\[|\]$/g,''))||url.port||!url.hostname.includes('.')))throw Error('Automatic HTTPS needs a domain name and the standard HTTPS port.');
 return url.origin;
}
async function noLinks(path){
 for(let current=resolve(path);;current=dirname(current)){
  try{if((await lstat(current)).isSymbolicLink())throw Error('Hosting paths must not contain symbolic links.');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(current===parse(current).root)break;
 }
}
/** Prepare an isolated installation directory. Never starts services or overwrites an installation. */
export async function prepareHosting({root=projectRoot,directory=resolve('yumunio-host'),origin,https=false,image=defaultImage}={}){
 if(typeof https!=='boolean'||typeof directory!=='string'||!directory||typeof image!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,250}$/.test(image))throw Error('Invalid hosting options.');
 const canonical=hostingOrigin(origin,{https}),target=resolve(directory);await noLinks(target);
 const names=['compose.yaml',...(https?['compose.https.yaml','deploy/Caddyfile']:[])],plan=[];
 for(const name of names){const source=join(root,name);await noLinks(source);const stat=await lstat(source);if(!stat.isFile()||stat.nlink!==1||stat.size>64000)throw Error('Invalid hosting template.');plan.push([name,await readFile(source)]);}
 try{await lstat(target);throw Error('The destination already exists. Choose a new directory; existing settings are preserved.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const flags=https?'-f compose.yaml -f compose.https.yaml ':'';
 const commands=[`docker compose ${flags}pull`,`docker compose ${flags}up -d`,`docker compose ${flags}logs yumunio`];
 const env=['# Complete installation using the Start setup link in the container log.',...(canonical?['YUMUNIO_PUBLIC_ORIGIN='+canonical]:['# YUMUNIO_PUBLIC_ORIGIN=https://notes.example.com']),...(image===defaultImage?[]:['YUMUNIO_IMAGE='+image]),''].join('\n');
 const guide=['# Yumunio hosting','',...(https?['Point this domain at your server and allow inbound TCP 80/443 before starting. UDP 443 is optional for HTTP/3.','Caddy stores its certificates in its own persistent volumes.','']:[]),'Run these commands in this directory:','','```sh',...commands,'```','','Open the Start setup link from the log. Internal credentials are generated automatically.','Keep this directory and the Docker volumes when updating.','If the image is unavailable, use the source-build instructions in the hosting guide.','',docs,''].join('\n');
 plan.push(['.env',env],['README.md',guide]);
 await mkdir(target);
 for(const[name,content]of plan){const file=join(target,name);if(name.includes('/'))await mkdir(dirname(file),{recursive:true});await writeFile(file,content,{flag:'wx',...(name==='.env'?{mode:0o600}:{})});}
 return{directory:target,origin:canonical??'http://127.0.0.1:8788',https,files:plan.map(([name])=>name),commands};
}
export function parseHostingOptions(args){
 const options={};for(let index=0;index<args.length;index++){
  const key=args[index];if(key==='--https'){if(options.https)throw Error('Duplicate --https');options.https=true;continue;}
  const field={'--directory':'directory','--origin':'origin','--image':'image'}[key];
  if(!field||options[field]!==undefined||!args[index+1]||args[index+1].startsWith('--'))throw Error('Use --directory <new-folder> [--origin <URL>] [--https] [--image <image>].');options[field]=args[++index];
 }return options;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const result=await prepareHosting(parseHostingOptions(process.argv.slice(2)));console.log('Prepared: '+result.directory);console.log('Next, run inside that directory:\n'+result.commands.join('\n'));console.log('Hosting guide: '+docs);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
