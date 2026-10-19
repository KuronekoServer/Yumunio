export const WEB_PAGE_NAMES=Object.freeze(['account','admin','attachments','backlinks','backups','collections','comments','forms','history','import','install','integrations','notes','offline','preferences','publication','setup','share','site','templates','webhooks','workspace-settings','workspace']);
const names=new Set(WEB_PAGE_NAMES);
/** Explicit page routes keep APIs, unknown paths and asset names out of the HTML fallback. */
export function webPageRoute(pathname){
 if(pathname==='/')return{assetPath:'/index.html',path:'/'};
 if(['/index','/index.html'].includes(pathname))return{redirectPath:'/notes'};
 const match=/^\/([a-z][a-z-]*)(\.html|\/)?$/.exec(pathname);
 if(!match||!names.has(match[1]))return null;
 const path='/'+match[1];return match[2]?{redirectPath:path}:{path,assetPath:path+'.html'};
}
export const workerPagePaths=()=>['/','/index','/index.html',...WEB_PAGE_NAMES.flatMap(name=>['/'+name,'/'+name+'/','/'+name+'.html'])];
