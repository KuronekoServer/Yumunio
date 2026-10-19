import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SharingClient} from '../public/share-data.js';
import {InvitationFlow,readInvitationLink} from '../public/invitation-flow.js';
import {validateCatalogParity} from '../public/i18n.js';
const token='A'.repeat(46)+'-_',invitationId='invite-fixture',accountId='account-a';
const link=()=>readInvitationLink(new URL('https://local.example/account?invite='+invitationId+'&token='+token));
const preview={invitationId,purpose:'page-guest',workspaceId:'workspace',workspaceName:'Private workspace',pageId:'page',pageTitle:'Private page',role:'editor',includeDescendants:false,expiresAt:'2026-10-16T00:00:00.000Z'};
function invitationFixture(){const calls=[];let actor=accountId,verified=true,previewStatus=200;const flow=new InvitationFlow(link(),{fetcher:async(path,options)=>{calls.push({path,options});if(path==='/api/auth/get-session')return Response.json({user:{id:actor,emailVerified:verified,email:actor+'@example.invalid'}});if(path==='/api/collaboration/preview')return Response.json(previewStatus===200?{...preview,privateToken:'must not escape'}:{error:{message:token}},{status:previewStatus});if(path==='/api/collaboration/accept')return Response.json({revision:7,workspaceId:'workspace',pageId:'page',role:'guest'});throw new Error();}});return{flow,calls,actor:value=>actor=value,verified:value=>verified=value,previewStatus:value=>previewStatus=value};}
test('invitation tokens are validated, retained only in private memory and sent in JSON bodies rather than request URLs',async()=>{
  const f=invitationFixture();assert.equal(f.flow.valid,true);assert.doesNotMatch(JSON.stringify(f.flow.snapshot),new RegExp(token));await f.flow.preview(accountId);
  assert.equal(f.flow.valid,true);assert.doesNotMatch(JSON.stringify(f.flow.snapshot),/privateToken|must not escape|AAAAAAAA/);
  const sent=f.calls.find(call=>call.path.endsWith('/preview'));assert.deepEqual(JSON.parse(sent.options.body),{invitationId,token});assert.equal(sent.options.headers['X-Yumunio-Expected-Account'],accountId);assert.doesNotMatch(sent.path,/token|AAAAAAAA/);assert.equal(sent.options.credentials,'same-origin');
});
test('invitation acceptance requires current verified actor, successful preview and explicit consent before a single consume request',async()=>{
  const f=invitationFixture();await assert.rejects(f.flow.accept(accountId,{confirmed:true}),{code:'CONSENT_REQUIRED'});assert.equal(f.calls.length,0);
  await f.flow.preview(accountId);await assert.rejects(f.flow.accept(accountId),{code:'CONSENT_REQUIRED'});assert.equal(f.calls.filter(call=>call.path.endsWith('/accept')).length,0);
  const result=await f.flow.accept(accountId,{confirmed:true});assert.deepEqual(result,{revision:7,workspaceId:'workspace',pageId:'page',role:'guest'});assert.equal(f.flow.valid,false);assert.equal(f.calls.filter(call=>call.path.endsWith('/accept')).length,1);assert.doesNotMatch(JSON.stringify(f.flow.snapshot),new RegExp(token));
});
test('actor changes or lost verification clear invitation previews and never send a consume request',async()=>{
  for(const change of ['actor','verified']){const f=invitationFixture();await f.flow.preview(accountId);if(change==='actor')f.actor('account-b');else f.verified(false);await assert.rejects(f.flow.accept(accountId,{confirmed:true}));assert.equal(f.flow.snapshot.preview,null);assert.equal(f.calls.filter(call=>call.path.endsWith('/accept')).length,0);}
});
test('malformed or unauthenticated invitation links reveal no details and backend error messages are discarded',async()=>{
  for(const search of ['?invite=x','?token='+token,'?invite=x&token=bad','?invite=x&invite=y&token='+token]){const value=readInvitationLink(new URL('https://local.example/account'+search));const flow=new InvitationFlow(value);assert.equal(flow.valid,false);}
  const f=invitationFixture();f.previewStatus(404);await assert.rejects(f.flow.preview(accountId),error=>error.code==='INVITATION_UNAVAILABLE'&&!error.message.includes(token));assert.equal(f.flow.snapshot.preview,null);assert.doesNotMatch(JSON.stringify(f.flow.snapshot),/Private workspace/);
});
function sharingFixture({role='member',pageManage=true,changed=false,conflict=false}={}){
  const calls=[];let current=accountId;const paths={};const client=new SharingClient({workspaceId:'workspace',pageId:'page',accountId,fetcher:async(path,options)=>{
    calls.push({path,options});if(path==='/api/auth/get-session')return Response.json({user:{id:current,email:'a@example.invalid',emailVerified:true}});
    if(options.method!=='GET'){const body=options.body?JSON.parse(options.body):{},result=path.endsWith('/grants')?{revision:4,grant:{id:'new-grant',workspaceId:'workspace',pageId:'page',accountId:body.accountId,permission:body.permission,includeDescendants:body.includeDescendants===true,status:'active'}}:path.includes('/grants/')?{revision:4,revoked:true}:{revision:4};return Response.json(conflict?{error:{code:'COLLABORATION_CONFLICT',message:'private SQL'}}:result,{status:conflict?409:200});}
    if(path==='/api/auth/organization/list')return Response.json([{id:'workspace',name:'Workspace'}]);
    if(path.endsWith('/pages'))return Response.json({revision:3,role,pages:[{id:'page',title:'Page',capabilities:pageManage?['read','manage','invite']:['read']}]});
    if(path.endsWith('/invitations'))return Response.json({revision:changed?4:3,invitations:[{id:'invite',pageId:'page',recipientEmail:'invited@example.invalid'}]});
    if(path.endsWith('/members'))return Response.json({revision:3,members:[{id:'membership-a',accountId,email:'a@example.invalid',emailVerified:true,role}]});
    if(path.endsWith('/grants'))return Response.json({revision:3,grants:[{id:'grant',accountId,permission:'full'}]});throw new Error('Unexpected route');
  }});return{client,calls,actor:value=>current=value};
}
test('sharing loads page grants for managers while member emails remain gated to workspace owner/admin roles',async()=>{
  const f=sharingFixture();const data=await f.client.load();assert.equal(data.canManagePage,true);assert.equal(data.canManageMembers,false);assert.deepEqual(data.members,[]);assert.equal(f.calls.some(call=>call.path.endsWith('/members')),false);
  const owner=sharingFixture({role:'owner'});const owned=await owner.client.load();assert.equal(owned.canInviteAdmin,true);assert.equal(owned.members.length,1);
  const viewer=sharingFixture({pageManage:false});const viewed=await viewer.client.load();assert.equal(viewed.canManagePage,false);assert.equal(viewer.calls.some(call=>call.path.endsWith('/grants')),false);
  for(const call of f.calls)assert.equal(call.options.headers['X-Yumunio-Expected-Account'],accountId);
});
test('sharing mutations freeze expected actor and revision, do not automatically retry 409 and retain caller drafts',async()=>{
  const f=sharingFixture({conflict:true}),draft={expectedRevision:3,requestId:'request',purpose:'page-guest',email:'draft@example.invalid',role:'editor',pageId:'page',includeDescendants:false},before=structuredClone(draft);
  await assert.rejects(f.client.invite(draft),{status:409,code:'COLLABORATION_CONFLICT'});assert.deepEqual(draft,before);const posts=f.calls.filter(call=>call.options.method!=='GET');assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].options.body),draft);assert.equal(posts[0].options.headers['X-Yumunio-Expected-Account'],accountId);
  const changed=sharingFixture();changed.actor('account-b');await assert.rejects(changed.client.grant({expectedRevision:3,accountId:'account-b',permission:'viewer'}),{code:'ACTOR_CHANGED'});assert.equal(changed.calls.some(call=>call.options.method!=='GET'),false);
});
test('sharing refuses mixed-revision snapshots and constructs only fixed workspace/page routes for administrative actions',async()=>{
  const mixed=sharingFixture({changed:true});await assert.rejects(mixed.client.load(),{status:409});
  const f=sharingFixture();await f.client.invitation('invite','resend',3);await f.client.member('membership-a',{expectedRevision:3,role:'member'});await f.client.revoke('grant',3);
  const actions=f.calls.filter(call=>call.options.method!=='GET');assert.deepEqual(actions.map(call=>[call.path,call.options.method]),[['/api/collaboration/workspaces/workspace/invitations/invite/resend','POST'],['/api/collaboration/workspaces/workspace/members/membership-a','PATCH'],['/api/content/workspaces/workspace/pages/page/grants/grant','DELETE']]);
  assert.throws(()=>new SharingClient({workspaceId:'../private',accountId}));assert.throws(()=>f.client.invitation('../private','cancel',3));
});
test('sharing and invitation locale resources preserve JA/EN key parity and tokens are stripped before the account page performs its first brand fetch',async()=>{
  const catalogs=await Promise.all(['ja','en'].map(locale=>readFile(new URL('../public/share-locales/'+locale+'.json',import.meta.url),'utf8').then(JSON.parse)));assert.equal(validateCatalogParity(...catalogs).valid,true);
  const source=await readFile(new URL('../public/account.js',import.meta.url),'utf8');assert.ok(source.indexOf('history.replaceState')<source.indexOf('await loadInstanceConfig'));assert.ok(source.indexOf('readInvitationLink(raw)')<source.indexOf('history.replaceState'));assert.doesNotMatch(source,/sessionStorage|localStorage/);
});
test('browser fetch receives no class instance as its receiver',async()=>{
  let calls=0;
  function fetcher(path){assert.equal(this,undefined);calls++;return Promise.resolve(Response.json({user:{id:accountId,emailVerified:true}}));}
  const client=new SharingClient({workspaceId:'workspace',accountId,fetcher});
  await client.verifyActor();
  const flow=new InvitationFlow(link(),{fetcher});
  await assert.rejects(flow.preview(accountId));
  assert.equal(calls,3);
});

