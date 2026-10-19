import {readInstanceConfig,isPublicBrandAssetPath} from './instance.js';
const headers={'Content-Type':'application/manifest+json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
export function readPwaManifest(env={}){
  const brand=readInstanceConfig(env);
  const icon=size=>{let custom;try{custom=env['YUMUNIO_BRAND_PWA_ICON_'+size];}catch{}return{src:isPublicBrandAssetPath(custom)&&custom.endsWith('.png')?custom:'/pwa/icon-'+size+'.png',sizes:size+'x'+size,type:'image/png',purpose:'any'};};
  return{id:'/',name:brand.applicationName,short_name:Array.from(brand.applicationName).slice(0,12).join(''),lang:brand.defaultLocale,start_url:'/account',scope:'/',display:'standalone',background_color:['forest','midnight'].includes(brand.initialTheme)?'#131C2B':'#FFFFFF',theme_color:brand.brandColor,icons:[icon(192),icon(512)]};
}
export function createPwaManifestApi({env={},origin}={}){
  if(new URL(origin).origin!==origin)throw new Error('Invalid PWA origin.');
  return async request=>{
    const url=new URL(request.url),status=url.origin!==origin||request.headers.has('origin')&&request.headers.get('origin')!==origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))?403:url.pathname!=='/manifest.webmanifest'?404:!['GET','HEAD'].includes(request.method)?405:url.search||url.hash?400:200;
    return new Response(request.method==='HEAD'?null:JSON.stringify(status===200?readPwaManifest(env):{error:{code:'MANIFEST_UNAVAILABLE'}}),{status,headers:{...headers,...(status===405?{Allow:'GET, HEAD'}:{})}});
  };
}
