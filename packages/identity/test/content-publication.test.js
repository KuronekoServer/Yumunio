import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createAccountContentApi} from '../src/content.js';
import {createSqliteContentStore} from '../src/content-store.js';
import {createSimpleTable,simpleTableToMarkdown} from '../../domain/src/simple-table.js';

const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8'),origin='https://publication.example',workspaceId='workspace-a',stamp='2026-10-15T00:00:00.000Z',secret='publication-fixture-key-'.repeat(4);
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close());
  for(const id of ['owner','member','guest'])db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id,id,id+'@example.invalid',stamp,stamp);
  for(const id of [workspaceId,'foreign'])db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt) VALUES(?,?,?,?)').run(id,id,id,stamp);
  for(const id of ['owner','member','guest'])db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('membership-'+id,workspaceId,id,id,stamp);
  db.exec("CREATE TABLE prototype_sentinel(value TEXT);INSERT INTO prototype_sentinel VALUES('legacy unchanged')");
  const raw=createSqliteContentStore(db);let beforeWrite=null,writes=0,reads=0,publicReads=0,sessions=0,sequence=0;
  const store={async read(...args){reads++;return raw.read(...args);},async readPublication(...args){publicReads++;return raw.readPublication(...args);},async write(...args){writes++;if(beforeWrite)await beforeWrite(...args);return raw.write(...args);}};
  const api=createAccountContentApi({store,origin,roomSecret:secret,publicationSecret:secret,now:()=>stamp,createId:()=> 'generated-'+ ++sequence,resolveSession:async request=>{sessions++;const id=request.headers.get('x-fixture-account');return id?{user:{id,emailVerified:true}}:null;}});
  const request=(path='',method='GET',body,accountId='owner',headers={})=>api(new Request(origin+'/api/content/workspaces/'+workspaceId+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(accountId?{'x-fixture-account':accountId,'X-Yumunio-Expected-Account':accountId}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const anonymous=(token,method='GET',headers={},query='')=>api(new Request(origin+'/api/public/pages/'+token+query,{method,headers}));
  return{db,raw,request,anonymous,setBeforeWrite(fn){beforeWrite=fn;},get writes(){return writes;},get reads(){return reads;},get publicReads(){return publicReads;},get sessions(){return sessions;}};
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function error(response,status,code){assert.equal(response.status,status,await response.clone().text());const value=await response.json();assert.equal(value.error.code,code);return value;}
async function create(f,blocks=[{id:'paragraph',type:'paragraph',data:{text:'Public literal <b>text</b>'}}],expectedRevision=0){const page=await ok(await f.request('/pages','POST',{expectedRevision,title:'Public example',blocks}),201);return{page:page.page,path:'/pages/'+page.page.id+'/publication',revision:expectedRevision+1};}
const review=(f,c,revision=c.revision,account='owner')=>f.request(c.path+'/review','POST',{expectedRevision:revision},account);
async function publish(f,c,revision=c.revision,account='owner'){const preview=await ok(await review(f,c,revision,account)),status=await ok(await f.request(c.path,'POST',{expectedRevision:revision,reviewDigest:preview.reviewDigest,confirmPublicExposure:true},account));return{...status,token:new URL(status.publicPath,origin).searchParams.get('publication'),preview};}
const grant=(f,c,accountId,expectedRevision,permission='full',actor='owner')=>f.request('/pages/'+c.page.id+'/grants','POST',{expectedRevision,accountId,permission},actor);

test('callout and toggle text can be published without copying private presentation or nested reference metadata',async t=>{
 const f=fixture(t),c=await create(f,[{id:'toggle',type:'toggle',data:{text:'Details',icon:'💡',background:'blue',authorId:'private-author'},children:[{id:'callout',type:'callout',data:{text:'Hint',color:'blue'}}]}]),result=await publish(f,c);
 assert.deepEqual(result.preview.snapshot.blocks,[{type:'toggle',text:'Details',children:[{type:'callout',text:'Hint'}]}]);assert.doesNotMatch(JSON.stringify(await ok(await f.anonymous(result.token))),/authorId|private-author|background|icon/);
});

test('publication review is nonmutating and public projection excludes metadata, link labels, source, attachments, unknown subtrees and child pages',async t=>{
  const f=fixture(t),target=await create(f,[]),c=await create(f,[{id:'public',type:'paragraph',data:{text:'Public <script>literal</script>',authorId:'private-author',email:'private@example.invalid'}},{id:'link',type:'paragraph',data:{text:'See Secret target here',links:[{start:4,end:17,label:'Secret target',pageId:target.page.id}]}},{id:'source',type:'code',data:{text:'Private source',purpose:'import-source'}},{id:'file',type:'image',data:{text:'Private attachment',url:'https://private.example.invalid'}},{id:'unknown',type:'custom-widget',data:{text:'Private widget'},children:[{id:'nested-private',type:'paragraph',data:{text:'Private nested'}}]},{id:'heading',type:'heading',data:{text:'Heading',level:2}},{id:'check',type:'checklist',data:{text:'Checked',checked:true},children:[{id:'quote',type:'quote',data:{text:'Quote'}}]},{id:'divider',type:'divider',data:{text:'Private divider metadata'}}],1);
  await ok(await f.request('/pages','POST',{expectedRevision:2,parentId:c.page.id,title:'Private child',blocks:[]}),201);const writes=f.writes,preview=await ok(await review(f,c,3));assert.equal(f.writes,writes);assert.equal(preview.mode,'snapshot');assert.equal(preview.sourceVersion,1);assert.match(preview.reviewDigest,/^[a-f0-9]{64}$/);assert.deepEqual(preview.summary,{blocksIncluded:6,blocksOmitted:4,linkSpansOmitted:1});
  const literal=JSON.stringify(preview.snapshot);assert.doesNotMatch(literal,/private|Secret target|hidden-page|authorId|email|\.invalid|nested-private/i);assert.equal(preview.snapshot.blocks[1].text,'See … here');assert.equal(preview.snapshot.blocks[2].level,2);assert.equal(preview.snapshot.blocks[3].checked,true);assert.equal(preview.snapshot.blocks[3].children[0].type,'quote');assert.deepEqual(preview.snapshot.blocks[4],{type:'divider'});
  const published=await publish(f,c,3),sessionCalls=f.sessions,beforeWrites=f.writes,publicPage=await ok(await f.anonymous(published.token));assert.equal(f.sessions,sessionCalls);assert.equal(f.writes,beforeWrites);assert.deepEqual(Object.keys(publicPage).sort(),['blocks','mode','publishedAt','schemaVersion','title']);assert.deepEqual(publicPage.blocks,preview.snapshot.blocks);assert.doesNotMatch(JSON.stringify(publicPage),/generated-|membership-|workspace-a|publisher|publications|tokenHash|private|Secret target/i);assert.equal(f.db.prepare('SELECT value FROM prototype_sentinel').get().value,'legacy unchanged');
});

test('public tokens hide routing IDs, authenticate the current stored nonce, and all absent, altered, wrong-query or malformed pages return the same anonymous 404',async t=>{
  const f=fixture(t),c=await create(f),published=await publish(f,c);assert.match(published.token,/^[a-f0-9]{160,2048}$/);assert.equal(published.token.includes(c.page.id),false);const sessions=f.sessions,reads=f.publicReads;
  const absent=await error(await f.anonymous('0'.repeat(160)),404,'PUBLIC_PAGE_NOT_FOUND');assert.equal(f.publicReads,reads);assert.equal(f.sessions,sessions);
  const changed=published.token.slice(0,-1)+(published.token.endsWith('0')?'1':'0');for(const response of [await f.anonymous(changed),await f.anonymous('invalid'),await f.anonymous(published.token,'GET',{},'?extra=1'),await f.anonymous(published.token,'POST')])assert.deepEqual(await error(response,404,'PUBLIC_PAGE_NOT_FOUND'),absent);
  const response=await f.anonymous(published.token,'GET',{Cookie:'irrelevant=private','X-Yumunio-Expected-Account':'someone-else'});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('x-robots-tag'),/noindex/);assert.equal(response.headers.has('set-cookie'),false);assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  f.db.prepare('UPDATE yumunio_account_content SET payload_json=?').run('private corrupt source');assert.deepEqual(await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND'),absent);
});

test('publishing requires page management, current expected actor, exact consent and matching reviewed snapshot',async t=>{
  const f=fixture(t),c=await create(f);await error(await f.request(c.path,'GET',undefined,'member'),404,'CONTENT_NOT_FOUND');await error(await review(f,c,1,'member'),404,'CONTENT_NOT_FOUND');const reads=f.reads;await error(await f.request(c.path,'GET',undefined,'owner',{'X-Yumunio-Expected-Account':'member'}),404,'CONTENT_NOT_FOUND');assert.equal(f.reads,reads);
  const preview=await ok(await review(f,c));await error(await f.request(c.path,'POST',{expectedRevision:1,reviewDigest:preview.reviewDigest,confirmPublicExposure:false}),400,'PUBLICATION_CONSENT_REQUIRED');await error(await f.request(c.path,'POST',{expectedRevision:1,reviewDigest:'0'.repeat(64),confirmPublicExposure:true}),409,'PUBLICATION_REVIEW_CHANGED');assert.equal(f.writes,1);
  await ok(await f.request('/pages/'+c.page.id,'PATCH',{expectedRevision:1,expectedVersion:1,title:'Updated before publish'}));await error(await f.request(c.path,'POST',{expectedRevision:2,reviewDigest:preview.reviewDigest,confirmPublicExposure:true}),409,'PUBLICATION_REVIEW_CHANGED');assert.equal((await f.raw.read(workspaceId,'owner')).payload.publications?.length??0,0);
});

test('an explicitly full-control guest can publish the one managed page without workspace authority or child scope',async t=>{
  const f=fixture(t),c=await create(f);await ok(await grant(f,c,'guest',1));const p=await publish(f,c,2,'guest');assert.equal((await ok(await f.anonymous(p.token))).title,'Public example');await error(await f.request('/pages','POST',{expectedRevision:3,title:'No workspace creation'},'guest'),404,'CONTENT_NOT_FOUND');assert.equal((await f.raw.read(workspaceId,'guest')).payload.publications[0].publisherMembershipId,'membership-guest');
});

test('source edits stop snapshot URLs immediately; republishing rotates the opaque token and never resurrects the old URL',async t=>{
  const f=fixture(t),c=await create(f),first=await publish(f,c);await ok(await f.request('/pages/'+c.page.id,'PATCH',{expectedRevision:2,expectedVersion:1,blocks:[{id:'new',type:'paragraph',data:{text:'New source'}}]}));await error(await f.anonymous(first.token),404,'PUBLIC_PAGE_NOT_FOUND');const stale=await ok(await f.request(c.path));assert.equal(stale.active,false);assert.equal(stale.needsRepublish,true);assert.equal(stale.sourceVersion,1);assert.equal(stale.currentSourceVersion,2);assert.equal(stale.publicPath,null);
  const second=await publish(f,c,3);assert.notEqual(first.token,second.token);assert.equal((await ok(await f.anonymous(second.token))).blocks[0].text,'New source');await error(await f.anonymous(first.token),404,'PUBLIC_PAGE_NOT_FOUND');const stopped=await ok(await f.request(c.path,'DELETE',{expectedRevision:4}));assert.equal(stopped.active,false);assert.equal(stopped.needsRepublish,false);await error(await f.anonymous(second.token),404,'PUBLIC_PAGE_NOT_FOUND');const third=await publish(f,c,5);assert.notEqual(third.token,second.token);await error(await f.anonymous(second.token),404,'PUBLIC_PAGE_NOT_FOUND');
});

test('page trash and restore fence the old publication even when page permissions are restored',async t=>{
  const f=fixture(t),c=await create(f),published=await publish(f,c);await ok(await f.request('/pages/'+c.page.id,'DELETE',{expectedRevision:2}));await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');await ok(await f.request('/pages/'+c.page.id+'/restore','POST',{expectedRevision:3,parentId:null}));await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');const status=await ok(await f.request(c.path));assert.equal(status.needsRepublish,true);assert.equal(status.currentSourceVersion,3);
});

test('publisher ACL removal and later regrant cannot revive an old publication fingerprint',async t=>{
  const f=fixture(t),c=await create(f);await ok(await grant(f,c,'member',1));const published=await publish(f,c,2);await ok(await grant(f,c,'owner',3,'deny','member'));await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');await ok(await grant(f,c,'owner',4,'full','member'));await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');assert.equal((await ok(await f.request(c.path))).needsRepublish,true);assert.equal((await publish(f,c,5)).active,true);
});

test('publisher verification and live membership generation are rechecked on every anonymous read and rejoining never revives the token',async t=>{
  const f=fixture(t),c=await create(f);await ok(await grant(f,c,'member',1));const published=await publish(f,c,2);f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('owner');await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');f.db.prepare('UPDATE yumunio_users SET emailVerified=1 WHERE id=?').run('owner');f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE id=?').run('replacement-owner','membership-owner');await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');await ok(await grant(f,c,'owner',3,'full','member'));await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');assert.equal((await publish(f,c,4)).active,true);
});