test('individual sharing validates the exact committed subject, scope and revision and verifies the actor again after writes',async()=>{
 const expected={revision:4,grant:{id:'grant',workspaceId:'workspace',pageId:'page',accountId:'recipient',permission:'editor',includeDescendants:true,status:'active'}};
 for(const change of [value=>{value.revision=3;},value=>{value.grant.pageId='other';},value=>{value.grant.accountId='other';},value=>{value.grant.permission='full';},value=>{value.grant.includeDescendants=false;},value=>{value.extra=true;}]){
  let posts=0;const result=structuredClone(expected);change(result);const client=new SharingClient({workspaceId:'workspace',pageId:'page',accountId,fetcher:async(path,options)=>{if(options.method==='POST'){posts++;return Response.json(result);}return Response.json({user:{id:accountId,emailVerified:true}});}});
  await assert.rejects(client.grant({expectedRevision:3,accountId:'recipient',permission:'editor',includeDescendants:true}),{code:'INVALID_RESPONSE'});assert.equal(posts,1);
 }
 let actor=accountId,posts=0;const client=new SharingClient({workspaceId:'workspace',pageId:'page',accountId,fetcher:async(path,options)=>{if(options.method==='POST'){posts++;actor='other-account';return Response.json(expected);}return Response.json({user:{id:actor,emailVerified:true}});}});await assert.rejects(client.grant({expectedRevision:3,accountId:'recipient',permission:'editor',includeDescendants:true}),{code:'ACTOR_CHANGED'});assert.equal(posts,1);
});
