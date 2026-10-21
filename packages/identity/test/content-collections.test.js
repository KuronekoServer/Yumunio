import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi,validateContentPayload} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
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
  const api=createAccountContentApi({store,origin,instanceEnvironment:{YUMUNIO_BRAND_NAME:'Example workspace',YUMUNIO_AUTH_SECRET:'synthetic-instance-private-secret'},roomSecret:'collections-test-room-secret-not-real-12345678',now:()=>stamp,createId:()=> 'generated-'+ ++sequence,resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account'),emailVerified:true}})});
  const request=(path='',method='GET',body,accountId='owner',headers={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{Origin:origin,'Content-Type':'application/json','x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return{db,raw,request,get writes(){return writes;},get reads(){return reads;},setBeforeWrite(fn){beforeWrite=fn;}};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());const result=await response.json();assert.equal(result.error.code,code);assert.deepEqual(Object.keys(result),['error']);assert.doesNotMatch(JSON.stringify(result),/membership-|payload_json|sourceValues|Private raw/);return result;}
async function create(f,properties=[],extra={}){return ok(await f.request('/collections','POST',{expectedRevision:0,title:'Independent collection',parentId:null,properties,...extra}),201);}
async function row(f,c,expectedRevision,title,values={}){return ok(await f.request('/collections/'+c.collectionId+'/records','POST',{expectedRevision,title,values}),201);}
async function get(f,c,account='owner'){return ok(await f.request('/collections/'+c.collectionId,'GET',undefined,account));}
async function grant(f,pageId,accountId,permission,expectedRevision,includeDescendants=false){return ok(await f.request('/pages/'+pageId+'/grants','POST',{expectedRevision,accountId,permission}));}

test('bootstrap returns the page, directory and authorized linked views from one content read',async t=>{
 const f=fixture(t),c=await create(f,[property('status','status',{options:['Todo','Done']}),property('person','person')]);
 const row=await ok(await f.request('/collections/'+c.collectionId+'/records','POST',{expectedRevision:c.revision,title:'Only authorized tasks',values:{status:'Todo',person:'owner'}}),201);
 const block={id:'placed',type:'database',data:{format:'collection-view-v1',collectionId:c.collectionId,view:view(),visiblePropertyIds:null}};
 const page=await ok(await f.request('/pages','POST',{expectedRevision:row.revision,title:'Project context',blocks:[{id:'description',type:'paragraph',data:{text:'Project description'}},block]}),201);
 const reads=f.reads,boot=await ok(await f.request('/bootstrap?page='+page.page.id));assert.equal(f.reads,reads+1);
 assert.equal(boot.user.id,'owner');assert.equal(boot.page.revision,boot.directory.revision);assert.equal(boot.page.context.placements.placed.revision,boot.page.revision);assert.equal(boot.page.context.placements.placed.collection.records[0].title,'Only authorized tasks');assert.equal(boot.page.context.placements.placed.collection.records[0].values.status,'Todo');
 assert.deepEqual(boot.page.context.placements.placed.people.map(person=>person.accountId),['owner']);assert.ok(Array.isArray(boot.directory.teamspaces));
 const {validateCollectionEnvelope}=await import('../../../apps/web/public/collections-model.js');
 const {validateInstanceConfig}=await import('../../../apps/web/public/instance.js');assert.equal(validateInstanceConfig(boot.instance).applicationName,'Example workspace');assert.doesNotMatch(JSON.stringify(boot),/synthetic-instance-private-secret|YUMUNIO_AUTH_SECRET/);
 assert.equal(validateCollectionEnvelope(boot.page.context.placements.placed,{workspaceId,collectionId:c.collectionId}).view.id,'placement');
 const record=await ok(await f.request('/pages/'+row.record.pageId+'?context=1'));assert.equal(record.context.collection.revision,record.revision);assert.equal(record.context.collection.collection.records[0].values.person,'owner');
 const beforeComments=f.reads,comments=await ok(await f.request('/bootstrap?section=comments&page='+page.page.id));assert.equal(f.reads,beforeComments+1);assert.equal(comments.page.page.id,page.page.id);assert.equal(comments.inbox.revision,comments.page.revision);assert.equal(comments.comments.revision,comments.page.revision);assert.equal(comments.people.pageId,page.page.id);assert.equal(Object.hasOwn(comments.page,'context'),false);
 const backlinks=await ok(await f.request('/bootstrap?section=backlinks&page='+page.page.id));assert.equal(backlinks.backlinks.page.id,page.page.id);assert.equal(Object.hasOwn(backlinks,'directory'),false);assert.equal(Object.hasOwn(backlinks,'page'),false);
 const missing=await ok(await f.request('/bootstrap?page=missing'));assert.equal(missing.page,null);assert.deepEqual(missing.pageError,{status:404,code:'CONTENT_NOT_FOUND'});
 await error(await f.request('/bootstrap?page='+page.page.id,'GET',undefined,'member',{'X-Yumunio-Expected-Account':'owner'}),404,'CONTENT_NOT_FOUND');
 for(const query of ['?page='+page.page.id+'&page=other','?view=unknown','?unknown=1'])await error(await f.request('/bootstrap'+query),400,'INVALID_CONTENT');
});

test('a readable destination never exposes a private database or people through context or bootstrap',async t=>{
 const f=fixture(t),c=await create(f,[property('person','person')]);
 const row=await ok(await f.request('/collections/'+c.collectionId+'/records','POST',{expectedRevision:c.revision,title:'Hidden source task',values:{person:'owner'}}),201);
 const page=await ok(await f.request('/pages','POST',{expectedRevision:row.revision,title:'Shared destination',blocks:[{id:'placed',type:'database',data:{format:'collection-view-v1',collectionId:c.collectionId,view:view(),visiblePropertyIds:null}}]}),201);
 const shared=await grant(f,page.page.id,'member','viewer',page.revision);
 const boot=await ok(await f.request('/bootstrap?page='+page.page.id,'GET',undefined,'member'));
 assert.deepEqual(boot.page.context.placements.placed,{error:{status:404,code:'CONTENT_NOT_FOUND'}});assert.equal(boot.page.context.collection,null);assert.doesNotMatch(JSON.stringify(boot),/Hidden source task|Name owner|Independent collection/);
 const visible=await ok(await f.request('/pages/'+page.page.id+'?context=1','GET',undefined,'member'));assert.equal(visible.context.placements.placed.error.status,404);
 await ok(await f.request('/pages/'+c.pageId+'/grants','POST',{expectedRevision:shared.revision,accountId:'member',permission:'viewer',includeDescendants:true}));
 const authorized=await ok(await f.request('/bootstrap?page='+page.page.id,'GET',undefined,'member'));assert.equal(authorized.page.context.placements.placed.collection.records[0].title,'Hidden source task');
 assert.deepEqual(authorized.page.context.placements.placed.people.map(person=>person.accountId),['member','owner']);
});

test('database templates apply independent bodies and typed defaults atomically and enforce both database and template access',async t=>{
 const f=fixture(t),c=await create(f,[property('state','status',{options:['未着手','進行中','完了']}),property('url','url'),property('created','created_time'),property('edited','last_edited_time')]);let rev=1;
 const body=[{id:'summary',type:'heading',data:{text:'概要',level:2}},{id:'steps',type:'heading',data:{text:'再現手順',level:2}},{id:'done',type:'heading',data:{text:'完了条件',level:2}}],path='/collections/'+c.collectionId;
 const template=await ok(await f.request(path+'/templates','POST',{expectedRevision:rev++,name:'新しい課題',values:{state:'未着手',url:'https://example.invalid/'},blocks:body}),201);
 const list=await get(f,c);assert.equal(list.collection.templates[0].id,template.templateId);assert.equal(list.collection.templates[0].values.state,'未着手');assert.equal(list.collection.templates[0].pageId,template.pageId);
 const page=await ok(await f.request('/pages/'+template.pageId));assert.equal(page.page.templateId,template.templateId);assert.equal(page.page.recordId,undefined);
 const a=await ok(await f.request(path+'/records','POST',{expectedRevision:rev++,title:'課題 A',values:{},templateId:template.templateId}),201),b=await ok(await f.request(path+'/records','POST',{expectedRevision:rev++,title:'課題 B',values:{state:'進行中'},templateId:template.templateId}),201);
 assert.equal(a.record.values.state,'未着手');assert.equal(b.record.values.state,'進行中');assert.equal(a.record.values.created,stamp);assert.equal(a.record.values.edited,stamp);
 const docA=await ok(await f.request('/pages/'+a.record.pageId)),docB=await ok(await f.request('/pages/'+b.record.pageId));assert.deepEqual(docA.document.blocks.map(block=>block.data.text),body.map(block=>block.data.text));assert.notEqual(docA.document.blocks[0].id,body[0].id);assert.notEqual(docA.document.blocks[0].id,docB.document.blocks[0].id);
 await ok(await f.request('/pages/'+template.pageId,'PATCH',{expectedRevision:rev++,expectedVersion:1,blocks:[...body,{id:'new',type:'paragraph',data:{text:'今後だけ反映'}}]}));assert.equal((await ok(await f.request('/pages/'+a.record.pageId))).document.blocks.length,3);
 await error(await f.request(path+'/records/'+a.record.id,'PATCH',{expectedRevision:rev,values:{created:stamp}}),400,'COMPUTED_PROPERTY_READ_ONLY');await error(await f.request(path+'/records','POST',{expectedRevision:rev,title:'bad',values:{url:'javascript:alert(1)'}}),400,'INVALID_CONTENT');
 await grant(f,c.pageId,'member','full',rev++);await grant(f,template.pageId,'member','deny',rev++);const hidden=await get(f,c,'member');assert.deepEqual(hidden.collection.templates,[]);await error(await f.request(path+'/records','POST',{expectedRevision:rev,title:'Cannot use hidden',values:{},templateId:template.templateId},'member'),404,'CONTENT_NOT_FOUND');
 await ok(await f.request(path+'/templates/'+template.templateId,'DELETE',{expectedRevision:rev++}));assert.equal((await get(f,c)).collection.templates,undefined);assert.equal((await ok(await f.request('/pages/'+template.pageId))).page.templateId,undefined);assert.equal((await ok(await f.request('/pages/'+a.record.pageId))).document.blocks.length,3);
});

test('automatic time fields project page times, support typed filtering, and never store caller timestamps',async t=>{
 const f=fixture(t),c=await create(f,[property('state','status',{options:['未着手','進行中','完了']}),property('created','created_time'),property('edited','last_edited_time')]),a=await row(f,c,1,'A',{state:'未着手'}),path='/collections/'+c.collectionId;
 const stored=await f.raw.read(workspaceId,'owner');assert.equal(stored.payload.collections[0].collection.records[0].values.created,null);assert.equal(a.record.values.created,stamp);
 const v=await ok(await f.request(path+'/views','POST',{expectedRevision:2,view:view('table',{filters:[{propertyId:'created',operator:'gte',value:stamp}],sorts:[{propertyId:'edited',direction:'desc'}]})}),201);assert.equal((await ok(await f.request(path+'/views/'+v.viewId))).collection.records.length,1);
 await error(await f.request(path+'/views','POST',{expectedRevision:3,view:view('table',{filters:[{propertyId:'created',operator:'eq',value:'2026-10-15'}]})}),400,'INVALID_CONTENT');
 const board=await ok(await f.request(path+'/views','POST',{expectedRevision:3,view:view('board',{groupBy:'state'})}),201);const moved=await ok(await f.request(path+'/views/'+board.viewId,'PATCH',{expectedRevision:4,boardMove:{recordId:a.record.id,targetValue:'完了',beforeRecordId:null,visibleRecordIds:[a.record.id]}}));assert.equal(moved.record.values.state,'完了');
});

test('inline placements keep independent view configuration and always require source and row access',async t=>{
 const f=fixture(t),c=await create(f,[property('project'),property('priority','number')]);
 const a=await row(f,c,1,'Issue A',{project:'Website',priority:2}),b=await row(f,c,2,'Private issue B',{project:'Other',priority:1});let rev=b.revision;
 const config=view('table',{filters:[{propertyId:'project',operator:'eq',value:'Website'}],sorts:[{propertyId:'priority',direction:'desc'}]}),other=view('gallery',{filters:[{propertyId:'project',operator:'eq',value:'Other'}]});
 const block=(id,view,visible)=>({id,type:'database',data:{format:'collection-view-v1',collectionId:c.collectionId,view,visiblePropertyIds:visible}});
 const page1=await ok(await f.request('/pages','POST',{expectedRevision:rev++,title:'Project explanation',blocks:[{id:'intro',type:'paragraph',data:{text:'Project introduction'}},block('db-one',config,['priority']),{id:'after',type:'heading',data:{text:'Next steps',level:2}}]}),201);
 const page2=await ok(await f.request('/pages','POST',{expectedRevision:rev++,title:'Other project',blocks:[block('db-two',other,[])]}),201);
 await grant(f,page1.page.id,'member','viewer',rev++);
 const shared=await ok(await f.request('/pages/'+page1.page.id,'GET',undefined,'member'));assert.equal(shared.document.blocks[1].type,'database');assert.doesNotMatch(JSON.stringify(shared),/Private issue B|Issue A/);
 const path='/collections/'+c.collectionId+'/query';await error(await f.request(path,'POST',{view:config},'member'),404,'CONTENT_NOT_FOUND');
 await grant(f,c.pageId,'member','viewer',rev++);await grant(f,a.record.pageId,'member','viewer',rev++);await grant(f,b.record.pageId,'member','deny',rev++);
 const writes=f.writes,visible=await ok(await f.request(path,'POST',{view:config},'member'));assert.deepEqual(visible.collection.records.map(row=>row.title),['Issue A']);assert.equal(f.writes,writes);assert.equal(visible.collection.views.length,0);
 assert.deepEqual((await ok(await f.request(path,'POST',{view:other},'member'))).collection.records,[]);
 await ok(await f.request('/collections/'+c.collectionId+'/records/'+a.record.id,'PATCH',{expectedRevision:rev++,values:{project:'Other',priority:9}}));
 assert.equal((await ok(await f.request(path,'POST',{view:config}))).collection.records.length,0);assert.equal((await ok(await f.request(path,'POST',{view:other}))).collection.records.find(row=>row.id===a.record.id).values.priority,9);
 assert.deepEqual((await ok(await f.request('/pages/'+page1.page.id))).document.blocks[1],block('db-one',config,['priority']));assert.deepEqual((await ok(await f.request('/pages/'+page2.page.id))).document.blocks[0],block('db-two',other,[]));
 await grant(f,c.pageId,'member','deny',rev++);await error(await f.request(path,'POST',{view:config},'member'),404,'CONTENT_NOT_FOUND');
});

test('ad hoc database projections reject invalid schemas and do not mutate saved views or revisions',async t=>{
 const f=fixture(t),c=await create(f,[property('project')]),path='/collections/'+c.collectionId+'/query',before=await f.raw.read(workspaceId,'owner');
 for(const config of [view('board'),view('table',{sorts:[{propertyId:'unknown',direction:'asc'}]}),view('table',{filters:[{propertyId:'project',operator:'execute',value:'x'}]}),{...view(),id:'injected'}])await error(await f.request(path,'POST',{view:config}),400,'INVALID_CONTENT');
 await error(await f.request(path,'GET'),405,'METHOD_NOT_ALLOWED');await error(await f.request(path,'POST',{view:view()},'guest'),404,'CONTENT_NOT_FOUND');
 await ok(await f.request(path,'POST',{view:view()}));assert.deepEqual(await f.raw.read(workspaceId,'owner'),before);
});

test('saved board reorders visible rows and crosses groups in one CAS while retaining hidden slots, row identities and view independence',async t=>{
 const f=fixture(t),c=await create(f,[property('status','select',{options:['Todo','Done']}),property('note')]);let rev=1;const rows=[];
 for(const [title,status]of [['A','Todo'],['Hidden','Todo'],['B','Todo'],['C','Done']]){const saved=await row(f,c,rev,title,{status,note:'original '+title});rev=saved.revision;rows.push(saved.record);}
 const config=view('board',{groupBy:'status'}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:rev++,view:config}),201),v2=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:rev++,view:config}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId;
 await grant(f,c.pageId,'member','full',rev++);for(const row of [rows[0],rows[2],rows[3]])await grant(f,row.pageId,'member','full',rev++);
 const visible=[rows[0].id,rows[2].id,rows[3].id],before=await f.raw.read(workspaceId,'owner'),changed=await ok(await f.request(path,'PATCH',{expectedRevision:rev,boardMove:{recordId:rows[2].id,targetValue:'Todo',beforeRecordId:rows[0].id,visibleRecordIds:visible}},'member'));rev++;
 assert.equal(changed.revision,rev);assert.equal(changed.viewId,v.viewId);assert.deepEqual(changed.boardOrder.recordIds,[rows[2].id,rows[0].id,rows[3].id]);assert.equal(changed.record.pageId,rows[2].pageId);assert.equal(changed.record.values.note,'original B');assert.deepEqual(changed.record.sourceValues,rows[2].sourceValues);
 let stored=await f.raw.read(workspaceId,'owner');assert.deepEqual(stored.payload.collections[0].views[0].boardOrder.recordIds,[rows[2].id,rows[1].id,rows[0].id,rows[3].id]);assert.equal(stored.payload.pages.find(item=>item.page.id===rows[2].pageId).document.version,before.payload.pages.find(item=>item.page.id===rows[2].pageId).document.version);
 const loaded=await ok(await f.request(path,'GET',undefined,'member'));assert.deepEqual(loaded.collection.records.map(row=>row.id),[rows[2].id,rows[0].id,rows[3].id]);assert.doesNotMatch(JSON.stringify(loaded),new RegExp(rows[1].id));assert.deepEqual((await ok(await f.request('/collections/'+c.collectionId+'/views/'+v2.viewId))).collection.records.map(row=>row.id),rows.map(row=>row.id));
 const cross=await ok(await f.request(path,'PATCH',{expectedRevision:rev,boardMove:{recordId:rows[2].id,targetValue:'Done',beforeRecordId:rows[3].id,visibleRecordIds:loaded.collection.records.map(row=>row.id)}},'member'));rev++;assert.equal(cross.record.values.status,'Done');assert.deepEqual(cross.boardOrder.recordIds,[rows[0].id,rows[2].id,rows[3].id]);
 await ok(await f.request(path,'PATCH',{expectedRevision:rev++,view:{...config,name:'Renamed board'}}));stored=await f.raw.read(workspaceId,'owner');assert.deepEqual(stored.payload.collections[0].views[0].boardOrder.recordIds,[rows[0].id,rows[1].id,rows[2].id,rows[3].id]);
 const exported=await ok(await f.request('/export?format=json','GET',undefined,'member'));assert.doesNotMatch(JSON.stringify(exported.collections),new RegExp(rows[1].id));
});

test('board moves reject stale visible reviews, sorted views, hidden anchors, injected metadata and lost actor generations without partial writes',async t=>{
 const f=fixture(t),c=await create(f,[property('group','number')]),a=await row(f,c,1,'A',{group:0}),b=await row(f,c,2,'B',{group:1}),config=view('board',{groupBy:'group'}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:3,view:config}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId,move={recordId:b.record.id,targetValue:0,beforeRecordId:a.record.id,visibleRecordIds:[a.record.id,b.record.id]};
 const baseline=await f.raw.read(workspaceId,'owner');
 for(const [change,status,code]of [[{visibleRecordIds:[b.record.id,a.record.id]},409,'CONTENT_CONFLICT'],[{beforeRecordId:'hidden'},400,'INVALID_BOARD_ORDER'],[{targetValue:'0'},400,'INVALID_CONTENT'],[{targetValue:false},400,'INVALID_CONTENT']]){await error(await f.request(path,'PATCH',{expectedRevision:4,boardMove:{...move,...change}}),status,code);assert.deepEqual(await f.raw.read(workspaceId,'owner'),baseline);}
 await error(await f.request(path,'PATCH',{expectedRevision:4,view:{...config,boardOrder:{recordIds:[b.record.id,a.record.id]}}}),400,'INVALID_CONTENT');
 await ok(await f.request(path,'PATCH',{expectedRevision:4,view:{...config,sorts:[{propertyId:'group',direction:'asc'}]}}));await error(await f.request(path,'PATCH',{expectedRevision:5,boardMove:move}),409,'BOARD_SORTED');await ok(await f.request(path,'PATCH',{expectedRevision:5,view:config}));
 const concurrent=await Promise.all([f.request(path,'PATCH',{expectedRevision:6,boardMove:move}),f.request(path,'PATCH',{expectedRevision:6,boardMove:move})]);assert.deepEqual(concurrent.map(value=>value.status).sort(),[200,409]);for(const value of concurrent)await value.arrayBuffer();
 const saved=await f.raw.read(workspaceId,'owner');f.setBeforeWrite(()=>{f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('new-owner-generation','membership-owner');f.setBeforeWrite(null);});
 await error(await f.request(path,'PATCH',{expectedRevision:7,boardMove:{recordId:a.record.id,targetValue:0,beforeRecordId:b.record.id,visibleRecordIds:[b.record.id,a.record.id]}}),404,'CONTENT_NOT_FOUND');assert.equal((await f.raw.read(workspaceId,'owner')).revision,saved.revision);
});

test('filtered boards retain excluded slots and remove newly filtered rows from projected order without changing other views',async t=>{
 const f=fixture(t),c=await create(f,[property('status','select',{options:['Todo','Done']})]),rows=[];let rev=1;
 for(const [title,status]of [['A','Todo'],['Filtered','Done'],['B','Todo']])rows.push((await row(f,c,rev++,title,{status})).record);
 const config=view('board',{groupBy:'status',filters:[{propertyId:'status',operator:'eq',value:'Todo'}]}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:rev++,view:config}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId;
 const saved=await ok(await f.request(path,'PATCH',{expectedRevision:rev++,boardMove:{recordId:rows[2].id,targetValue:'Todo',beforeRecordId:rows[0].id,visibleRecordIds:[rows[0].id,rows[2].id]}}));assert.deepEqual(saved.boardOrder.recordIds,[rows[2].id,rows[0].id]);
 assert.deepEqual((await f.raw.read(workspaceId,'owner')).payload.collections[0].views[0].boardOrder.recordIds,[rows[2].id,rows[1].id,rows[0].id]);
 await ok(await f.request(path,'PATCH',{expectedRevision:rev++,boardMove:{recordId:rows[2].id,targetValue:'Done',beforeRecordId:null,visibleRecordIds:[rows[2].id,rows[0].id]}}));const filtered=await ok(await f.request(path));assert.deepEqual(filtered.collection.records.map(row=>row.id),[rows[0].id]);assert.deepEqual(filtered.view.boardOrder.recordIds,[rows[0].id]);
 const views=await ok(await f.request('/collections/'+c.collectionId+'/views'));assert.deepEqual(views.views[0].boardOrder.recordIds,[rows[0].id]);await ok(await f.request(path,'PATCH',{expectedRevision:rev++,view:view('table')}));assert.equal(Object.hasOwn((await get(f,c)).collection.views[0],'boardOrder'),false);
});

test('a row editor cannot change a shared board order without full collection access and record-deny defeats collection access',async t=>{
 const f=fixture(t),c=await create(f,[property('status','select',{options:['Todo','Done']})]),a=await row(f,c,1,'A',{status:'Todo'}),b=await row(f,c,2,'B',{status:'Todo'}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:3,view:view('board',{groupBy:'status'})}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId;
 await grant(f,c.pageId,'member','viewer',4);await grant(f,a.record.pageId,'member','full',5);await grant(f,b.record.pageId,'member','viewer',6);
 const before=await f.raw.read(workspaceId,'owner');await error(await f.request(path,'PATCH',{expectedRevision:7,boardMove:{recordId:a.record.id,targetValue:'Todo',beforeRecordId:null,visibleRecordIds:[a.record.id,b.record.id]}},'member'),404,'CONTENT_NOT_FOUND');assert.deepEqual(await f.raw.read(workspaceId,'owner'),before);
 await ok(await f.request('/collections/'+c.collectionId+'/records/'+a.record.id,'PATCH',{expectedRevision:7,values:{status:'Done'}},'member'));
 await grant(f,c.pageId,'member','full',8);await grant(f,a.record.pageId,'member','deny',9);const visible=await ok(await f.request(path,'GET',undefined,'member'));assert.deepEqual(visible.collection.records.map(row=>row.id),[b.record.id]);await error(await f.request(path,'PATCH',{expectedRevision:10,boardMove:{recordId:a.record.id,targetValue:'Todo',beforeRecordId:null,visibleRecordIds:[b.record.id]}},'member'),404,'CONTENT_NOT_FOUND');
});

test('board visible-review person filters are membership guarded at the same SQL commit',async t=>{
 const f=fixture(t),c=await create(f,[property('status','select',{options:['Todo','Done']}),property('assignee','person')]),a=await row(f,c,1,'A',{status:'Todo',assignee:'person'}),b=await row(f,c,2,'B',{status:'Todo',assignee:'person'}),v=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:3,view:view('board',{groupBy:'status',filters:[{propertyId:'assignee',operator:'eq',value:'person'}]})}),201),path='/collections/'+c.collectionId+'/views/'+v.viewId,before=await f.raw.read(workspaceId,'owner');
 f.setBeforeWrite(()=>{f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('person');f.setBeforeWrite(null);});
 await error(await f.request(path,'PATCH',{expectedRevision:4,boardMove:{recordId:b.record.id,targetValue:'Todo',beforeRecordId:a.record.id,visibleRecordIds:[a.record.id,b.record.id]}}),404,'CONTENT_NOT_FOUND');const after=await f.raw.read(workspaceId,'owner');assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload);
});

