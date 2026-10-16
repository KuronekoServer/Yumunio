import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createCollaborationService } from '../src/collaboration.js';
import { createSqliteCollaborationStore, createD1CollaborationStore } from '../src/collaboration-store.js';
import { createSqliteContentStore } from '../src/content-store.js';
import { createDomainPolicy } from '../src/config.js';
import { createDurableMailQueue } from '../src/jobs.js';

const schema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const extra=await readFile(new URL('../schema/collaboration.sqlite.sql',import.meta.url),'utf8');
const origin='https://workspace.example.invalid',secret='fixture-outbox-key-'.repeat(4),stamp='2026-10-15T00:00:00.000Z';
function d1Bridge(db){
  const execute=statement=>{const s=db.prepare(statement.sql);if(/^\s*SELECT\b/i.test(statement.sql))return {success:true,results:s.all(...statement.args),meta:{changes:0}};return {success:true,results:[],meta:{changes:Number(s.run(...statement.args).changes)}};};
  return {prepare(sql){return {bind(...args){return {sql,args,async all(){return execute({sql,args});}};}};},async batch(statements){
    db.exec('BEGIN IMMEDIATE');try{const results=statements.map(execute);db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}
  }};
}
async function fixture(t,{d1=false,sendMail,domainPolicy,...options}={}){
  const db=new DatabaseSync(':memory:');db.exec(schema);db.exec(extra);t.after(()=>db.close());
  const users=[['owner',1],['manager',1],['guest',1],['recipient',1],['other',1],['unverified',0]];
  for(const [id,verified]of users)db.prepare('INSERT INTO yumunio_users (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(id,id,id+'@studio.example.invalid',verified,stamp,stamp);
  for(const id of ['workspace-a','workspace-b'])db.prepare('INSERT INTO yumunio_workspaces (id,name,slug,createdAt) VALUES (?,?,?,?)').run(id,id,id,stamp);
  for(const [id,user,role,workspace]of [['membership-owner','owner','owner','workspace-a'],['membership-manager','manager','member','workspace-a'],['membership-guest','guest','guest','workspace-a']])
    db.prepare('INSERT INTO yumunio_memberships (id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)').run(id,workspace,user,role,stamp);
  const payload={schemaVersion:1,pages:[{page:{id:'page-a',workspaceId:'workspace-a',title:'Synthetic private page',parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null},
    document:{pageId:'page-a',workspaceId:'workspace-a',version:1,blocks:[],updatedAt:stamp},inheritPermissions:false}],grants:[],grantBindings:[]};
  for(const [account,permission]of [['owner','full'],['manager','full'],['guest','viewer']]){
    const id='grant-'+account;payload.grants.push({id,workspaceId:'workspace-a',pageId:'page-a',accountId:account,permission,includeDescendants:false,status:'active'});
    payload.grantBindings.push({grantId:id,membershipId:'membership-'+account});
  }
  await createSqliteContentStore(db).write('workspace-a','owner',{expectedRevision:0,payload,actorMembershipId:'membership-owner',actorRole:'owner'});
  const store=d1?createD1CollaborationStore(d1Bridge(db)):createSqliteCollaborationStore(db),mail=[];
  let time=stamp;
  const service=createCollaborationService({store,origin,secret,domainPolicy,now:()=>time,sendMail:sendMail??(async message=>{mail.push(message);return {status:'accepted'};}),
    resolveSession:async request=>({user:{id:request.headers.get('x-fixture-account')??'owner',emailVerified:true}}),...options});
  const request=async(path,{method='POST',body,account='owner',headers={}}={})=>service.handle(new Request(origin+'/api/collaboration'+path,{
    method,headers:{Origin:origin,'x-fixture-account':account,'X-Yumunio-Expected-Account':account,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const currentRevision=()=>Number(db.prepare('SELECT revision FROM yumunio_account_content WHERE workspace_id=?').get('workspace-a').revision);
  const invite=async(overrides={},account='owner')=>request('/workspaces/workspace-a/invitations',{account,body:{expectedRevision:currentRevision(),requestId:'invitation-1',purpose:'page-guest',email:'recipient@studio.example.invalid',role:'editor',pageId:'page-a',...overrides}});
  const token=async id=>{
    const row=db.prepare('SELECT payload_ciphertext FROM yumunio_mail_jobs WHERE invitation_id=? ORDER BY invitation_generation DESC LIMIT 1').get(id??'invitation-1');
    const message=JSON.parse(await symmetricDecrypt({key:secret,data:row.payload_ciphertext}));
    return new URL(message.text.split('\n').at(-1)).searchParams.get('token');
  };
  return {db,store,service,request,currentRevision,invite,token,mail,setTime(value){time=value;}};
}
const errorCode=async response=>(await response.json()).error.code;
const pendingCount=f=>f.db.prepare("SELECT COUNT(*) AS n FROM yumunio_mail_jobs WHERE status IN ('queued','leased')").get().n;

for(const d1 of [false,true])test((d1?'D1-shaped':'SQLite')+' acceptance atomically inserts a guest, binds exactly one page and consumes one digest',async t=>{
  const f=await fixture(t,{d1});await f.store.checkSchema();
  const issued=await f.invite();assert.equal(issued.status,201);const body=await issued.json();
  assert.equal(body.mailStatus,'queued');assert.equal('tokenHash' in body.invitation,false);assert.equal(f.mail.length,0);
  const token=await f.token();const raw=f.db.prepare('SELECT invitation_json FROM yumunio_collaboration_invitations').get().invitation_json;
  assert.equal(raw.includes(token),false);
  assert.equal(f.db.prepare('SELECT payload_ciphertext FROM yumunio_mail_jobs').get().payload_ciphertext.includes(token),false);
  const accepted=await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}});assert.equal(accepted.status,200);
  const member=f.db.prepare('SELECT id,role FROM yumunio_memberships WHERE userId=? AND organizationId=?').get('recipient','workspace-a');
  assert.equal(member.role,'guest');
  const saved=await createSqliteContentStore(f.db).read('workspace-a','recipient');
  const grant=saved.payload.grants.find(g=>g.accountId==='recipient');assert.equal(grant.pageId,'page-a');assert.equal(grant.includeDescendants,false);
  assert.equal(saved.payload.grantBindings.find(g=>g.grantId===grant.id).membershipId,member.id);
  assert.equal(f.db.prepare('SELECT status FROM yumunio_collaboration_invitations').get().status,'accepted');
  assert.equal(pendingCount(f),0);
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}})).status,404);
});

