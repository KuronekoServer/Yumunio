import test from 'node:test';
import assert from 'node:assert/strict';
import {readInstanceConfig} from '../../../packages/identity/src/instance.js';
import {PreferencesStore} from '../public/preferences.js';
import {validateInstanceConfig,loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from '../public/instance.js';
const config=()=>readInstanceConfig({YUMUNIO_BRAND_NAME:'Studio 日本語',YUMUNIO_BRAND_ORGANIZATION:'Example Org',YUMUNIO_BRAND_COLOR:'#23558e',YUMUNIO_DEFAULT_THEME:'midnight',YUMUNIO_DEFAULT_LOCALE:'en',YUMUNIO_BRAND_LOGO_LIGHT:'/brand/light.svg',YUMUNIO_BRAND_LOGO_DARK:'/brand/dark.png',YUMUNIO_BRAND_FAVICON:'/brand/icon.ico'});
function storage(){const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};}
class Element{
  constructor(){this.attributes=new Map();this.dataset={};this.hidden=false;this.textContent='';this.style={values:new Map(),setProperty(key,value){this.values.set(key,value);},getPropertyValue(key){return this.values.get(key)??'';}};}
  setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}removeAttribute(key){this.attributes.delete(key);}
  set innerHTML(value){throw new Error('HTML injection is forbidden');}querySelector(){return this.fallback??null;}
}
function documentFixture(){
  const nodes={name:new Element(),label:new Element(),organization:new Element(),mark:new Element(),primary:new Element(),image:new Element(),fallback:new Element(),title:new Element()};
  nodes.image.parentElement={querySelector:()=>nodes.fallback};nodes.title.setAttribute('data-instance-title','Account');const root=new Element();root.style.setProperty('--accent','#ABCDEF');root.style.setProperty('--on','#010203');
  const registry=new Map([['[data-instance-name]',[nodes.name]],['[data-instance-label]',[nodes.label]],['[data-instance-organization]',[nodes.organization]],['[data-instance-brand-mark]',[nodes.mark]],['[data-instance-primary]',[nodes.primary]],['[data-instance-logo]',[nodes.image]],['title[data-instance-title]',[nodes.title]]]);
  const document={documentElement:root,title:'',head:{append(node){registry.set('[data-instance-favicon]',[node]);}},createElement:()=>new Element(),querySelectorAll:selector=>registry.get(selector)??[],querySelector:selector=>registry.get(selector)?.[0]??null};
  return{document,root,nodes};
}
test('public brand DTO validation rejects extra secrets and unsafe asset paths',()=>{
  assert.deepEqual(validateInstanceConfig(config()),config());for(const patch of [{privateSecret:'hidden'},{logos:{light:'https://evil.example/logo.png',dark:null}},{logos:{light:'/api/private.png',dark:null}},{brandColor:'red'},{defaultLocale:'../unknown'}])assert.throws(()=>validateInstanceConfig({...config(),...patch}),/INVALID_INSTANCE/);
});
test('brand loading uses one fixed same-origin no-store GET and falls back safely for invalid, oversized or unavailable responses',async()=>{
  let calls=0;const loaded=await loadInstanceConfig({fetcher:async(path,options)=>{calls++;assert.equal(path,'/api/instance');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');return Response.json(config());}});assert.deepEqual(loaded,config());assert.equal(calls,1);
  for(const fetcher of [async()=>Response.json({...config(),secret:'hidden'}),async()=>new Response('x'.repeat(8193)),async()=>new Response('',{status:503}),async()=>{throw new Error('private credentials');}])assert.deepEqual(await loadInstanceConfig({fetcher}),readInstanceConfig());
});
test('instance defaults initialize only a previously unsaved profile and preserve existing theme, custom accent, locale and malformed records',()=>{
  const fresh=new PreferencesStore({storage:storage(),profileId:'fresh-user'});assert.equal(applyInstanceDefaults(fresh,config()),true);assert.equal(fresh.snapshot().themeId,'midnight');assert.equal(fresh.snapshot().locale,'en');assert.deepEqual(fresh.snapshot().customColors,{});
  fresh.update({themeId:'forest',locale:'ja',customColors:{accent:'#99D3AF'}});const previous=fresh.snapshot();assert.equal(applyInstanceDefaults(fresh,config()),false);assert.deepEqual(fresh.snapshot(),previous);
  const brokenStorage=storage();brokenStorage.setItem('yumunio.preferences.v1:broken','not json');const broken=new PreferencesStore({storage:brokenStorage,profileId:'broken'});assert.equal(applyInstanceDefaults(broken,config()),false);assert.equal(brokenStorage.getItem(broken.key),'not json');
});
test('brand DOM changes are text-only and keep personal accent while applying public marks, logo, title, organization and favicon',()=>{
  const f=documentFixture();const value=config();value.applicationName='<img src=x onerror=bad()>';const brand=createInstanceBrand(value,{document:f.document});brand.apply({kind:'light',titleSuffix:'Account',pageTitle:'Private page title'});
  assert.equal(f.nodes.name.textContent,value.applicationName);assert.equal(f.nodes.label.getAttribute('aria-label'),value.applicationName);assert.equal(f.nodes.organization.textContent,'Example Org');assert.equal(f.nodes.image.alt,value.applicationName);
  assert.equal(f.nodes.image.getAttribute('src'),'/brand/light.svg');assert.equal(f.nodes.image.hidden,true);assert.equal(f.nodes.fallback.hidden,false);f.nodes.image.onload();assert.equal(f.nodes.image.hidden,false);assert.equal(f.nodes.fallback.getAttribute('hidden'),'');
  assert.equal(f.root.style.getPropertyValue('--accent'),'#ABCDEF');assert.equal(f.root.style.getPropertyValue('--on'),'#010203');assert.equal(f.root.style.getPropertyValue('--instance-brand-color'),'#23558E');assert.equal(f.nodes.primary.style.backgroundColor,'#23558E');
  assert.equal(f.document.title,'Private page title — '+value.applicationName+' — Account');assert.equal(f.document.querySelector('[data-instance-favicon]').getAttribute('href'),'/brand/icon.ico');
});
test('dark logo errors fall back to the standard dark mark and favicon without borrowing the custom light asset',()=>{
  const f=documentFixture(),brand=createInstanceBrand(config(),{document:f.document});brand.apply({kind:'dark'});assert.equal(f.nodes.image.getAttribute('src'),'/brand/dark.png');f.nodes.image.onerror();assert.equal(f.nodes.image.hidden,true);assert.equal(f.nodes.fallback.hidden,false);assert.equal(f.nodes.image.getAttribute('src'),null);
  brand.apply();assert.equal(f.nodes.image.getAttribute('src'),null);const favicon=f.document.querySelector('[data-instance-favicon]');favicon.onerror();assert.match(favicon.getAttribute('href'),/^data:image\/svg\+xml,/);assert.match(decodeURIComponent(favicon.getAttribute('href')),/#131C2B/);
  const onlyLight=config();onlyLight.logos.dark=null;const g=documentFixture();createInstanceBrand(onlyLight,{document:g.document}).apply({kind:'dark'});assert.equal(g.nodes.image.getAttribute('src'),null);assert.equal(g.nodes.fallback.hidden,false);
});
test('unset organization is hidden and default brand colors never change the user palette',()=>{
  const f=documentFixture();createInstanceBrand(readInstanceConfig(),{document:f.document}).apply({kind:'light'});assert.equal(f.nodes.organization.hidden,true);assert.equal(f.nodes.name.textContent,'Yumunio');assert.equal(f.nodes.image.getAttribute('src'),null);assert.equal(f.root.style.getPropertyValue('--accent'),'#ABCDEF');
});