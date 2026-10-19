import {build} from 'esbuild';

/** Bundle the existing DOM controllers without changing their mounting or security boundaries. */
export async function bundleBrowserControllers(sources,entries){
 const entryPoints=Object.fromEntries(entries.filter(name=>sources.has(name)).map(name=>[name.slice(0,-3),name]));
 if(!Object.keys(entryPoints).length)return new Map();
 const result=await build({entryPoints,bundle:true,splitting:true,write:false,outdir:'web',format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'inline',tsconfigRaw:{},logLevel:'silent',metafile:true,
  entryNames:'[name]',chunkNames:'_assets/[name]-[hash]',
  plugins:[{name:'canonical-static-sources',setup(api){
   api.onResolve({filter:/.*/},args=>{
    const path=args.kind==='entry-point'?args.path:new URL(args.path,'https://static.invalid/'+args.importer).pathname.slice(1);
    if(!sources.has(path))throw new Error('Unknown browser module: '+path);
    return{path,namespace:'yumunio-static'};
   });
   api.onLoad({filter:/.*/,namespace:'yumunio-static'},args=>({contents:sources.get(args.path),loader:'js'}));
  }}]});
 return new Map(result.outputFiles.map(file=>[file.path.replaceAll('\\','/').split('/web/').at(-1),file.contents]));
}