test('page manage permits single-page guest invitations without workspace invite authority',async t=>{
  const f=await fixture(t);
  assert.equal((await f.invite({},'manager')).status,201);
  assert.equal((await f.invite({requestId:'member-invite',purpose:'workspace-member',role:'member',pageId:null},'manager')).status,404);
  assert.equal((await f.invite({requestId:'guest-denied'},'guest')).status,404);
  assert.equal((await f.invite({requestId:'scope-denied',includeDescendants:true},'owner')).status,404);
});

test('workspace invitation grants only its assigned member role; only an owner can invite an administrator',async t=>{
  const f=await fixture(t);
  assert.equal((await f.invite({purpose:'workspace-member',role:'member',pageId:null})).status,201);
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token:await f.token()}})).status,200);
  assert.equal(f.db.prepare('SELECT role FROM yumunio_memberships WHERE userId=?').get('recipient').role,'member');
  assert.equal((await createSqliteContentStore(f.db).read('workspace-a','recipient')).payload.grants.some(g=>g.accountId==='recipient'),false);
  f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('admin','manager');
  assert.equal((await f.invite({requestId:'admin-attempt',purpose:'workspace-member',role:'admin',pageId:null},'manager')).status,404);
  assert.equal((await f.invite({requestId:'owner-attempt',purpose:'workspace-member',role:'owner',pageId:null})).status,400);
});