test('SQLite stores all eight property types, private container and row pages, canonical nulls and immutable manual provenance',async t=>{
  const f=fixture(t),properties=[property('text'),property('number','number'),property('check','checkbox'),property('date','date'),property('select','select',{options:['New','Done']}),property('multi','multi_select',{options:['A','B']}),property('person','person'),property('relation','relation')];
  const c=await create(f,properties);assert.equal(c.revision,1);const first=await row(f,c,1,'First',{text:'日本語 😀',number:12.5,check:false,date:'2026-10-15',select:'New',multi:['B','A'],person:'person'});
  assert.equal(first.record.title,'First');assert.equal(first.record.sourceKind,'manual');assert.deepEqual(first.record.sourceValues,{});assert.equal(first.record.values.relation,null);assert.ok(first.record.capabilities.includes('manage'));
  const second=await row(f,c,2,'Second',{relation:[first.record.pageId]});const saved=await get(f,c);assert.equal(saved.collection.records.length,2);assert.deepEqual(saved.collection.records[1].values.relation,[first.record.pageId]);assert.equal(saved.collection.records[1].values.number,null);assert.deepEqual(saved.collection.sourceProperties,[]);assert.deepEqual(saved.collection.sourceHeaders,[]);
  const hidden=await ok(await f.request('/collections','GET',undefined,'member'));assert.deepEqual(hidden.collections,[]);
  const again=createSqliteContentStore(f.db),persisted=await again.read(workspaceId,'owner');assert.equal(persisted.revision,3);validateContentPayload(persisted.payload,workspaceId);
  assert.equal(f.db.prepare('SELECT value FROM prototype_sentinel').get().value,'legacy unchanged');assert.equal(second.record.title,'Second');
});