test('publish CAS protects the reviewed state and live SQL actor; failed attempts never expose a partial snapshot',async t=>{
  const f=fixture(t),c=await create(f),preview=await ok(await review(f,c));const body={expectedRevision:1,reviewDigest:preview.reviewDigest,confirmPublicExposure:true};const responses=await Promise.all([f.request(c.path,'POST',body),f.request(c.path,'POST',body)]);assert.deepEqual(responses.map(row=>row.status).sort(),[200,409]);for(const response of responses)await response.arrayBuffer();assert.equal((await f.raw.read(workspaceId,'owner')).payload.publications.length,1);
  const g=fixture(t),d=await create(g),next=await ok(await review(g,d));g.setBeforeWrite(()=>{g.setBeforeWrite(null);g.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('owner');});await error(await g.request(d.path,'POST',{expectedRevision:1,reviewDigest:next.reviewDigest,confirmPublicExposure:true}),404,'CONTENT_NOT_FOUND');assert.equal((await g.raw.readPublication(workspaceId)).payload.publications?.length??0,0);
});

test('invalid structured link spans are rejected before persistence and publication retains mention labels without identities and rejects size limits',async t=>{
  const f=fixture(t);await error(await f.request('/pages','POST',{expectedRevision:0,title:'Invalid reference',blocks:[{id:'invalid-link',type:'paragraph',data:{text:'Private hidden label',links:[{start:0,end:4,label:'wrong',pageId:'hidden'}]}}]}),400,'INVALID_CONTENT');assert.equal(f.writes,0);const c=await create(f,[{id:'private-mention',type:'paragraph',data:{text:'Private person label',mentions:[{kind:'person',accountId:'owner',start:0,end:20}]}},{id:'public',type:'paragraph',data:{text:'Visible'}}]),preview=await ok(await review(f,c));assert.deepEqual(preview.snapshot.blocks,[{type:'paragraph',text:'Private person label'},{type:'paragraph',text:'Visible'}]);assert.equal(preview.summary.blocksOmitted,0);assert.doesNotMatch(JSON.stringify(preview.snapshot),/mentions|accountId|membershipId/);
  const g=fixture(t),d=await create(g,Array.from({length:1001},(_,i)=>({id:'block-'+i,type:'paragraph',data:{text:'x'}})));await error(await review(g,d),413,'PUBLICATION_TOO_LARGE');assert.equal(g.writes,1);
  const h=fixture(t),e=await create(h,[{id:'a',type:'paragraph',data:{text:'界'.repeat(70000)}}]);await error(await review(h,e),413,'PUBLICATION_TOO_LARGE');assert.equal(h.writes,1);
});

