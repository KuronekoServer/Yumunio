import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';

/** Compile only the shadcn source. The legacy editor CSS must stay under Next's
 * own CSS loader, which preserves its nested import URLs and existing defaults. */
export async function buildUiStyles(root){
 const output=join(root,'.build/ui/shadcn.css');await mkdir(dirname(output),{recursive:true});
 const input=join(root,'apps/web/src/shadcn.css');
 const result=await postcss([tailwindcss({base:join(root,'apps/web'),optimize:true})]).process(await readFile(input,'utf8'),{from:input,to:output,map:false});
 await writeFile(output,result.css,'utf8');
}
