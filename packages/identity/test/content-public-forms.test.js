import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';

const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const origin='https://public-forms.example',workspaceId='workspace-a',secret='synthetic-public-forms-secret-over-thirty-two-bytes',stamp='2026-10-16T00:00:00.000Z';
const fields=[{id:'question',propertyId:'answer',label:'Your feedback',description:'Public question',required:true,condition:null}];
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
 for(const id of ['owner','member'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,'Name '+id,id+'@example.invalid',stamp,stamp);
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(workspaceId,'Private workspace','private-workspace',stamp);
 for(const id of ['owner','member'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,id,stamp);
 const raw=createSqliteContentStore(db);let beforeWrite=null,time=stamp,sessions=0,api;
 const store={read:(...args)=>raw.read(...args),readPublication:(...args)=>raw.readPublication(...args),async write(...args){if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
 const recreate=()=>api=createAccountContentApi({store,origin,publicationSecret:secret,now:()=>time,resolveSession:async request=>{sessions++;const id=request.headers.get('x-fixture-account');return id?{user:{id,emailVerified:true}}:null;}});recreate();
 const request=(path,method='GET',body,account='owner',extra={})=>api(new Request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(account?{'x-fixture-account':account,'X-Yumunio-Expected-Account':account}:{}),...extra},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
 return{db,raw,request,recreate,get sessions(){return sessions;},setTime:value=>time=value,setBeforeWrite:fn=>beforeWrite=fn};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());const value=await response.json();assert.deepEqual(Object.keys(value),['error']);assert.equal(value.error.code,code);}
const base='/api/content/workspaces/'+workspaceId;
async function setup(f){const collection=await ok(await f.request(base+'/collections','POST',{expectedRevision:0,title:'Private answers',parentId:null,properties:[{id:'answer',name:'Private column name',type:'text',required:true}]}),201),path=base+'/collections/'+collection.collectionId+'/forms';const form=await ok(await f.request(path,'POST',{expectedRevision:1,definition:{title:'Feedback',description:'Public invitation',fields}}),201);return{...collection,...form,path:path+'/'+form.formId};}
async function publish(f,c,revision=2){await ok(await f.request(c.path+'/acceptance','POST',{expectedRevision:revision,accepting:true,audience:'anonymous',confirmManagerAccess:true,confirmPublicExposure:true}));const status=(await ok(await f.request(c.path))).form;assert.equal(status.audience,'anonymous');assert.equal(status.accepting,true);return'/api/public/forms/'+new URL(status.publicPath,origin).searchParams.get('public');}
const submission=(answer='Synthetic answer',requestId=crypto.randomUUID(),version=1)=>({requestId,version,answers:{question:answer}});

test('anonymous publication requires explicit exposure consent, has no session dependence and grants no respondent read',async t=>{
 const f=fixture(t),c=await setup(f);await error(await f.request(c.path+'/acceptance','POST',{expectedRevision:2,accepting:true,audience:'anonymous',confirmManagerAccess:true}),400,'FORM_ACCEPTANCE_CONSENT');
 const path=await publish(f,c),before=f.sessions,form=await ok(await f.request(path,'GET',undefined,null));assert.equal(f.sessions,before);assert.equal(form.id,'public-form');assert.equal(form.accountRequired,false);assert.equal(form.accessToSubmission,'none');assert.equal(form.fields[0].label,'Your feedback');
 for(const privateValue of [workspaceId,c.collectionId,c.pageId,c.formId,'Private column name','membership-owner'])assert.equal(JSON.stringify(form).includes(privateValue),false);
 const body=submission(),accepted=await ok(await f.request(path+'/responses','POST',body,null),201);assert.deepEqual(accepted,{requestId:body.requestId,accepted:true});
 const saved=await f.raw.read(workspaceId,'owner'),receipt=saved.payload.publicFormReceipts[0];assert.equal(saved.payload.formReceipts,undefined);assert.equal(saved.payload.formRateCounters[0].minuteCount,1);assert.equal(saved.payload.collections[0].collection.records.length,1);
 const response=saved.payload.pages.find(row=>row.page.id===receipt.pageId);assert.equal(response.inheritPermissions,false);assert.deepEqual(JSON.parse(response.document.blocks[0].data.text).questions,[{label:'Your feedback',value:'Synthetic answer'}]);
 await error(await f.request(base+'/pages/'+receipt.pageId,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');await error(await f.request(base+'/pages/'+receipt.pageId,'GET',undefined,null),401,'UNAUTHORIZED');assert.deepEqual(saved.payload.grants.filter(row=>row.pageId===receipt.pageId).map(row=>row.accountId),['owner']);
});

test('malformed and invalid answers consume durable bounded counters, exact successful retries do not and windows survive recreation',async t=>{
 const f=fixture(t),c=await setup(f),path=await publish(f,c);await error(await f.request(path+'/responses','POST','{',null),400,'INVALID_FORM');
 for(let i=1;i<20;i++)await error(await f.request(path+'/responses','POST',{...submission(),answers:{}},null),400,'FORM_REQUIRED_ANSWER');
 f.recreate();await error(await f.request(path+'/responses','POST',submission(),null),429,'FORM_RATE_LIMITED');let saved=await f.raw.read(workspaceId,'owner');assert.equal(saved.payload.publicFormReceipts,undefined);assert.deepEqual(saved.payload.formRateCounters[0],{formId:c.formId,minuteStart:Date.parse(stamp),hourStart:Date.parse(stamp),minuteCount:20,hourCount:20});assert.equal(saved.revision,23);
 f.setTime('2026-10-16T00:01:00.001Z');const body=submission();await ok(await f.request(path+'/responses','POST',body,null),201);saved=await f.raw.read(workspaceId,'owner');await ok(await f.request(path+'/responses','POST',body,null));assert.equal((await f.raw.read(workspaceId,'owner')).revision,saved.revision);assert.equal(saved.payload.formRateCounters[0].minuteCount,1);assert.equal(saved.payload.formRateCounters[0].hourCount,21);
});

test('concurrent and unknown-result retries create one private response; conflicting reuse is rejected',async t=>{
 const f=fixture(t),c=await setup(f),path=await publish(f,c),body=submission();const responses=await Promise.all([f.request(path+'/responses','POST',body,null),f.request(path+'/responses','POST',body,null)]);assert.deepEqual(responses.map(row=>row.status).sort(),[200,201]);for(const response of responses)assert.deepEqual(await response.json(),{requestId:body.requestId,accepted:true});
 await error(await f.request(path+'/responses','POST',{...body,answers:{question:'Different answer'}},null),409,'FORM_SUBMISSION_CONFLICT');let saved=await f.raw.read(workspaceId,'owner');assert.equal(saved.payload.publicFormReceipts.length,1);assert.equal(saved.payload.formRateCounters[0].minuteCount,2);
 let failOnce=true;f.setBeforeWrite(async(...args)=>{if(!failOnce)return;failOnce=false;f.setBeforeWrite(null);await f.raw.write(...args);throw Error('Synthetic lost ACK');});const unknown=submission('Unknown result');await error(await f.request(path+'/responses','POST',unknown,null),503,'FORM_UNAVAILABLE');await ok(await f.request(path+'/responses','POST',unknown,null));saved=await f.raw.read(workspaceId,'owner');assert.equal(saved.payload.publicFormReceipts.length,2);assert.equal(saved.payload.collections[0].collection.records.length,2);
});

test('current schema, rotated links, closing and manager membership generations fail closed including old receipts',async t=>{
 const f=fixture(t),c=await setup(f),path=await publish(f,c),body=submission();await ok(await f.request(path+'/responses','POST',body,null),201);const next=await publish(f,c,4);assert.notEqual(next,path);await error(await f.request(path,'GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');await error(await f.request(path+'/responses','POST',body,null),404,'PUBLIC_FORM_NOT_FOUND');
 await error(await f.request(next+'/responses','POST',body,null),409,'FORM_VERSION_CHANGED');let saved=await f.raw.read(workspaceId,'owner');await ok(await f.request(base+'/collections/'+c.collectionId,'PATCH',{expectedRevision:saved.revision,properties:[{id:'answer',name:'Changed',type:'text',required:true}]}));await error(await f.request(next,'GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');
 saved=await f.raw.read(workspaceId,'owner');const fresh=await publish(f,c,saved.revision);f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('new-owner-generation','membership-owner');await error(await f.request(fresh,'GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');assert.equal((await f.raw.read(workspaceId,'owner')).payload.publicFormReceipts.length,1);
});

test('manager revocation at the final CAS cannot commit a response or its counter and restoring grants cannot revive the old token',async t=>{
 const f=fixture(t),c=await setup(f),path=await publish(f,c);f.setBeforeWrite(()=>{f.setBeforeWrite(null);f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('owner');});await error(await f.request(path+'/responses','POST',submission(),null),404,'PUBLIC_FORM_NOT_FOUND');f.db.prepare('UPDATE yumunio_users SET emailVerified=1 WHERE id=?').run('owner');let saved=await f.raw.read(workspaceId,'owner');assert.equal(saved.revision,3);assert.equal(saved.payload.formRateCounters,undefined);
 const grant=saved.payload.grants.find(row=>row.pageId===c.pageId&&row.accountId==='owner');saved.payload.grants.find(row=>row.id===grant.id).status='revoked';await f.raw.write(workspaceId,'owner',{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'membership-owner',actorRole:'owner'});await error(await f.request(path,'GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');saved=await f.raw.read(workspaceId,'owner');saved.payload.grants.push({...grant,id:crypto.randomUUID(),status:'active'});saved.payload.grantBindings.push({grantId:saved.payload.grants.at(-1).id,membershipId:'membership-owner'});await f.raw.write(workspaceId,'owner',{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'membership-owner',actorRole:'owner'});await error(await f.request(path,'GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');
});

test('public requests reject cross-origin mutation and changed tokens without reading sessions or creating counters',async t=>{
 const f=fixture(t),c=await setup(f),path=await publish(f,c),sessions=f.sessions;await error(await f.request(path+'/responses','POST',submission(),null,{Origin:'https://foreign.example'}),403,'ORIGIN_REJECTED');await error(await f.request(path+'?q=private','GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');await error(await f.request(path.slice(0,-1)+(path.endsWith('a')?'b':'a'),'GET',undefined,null),404,'PUBLIC_FORM_NOT_FOUND');assert.equal(f.sessions,sessions);assert.equal((await f.raw.read(workspaceId,'owner')).payload.formRateCounters,undefined);
});
test('the durable hourly ceiling is independent of a new minute and a backwards clock cannot erase counters',async t=>{
 const f=fixture(t),c=await setup(f),path=await publish(f,c);await ok(await f.request(path+'/responses','POST',submission(),null),201);const saved=await f.raw.read(workspaceId,'owner');saved.payload.formRateCounters[0].hourCount=200;await f.raw.write(workspaceId,'owner',{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'membership-owner',actorRole:'owner'});
 f.setTime('2026-10-16T00:01:00.001Z');await error(await f.request(path+'/responses','POST',submission(),null),429,'FORM_RATE_LIMITED');assert.equal((await f.raw.read(workspaceId,'owner')).revision,5);
 f.setTime('2026-10-15T23:59:59.000Z');await error(await f.request(path+'/responses','POST',submission(),null),503,'FORM_UNAVAILABLE');assert.equal((await f.raw.read(workspaceId,'owner')).payload.formRateCounters[0].hourCount,200);
 f.setTime('2026-10-16T01:00:00.000Z');await ok(await f.request(path+'/responses','POST',submission(),null),201);assert.equal((await f.raw.read(workspaceId,'owner')).payload.formRateCounters[0].hourCount,1);
});