test('native schema edits freeze text source definitions, require exact deletion consent, retain every original cell and reject implicit conversion',async t=>{
  const f=fixture(t),imported=await ok(await f.request('/imports','POST',{expectedRevision:0,importId:'source-import',pages:[{sourceId:'container',parentSourceId:null,title:'Imported',blocks:[]},{sourceId:'record',parentSourceId:'container',title:'Raw row',blocks:[]}],collections:[{sourceId:'source',pageSourceId:'container',properties:[{id:'a',name:'A',type:'text',sourceName:''},{id:'b',name:'B',type:'text'}],records:[{sourceId:'row',pageSourceId:'record',values:{a:'007',b:'Private raw =SUM(A1)'}}]}]}),201);
  const c=(await ok(await f.request('/collections'))).collections[0],initial=await get(f,{collectionId:c.id}),[a,b]=initial.collection.properties;
  const properties=[{...b,name:'Renamed'},property('new-number','number')];const request={expectedRevision:imported.revision,properties};const writes=f.writes;
  await error(await f.request('/collections/'+c.id,'PATCH',request),409,'PROPERTY_DELETION_CONFIRMATION_REQUIRED');assert.equal(f.writes,writes);
  await ok(await f.request('/collections/'+c.id,'PATCH',{...request,confirmPropertyDeletion:[a.id]}));const changed=await get(f,{collectionId:c.id});
  assert.deepEqual(changed.collection.sourceHeaders,['','B']);assert.deepEqual(changed.collection.sourceProperties,[a,b]);assert.deepEqual(changed.collection.records[0].sourceValues,{[a.id]:'007',[b.id]:'Private raw =SUM(A1)'});assert.deepEqual(changed.collection.records[0].values,{[b.id]:'Private raw =SUM(A1)','new-number':null});
  await error(await f.request('/collections/'+c.id,'PATCH',{expectedRevision:2,properties:[{...b,type:'number'}],confirmPropertyDeletion:['new-number']}),409,'PROPERTY_TYPE_CHANGE_UNSUPPORTED');
  const manual=await row(f,{collectionId:c.id},2,'Manual',{[b.id]:'new'});assert.equal(manual.record.sourceKind,'manual');assert.deepEqual(manual.record.sourceValues,{});assert.equal((await get(f,{collectionId:c.id})).collection.records.length,2);
});