test('canonical tables persist exact literal cells, export escaped GFM and enter only explicitly reviewed public snapshots',async t=>{
 const f=fixture(t),data=createSimpleTable({rows:[['Heading','Other'],['<script>literal</script>','UniqueTableCell']],columnAlignments:['left','right']}),blocks=[{id:'table',type:'table',data},{id:'legacy',type:'table',data:{opaque:'Private legacy table'}}],c=await create(f,blocks);
 const published=await publish(f,c);assert.deepEqual(published.preview.snapshot.blocks,[{type:'table',data}]);assert.equal(published.preview.summary.blocksOmitted,1);const publicPage=await ok(await f.anonymous(published.token));assert.deepEqual(publicPage.blocks,[{type:'table',data}]);assert.equal(JSON.stringify(publicPage).includes('Private legacy table'),false);
 const exported=await ok(await f.request('/export?format=json'));assert.deepEqual(exported.pages[0].document.blocks,blocks);const zip=await f.request('/export?format=zip');assert.equal(zip.status,200);assert.ok(new TextDecoder().decode(await zip.arrayBuffer()).includes(simpleTableToMarkdown(data)));
 const changed=structuredClone(data);changed.rows[1][1]='Edited table cell';const saved=await ok(await f.request('/pages/'+c.page.id,'PATCH',{expectedRevision:2,expectedVersion:1,title:c.page.title,blocks:[{id:'table',type:'table',data:changed},blocks[1]]}));assert.equal(saved.document.version,2);assert.deepEqual(saved.document.blocks[0].data,changed);await error(await f.anonymous(published.token),404,'PUBLIC_PAGE_NOT_FOUND');
 const reopened=createAccountContentApi({store:createSqliteContentStore(f.db),origin,publicationSecret:secret,resolveSession:async()=>({user:{id:'owner',emailVerified:true}})}),read=await reopened(new Request(origin+'/api/content/workspaces/'+workspaceId+'/pages/'+c.page.id,{headers:{'X-Yumunio-Expected-Account':'owner'}}));assert.equal(read.status,200);assert.deepEqual((await read.json()).document.blocks[0].data,changed);
});
