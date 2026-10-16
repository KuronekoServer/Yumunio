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


test('saved Feed uses ACL-projected filtered/sorted records, computed values and persistent config with CAS',async t=>{
 const f=fixture(t),props=[property('status','select',{options:['New','Done']}),property('amount','number'),property('double','formula',{formula:{version:1,expression:'field("amount") * 2',resultType:'number'}})],c=await create(f,props),low=await row(f,c,1,'Low',{status:'New',amount:2}),high=await row(f,c,2,'<b>High</b>',{status:'New',amount:8}),hidden=await row(f,c,3,'Private row',{status:'Done',amount:999});
 const config=view('feed',{filters:[{propertyId:'status',operator:'eq',value:'New'}],sorts:[{propertyId:'double',direction:'desc'}]}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:4,view:config}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId;
 let result=await ok(await f.request(path));assert.deepEqual(result.collection.records.map(record=>[record.title,record.values.double]),[['<b>High</b>',16],['Low',4]]);assert.equal(Object.hasOwn(result,'groups'),false);assert.equal(Object.hasOwn(result,'chart'),false);
 await grant(f,c.pageId,'member','viewer',5);await grant(f,low.record.pageId,'member','viewer',6);result=await ok(await f.request(path,'GET',undefined,'member'));assert.deepEqual(result.collection.records.map(({id,pageId,title,values})=>({id,pageId,title,values})),[{id:low.record.id,pageId:low.record.pageId,title:'Low',values:{status:'New',amount:2,double:4}}]);assertNoPrivateJsonLiterals(result,[high.record.id,high.record.pageId,hidden.record.id,hidden.record.pageId,'<b>High</b>','Private row',999,'999',1998,'1998']);
 const persisted=await createSqliteContentStore(f.db).read(workspaceId,'owner');assert.equal(persisted.payload.collections[0].views[0].type,'feed');assert.deepEqual(persisted.payload.collections[0].views[0].sorts,config.sorts);await error(await f.request(path,'PATCH',{expectedRevision:5,view:{...config,name:'Retained draft'}}),409,'CONTENT_CONFLICT');await error(await f.request(path,'PATCH',{expectedRevision:7,view:config},'member'),404,'CONTENT_NOT_FOUND');assert.equal((await get(f,c)).revision,7);
});
test('Feed rejects irrelevant grouping/dates/chart metadata without writing',async t=>{
 const f=fixture(t),c=await create(f,[property('text'),property('date','date')]),before=f.writes;
 for(const config of [view('feed',{groupBy:'text'}),view('feed',{datePropertyId:'date'}),view('feed',{endDatePropertyId:'date'}),view('feed',{chart:{type:'bar',aggregation:'count',valuePropertyId:null}})])await error(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:1,view:config}),400,'INVALID_CONTENT');assert.equal(f.writes,before);
});
test('Feed never exposes hidden person references and revocation or membership generation changes apply on the next GET',async t=>{
 const f=fixture(t),c=await create(f,[property('person','person'),property('amount','number'),property('ratio','formula',{formula:{version:1,expression:'1 / field("amount")',resultType:'number'}})]),a=await row(f,c,1,'Readable',{person:'person',amount:0}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:2,view:view('feed')}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId;
 await grant(f,c.pageId,'member','viewer',3);await grant(f,a.record.pageId,'member','viewer',4);f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('person');let result=await ok(await f.request(path,'GET',undefined,'member'));assert.equal(result.collection.records[0].values.person,null);assert.ok(result.collection.records[0].redactedProperties.includes('person'));assert.deepEqual(result.collection.records[0].formulaErrors,{ratio:{code:'FORMULA_DIVISION_BY_ZERO'}});assert.equal(Object.hasOwn(result.collection.records[0],'document'),false);
 f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('new-member-generation','member');await error(await f.request(path,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');
});
