import {canonicalLocale} from './locale-code.js';
const THEMES=new Set(['paper','light','ocean','lavender','forest','midnight']);
const defaults={schemaVersion:1,applicationName:'Yumunio',organizationName:null,logos:{light:null,dark:null},favicons:{light:null,dark:null},brandColor:'#3D3D3A',initialTheme:'light',defaultLocale:'ja'};
const clone=value=>structuredClone(value);
function value(env,key){try{return typeof env[key]==='string'?env[key].trim():'';}catch{return '';}}
function name(input,max,fallback){return input&&Array.from(input).length<=max&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input)?input:fallback;}
export function isPublicBrandAssetPath(input){
  return typeof input==='string'&&input.length<=512&&/^\/brand\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png|ico)$/.test(input)&&
    input.split('/').every(part=>part!=='.'&&part!=='..'&&!part.includes('..'));
}
/** Only these public fields are resolved. Invalid individual settings use safe defaults. */
export function readInstanceConfig(env={}){
  const result=clone(defaults);result.applicationName=name(value(env,'YUMUNIO_BRAND_NAME'),80,defaults.applicationName);
  result.organizationName=name(value(env,'YUMUNIO_BRAND_ORGANIZATION'),120,null);
  for(const [key,variant]of [['YUMUNIO_BRAND_LOGO_LIGHT','light'],['YUMUNIO_BRAND_LOGO_DARK','dark']]){const path=value(env,key);if(isPublicBrandAssetPath(path))result.logos[variant]=path;}
  const favicon=value(env,'YUMUNIO_BRAND_FAVICON');if(isPublicBrandAssetPath(favicon))result.favicons={light:favicon,dark:favicon};
  const color=value(env,'YUMUNIO_BRAND_COLOR');if(/^#[a-f0-9]{6}$/i.test(color))result.brandColor=color.toUpperCase();else if(/^#[a-f0-9]{3}$/i.test(color))result.brandColor='#'+color.slice(1).split('').map(char=>char+char).join('').toUpperCase();
  const theme=value(env,'YUMUNIO_DEFAULT_THEME');if(THEMES.has(theme))result.initialTheme=theme;
  const locale=value(env,'YUMUNIO_DEFAULT_LOCALE');try{result.defaultLocale=canonicalLocale(locale);}catch{}
  return result;
}
/** Same-origin, public read-only identification; no environment or diagnostic endpoint. */
export function createInstanceApi({env={},origin}={}){
  let url;try{url=new URL(origin);}catch{throw new Error('Invalid instance origin.');}
  if(url.origin!==origin||!['https:','http:'].includes(url.protocol))throw new Error('Invalid instance origin.');
  const config=readInstanceConfig(env),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
  return async request=>{
    const url=new URL(request.url);let status=200,code;
    if(url.origin!==origin||(request.headers.has('origin')&&request.headers.get('origin')!==origin)||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))) {status=403;code='INSTANCE_REQUEST_REJECTED';}
    else if(url.pathname!=='/api/instance'){status=404;code='INSTANCE_NOT_FOUND';}
    else if(request.method!=='GET'){status=405;code='METHOD_NOT_ALLOWED';}
    else if(url.search||url.hash){status=400;code='INVALID_INSTANCE_REQUEST';}
    return Response.json(code?{error:{code,message:'Instance identification is unavailable.'}}:config,{status,headers:{...headers,...(status===405?{Allow:'GET'}:{})}});
  };
}