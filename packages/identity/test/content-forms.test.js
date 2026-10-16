import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';

const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const origin='https://forms.example',workspaceId='workspace-a',stamp='2026-10-15T00:00:00.000Z';
const property=(id,type='text',extra={})=>({id,name:id,type,...extra});
const question=(id,propertyId=id,extra={})=>({id,propertyId,label:'Question '+id,description:'',required:false,condition:null,...extra});
const definition=(fields=[question('text')],extra={})=>({title:'Review form',description:'Assigned respondents only',fields,...extra});
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  for(const id of ['owner','member','guest','other'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,'Name '+id,id+'@example.invalid',stamp,stamp);
  for(const id of [workspaceId,'foreign'])db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(id,id,id,stamp);
  for(const id of ['owner','member','guest','other'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,id==='other'?'member':id,stamp);
  db.exec("CREATE TABLE prototype_sentinel(value TEXT);INSERT INTO prototype_sentinel VALUES('legacy unchanged')");
  const raw=createSqliteContentStore(db);let beforeWrite=null,reads=0,writes=0,sequence=0,time=stamp;
  const store={async read(...args){reads++;return raw.read(...args);},async write(...args){writes++;if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
  const api=createAccountContentApi({store,origin,now:()=>time,createId:()=> 'generated-'+ ++sequence,resolveSession:async request=>{const id=request.headers.get('x-fixture-account');return id?{user:{id,emailVerified:true}}:null;}});
  const request=(path='',method='GET',body,accountId='owner',headers={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(accountId?{'x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return{db,raw,request,get writes(){return writes;},get reads(){return reads;},setBeforeWrite(fn){beforeWrite=fn;},setTime(value){time=value;}};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());const result=await response.json();assert.equal(result.error.code,code);assert.deepEqual(Object.keys(result),['error']);return result;}
async function setup(f,properties=[property('text')],def=definition(),recipients=['member','guest']){
  const collection=await ok(await f.request('/collections','POST',{expectedRevision:0,title:'Private responses',parentId:null,properties}),201);
  const path='/collections/'+collection.collectionId+'/forms';
  const form=await ok(await f.request(path,'POST',{expectedRevision:collection.revision,definition:def}),201);
  const started=await ok(await f.request(path+'/'+form.formId+'/acceptance','POST',{expectedRevision:form.revision,accepting:true,confirmManagerAccess:true,respondentAccountIds:recipients}));
  return{...collection,...form,revision:started.revision,version:started.version,path:path+'/'+form.formId,respond:'/forms/'+form.formId};
}
const submission=(requestId,answers={text:'An answer'},version=1)=>({requestId,version,answers});
const submit=(f,c,id,answers,account='member',version=c.version)=>f.request(c.respond+'/responses','POST',submission(id,answers,version),account);
async function saved(f){return f.raw.read(workspaceId,'owner');}

test('assigned verified members and guests have create-only form metadata and receipts, never response or collection read',async t=>{
  const f=fixture(t),c=await setup(f),form=await ok(await f.request(c.respond,'GET',undefined,'guest'));
  assert.deepEqual(Object.keys(form).sort(),['accessToSubmission','accountRequired','description','fields','id','title','version']);assert.equal(form.accessToSubmission,'none');assert.deepEqual(Object.keys(form.fields[0]).sort(),['condition','description','id','label','required','type']);
  await error(await f.request(c.respond,'GET',undefined,'other'),404,'CONTENT_NOT_FOUND');await error(await f.request(c.path,'GET',undefined,'guest'),404,'CONTENT_NOT_FOUND');
  const receipt=await ok(await submit(f,c,'first',{text:'<script>literal</script>'},'guest'),201);assert.deepEqual(receipt,{requestId:'first',accepted:true});
  const state=await saved(f),row=state.payload.collections[0].recordPages[0],page=state.payload.pages.find(item=>item.page.id===row.pageId);assert.equal(page.inheritPermissions,false);assert.equal(page.page.parentId,c.pageId);assert.equal(state.payload.collections[0].collection.records[0].values.text,'<script>literal</script>');
  const source=JSON.parse(page.document.blocks[0].data.text);assert.equal(source.formTitle,'Review form');assert.deepEqual(source.questions,[{label:'Question text',value:'<script>literal</script>'}]);assert.equal(page.document.blocks[0].data.purpose,'import-source');
  assert.equal(state.payload.grants.some(grant=>grant.pageId===row.pageId&&grant.accountId==='guest'),false);assert.equal(state.payload.grants.find(grant=>grant.pageId===row.pageId).permission,'full');
  for(const account of ['guest','member']){await error(await f.request('/collections/'+c.collectionId,'GET',undefined,account),404,'CONTENT_NOT_FOUND');await error(await f.request('/pages/'+row.pageId,'GET',undefined,account),404,'CONTENT_NOT_FOUND');const list=await ok(await f.request('/pages','GET',undefined,account));assert.deepEqual(list.pages,[]);}
  assert.equal(f.db.prepare('SELECT value FROM prototype_sentinel').get().value,'legacy unchanged');validateContentPayload(state.payload,workspaceId);
});

test('same receipt is idempotent across simultaneous writes and different submissions merge by aggregate CAS',async t=>{
  const f=fixture(t),c=await setup(f);const responses=await Promise.all([submit(f,c,'duplicate'),submit(f,c,'duplicate')]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);for(const response of responses)assert.deepEqual(await response.json(),{requestId:'duplicate',accepted:true});
  assert.equal((await saved(f)).payload.collections[0].collection.records.length,1);const writes=f.writes;assert.deepEqual(await ok(await submit(f,c,'duplicate')),{requestId:'duplicate',accepted:true});assert.equal(f.writes,writes);
  const distinct=await Promise.all([submit(f,c,'second',{text:'B'}),submit(f,c,'third',{text:'C'})]);assert.deepEqual(distinct.map(r=>r.status),[201,201]);for(const response of distinct)await response.arrayBuffer();const state=await saved(f);assert.equal(state.payload.collections[0].collection.records.length,3);assert.equal(state.payload.formReceipts.length,3);
});

test('workspace-wide request IDs reject cross-form, changed-version and changed-answer reuse without another response',async t=>{
  const f=fixture(t),c=await setup(f);await ok(await submit(f,c,'request'),201);await error(await submit(f,c,'request',{text:'changed'}),409,'FORM_SUBMISSION_CONFLICT');
  const current=await saved(f),second=await ok(await f.request('/collections/'+c.collectionId+'/forms','POST',{expectedRevision:current.revision,definition:definition()}),201);const path='/collections/'+c.collectionId+'/forms/'+second.formId;
  await ok(await f.request(path+'/acceptance','POST',{expectedRevision:second.revision,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}));await error(await f.request('/forms/'+second.formId+'/responses','POST',submission('request'),'member'),409,'FORM_SUBMISSION_CONFLICT');
  const state=await saved(f);await ok(await f.request(c.path+'/acceptance','POST',{expectedRevision:state.revision,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}));await error(await submit(f,c,'request',{text:'An answer'},'member',2),409,'FORM_SUBMISSION_CONFLICT');assert.equal((await saved(f)).payload.formReceipts.length,1);
});

test('draft changes do not mutate accepted version labels and explicit restart invalidates old version',async t=>{
  const f=fixture(t),c=await setup(f),updated=definition([question('text','text',{label:'New label'})],{title:'New draft'});
  await ok(await f.request(c.path,'PATCH',{expectedRevision:c.revision,definition:updated}));const old=await ok(await f.request(c.respond,'GET',undefined,'member'));assert.equal(old.title,'Review form');assert.equal(old.fields[0].label,'Question text');
  await ok(await submit(f,c,'old'),201);const state=await saved(f);await ok(await f.request(c.path+'/acceptance','POST',{expectedRevision:state.revision,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}));await error(await submit(f,c,'stale'),409,'FORM_VERSION_CHANGED');const latest=await ok(await f.request(c.respond,'GET',undefined,'member'));assert.equal(latest.title,'New draft');assert.equal(latest.version,2);
  const source=JSON.parse((await saved(f)).payload.pages.at(-1).document.blocks[0].data.text);assert.equal(source.formTitle,'Review form');assert.equal(source.questions[0].label,'Question text');
});

test('stopped admission rejects receipt replay and revoked publisher or membership generation closes admission',async t=>{
  const f=fixture(t),c=await setup(f);await ok(await submit(f,c,'old'),201);let state=await saved(f);await ok(await f.request(c.path+'/acceptance','POST',{expectedRevision:state.revision,accepting:false}));await error(await submit(f,c,'old'),404,'CONTENT_NOT_FOUND');
  state=await saved(f);await ok(await f.request(c.path+'/acceptance','POST',{expectedRevision:state.revision,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}));f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('owner');await error(await f.request(c.respond,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');await error(await submit(f,c,'new',undefined,'member',2),404,'CONTENT_NOT_FOUND');
  f.db.prepare('UPDATE yumunio_users SET emailVerified=1 WHERE id=?').run('owner');f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('replacement-owner','membership-owner');await error(await f.request(c.respond,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');assert.equal((await saved(f)).payload.formReceipts.length,1);
});

test('fresh SQL actor and publisher guards stop revocation races without creating a response or leaking metadata',async t=>{
  for(const target of ['owner','member']){const f=fixture(t),c=await setup(f);f.setBeforeWrite(()=>{f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run(target);f.setBeforeWrite(null);});await error(await submit(f,c,'raced'),404,'CONTENT_NOT_FOUND');const state=await f.raw.read(workspaceId,target==='owner'?'member':'owner');assert.equal(state.revision,3);assert.equal(state.payload.collections[0].collection.records.length,0);}
});

test('aggregate ACL revocation during submission CAS is rechecked, while harmless actor role changes retry with current role',async t=>{
  const f=fixture(t),c=await setup(f);f.setBeforeWrite(async()=>{f.setBeforeWrite(null);const current=await saved(f),payload=structuredClone(current.payload);payload.grants.find(grant=>grant.pageId===c.pageId).status='revoked';await f.raw.write(workspaceId,'owner',{expectedRevision:current.revision,payload,actorMembershipId:'membership-owner',actorRole:'owner',guardMemberships:[]});});await error(await submit(f,c,'revoked'),404,'CONTENT_NOT_FOUND');assert.equal((await saved(f)).payload.formReceipts?.length??0,0);
  const g=fixture(t),d=await setup(g);g.setBeforeWrite(()=>{g.setBeforeWrite(null);g.db.prepare('UPDATE yumunio_memberships SET role=? WHERE id=?').run('guest','membership-member');});await ok(await submit(g,d,'same-generation'),201);assert.equal((await saved(g)).payload.formReceipts.length,1);
});

test('conditional required typed questions reject hidden injection, unknown values and implicit coercion atomically',async t=>{
  const f=fixture(t),props=[property('reason'),property('choice','select',{options:['Yes','No']}),property('count','number'),property('when','date'),property('tags','multi_select',{options:['A','B']}),property('check','checkbox')];
  const fields=[question('choice','choice',{required:true}),question('reason','reason',{required:true,condition:{fieldId:'choice',value:'Yes'}}),question('count'),question('when'),question('tags'),question('check')],c=await setup(f,props,definition(fields));
  const writes=f.writes;
  for(const [answers,code]of [[{choice:'Yes'},'FORM_REQUIRED_ANSWER'],[{choice:'No',reason:'injected'},'FORM_HIDDEN_ANSWER'],[{choice:'No',unknown:'x'},'INVALID_FORM'],[{choice:'No',count:'12'},'INVALID_CONTENT'],[{choice:'No',when:'2026-02-30'},'INVALID_CONTENT'],[{choice:'No',tags:['A','A']},'INVALID_CONTENT']])await error(await submit(f,c,'invalid',answers),400,code);
  assert.equal(f.writes,writes);await ok(await submit(f,c,'valid',{choice:'No',count:0,when:'2026-10-15',tags:['B'],check:false}),201);const values=(await saved(f)).payload.collections[0].collection.records[0].values;assert.deepEqual(values,{reason:null,choice:'No',count:0,when:'2026-10-15',tags:['B'],check:false});
});

test('required native columns and empty required choice options cannot be omitted from acceptance',async t=>{
  for(const props of [[property('text'),property('required','person',{required:true})],[property('text'),property('required','text',{required:true})]]){const f=fixture(t),c=await ok(await f.request('/collections','POST',{expectedRevision:0,title:'Required',parentId:null,properties:props}),201),form=await ok(await f.request('/collections/'+c.collectionId+'/forms','POST',{expectedRevision:1,definition:definition()}),201);await error(await f.request('/collections/'+c.collectionId+'/forms/'+form.formId+'/acceptance','POST',{expectedRevision:2,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}),409,'FORM_REQUIRED_PROPERTY');assert.equal((await saved(f)).revision,2);}
  const f=fixture(t),c=await setup(f,[property('text'),property('choice','select')],definition([question('text'),question('choice')]));assert.deepEqual((await ok(await f.request(c.respond,'GET',undefined,'member'))).fields[1].options,[]);
  await ok(await f.request(c.path,'PATCH',{expectedRevision:3,definition:definition([question('choice','choice',{required:true})])}));await error(await f.request(c.path+'/acceptance','POST',{expectedRevision:4,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}),409,'FORM_REQUIRED_PROPERTY');
});

test('changing collection schema closes old admission instead of silently changing questions',async t=>{
  const f=fixture(t),c=await setup(f);await ok(await f.request('/collections/'+c.collectionId,'PATCH',{expectedRevision:3,properties:[{id:'text',name:'Renamed column',type:'text'}]}));await error(await f.request(c.respond,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');const management=await ok(await f.request(c.path));assert.equal(management.form.accepting,false);assert.equal(management.form.needsRepublish,true);await ok(await f.request(c.path+'/acceptance','POST',{expectedRevision:4,accepting:true,confirmManagerAccess:true,respondentAccountIds:['member']}));assert.equal((await ok(await f.request(c.respond,'GET',undefined,'member'))).version,2);
});

test('persistent successful-submission rate limits survive API recreation and exact retries do not consume capacity',async t=>{
  const f=fixture(t),c=await setup(f);for(let i=0;i<5;i++)await ok(await submit(f,c,'rate-'+i),201);const writes=f.writes;await ok(await submit(f,c,'rate-0'));await error(await submit(f,c,'rate-5'),429,'FORM_RATE_LIMITED');assert.equal(f.writes,writes);assert.equal((await createSqliteContentStore(f.db).read(workspaceId,'owner')).payload.formReceipts.length,5);f.setTime('2026-10-15T00:01:00.001Z');await ok(await submit(f,c,'rate-5'),201);assert.equal((await saved(f)).payload.formReceipts.length,6);
});

test('forms guard origin, session and expected actor before reads; bound request size and recipient generations',async t=>{
  const f=fixture(t);await error(await f.request('/forms/hidden','GET',undefined,'member',{'X-Yumunio-Expected-Account':'owner'}),404,'CONTENT_NOT_FOUND');assert.equal(f.reads,0);await error(await f.request('/forms/hidden','POST',{},'member',{Origin:'https://wrong.example'}),403,'ORIGIN_REJECTED');assert.equal(f.reads,0);await error(await f.request('/forms/hidden','GET',undefined,null),401,'UNAUTHORIZED');assert.equal(f.reads,0);
  const c=await setup(f),writes=f.writes;await error(await submit(f,c,'huge',{text:'x'.repeat(64000)}),413,'FORM_TOO_LARGE');assert.equal(f.writes,writes);
  f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('replacement-member','membership-member');await error(await f.request(c.respond,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');await error(await submit(f,c,'after-rejoin'),404,'CONTENT_NOT_FOUND');assert.equal((await saved(f)).revision,3);
});