test('typed input, required additions and reference validation have no partial SQLite writes',async t=>{
  const f=fixture(t),props=[property('number','number'),property('date','date'),property('check','checkbox'),property('select','select',{options:['A']}),property('multi','multi_select',{options:['A']}),property('person','person'),property('relation','relation')],c=await create(f,props),first=await row(f,c,1,'One');
  const before=f.writes;
  for(const values of [{number:'3'},{date:'2026-02-30'},{check:'true'},{select:'B'},{multi:['A','A']},{extra:'unknown'}])await error(await f.request('/collections/'+c.collectionId+'/records/'+first.record.id,'PATCH',{expectedRevision:2,values}),400,'INVALID_CONTENT');
  for(const values of [{person:'not-a-member'},{relation:['outside-record']}])await error(await f.request('/collections/'+c.collectionId+'/records/'+first.record.id,'PATCH',{expectedRevision:2,values}),404,'CONTENT_NOT_FOUND');
  await error(await f.request('/collections/'+c.collectionId,'PATCH',{expectedRevision:2,properties:[...props,property('required','text',{required:true})]}),400,'INVALID_CONTENT');assert.equal(f.writes,before);assert.equal((await get(f,c)).revision,2);
});

test('record ACL filters rows and redacts hidden person/relation references in GET, saved views and both exports without changing stored values',async t=>{
  const f=fixture(t),props=[property('person','person'),property('relation','relation')],c=await create(f,props),target=await row(f,c,1,'Hidden target'),first=await row(f,c,2,'Visible',{person:'person',relation:[target.record.pageId]});
  const savedView=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:3,view:view('table',{filters:[{propertyId:'relation',operator:'contains',value:target.record.pageId}]})}),201);
  await grant(f,c.pageId,'member','viewer',4);await grant(f,first.record.pageId,'member','viewer',5);
  f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('person');const visible=await get(f,c,'member');assert.equal(visible.collection.records.length,1);assert.deepEqual(visible.collection.records[0].values,{person:null,relation:[]});assert.deepEqual(visible.collection.records[0].redactedProperties,['person','relation']);assert.doesNotMatch(JSON.stringify(visible),new RegExp(target.record.pageId));assert.equal(visible.collection.views[0].filters[0].redacted,true);
  const filtered=await ok(await f.request('/collections/'+c.collectionId+'/views/'+savedView.viewId,'GET',undefined,'member'));assert.deepEqual(filtered.collection.records,[]);assert.equal(filtered.view.filters[0].value,null);
  const exported=await ok(await f.request('/export?format=json','GET',undefined,'member'));assert.deepEqual(exported.collections[0].collection.records[0].values,{person:null,relation:[]});assert.doesNotMatch(JSON.stringify(exported),new RegExp(target.record.pageId));
  const zip=await f.request('/export?format=zip','GET',undefined,'member');assert.equal(zip.status,200);const bytes=Buffer.from(await zip.arrayBuffer());assert.equal(bytes.includes(Buffer.from(target.record.pageId)),false);
  const stored=(await f.raw.read(workspaceId,'owner')).payload.collections[0].collection.records.find(row=>row.id===first.record.id);assert.deepEqual(stored.values,{person:'person',relation:[target.record.pageId]});
});
test('six saved view types persist typed filters, ordering and grouping, and protect dependencies and exact request shapes',async t=>{
  const f=fixture(t),props=[property('name'),property('priority','number'),property('status','select',{options:['New','Done']}),property('start','date'),property('end','date')],c=await create(f,props);
  const one=await row(f,c,1,'One',{name:'Alpha',priority:1,status:'New',start:'2026-10-15',end:'2026-10-16'}),two=await row(f,c,2,'Two',{name:'Beta',priority:3,status:'Done',start:'2026-10-20',end:'2026-10-21'});let rev=3;const ids=[];
  for(const type of ['table','board','list','gallery','calendar','timeline']){const config=view(type,{filters:[{propertyId:'priority',operator:'gte',value:1}],sorts:[{propertyId:'priority',direction:'desc'}],...(type==='board'?{groupBy:'status'}:{}),...(['calendar','timeline'].includes(type)?{datePropertyId:'start'}:{}),...(type==='timeline'?{endDatePropertyId:'end'}:{})});
    const created=await ok(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:rev,view:config}),201);rev++;ids.push(created.viewId);const loaded=await ok(await f.request('/collections/'+c.collectionId+'/views/'+created.viewId));assert.equal(loaded.view.type,type);assert.deepEqual(loaded.collection.records.map(row=>row.id),[two.record.id,one.record.id]);if(type==='board')assert.deepEqual(loaded.groups.map(group=>group.value),['Done','New']);}
  const before=f.writes;await error(await f.request('/collections/'+c.collectionId,'PATCH',{expectedRevision:rev,properties:props.filter(property=>property.id!=='priority'),confirmPropertyDeletion:['priority']}),409,'COLLECTION_VIEW_DEPENDENCY');assert.equal(f.writes,before);
  for(const invalid of [view('board'),view('calendar'),view('table',{filters:[{propertyId:'priority',operator:'contains',value:'1'}]}),view('table',{filters:[{propertyId:'name',operator:'empty',value:null}]}),{...view(),secret:'unexpected'}])await error(await f.request('/collections/'+c.collectionId+'/views','POST',{expectedRevision:rev,view:invalid}),400,'INVALID_CONTENT');
  await ok(await f.request('/collections/'+c.collectionId+'/views/'+ids[0],'PATCH',{expectedRevision:rev,view:view('list',{name:'Reviewed list',filters:[{propertyId:'name',operator:'contains',value:'bet'}]})}));rev++;
  const filtered=await ok(await f.request('/collections/'+c.collectionId+'/views/'+ids[0]));assert.equal(filtered.view.name,'Reviewed list');assert.deepEqual(filtered.collection.records.map(row=>row.title),['Two']);
  const removed=await ok(await f.request('/collections/'+c.collectionId+'/views/'+ids[0],'DELETE',{expectedRevision:rev}));assert.equal(removed.removed,true);await error(await f.request('/collections/'+c.collectionId+'/views/'+ids[0]),404,'CONTENT_NOT_FOUND');
});