test('a guest invitation never downgrades an existing member or grants workspace administration',async t=>{
  const f=await fixture(t);
  assert.equal((await f.invite({email:'manager@studio.example.invalid',role:'viewer'})).status,201);
  assert.equal((await f.request('/accept',{account:'manager',body:{invitationId:'invitation-1',token:await f.token()}})).status,200);
  assert.equal(f.db.prepare('SELECT role FROM yumunio_memberships WHERE userId=?').get('manager').role,'member');
});

test('verified recipient, email identity, domain and token expiry are required at acceptance',async t=>{
  const f=await fixture(t);await f.invite();const token=await f.token();
  assert.equal((await f.request('/accept',{account:'other',body:{invitationId:'invitation-1',token}})).status,404);
  assert.equal((await f.request('/accept',{account:'unverified',body:{invitationId:'invitation-1',token}})).status,404);
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token:'x'.repeat(48)}})).status,404);
  f.db.prepare('UPDATE yumunio_users SET emailVerified=0 WHERE id=?').run('recipient');
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}})).status,404);
  f.db.prepare('UPDATE yumunio_users SET emailVerified=1 WHERE id=?').run('recipient');
  f.setTime('2026-10-16T00:00:00.000Z');
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}})).status,404);
  const blocked=await fixture(t,{domainPolicy:createDomainPolicy({blockedDomains:['studio.example.invalid']})});
  assert.equal((await blocked.invite()).status,400);
});

test('revoking issuer page access or replacing their membership generation invalidates pending invitations',async t=>{
  for(const replacement of [false,true]){
    const f=await fixture(t);await f.invite({},'manager');const token=await f.token();
    if(replacement){
      f.db.prepare('DELETE FROM yumunio_memberships WHERE id=?').run('membership-manager');
      f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run('new-generation','workspace-a','manager','member',stamp);
    }else{
      const store=createSqliteContentStore(f.db),saved=await store.read('workspace-a','owner');saved.payload.grants.find(g=>g.accountId==='manager').status='revoked';
      await store.write('workspace-a','owner',{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'membership-owner',actorRole:'owner'});
    }
    assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}})).status,404);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_memberships WHERE userId=?').get('recipient').n,0);
  }
});

test('resend rotates digest/generation and cancels older queued jobs; cancellation makes the current token unusable',async t=>{
  const f=await fixture(t);await f.invite();const oldToken=await f.token();
  const resent=await f.request('/workspaces/workspace-a/invitations/invitation-1/resend',{body:{expectedRevision:f.currentRevision()}});
  assert.equal(resent.status,200);assert.equal((await resent.json()).invitation.generation,2);
  const newToken=await f.token();assert.notEqual(newToken,oldToken);
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token:oldToken}})).status,404);
  assert.equal((await f.request('/workspaces/workspace-a/invitations/invitation-1',{method:'DELETE',body:{expectedRevision:f.currentRevision()}})).status,200);
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token:newToken}})).status,404);
  assert.equal(pendingCount(f),0);assert.equal((await f.service.runJobs()).claimed,0);
});

test('one concurrent accept wins and a zero-row CAS aborts membership, invitation, grant and mail changes together',async t=>{
  const f=await fixture(t,{d1:true});await f.invite();const token=await f.token();
  const responses=await Promise.all([1,2].map(()=>f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}})));
  assert.equal(responses.filter(r=>r.status===200).length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_memberships WHERE userId=?').get('recipient').n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_transaction_guards').get().n,0);
  const saved=await f.store.load('workspace-a'),before=f.currentRevision();
  await assert.rejects(f.store.commit({workspaceId:'workspace-a',expectedRevision:before-1,payload:saved.payload,
    membershipChange:{kind:'insert',id:'must-rollback',accountId:'other',role:'member',createdAt:stamp}}),e=>e.code==='COLLABORATION_CONFLICT');
  assert.equal(f.currentRevision(),before);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_memberships WHERE id=?').get('must-rollback').n,0);
});

