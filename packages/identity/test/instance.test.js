import test from 'node:test';
import assert from 'node:assert/strict';
import {readInstanceConfig,createInstanceApi,isPublicBrandAssetPath} from '../src/instance.js';
const origin='https://instance.example';
test('instance defaults expose only the fixed public brand DTO and never read unrelated environment secrets',()=>{
  const env={};Object.defineProperty(env,'YUMUNIO_AUTH_SECRET',{get(){throw new Error('Must not be read');}});
  const config=readInstanceConfig(env);assert.deepEqual(config,{schemaVersion:1,applicationName:'Yumunio',organizationName:null,logos:{light:null,dark:null},favicons:{light:null,dark:null},brandColor:'#385772',initialTheme:'light',defaultLocale:'ja'});
  config.logos.dark='/brand/changed.svg';assert.equal(readInstanceConfig().logos.dark,null);
});
test('public instance settings normalize names, color, locale and independent logo variants without rewriting user preferences',()=>{
  const config=readInstanceConfig({YUMUNIO_BRAND_NAME:'  Studio 日本語 😀  ',YUMUNIO_BRAND_ORGANIZATION:' Example Studio ',YUMUNIO_BRAND_COLOR:'#aB3',YUMUNIO_DEFAULT_THEME:'midnight',YUMUNIO_DEFAULT_LOCALE:'en-GB',YUMUNIO_BRAND_LOGO_LIGHT:'/brand/logo-light.svg',YUMUNIO_BRAND_LOGO_DARK:'/brand/theme/logo-dark.png',YUMUNIO_BRAND_FAVICON:'/brand/favicon.ico'});
  assert.equal(config.applicationName,'Studio 日本語 😀');assert.equal(config.organizationName,'Example Studio');assert.equal(config.brandColor,'#AABB33');assert.equal(config.initialTheme,'midnight');assert.equal(config.defaultLocale,'en-GB');
  assert.deepEqual(config.logos,{light:'/brand/logo-light.svg',dark:'/brand/theme/logo-dark.png'});assert.deepEqual(config.favicons,{light:'/brand/favicon.ico',dark:'/brand/favicon.ico'});
});
test('invalid brand fields fall back independently, without reflecting rejected configuration values',()=>{
  const config=readInstanceConfig({YUMUNIO_BRAND_NAME:'bad\nsecret',YUMUNIO_BRAND_ORGANIZATION:'  ',YUMUNIO_BRAND_COLOR:'url(https://private.example)',YUMUNIO_DEFAULT_THEME:'secret-path',YUMUNIO_DEFAULT_LOCALE:'unsupported_locale',YUMUNIO_BRAND_LOGO_LIGHT:'/api/content/private.png',YUMUNIO_BRAND_LOGO_DARK:'/brand/valid.svg',YUMUNIO_BRAND_FAVICON:'data:image/svg+xml,private'});
  assert.equal(config.applicationName,'Yumunio');assert.equal(config.organizationName,null);assert.equal(config.brandColor,'#385772');assert.equal(config.initialTheme,'light');assert.equal(config.defaultLocale,'ja');
  assert.deepEqual(config.logos,{light:null,dark:'/brand/valid.svg'});assert.deepEqual(config.favicons,{light:null,dark:null});assert.doesNotMatch(JSON.stringify(config),/private|secret|unsupported_locale/);
});
test('brand asset paths are a dedicated public allowlist and reject arbitrary origins, encoded traversal, secrets and URL modifiers',()=>{
  for(const path of ['/brand/logo.svg','/brand/dark/logo-2.png','/brand/favicon.ico'])assert.equal(isPublicBrandAssetPath(path),true,path);
  for(const path of ['https://evil.example/logo.png','//evil.example/logo.png','javascript:alert(1)','data:image/svg+xml,anything','/api/auth/logo.png','/.env','/brand/../logo.png','/brand/%2e%2e/logo.png','/brand/logo.png?secret=1','/brand/logo.svg#fragment','/brand/.env.svg','/brand/x..png','/brand/logo.jpg','/brand\\logo.png','/brand/logo\n.png'])assert.equal(isPublicBrandAssetPath(path),false,path);
});
test('instance API is an exact same-origin GET with no environment diagnostics or mutable configuration route',async()=>{
  const handler=createInstanceApi({origin,env:{YUMUNIO_BRAND_NAME:'Studio',YUMUNIO_AUTH_SECRET:'private auth secret',YUMUNIO_S3_SECRET_ACCESS_KEY:'private storage secret'}});
  const response=await handler(new Request(origin+'/api/instance'));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).applicationName,'Studio');
  for(const [url,options,status]of [[origin+'/api/instance',{method:'POST'},405],[origin+'/api/instance',{method:'HEAD'},405],[origin+'/api/instance?env=true',{},400],[origin+'/api/else',{},404],['https://foreign.example/api/instance',{},403],[origin+'/api/instance',{headers:{Origin:'https://foreign.example'}},403],[origin+'/api/instance',{headers:{'Sec-Fetch-Site':'cross-site'}},403]]){
    const denied=await handler(new Request(url,options));assert.equal(denied.status,status);assert.doesNotMatch(await denied.text(),/private auth|private storage|YUMUNIO_|Studio/);
  }
  assert.throws(()=>createInstanceApi({origin:origin+'/nested'}));
});