test('schema changes require management of every affected row while row values remain individually editable and guests cannot create rows',async t=>{
  const f=fixture(t),c=await create(f,[property('text')]),first=await row(f,c,1,'One',{text:'before'});await grant(f,first.record.pageId,'member','full',2);await grant(f,first.record.pageId,'owner','deny',3);
  const writes=f.writes;await error(await f.request('/collections/'+c.collectionId,'PATCH',{expectedRevision:4,properties:[property('text'),property('number','number')]}),404,'CONTENT_NOT_FOUND');assert.equal(f.writes,writes);
  await grant(f,c.pageId,'member','viewer',4);const changed=await ok(await f.request('/collections/'+c.collectionId+'/records/'+first.record.id,'PATCH',{expectedRevision:5,values:{text:'individual edit'}},'member'));assert.equal(changed.record.values.text,'individual edit');
  await grant(f,c.pageId,'guest','full',6);await error(await f.request('/collections/'+c.collectionId+'/records','POST',{expectedRevision:7,title:'Guest row',values:{text:'forbidden'}},'guest'),404,'CONTENT_NOT_FOUND');
  await error(await f.request('/collections','POST',{expectedRevision:7,title:'Guest collection',parentId:null,properties:[]},'guest'),404,'CONTENT_NOT_FOUND');assert.equal((await f.raw.read(workspaceId,'member')).revision,7);
});