test('membership role changes protect the last verified owner atomically and never create page read permissions',async t=>{
  const f=await fixture(t,{d1:true});
  const path='/workspaces/workspace-a/members/membership-owner';
  const last=await f.request(path,{method:'PATCH',body:{expectedRevision:f.currentRevision(),role:'member'}});
  assert.equal(last.status,409);assert.equal(await errorCode(last),'LAST_WORKSPACE_OWNER');
  assert.equal((await f.request('/workspaces/workspace-a/members/membership-manager',{method:'PATCH',body:{expectedRevision:f.currentRevision(),role:'owner'}})).status,200);
  const revision=f.currentRevision();
  const results=await Promise.all([
    f.request(path,{method:'PATCH',body:{expectedRevision:revision,role:'member'}}),
    f.request('/workspaces/workspace-a/members/membership-manager',{method:'PATCH',account:'manager',body:{expectedRevision:revision,role:'member'}}),
  ]);
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM yumunio_memberships WHERE role='owner'").get().n,1);
});

test('cross-workspace resources, hidden invitations, stale revision, unexpected account, origin and bulk bodies are rejected',async t=>{
  const f=await fixture(t);await f.invite();
  assert.equal((await f.request('/workspaces/workspace-b/invitations',{method:'GET'})).status,404);
  assert.deepEqual((await (await f.request('/workspaces/workspace-a/invitations',{method:'GET',account:'guest'})).json()).invitations,[]);
  assert.equal((await f.invite({requestId:'stale',expectedRevision:0})).status,409);
  assert.equal((await f.request('/workspaces/workspace-a/invitations',{body:{},headers:{'X-Yumunio-Expected-Account':'other'}})).status,404);
  assert.equal((await f.request('/workspaces/workspace-a/invitations',{body:{},headers:{Origin:'https://other.example.invalid'}})).status,403);
  assert.equal((await f.invite({requestId:'bulk',grants:[]})).status,400);
});

test('durable jobs persist encrypted, retry after transient errors and acknowledge provider acceptance separately from delivery',async t=>{
  let calls=0;
  const f=await fixture(t,{sendMail:async()=>{calls++;if(calls===1)throw new Error('secret SMTP relay details');return {status:'accepted'};}});
  await f.invite();
  const first=await f.service.runJobs();assert.equal(first.retried,1);assert.equal(calls,1);
  const row=f.db.prepare('SELECT status,attempts,available_at FROM yumunio_mail_jobs').get();assert.equal(row.status,'queued');assert.equal(row.attempts,1);
  assert.equal((await f.service.runJobs()).claimed,0);
  f.setTime(row.available_at);
  const restarted=createDurableMailQueue({store:createSqliteCollaborationStore(f.db),secret,sendMail:async(message,context)=>{calls++;assert.ok(context.idempotencyKey);return {status:'accepted'};},now:()=>row.available_at});
  assert.equal((await restarted.runDue()).accepted,1);
  assert.equal(f.db.prepare('SELECT status FROM yumunio_mail_jobs').get().status,'accepted');
  assert.equal((await restarted.runDue()).claimed,0);
});

test('expired leases can be recovered once, stale lease holders cannot acknowledge a new lease, and max attempts become dead',async t=>{
  const f=await fixture(t);await f.invite();const id=f.db.prepare('SELECT id FROM yumunio_mail_jobs').get().id;
  const first=await f.store.claim(id,'lease-a',stamp,'2026-10-15T00:01:00.000Z');assert.ok(first);
  assert.equal(await f.store.claim(id,'lease-b',stamp,'2026-10-15T00:01:00.000Z'),null);
  const later='2026-10-15T00:02:00.000Z';
  assert.ok(await f.store.claim(id,'lease-b',later,'2026-10-15T00:03:00.000Z'));
  assert.equal(await f.store.settle(id,'lease-a',{status:'accepted',now:later}),false);
  assert.equal(await f.store.settle(id,'lease-b',{status:'queued',now:later,availableAt:later}),true);
  const runner=createDurableMailQueue({store:f.store,secret,sendMail:async()=>{throw new Error('private');},now:()=>later,maxAttempts:1});
  assert.equal((await runner.runDue()).dead,1);
});

