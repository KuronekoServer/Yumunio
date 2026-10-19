import {createD1AdminStore} from '../../../packages/identity/src/admin-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initialSetupAuthorization} from '../../../packages/identity/src/setup.js';

const root=fileURLToPath(new URL('../../../',import.meta.url)),prefix='yumunio-worker-mail-',origin='https://email.fixture.invalid',secret='Synthetic-worker-email-instance-2026-'.repeat(3);
test('actual workerd persists native Email Service settings and routes administrator tests through the durable mail queue', {timeout:90000},async t=>{
 const folder=await mkdtemp(join(tmpdir(),prefix)),entry=join(folder,'fixture.mjs'),bundle=join(folder,'worker.mjs');let worker;
 t.after(async()=>{await worker?.dispose();const rel=relative(resolve(tmpdir()),resolve(folder));assert.ok(!isAbsolute(rel)&&!rel.includes(sep)&&rel.startsWith(prefix));await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await writeFile(entry,`import app from ${JSON.stringify(pathToFileURL(join(root,'apps/worker/worker.js')).href)};const sent=[];const mail={async send(value){sent.push(value);return{messageId:'fixture-native-email-'+sent.length};}};export default{fetch(request,env,ctx){if(new URL(request.url).pathname==='/__fixture_mail')return Response.json(sent);if(new URL(request.url).pathname==='/__fixture_drain')return(async()=>{const pending=[];await app.scheduled({},{...env,EMAIL:mail},{waitUntil:task=>pending.push(task)});await Promise.all(pending);return Response.json({done:true});})();return app.fetch(request,{...env,EMAIL:mail},ctx);},scheduled(event,env,ctx){return app.scheduled(event,{...env,EMAIL:mail},ctx);}};`);
 await build({stdin:{contents:await readFile(entry,'utf8'),resolveDir:root,sourcefile:'worker-mail-fixture.mjs'},outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],logLevel:'silent',plugins:[{name:'fixture-file-url',setup(builder){builder.onResolve({filter:/^file:/},args=>({path:fileURLToPath(args.path)}));}}]});
 worker=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:bundle,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'mail-installation'},r2Buckets:{BLOBS:'mail-assets'},telemetry:{enabled:false},bindings:{YUMUNIO_INSTANCE_SECRET:secret,YUMUNIO_WEB_SETUP:'true',YUMUNIO_BLOB_DRIVER:'r2'}}));await worker.ready;
 const db=await worker.getD1Database('DB'),schema=(await readFile(join(root,'apps/worker/install-migrations/0001_install.sql'),'utf8')).replace(/^\s*--[^\r\n]*$/gm,'');await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
 let cookie='',accountId='';const request=(path,method='GET',body,headers={})=>worker.dispatchFetch(origin+path,{method,headers:{...(cookie?{Cookie:cookie,'X-Yumunio-Expected-Account':accountId}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const owner={name:'Email fixture owner',email:'owner@example.invalid',password:'Synthetic-mail-owner-password-2026!',settings:{YUMUNIO_MAIL_DRIVER:'cloudflare',YUMUNIO_SMTP_FROM:'notes@example.invalid'}};
 const claimed=await request('/api/setup','POST',owner,{'X-Yumunio-Setup-Token':await initialSetupAuthorization({YUMUNIO_INSTANCE_SECRET:secret})});assert.equal(claimed.status,201,await claimed.clone().text());
 const signIn=await request('/api/auth/sign-in/email','POST',{email:owner.email,password:owner.password});assert.equal(signIn.status,200);accountId=(await signIn.json()).user.id;cookie=signIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const settings=await(await request('/api/admin/settings')).json();assert.equal(settings.mailCapabilities.cloudflare,true);assert.equal(settings.settings.YUMUNIO_MAIL_DRIVER,'cloudflare');
 const invalid=await request('/api/admin/settings','PUT',{revision:settings.revision,settings:{YUMUNIO_MAIL_DRIVER:'smtp',YUMUNIO_SMTP_HOST:'smtp.example.invalid',YUMUNIO_SMTP_PORT:'25'}});assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,'SETUP_SMTP_PORT');
 const testMail=await request('/api/admin/mail-test','POST',{requestId:'native-email-fixture',consent:true});assert.equal(testMail.status,202,await testMail.clone().text());await testMail.arrayBuffer();
 await(await request('/__fixture_drain')).arrayBuffer();let jobs;for(let attempt=0;attempt<30;attempt++){const jobsResponse=await request('/api/admin/jobs');assert.equal(jobsResponse.status,200,await jobsResponse.clone().text());jobs=await jobsResponse.json();if(jobs.tests[0]?.status==='accepted')break;await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(jobs.tests[0].status,'accepted');const sent=await(await request('/__fixture_mail')).json();assert.equal(sent.length,1);assert.equal(sent[0].from,'notes@example.invalid');assert.equal(sent[0].to,owner.email);assert.ok(sent[0].text.length>0);
 const replay=await request('/api/admin/mail-test','POST',{requestId:'native-email-fixture',consent:true});assert.equal((await replay.json()).replayed,true);await(await request('/__fixture_drain')).arrayBuffer();assert.equal((await(await request('/__fixture_mail')).json()).length,1);
 const smtp=await request('/api/admin/settings','PUT',{revision:settings.revision,settings:{YUMUNIO_MAIL_DRIVER:'smtp',YUMUNIO_SMTP_HOST:'smtp.example.invalid',YUMUNIO_SMTP_PORT:'465',YUMUNIO_SMTP_TLS:'implicit_tls',YUMUNIO_SMTP_USER:'synthetic-user',YUMUNIO_SMTP_PASSWORD:'synthetic-mail-password'}});assert.equal(smtp.status,200,await smtp.clone().text());assert.equal((await request('/health')).status,200);
 const stored=await(await request('/api/admin/settings')).json();assert.equal(stored.secrets.YUMUNIO_SMTP_PASSWORD,true);assert.ok(!JSON.stringify(stored).includes('synthetic-mail-password'));assert.ok(!(await db.prepare('SELECT sealed FROM yumunio_instance_settings').first()).sealed.includes('synthetic-mail-password'));
});
