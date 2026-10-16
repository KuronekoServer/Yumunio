import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {assertNoPrivateJsonLiterals} from './fixtures/assert-private-projection.js';
const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const origin='https://collections.example',workspaceId='workspace-a',stamp='2026-10-15T00:00:00.000Z';
const property=(id,type='text',extra={})=>({id,name:id,type,...extra});
const view=(type='table',extra={})=>({name:type,type,filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null,...extra});
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  for(const id of ['owner','member','person','guest'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,'Name '+id,id+'@example.invalid',stamp,stamp);
  for(const id of [workspaceId,'foreign'])db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(id,id,id,stamp);
  for(const id of ['owner','member','person','guest'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,id==='person'?'member':id,stamp);
  db.exec("CREATE TABLE prototype_sentinel(value TEXT);INSERT INTO prototype_sentinel VALUES('legacy unchanged')");
  const raw=createSqliteContentStore(db);let beforeWrite=null,reads=0,writes=0,sequence=0;
  const store={async read(...args){reads++;return raw.read(...args);},async write(...args){writes++;if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
  const api=createAccountContentApi({store,origin,roomSecret:'collections-test-room-secret-not-real-12345678',now:()=>stamp,createId:()=> 'generated-'+ ++sequence,resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}})});
  const request=(path='',method='GET',body,accountId='owner',headers={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{Origin:origin,'Content-Type':'application/json','x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return{db,raw,request,get writes(){return writes;},get reads(){return reads;},setBeforeWrite(fn){beforeWrite=fn;}};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());const result=await response.json();assert.equal(result.error.code,code);assert.deepEqual(Object.keys(result),['error']);assert.doesNotMatch(JSON.stringify(result),/membership-|payload_json|sourceValues|Private raw/);return result;}
async function create(f,properties=[],extra={}){return ok(await f.request('/collections','POST',{expectedRevision:0,title:'Independent collection',parentId:null,properties,...extra}),201);}
async function row(f,c,expectedRevision,title,values={}){return ok(await f.request('/collections/'+c.collectionId+'/records','POST',{expectedRevision,title,values}),201);}
async function get(f,c,account='owner'){return ok(await f.request('/collections/'+c.collectionId,'GET',undefined,account));}
async function grant(f,pageId,accountId,permission,expectedRevision,includeDescendants=false){return ok(await f.request('/pages/'+pageId+'/grants','POST',{expectedRevision,accountId,permission}));}


test('saved charts aggregate projected rows only, persist across new stores and retain schema/CAS boundaries',async t=>{
 const f=fixture(t),props=[property('status','select',{options:['New','Done']}),property('amount','number')],c=await create(f,props),a=await row(f,c,1,'Visible',{status:'New',amount:4}),hidden=await row(f,c,2,'Private row',{status:'Done',amount:999});
 const config=view('chart',{groupBy:'status',chart:{type:'bar',aggregation:'sum',valuePropertyId:'amount'}}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:3,view:config}),201);
 await grant(f,c.pageId,'member','viewer',4);await grant(f,a.record.pageId,'member','viewer',5);
 const path='/collections/'+c.collectionId+'/views/'+v.viewId,visible=await ok(await f.request(path,'GET',undefined,'member'));assert.equal(Object.hasOwn(visible,'groups'),false);assert.deepEqual(visible.chart,{status:'available',groups:[{value:'New',count:1,numericCount:1,result:4}]});assert.deepEqual(visible.collection.records.map(({id,pageId,title,values})=>({id,pageId,title,values})),[{id:a.record.id,pageId:a.record.pageId,title:'Visible',values:{status:'New',amount:4}}]);assertNoPrivateJsonLiterals(visible,[hidden.record.id,hidden.record.pageId,'Private row',999,'999']);
 const persisted=await createSqliteContentStore(f.db).read(workspaceId,'owner');assert.deepEqual(persisted.payload.collections[0].views[0].chart,config.chart);
 await error(await f.request('/collections/'+c.collectionId,'PATCH',{expectedRevision:6,properties:[props[0]],confirmPropertyDeletion:['amount']}),409,'COLLECTION_VIEW_DEPENDENCY');
 const concurrent=await Promise.all(['bar','donut'].map(type=>f.request(path,'PATCH',{expectedRevision:6,view:{...config,chart:{...config.chart,type}}})));assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);for(const response of concurrent)await response.arrayBuffer();assert.equal((await get(f,c)).revision,7);
 await error(await f.request(path,'PATCH',{expectedRevision:7,view:config},'member'),404,'CONTENT_NOT_FOUND');
});
test('a calculation error cannot be hidden by a chart filter and hidden rows cannot cause false unavailability',async t=>{
 const f=fixture(t),props=[property('status'),property('amount','number'),property('ratio','formula',{formula:{version:1,expression:'10 / field("amount")',resultType:'number'}})],c=await create(f,props),a=await row(f,c,1,'Readable',{status:'A',amount:2}),bad=await row(f,c,2,'Errored',{status:'B',amount:0});
 const config=view('chart',{groupBy:'status',filters:[{propertyId:'ratio',operator:'gt',value:0}],chart:{type:'bar',aggregation:'sum',valuePropertyId:'ratio'}}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:3,view:config}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId;
 const owner=await ok(await f.request(path));assert.deepEqual(owner.chart,{status:'unavailable',reason:'CHART_INPUT_UNAVAILABLE'});assert.equal(owner.collection.records.length,1);assert.equal(Object.hasOwn(owner,'groups'),false);
 await grant(f,c.pageId,'member','viewer',4);await grant(f,a.record.pageId,'member','viewer',5);const member=await ok(await f.request(path,'GET',undefined,'member'));assert.equal(member.chart.groups[0].result,5);assert.doesNotMatch(JSON.stringify(member),new RegExp(bad.record.id));
});
test('invalid chart config performs no write and cannot be smuggled onto a nonchart view',async t=>{
 const f=fixture(t),c=await create(f,[property('status'),property('amount','number')]),before=f.writes;
 for(const config of [view('chart'),view('chart',{groupBy:'amount',chart:{type:'bar',aggregation:'count',valuePropertyId:null}}),view('chart',{groupBy:'status',chart:{type:'donut',aggregation:'sum',valuePropertyId:'missing'}}),view('table',{chart:{type:'bar',aggregation:'count',valuePropertyId:null}})])await error(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:1,view:config}),400,'INVALID_CONTENT');assert.equal(f.writes,before);
});
