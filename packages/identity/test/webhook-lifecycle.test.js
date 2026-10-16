import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createSqliteContentStore,createD1ContentStore} from '../src/content-store.js';
import {createSqliteWebhookStore,createD1WebhookStore,migrateWebhookEventSchema} from '../src/webhooks-store.js';
import {readWebhookConfig,webhookPageAuthority,WEBHOOK_EVENT_TYPES} from '../src/webhooks-model.js';
import {createWebhookApi,createWebhookRunner} from '../src/webhooks.js';
import {validateContentPayload} from '../src/content.js';

const stamp='2026-10-16T00:00:00.000Z',origin='https://workspace.example.invalid';
const env={YUMUNIO_WEBHOOK_ENABLED:'true',YUMUNIO_WEBHOOK_ENDPOINT:'https://receiver.lifecycle.invalid/events',YUMUNIO_WEBHOOK_SIGNING_KEY:Buffer.alloc(32,17).toString('base64'),YUMUNIO_WEBHOOK_EVENTS:WEBHOOK_EVENT_TYPES.join(','),YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS:'true'};
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
function page(id,parentId=null){return{page:{id,workspaceId:'workspace',title:'Private '+id,parentId,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId:'workspace',version:1,blocks:[{id:'block-'+id,type:'paragraph',data:{text:'Private body fixture@example.invalid'}}],updatedAt:stamp},inheritPermissions:parentId!==null};}
const bump=item=>{item.document.version++;item.document.updatedAt=stamp;item.page.updatedAt=stamp;};
function d1Binding(db,intercept){const prepare=(sql,params=[])=>({sql,params,bind(...values){return prepare(sql,values);},async all(){return{success:true,results:db.prepare(sql).all(...params),meta:{changes:0}};}});return{prepare,async batch(commands){intercept();db.exec('BEGIN IMMEDIATE');try{const results=commands.map(({sql,params})=>{const statement=db.prepare(sql);return /^\s*SELECT\b/i.test(sql)?{success:true,results:statement.all(...params),meta:{changes:0}}:{success:true,results:[],meta:{changes:Number(statement.run(...params).changes)}};});db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};}
async function fixture(t,{driver='sqlite',includeDescendants=true,events=WEBHOOK_EVENT_TYPES}={}){
 const config=await readWebhookConfig({...env,YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS:String(includeDescendants),YUMUNIO_WEBHOOK_EVENTS:events.join(',')}),db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());await migrateWebhookEventSchema({dialect:'sqlite',database:db});
 for(const id of ['owner','writer','admin'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run('workspace','Synthetic lifecycle workspace','lifecycle-workspace',stamp);
 for(const [id,role]of [['owner','owner'],['writer','member']])db.prepare('INSERT INTO yumunio_memberships VALUES(?,?,?,?,?)').run('membership-'+id,'workspace',id,role,stamp);
 const payload={schemaVersion:1,pages:[page('root'),page('outside')],grants:[],grantBindings:[]};
 for(const [accountId,pageId]of [['owner','root'],['owner','outside'],['writer','root']]){const id='grant-'+accountId+'-'+pageId;payload.grants.push({id,workspaceId:'workspace',pageId,accountId,permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId:id,membershipId:'membership-'+accountId});}
 db.prepare('INSERT INTO yumunio_account_content VALUES(?,?,?)').run('workspace',1,JSON.stringify(payload));
 let beforeBatch=null;const intercept=()=>{const callback=beforeBatch;beforeBatch=null;callback?.();},binding=driver==='d1'?d1Binding(db,intercept):{prepare:db.prepare.bind(db),exec(sql){if(sql==='BEGIN IMMEDIATE')intercept();return db.exec(sql);}},store=driver==='d1'?createD1WebhookStore(binding):createSqliteWebhookStore(binding);
 const options={webhookStore:store,webhookConfig:config,webhookAdminIds:['admin'],validatePayload:validateContentPayload,webhookNow:()=>stamp},content=driver==='d1'?createD1ContentStore(binding,options):createSqliteContentStore(binding,options);
 const api=createWebhookApi({config,store,contentStore:content,resolveSession:async()=>({user:{id:'owner',emailVerified:true}}),origin,adminIds:['admin'],now:()=>stamp});
 const authority=await webhookPageAuthority({workspaceId:'workspace',pageId:'root',accountId:'owner',saved:await content.read('workspace','owner'),validatePayload:validateContentPayload}),approval=await store.approve({profileHash:config.profileHash,accountId:'admin',expectedVersion:0,now:stamp});
 await store.subscribe({id:randomUUID(),workspaceId:'workspace',pageId:'root',issuerAccountId:'owner',membershipId:'membership-owner',actorRole:'owner',profileHash:config.profileHash,authorityFingerprint:authority.fingerprint,startVersion:1,status:'active',reason:null,missedFromVersion:null,missedThroughVersion:null,gapAcknowledgedAt:null,createdAt:stamp,updatedAt:stamp,version:1},{authority,approval,expectedVersion:0});
 const received=[],runner=createWebhookRunner({config,store,contentStore:content,adminIds:['admin'],now:()=>stamp,fetcher:async(url,options)=>{assert.equal(url,env.YUMUNIO_WEBHOOK_ENDPOINT);assert.equal(options.redirect,'manual');const event=JSON.parse(options.body);assert.deepEqual(Object.keys(event),['schemaVersion','eventId','eventType','workspaceId','pageId','version','occurredAt']);assert.doesNotMatch(options.body,/Private|fixture@|membership|grant|profile|parentId/);received.push(event);return new Response(null,{status:204});}});
 const save=async(mutator,{actor='owner'}={})=>{const current=await content.read('workspace',actor);mutator(current.payload);return content.write('workspace',actor,{expectedRevision:current.revision,payload:current.payload,actorMembershipId:'membership-'+actor,actorRole:actor==='owner'?'owner':'member'});};
 return{db,config,content,store,api,runner,received,save,setBeforeBatch(callback){beforeBatch=callback;},request:async(method,body)=>api(new Request(origin+'/api/webhooks/workspaces/workspace/pages/root/subscription',{method,headers:{'x-yumunio-expected-account':'owner',...(method==='GET'?{}:{origin,'content-type':'application/json'})},...(body?{body:JSON.stringify(body)}:{})}))};
}

for(const driver of ['sqlite','d1']){
 test(driver+' lifecycle creation dedupes by actual child ID and retains legacy per-page metadata',async t=>{
  const f=await fixture(t,{driver});await f.save(payload=>payload.pages.push(page('child-a','root'),page('child-b','root')));
  const jobs=f.db.prepare('SELECT * FROM yumunio_webhook_jobs').all();assert.equal(jobs.length,2);assert.deepEqual(jobs.map(row=>row.event_type),['page.created','page.created']);assert.deepEqual(new Set(jobs.map(row=>row.page_id)),new Set(['child-a','child-b']));assert.ok(jobs.every(row=>row.page_version===1));
  assert.deepEqual(await f.runner.runJobs(),{processed:2});assert.deepEqual(new Set(f.received.map(event=>event.pageId)),new Set(['child-a','child-b']));assert.equal((await f.store.subscription('workspace','root')).status,'active');
 });
 test(driver+' root movement trash and restore advance only unchanged-ACL authority and deliver each transition',async t=>{
  const f=await fixture(t,{driver,includeDescendants:false});
  await f.save(payload=>{const root=payload.pages[0];root.page.parentId='outside';bump(root);});assert.deepEqual(await f.runner.runJobs(),{processed:1});assert.equal(f.received[0].eventType,'page.moved');assert.equal((await f.store.subscription('workspace','root')).version,2);
  await f.save(payload=>{payload.pages[0].page.trashedAt=stamp;bump(payload.pages[0]);});assert.deepEqual(await f.runner.runJobs(),{processed:1});assert.equal(f.received[1].eventType,'page.trashed');
  await f.save(payload=>{payload.pages[0].page.trashedAt=null;bump(payload.pages[0]);});assert.deepEqual(await f.runner.runJobs(),{processed:1});assert.equal(f.received[2].eventType,'page.restored');assert.equal((await f.store.subscription('workspace','root')).status,'active');
  assert.ok(f.received.every(event=>event.pageId==='root'));
 });
 test(driver+' child ACL loss hides history and cancels only that job without granting access or stopping root subscription',async t=>{
  const f=await fixture(t,{driver});await f.save(payload=>payload.pages.push(page('private-child','root')));
  await f.save(payload=>{payload.pages[2].inheritPermissions=false;});assert.deepEqual(await f.runner.runJobs(),{processed:0});assert.equal(f.received.length,0);assert.equal((await f.store.subscription('workspace','root')).status,'active');const job=f.db.prepare('SELECT status,last_code FROM yumunio_webhook_jobs').get();assert.equal(job.status,'cancelled');assert.equal(job.last_code,'AUTHORITY');
 });
 test(driver+' combined ACL revoke and movement never rebinds or sends metadata',async t=>{
  const f=await fixture(t,{driver});await f.save(payload=>{payload.pages[0].page.parentId='outside';bump(payload.pages[0]);payload.grants.find(row=>row.id==='grant-owner-root').status='revoked';payload.grants.find(row=>row.id==='grant-owner-outside').status='revoked';});assert.equal((await f.store.subscription('workspace','root')).status,'cancelled');assert.deepEqual(await f.runner.runJobs(),{processed:0});assert.equal(f.received.length,0);
 });
 test(driver+' pending delivery before anchor movement pauses with explicit gap consent instead of silently discarding history',async t=>{
  const f=await fixture(t,{driver});await f.save(payload=>{payload.pages[0].page.title='Private pending title';bump(payload.pages[0]);});assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yumunio_webhook_jobs WHERE status='queued'").get().n,2);
  await f.save(payload=>{payload.pages[0].page.parentId='outside';bump(payload.pages[0]);});const sub=await f.store.subscription('workspace','root');assert.equal(sub.status,'paused');assert.equal(sub.reason,'authority');assert.equal(sub.missedFromVersion,null);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yumunio_webhook_jobs WHERE status='queued'").get().n,0);assert.deepEqual(await f.runner.runJobs(),{processed:0});
  const body={expectedRevision:3,expectedVersion:sub.version,profileDigest:f.config.profileHash,confirmMetadataTransfer:true,confirmDescendants:true,acknowledgeMissing:false};assert.equal((await f.request('POST',body)).status,400);assert.equal((await f.request('POST',{...body,acknowledgeMissing:true})).status,200);assert.equal((await f.store.subscription('workspace','root')).gapAcknowledgedAt,stamp);
  await f.save(payload=>{payload.pages[0].page.title='Private future title';bump(payload.pages[0]);});assert.deepEqual(await f.runner.runJobs(),{processed:2});assert.ok(f.received.every(event=>event.version===4));assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yumunio_webhook_jobs WHERE status='cancelled'").get().n,2);
 });
 test(driver+' large subtree changes preserve content and pause with an acknowledged unknown-size gap',async t=>{
  const f=await fixture(t,{driver});await f.save(payload=>{payload.pages[1].document.blocks=[{id:'source',type:'code',data:{purpose:'import-source',language:'markdown',text:'x'.repeat(7700000)}}];bump(payload.pages[1]);for(let index=0;index<12;index++)payload.pages.push(page('child-'+index,'root'));});assert.equal((await f.content.read('workspace','owner')).payload.pages.length,14);assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_content_chunks').get().n>=30);const subscription=await f.store.subscription('workspace','root');assert.equal(subscription.status,'paused');assert.equal(subscription.reason,'capacity');assert.equal(subscription.missedFromVersion,null);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_webhook_jobs').get().n,0);
  const body={expectedRevision:2,expectedVersion:subscription.version,profileDigest:f.config.profileHash,confirmMetadataTransfer:true,confirmDescendants:true,acknowledgeMissing:false};assert.equal((await f.request('POST',body)).status,400);assert.equal((await f.request('POST',{...body,acknowledgeMissing:true})).status,200);
 });
 test(driver+' issuer generation race commits another actor content but never enqueues or revives the old subscription',async t=>{
  const f=await fixture(t,{driver});f.setBeforeBatch(()=>f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('rejoined-owner','owner'));await f.save(payload=>payload.pages.push(page('child','root')),{actor:'writer'});assert.equal((await f.content.read('workspace','writer')).revision,2);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_webhook_jobs').get().n,0);assert.equal((await f.store.subscription('workspace','root')).status,'cancelled');
 });
}
test('descendant transfer is separately consented, profile-bound, and disabled by default',async t=>{
 const legacy=await readWebhookConfig({...env,YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS:'false'}),current=await readWebhookConfig(env);assert.notEqual(current.profileHash,legacy.profileHash);assert.equal((await readWebhookConfig({...env,YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS:undefined})).profileHash,legacy.profileHash);await assert.rejects(readWebhookConfig({...env,YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS:'yes'}));
 const f=await fixture(t);const sub=await f.store.subscription('workspace','root'),body={expectedRevision:1,expectedVersion:sub.version,profileDigest:f.config.profileHash,confirmMetadataTransfer:true,acknowledgeMissing:false};assert.equal((await f.request('POST',body)).status,400);assert.equal((await f.request('POST',{...body,confirmDescendants:true})).status,200);assert.equal((await(await f.request('GET')).json()).profile.includeDescendants,true);
 const flat=await fixture(t,{includeDescendants:false});await flat.save(payload=>payload.pages.push(page('child','root')));assert.equal(flat.db.prepare('SELECT COUNT(*) AS n FROM yumunio_webhook_jobs').get().n,0);
});
