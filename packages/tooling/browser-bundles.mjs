import {build} from 'esbuild';

/** Bundle the existing DOM controllers without changing their mounting or security boundaries. */
export async function bundleBrowserControllers(sources,entries){
 const available=entries.filter(name=>sources.has(name)),standalone=available.filter(name=>name==='workspace-preload.js'),normal=available.filter(name=>!standalone.includes(name));
 if(!available.length)return new Map();
 const options={bundle:true,write:false,outdir:'web',platform:'browser',target:'es2022',minify:true,legalComments:'inline',tsconfigRaw:{},logLevel:'silent',metafile:true,entryNames:'[name]',chunkNames:'_assets/[name]-[hash]',
  plugins:[{name:'canonical-static-sources',setup(api){
   api.onResolve({filter:/.*/},args=>{
    const path=args.kind==='entry-point'?args.path:new URL(args.path,'https://static.invalid/'+args.importer).pathname.slice(1);
    if(!sources.has(path))throw new Error('Unknown browser module: '+path);
    return{path,namespace:'yumunio-static'};
   });
   api.onLoad({filter:/.*/,namespace:'yumunio-static'},args=>({contents:sources.get(args.path),loader:'js'}));
  }}]};
 const points=names=>Object.fromEntries(names.map(name=>[name.slice(0,-3),name])),jobs=[];
 if(normal.length)jobs.push(build({...options,entryPoints:points(normal),splitting:true,format:'esm'}));
 // Initial API requests must not wait for another round trip to shared chunks.
 for(const name of standalone)jobs.push(build({...options,entryPoints:points([name]),splitting:false,format:'iife'}).then(result=>{if(Object.values(result.metafile.outputs).some(output=>output.imports.length))throw Error('Startup controller must be self-contained.');return result;}));
 const results=await Promise.all(jobs);
 return new Map(results.flatMap(result=>result.outputFiles.map(file=>[file.path.replaceAll('\\','/').split('/web/').at(-1),file.contents])));
}
