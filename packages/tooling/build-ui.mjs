import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Compile only the shadcn source. The legacy editor CSS must stay under Next's
 * own CSS loader, which preserves its nested import URLs and existing defaults. */
export async function buildUiStyles(root){
 const output=join(root,'.build/ui/shadcn.css');await mkdir(dirname(output),{recursive:true});
 const cli=fileURLToPath(new URL('../../node_modules/@tailwindcss/cli/dist/index.mjs',import.meta.url));
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,'--input',join(root,'apps/web/src/shadcn.css'),'--output',output,'--minify'],{cwd:join(root,'apps/web'),stdio:'inherit',windowsHide:true});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('UI styles did not compile.')));
 });
}
