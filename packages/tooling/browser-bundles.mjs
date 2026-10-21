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
   api.onLoad({filter:/.*/,namespace:'yumunio-static'},args=>({contents:sources.get(args.path),loader:args.path.endsWith('.json')?'json':'js'}));
  }}]};
 const points=names=>Object.fromEntries(names.map(name=>[name.slice(0,-3),name])),jobs=[];
 if(normal.length)jobs.push(build({...options,entryPoints:points(normal),splitting:true,format:'esm'}));
 // Initial API requests must not wait for another round trip to shared chunks.
 for(const name of standalone)jobs.push(build({...options,entryPoints:points([name]),splitting:false,format:'iife'}).then(result=>{if(Object.values(result.metafile.outputs).some(output=>output.imports.length))throw Error('Startup controller must be self-contained.');return result;}));
 const results=await Promise.all(jobs),files=new Map(results.flatMap(result=>result.outputFiles.map(file=>[file.path.replaceAll('\\','/').split('/web/').at(-1),file.contents])));
 const clean=path=>path.replaceAll('\\','/').replace(/^.*\/web\/|^web\//,''),graph=new Map();
 for(const result of results)for(const[path,output]of Object.entries(result.metafile.outputs))graph.set(clean(path),output.imports.filter(item=>!item.external&&item.kind==='import-statement').map(item=>clean(item.path)));
 files.preloads=new Map();
 for(const name of normal){const visited=new Set(),pending=[...(graph.get(name)??[])];while(pending.length){const dependency=pending.pop();if(visited.has(dependency))continue;if(!/^_assets\/[A-Za-z0-9_-]+\.js$/.test(dependency))throw Error('Invalid controller preload.');visited.add(dependency);pending.push(...(graph.get(dependency)??[]));}files.preloads.set(name,[...visited].sort());}
 return files;
}

/** Make required modules available together. Dynamic imports remain lazy. */
export function addControllerPreloads(html,preloads){
 const paths=new Set();
 for(const tag of html.match(/<link\b[^>]*>/g)??[]){if(!/\brel="modulepreload"/.test(tag))continue;const entry=/\bhref="\/([^"?#]+)(?:\?[^"#]*)?"/.exec(tag)?.[1];for(const path of preloads?.get(entry)??[])paths.add(path);}
 if(!paths.size)return html;
 const links=[...paths].filter(path=>!html.includes('href="/'+path+'"')).map(path=>{if(!/^_assets\/[A-Za-z0-9_-]+\.js$/.test(path))throw Error('Invalid controller preload.');return'<link rel="modulepreload" href="/'+path+'"/>';}).join('');
 return html.replace('</head>',links+'</head>');
}
