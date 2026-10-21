import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';

/** Include the runtime dependency graph used by the checked-in shadcn components. */
export async function uiLicenseNotices(root){
 const seen=new Set(),notices=[],missing=[];
 async function visit(name,from){
  if(['react','react-dom'].includes(name))return;
  const require=createRequire(from);let path;
  try{path=require.resolve(name+'/package.json');}
  catch(error){
   if(error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;
   let directory=dirname(require.resolve(name));
   for(let depth=0;depth<8;depth++){
    const candidate=join(directory,'package.json');
    try{if(JSON.parse(await readFile(candidate,'utf8')).name===name){path=candidate;break;}}catch(failure){if(failure.code!=='ENOENT')throw failure;}
    directory=dirname(directory);
   }
   if(!path)throw new Error('UI package metadata was not found: '+name);
  }
  if(seen.has(path))return;
  seen.add(path);if(seen.size>128)throw new Error('Unexpected UI dependency graph.');
  const pkg=JSON.parse(await readFile(path,'utf8'));let license;
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','license.md','license']){try{license=await readFile(join(dirname(path),file),'utf8');break;}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!license){try{license=await readFile(join(root,'apps/web/src/components/ui/licenses',name.replaceAll('/','__')+'.txt'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!license)missing.push({name,version:pkg.version,repository:pkg.repository});
  else notices.push(name+'@'+pkg.version+'\n\n'+license);
  for(const dependency of Object.keys(pkg.dependencies??{}))await visit(dependency,path);
 }
 const from=join(root,'apps/web/package.json');
 for(const name of ['@radix-ui/react-slot','@radix-ui/react-dropdown-menu','@radix-ui/react-tooltip','class-variance-authority','clsx','tailwind-merge','tailwindcss'])await visit(name,from);
 notices.push('shadcn/ui\n\n'+await readFile(join(root,'apps/web/src/components/ui/LICENSE.txt'),'utf8'));
 if(missing.length)throw new Error('UI dependencies require license notices: '+JSON.stringify(missing));
 return notices;
}
