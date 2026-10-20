import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {externalizeNextScripts} from '../next-pages.mjs';
import {WEB_PAGE_NAMES,webPageRoute,workerPagePaths} from '../../prototype/src/web-routes.js';
import {consumeSetupAuthorization,setupSettings,setupRequest} from '../../../apps/web/src/setup-client.js';

test('every UI route has an explicit clean URL, compatible legacy redirect and matching Worker dispatch',async()=>{
 const dispatch=workerPagePaths();for(const name of WEB_PAGE_NAMES){const path='/'+name;assert.deepEqual(webPageRoute(path),{path,assetPath:path+'.html'});assert.deepEqual(webPageRoute(path+'.html'),{redirectPath:path});assert.deepEqual(webPageRoute(path+'/'),{redirectPath:path});assert.ok(dispatch.includes(path));assert.ok(dispatch.includes(path+'.html'));}
 for(const path of ['/api/setup','/api/content/workspaces/a/pages','/health','/unknown','/setup.js','/setup/extra','//setup','/../setup'])assert.equal(webPageRoute(path),null,path);
 for(const file of ['wrangler.jsonc','apps/worker/wrangler.jsonc']){const config=JSON.parse(await readFile(new URL('../../../'+file,import.meta.url),'utf8'));for(const path of dispatch)assert.ok(config.assets.run_worker_first.includes(path),file+' '+path);}
});
test('Next bootstrap and Flight data work with script-src self without changing script bodies or order',()=>{
 const first='(self.__next_f=self.__next_f||[]).push([0]);',second='self.__next_f.push([1,"static page data"]);';
 const html='<main>Static page</main><script src="/_next/static/chunks/app.js" async></script><script>'+first+'</script><script>'+second+'</script><script>'+first+'</script><script type="application/ld+json">{"name":"Yumunio"}</script>';
 const built=externalizeNextScripts(html),again=externalizeNextScripts(html);
 assert.equal(built.html,again.html);assert.deepEqual([...built.scripts],[...again.scripts]);assert.equal(built.scripts.size,2);
 const paths=[...built.html.matchAll(/<script src="(\/_next\/static\/yumunio\/[a-f0-9]{64}\.js)"><\/script>/g)].map(value=>value[1].slice(1));
 assert.deepEqual(paths.map(path=>built.scripts.get(path)),[first,second,first]);assert.match(built.html,/<script type="application\/ld\+json">/);
 assert.doesNotMatch(built.html,/<script>self\.|<script>\(self\./);assert.match(built.html,/src="\/_next\/static\/chunks\/app.js" async/);
});

test('every exported Next page uses local executable assets and carries no inline script dependency',async()=>{
 for(const name of ['index',...WEB_PAGE_NAMES]){
  const html=await readFile(new URL('../../../.build/web/'+name+'.html',import.meta.url),'utf8');
  assert.match(html,/_next\/static\/chunks\//,name+' is a real Next export');assert.doesNotMatch(html,/router-app\.js|react-route-view|id="react-app"/);
  for(const [,attributes,body]of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
   if(/type="application\/ld\+json"/.test(attributes))continue;
   assert.equal(body.trim(),'',name+' executable script body is external');
   const path=/src="(\/[^"?#]+)"/.exec(attributes)?.[1];assert.ok(path,name+' script is local');
   await readFile(new URL('../../../.build/web'+path,import.meta.url));
  }
 }
});

test('workspace and embedded editor preload the same content-versioned controller',async()=>{
 const read=name=>readFile(new URL('../../../.build/web/'+name+'.html',import.meta.url),'utf8'),workspace=await read('workspace'),detail=await read('workspace-detail'),version=workspace.match(/href="\/workspace\.js\?v=([a-f0-9]{64})"/)?.[1];assert.ok(version);assert.ok(detail.includes('/workspace.js?v='+version));
});
test('initial setup authorization is consumed once from the fragment without losing other URL parameters',()=>{
 const calls=[],location={pathname:'/setup',search:'?locale=en',hash:'#start=synthetic'},history={state:{position:1},replaceState(...args){calls.push(args);}};
 assert.equal(consumeSetupAuthorization(location,history),'synthetic');assert.deepEqual(calls,[[{position:1},'','/setup?locale=en']]);
 assert.equal(consumeSetupAuthorization({...location,hash:''},history),'');assert.equal(calls.length,1);
});
test('React setup sends generated authorization privately and preserves admin actor fencing without caching credentials',async t=>{
 const previous=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=previous;});globalThis.fetch=async(path,options)=>{calls.push({path,options});return Response.json({complete:true});};
 await setupRequest('/api/setup',{method:'POST',authorization:'synthetic',body:{name:'Fixture'}});const request=calls[0];assert.equal(request.path,'/api/setup');assert.equal(request.options.headers['X-Yumunio-Setup-Token'],'synthetic');assert.equal(request.options.cache,'no-store');assert.equal(request.options.redirect,'error');assert.equal(request.options.credentials,'same-origin');assert.equal(request.path.includes('synthetic'),false);
 await setupRequest('/api/admin/settings',{accountId:'owner'});assert.equal(calls[1].options.headers['X-Yumunio-Expected-Account'],'owner');
 const form=new FormData();form.set('YUMUNIO_BRAND_NAME','Fixture');form.set('name','Not a setting');form.set('provider_GOOGLE','false');const settings=setupSettings(form);assert.equal(settings.YUMUNIO_BRAND_NAME,'Fixture');assert.equal(settings.name,undefined);assert.equal(settings.YUMUNIO_OAUTH_GOOGLE_CLIENT_SECRET,null);
 globalThis.fetch=async()=>Response.json({error:{code:'SETUP_CONFLICT'}},{status:409});await assert.rejects(setupRequest('/api/setup'),/SETUP_CONFLICT/);
});
