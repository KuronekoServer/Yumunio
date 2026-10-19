import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
function prose(source){
 let fence=null;return source.split(/\r?\n/).map(line=>{
  const marker=/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if(fence){if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;return '';}
  if(marker){fence=marker[1];return '';}return line;
 }).join('\n');
}
export function documentationAnchors(source){
 const used=new Map(),anchors=new Set();for(const line of prose(source).split('\n')){
  const heading=/^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);if(!heading)continue;
  const slug=heading[1].toLowerCase().replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/[^\p{L}\p{N}\p{M}\s_-]/gu,'').trim().replace(/\s/g,'-'),number=used.get(slug)??0;used.set(slug,number+1);anchors.add(slug+(number?'-'+number:''));
 }return anchors;
}
/** Local Markdown targets only. No network requests or execution of examples. */
export async function checkDocumentation(root=projectRoot){
 root=await realpath(root);const files=[];
 for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.md'))files.push(entry.name);
 async function collect(folder){let entries;try{if((await lstat(join(root,folder))).isSymbolicLink())throw Error('Documentation directories must not be symbolic links.');entries=await readdir(join(root,folder),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const entry of entries){const path=join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Documentation entries must not be symbolic links.');if(entry.isDirectory())await collect(path);else if(entry.isFile()&&entry.name.endsWith('.md'))files.push(path);}
 }
 await collect('docs');await collect('deploy');const cache=new Map(),load=async path=>{if(!cache.has(path)){const stat=await lstat(path);if(!stat.isFile()||stat.size>2*1024*1024)throw Error('Invalid documentation file.');cache.set(path,await readFile(path,'utf8'));}return cache.get(path);};
 const problems=[];let links=0;
 for(const file of files){const text=prose(await load(join(root,file))),pattern=/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g;for(const match of text.matchAll(pattern)){
  let href=match[1].replace(/^<|>$/g,'');if(/^(?:https?:|mailto:|tel:)/i.test(href))continue;
  const line=text.slice(0,match.index).split('\n').length;links++;
  try{
   const [path,fragment]=href.split('#');if(path.includes('?')||/^[A-Za-z][\w+.-]*:/.test(path))throw Error('unsupported local target');
   const target=resolve(dirname(join(root,file)),decodeURIComponent(path||'.')),real=await realpath(path?target:join(root,file)),rel=relative(root,real);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw Error('target leaves the repository');
   if(fragment&&extname(real).toLowerCase()==='.md'&&!documentationAnchors(await load(real)).has(decodeURIComponent(fragment)))throw Error('missing heading #'+fragment);
  }catch(error){problems.push(file+':'+line+' → '+href+' ('+(error.code==='ENOENT'?'missing file':error.message)+')');}
 }}
 if(problems.length)throw Error('Documentation links need attention:\n'+problems.join('\n'));
 return{files:files.length,localLinks:links,externalLinksChecked:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await checkDocumentation()));}catch(error){console.error(error.message);process.exitCode=1;}}
