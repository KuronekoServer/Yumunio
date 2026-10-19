import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve,relative} from 'node:path';
import {WEB_PAGE_NAMES} from '../prototype/src/web-routes.js';

/** Keep the static host's script-src 'self' policy: Next's build-time bootstrap is external. */
export function externalizeNextScripts(html){
 const scripts=new Map();
 const content=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(tag,attributes,body)=>{
  if(/\bsrc\s*=/i.test(attributes)||!body.trim())return tag;
  const type=/\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
  if(type&&!['module','text/javascript','application/javascript'].includes(type))return tag;
  const name='_next/static/yumunio/'+createHash('sha256').update(body).digest('hex')+'.js';
  scripts.set(name,body);
  return '<script'+attributes+' src="/'+name+'"></script>';
 });
 return{html:content,scripts};
}
async function checkedDirectory(path){
 try{if((await lstat(path)).isSymbolicLink())throw new Error('Next build directories must not be symbolic links.');}catch(error){if(error.code!=='ENOENT')throw error;}
}

/** Build real App Router pages, keeping generated server bundles out of the public artifact. */
export async function buildNextPages(root,{publicFiles=[]}={}){
 const app=resolve(root,'apps/web'),output=resolve(app,'out');
 if(relative(resolve(root),output)!==join('apps','web','out'))throw new Error('Unexpected Next export destination.');
 await checkedDirectory(app);await checkedDirectory(join(app,'.next'));await checkedDirectory(output);
 await new Promise((done,reject)=>{
  const child=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:app,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';
  child.stdout.on('data',bytes=>process.stdout.write(bytes));
  child.stderr.on('data',bytes=>{process.stderr.write(bytes);errors=(errors+bytes).slice(-3000);});
  child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error('Next.js build failed. '+errors)));
 });
 const files=new Map(),existing=new Set(publicFiles);
 async function collect(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const name=prefix?prefix+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink()||name.split('/').some(part=>part==='..'||part.startsWith('.')))throw new Error('Unexpected Next export path.');
   const path=join(directory,entry.name);
   if(entry.isDirectory())await collect(path,name);
   else if(entry.isFile()){
    if((await lstat(path)).nlink>1)throw new Error('Next export files must not be hard linked.');
    if(existing.has(name))continue;
    if(!/\.(?:html|js|css|txt|json|svg|png|ico|woff2?)$/.test(name))throw new Error('Unexpected Next export asset: '+name);
    const bytes=await readFile(path);
    if(name.endsWith('.html')){const external=externalizeNextScripts(bytes.toString('utf8'));files.set(name,external.html);for(const [path,source]of external.scripts)files.set(path,source);}
    else files.set(name,bytes);
   }else throw new Error('Unexpected Next export entry.');
  }
 }
 await collect(output);
 for(const name of ['index','404',...WEB_PAGE_NAMES])if(!files.has(name+'.html'))throw new Error('Next export is missing a page: '+name);
 return files;
}