test('generic identity mail enqueue is durable and deduplicated without sending or storing token plaintext',async t=>{
  const f=await fixture(t),message={to:'recipient@studio.example.invalid',subject:'Verification',text:'Private token fixture-only-6482'};
  const first=await f.service.enqueueMail(message),second=await f.service.enqueueMail(message);
  assert.equal(first.status,'queued');assert.equal(first.id,second.id);assert.equal(f.mail.length,0);
  const rows=f.db.prepare('SELECT * FROM yumunio_mail_jobs').all();assert.equal(rows.length,1);assert.equal(JSON.stringify(rows).includes('fixture-only-6482'),false);
});


test('member removal preserves the last page manager even for trashed pages without disclosing page IDs',async t=>{
  for(const trashed of [false,true]){
    const f=await fixture(t),content=createSqliteContentStore(f.db),saved=await content.read('workspace-a','owner');
    saved.payload.grants.find(g=>g.accountId==='owner').status='revoked';
    if(trashed)saved.payload.pages[0].page.trashedAt=stamp;
    await content.write('workspace-a','owner',{expectedRevision:saved.revision,payload:saved.payload,actorMembershipId:'membership-owner',actorRole:'owner'});
    const response=await f.request('/workspaces/workspace-a/members/membership-manager',{method:'DELETE',body:{expectedRevision:f.currentRevision()}});
    assert.equal(response.status,409);const text=await response.text();assert.ok(text.includes('LAST_PAGE_MANAGER'));assert.equal(text.includes('page-a'),false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_memberships WHERE id=?').get('membership-manager').n,1);
    const current=await content.read('workspace-a','owner');current.payload.grants.find(g=>g.accountId==='owner').status='active';
    await content.write('workspace-a','owner',{expectedRevision:current.revision,payload:current.payload,actorMembershipId:'membership-owner',actorRole:'owner'});
    assert.equal((await f.request('/workspaces/workspace-a/members/membership-manager',{method:'DELETE',body:{expectedRevision:f.currentRevision()}})).status,200);
  }
});

test('a later zero-row membership mutation rolls back a previously successful content CAS in both transaction adapters',async t=>{
  for(const d1 of [false,true]){
    const f=await fixture(t,{d1}),saved=await f.store.load('workspace-a'),before=f.currentRevision();
    saved.payload.pages[0].page.title='This title must roll back';
    await assert.rejects(f.store.commit({workspaceId:'workspace-a',expectedRevision:before,payload:saved.payload,
      membershipChange:{kind:'update',id:'missing-membership',accountId:'other',previousRole:'member',role:'admin'}}),e=>e.code==='COLLABORATION_CONFLICT');
    assert.equal(f.currentRevision(),before);
    assert.equal((await f.store.load('workspace-a')).payload.pages[0].page.title,'Synthetic private page');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_transaction_guards').get().n,0);
  }
});

test('member lists are workspace-administrator only and contain no session, digest, job payload or unrelated-workspace records',async t=>{
  const f=await fixture(t);
  const owner=await f.request('/workspaces/workspace-a/members',{method:'GET'});
  assert.equal(owner.status,200);const body=await owner.json();assert.equal(body.members.length,3);
  assert.equal(body.members.find(p=>p.currentUser).accountId,'owner');
  assert.equal(body.members.every(p=>Object.keys(p).sort().join(',')==='accountId,currentUser,email,emailVerified,id,role'),true);
  assert.equal((await f.request('/workspaces/workspace-a/members',{method:'GET',account:'manager'})).status,404);
  assert.equal((await f.request('/workspaces/workspace-b/members',{method:'GET'})).status,404);
});

test('body bounds, malformed JSON, non-JSON requests and canonical same-account guard fail before mutation',async t=>{
  const f=await fixture(t),path=origin+'/api/collaboration/workspaces/workspace-a/invitations';
  const request=(body,contentType='application/json')=>f.service.handle(new Request(path,{method:'POST',headers:{Origin:origin,'Content-Type':contentType,'X-Yumunio-Expected-Account':'owner'},body}));
  assert.equal((await request('{broken')).status,400);
  assert.equal((await request('x'.repeat(16385))).status,413);
  assert.equal((await request('{}','text/plain')).status,415);
  assert.equal(f.currentRevision(),1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,0);
});

test('runner does not count provider acceptance after its lease was cancelled during transport',async t=>{
  let f;
  f=await fixture(t,{sendMail:async()=>{
    await f.request('/workspaces/workspace-a/invitations/invitation-1',{method:'DELETE',body:{expectedRevision:f.currentRevision()}});
    return {status:'accepted'};
  }});
  await f.invite();const result=await f.service.runJobs();
  assert.equal(result.accepted,0);assert.equal(f.db.prepare('SELECT status FROM yumunio_mail_jobs').get().status,'cancelled');
});


test('one mail enqueue participates in a caller-owned SDK transaction without nested BEGIN and rolls back with that transaction',async t=>{
  const f=await fixture(t),message={to:'recipient@studio.example.invalid',subject:'SDK transaction',text:'Synthetic verification token'};
  f.db.exec('BEGIN IMMEDIATE');
  const result=await f.service.enqueueMail(message);assert.equal(result.status,'queued');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,1);
  f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,0);
  const second=await f.service.enqueueMail(message);assert.equal(second.status,'queued');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_mail_jobs').get().n,1);
});