test('SQLite CAS admits one concurrent row update and lost actor or target generations produce generic nonleaking failures',async t=>{
  const f=fixture(t),c=await create(f,[property('text'),property('person','person')]),first=await row(f,c,1,'One',{text:'baseline'}),path='/collections/'+c.collectionId+'/records/'+first.record.id;
  const results=await Promise.all(['A','B'].map(text=>f.request(path,'PATCH',{expectedRevision:2,values:{text}})));assert.deepEqual(results.map(response=>response.status).sort(),[200,409]);for(const response of results)await response.arrayBuffer();assert.equal((await get(f,c)).revision,3);
  f.setBeforeWrite(()=>{f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('person');f.setBeforeWrite(null);});await error(await f.request(path,'PATCH',{expectedRevision:3,values:{person:'person'}}),404,'CONTENT_NOT_FOUND');assert.equal((await get(f,c)).collection.records[0].values.person,null);
  f.setBeforeWrite(()=>{f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE id=?').run('member','membership-owner');f.setBeforeWrite(null);});await error(await f.request(path,'PATCH',{expectedRevision:3,values:{text:'must not persist'}}),404,'CONTENT_NOT_FOUND');assert.equal((await f.raw.read(workspaceId,'owner')).revision,3);
});

test('record trash uses the shared subtree lifecycle, schema changes preserve trash and restored rows receive nullable added fields',async t=>{
  const f=fixture(t),c=await create(f,[property('text')]),first=await row(f,c,1,'One',{text:'keep'}),path='/collections/'+c.collectionId+'/records/'+first.record.id;
  const removed=await ok(await f.request(path,'DELETE',{expectedRevision:2}));assert.equal(removed.pageId,first.record.pageId);assert.equal(removed.affectedPageCount,1);assert.deepEqual((await get(f,c)).collection.records,[]);
  await ok(await f.request('/collections/'+c.collectionId,'PATCH',{expectedRevision:3,properties:[property('text'),property('number','number')]}));
  await ok(await f.request('/pages/'+first.record.pageId+'/restore','POST',{expectedRevision:4,parentId:c.pageId}));const restored=(await get(f,c)).collection.records[0];assert.deepEqual(restored.values,{text:'keep',number:null});assert.deepEqual(restored.sourceValues,{});assert.equal(restored.sourceKind,'manual');
  const page=await ok(await f.request('/pages/'+first.record.pageId));assert.equal(page.document.version,3);assert.equal(page.page.trashedAt,null);
});

test('title updates retain page history and invalidate an existing collaboration room before changing its document version',async t=>{
  const f=fixture(t),c=await create(f),first=await row(f,c,1,'Old title');const room=await ok(await f.request('/pages/'+first.record.pageId+'/room/open','POST',{expectedRevision:2}),201);
  const updated=await ok(await f.request('/collections/'+c.collectionId+'/records/'+first.record.id,'PATCH',{expectedRevision:3,title:'New title'}));assert.equal(updated.record.title,'New title');
  const payload=(await f.raw.read(workspaceId,'owner')).payload;assert.equal(payload.rooms?.some(entry=>entry.pageId===first.record.pageId)??false,false);const history=payload.history.find(item=>item.pageId===first.record.pageId);assert.equal(history.title,'Old title');assert.equal(history.document.version,1);
  const stale=await f.request('/pages/'+first.record.pageId+'/room','GET',undefined,'owner',{'X-Yumunio-Room-Ticket':room.ticket});assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'ROOM_EPOCH_CHANGED');
});

test('new collection routes enforce the expected actor before reads and bound property and membership guard counts',async t=>{
  const f=fixture(t);await error(await f.request('/collections','POST',{expectedRevision:0,title:'Wrong actor',parentId:null,properties:[]},'owner',{'X-Yumunio-Expected-Account':'member'}),404,'CONTENT_NOT_FOUND');assert.equal(f.reads,0);assert.equal(f.writes,0);
  await error(await f.request('/collections','POST',{expectedRevision:0,title:'Oversized schema',parentId:null,properties:Array.from({length:129},(_,index)=>property('p'+index))}),413,'CONTENT_TOO_LARGE');assert.equal(f.writes,0);
  const props=Array.from({length:17},(_,index)=>property('p'+index,'person')),values={};for(let index=0;index<17;index++){const id='person-'+index;f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,'member',stamp);values['p'+index]=id;}
  const c=await create(f,props),writes=f.writes;await error(await f.request('/collections/'+c.collectionId+'/records','POST',{expectedRevision:1,title:'Too many guards',values}),413,'CONTENT_TOO_LARGE');assert.equal(f.writes,writes);assert.equal((await get(f,c)).collection.records.length,0);
});