test('invitation and new-member admission refuse to cross the existing bounded workspace read limits',async t=>{
  const f=await fixture(t);await f.invite();const token=await f.token(),saved=await f.store.load('workspace-a');
  const originalLoad=f.store.load.bind(f.store);
  f.store.load=async id=>({...await originalLoad(id),invitations:Array.from({length:2000},(_,index)=>({
    ...saved.invitations[0],invitation:{...saved.invitations[0].invitation,id:'bounded-invite-'+index,tokenHash:index.toString(16).padStart(64,'0')},
  }))});
  assert.equal((await f.invite({requestId:'past-invitation-limit'})).status,413);
  f.store.load=async id=>({...await originalLoad(id),principals:[...saved.principals,...Array.from({length:997},(_,index)=>({
    id:'bounded-member-'+index,accountId:'bounded-user-'+index,email:'bounded-'+index+'@studio.example.invalid',emailVerified:true,role:'member',
  }))]});
  assert.equal((await f.request('/accept',{account:'recipient',body:{invitationId:'invitation-1',token}})).status,413);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM yumunio_memberships WHERE userId=?').get('recipient').n,0);
});

test('URL-safe invitation tokens containing hyphen and underscore work for review and one-use acceptance',async t=>{
  const f=await fixture(t);assert.equal((await f.invite()).status,201);
  const token='-_'.repeat(24),row=f.db.prepare('SELECT invitation_json FROM yumunio_collaboration_invitations WHERE id=?').get('invitation-1');
  const invitation=JSON.parse(row.invitation_json);invitation.tokenHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  f.db.prepare('UPDATE yumunio_collaboration_invitations SET invitation_json=? WHERE id=?').run(JSON.stringify(invitation),'invitation-1');
  const body={invitationId:'invitation-1',token};
  const reviewed=await f.request('/preview',{account:'recipient',body});assert.equal(reviewed.status,200);assert.equal((await reviewed.json()).pageTitle,'Synthetic private page');
  assert.equal(f.db.prepare('SELECT status FROM yumunio_collaboration_invitations').get().status,'pending');
  assert.equal((await f.request('/accept',{account:'recipient',body})).status,200);assert.equal((await f.request('/accept',{account:'recipient',body})).status,404);
});
