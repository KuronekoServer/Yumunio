import {accountContentPolicy,preserveTeamspaceOwners} from './content-policy.js';
import { assertId, assertJsonSerializable, assertPlainObject, validateInvitation, createPageAccessEvaluator, evaluateWorkspaceAccess, evaluateInvitationAcceptance } from '@yumunio/domain';
import { constantTimeEqual, generateRandomString } from 'better-auth/crypto';
import { createDomainPolicy, isEmailAllowed } from './config.js';
import { validateMailMessage } from './mail.js';
import { validateContentPayload } from './content.js';
import { createDurableMailQueue, prepareMailJob } from './jobs.js';
const encoder=new TextEncoder(),headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
const json=(body,status=200)=>Response.json(body,{status,headers});
export class CollaborationError extends Error { constructor(code='COLLABORATION_NOT_FOUND',status=404){super('The collaboration request could not be completed.');this.name='CollaborationError';this.code=code;this.status=status;} }
const fail=(code='COLLABORATION_NOT_FOUND',status=404)=>{throw new CollaborationError(code,status);};
const invalid=()=>fail('INVALID_COLLABORATION',400),conflict=()=>fail('COLLABORATION_CONFLICT',409);
function object(value,allowed,required=allowed){assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))invalid();}
function revision(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)invalid();return value;}
const digest=async token=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
function payloadOf(saved,workspaceId){try{return validateContentPayload(saved.revision===0&&saved.payload===null?{schemaVersion:1,pages:[],grants:[],grantBindings:[]}:saved.payload,workspaceId);}catch{fail('COLLABORATION_UNAVAILABLE',503);}}
function policyOf(saved,payload,workspaceId,extraAccount){return accountContentPolicy(payload,saved.principals,workspaceId,{extraAccount,invitations:saved.invitations.map(row=>validateInvitation(row.invitation))});}

function publicInvitation(row){const i=row.invitation;return {id:i.id,purpose:i.purpose,recipientEmail:i.recipientEmail,role:i.role,pageId:i.pageId,includeDescendants:i.includeDescendants,expiresAt:i.expiresAt,status:row.status,generation:row.generation};}
function canInvite(state,accountId,invitation){
  if(invitation.purpose==='workspace-member')return evaluateWorkspaceAccess(state,{accountId,workspaceId:invitation.workspaceId}).capabilities.includes(invitation.role==='admin'?'inviteAdmin':'inviteMember');
  return createPageAccessEvaluator(state)({accountId,workspaceId:invitation.workspaceId,pageId:invitation.pageId}).capabilities.includes('invite');
}
function preservePageManagers(before,after,accountId,workspaceId){
  const untrash=state=>({...state,pages:state.pages.map(page=>({...page,trashedAt:null})),teamspaces:(state.teamspaces??[]).map(team=>({...team,archivedAt:null}))});
  const initial=untrash(before),result=untrash(after),checkBefore=createPageAccessEvaluator(initial),checkAfter=createPageAccessEvaluator(result);
  const pages=new Map(result.pages.map(page=>[page.id,page])),fullByPage=new Map();
  for(const grant of result.grants.filter(g=>g.status==='active'&&g.permission==='full')){
    if(!fullByPage.has(grant.pageId))fullByPage.set(grant.pageId,[]);fullByPage.get(grant.pageId).push(grant);
  }
  for(const page of initial.pages){
    if(!checkBefore({accountId,workspaceId,pageId:page.id}).capabilities.includes('manage'))continue;
    const candidates=new Set(result.memberships.filter(member=>member.status==='active').map(member=>member.accountId)),seen=new Set();let cursor=pages.get(page.id);
    while(cursor&&!seen.has(cursor.id)){
      seen.add(cursor.id);
      for(const grant of fullByPage.get(cursor.id)??[])if(cursor.id===page.id||grant.includeDescendants)candidates.add(grant.accountId);
      if(!cursor.inheritPermissions)break;cursor=pages.get(cursor.parentId);
    }
    if(![...candidates].some(id=>checkAfter({accountId:id,workspaceId,pageId:page.id}).capabilities.includes('manage')))fail('LAST_PAGE_MANAGER',409);
  }
}
async function readJson(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))fail('CONTENT_TYPE',415);
  const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16384))fail('COLLABORATION_TOO_LARGE',413);
  if(!request.body)invalid();const reader=request.body.getReader(),parts=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){try{await reader.cancel();}catch{}fail('COLLABORATION_TOO_LARGE',413);}parts.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
  }finally{reader.releaseLock();}
}
export function createCollaborationService({store,origin,secret,domainPolicy=createDomainPolicy(),resolveSession,sendMail,now=()=>new Date().toISOString(),createId=()=>crypto.randomUUID(),invitationTtlMs=86400000}={}){
  if(!store||typeof store.load!=='function'||typeof store.commit!=='function'||typeof resolveSession!=='function'||new URL(origin).origin!==origin||typeof secret!=='string'||secret.length<32||secret.length>4096||!Number.isSafeInteger(invitationTtlMs)||invitationTtlMs<60000||invitationTtlMs>7*86400000)throw new Error('Invalid collaboration configuration.');
  const domain=createDomainPolicy(domainPolicy),queue=createDurableMailQueue({store,secret,sendMail,now,createId});
  const currentTime=()=>{const value=now();if(typeof value!=='string'||new Date(value).toISOString()!==value)throw new Error('Invalid service clock.');return value;};
  const load=async(workspaceId,accountId)=>{
    const saved=await store.load(assertId(workspaceId));if(!saved)fail();
    const actor=saved.principals.find(p=>p.accountId===accountId&&p.emailVerified);if(!actor)fail();
    const payload=payloadOf(saved,workspaceId),state=policyOf(saved,payload,workspaceId);return {saved,actor,payload,state};
  };
  const mailJob=async(invitation,generation,token,current)=>{
    const link=new URL('/account.html',origin);link.searchParams.set('invite',invitation.id);link.searchParams.set('token',token);
    return prepareMailJob({to:invitation.recipientEmail,subject:'Yumunio: 共有への招待',text:'本人が招待内容を確認して承諾する場合だけ、次の画面で操作してください。\n'+link.href},
      {secret,id:createId(),dedupeKey:'invitation:'+invitation.id+':'+generation,now:current,expiresAt:invitation.expiresAt,invitationId:invitation.id,invitationGeneration:generation});
  };
  const commit=async input=>{try{return await store.commit(input);}catch(error){if(error?.code==='COLLABORATION_CONFLICT')conflict();throw error;}};
  const issue=async(accountId,workspaceId,data)=>{
    object(data,['expectedRevision','requestId','purpose','email','role','pageId','includeDescendants'],['expectedRevision','requestId','purpose','email','role']);
    revision(data.expectedRevision);assertId(data.requestId);
    const {saved,actor,payload,state}=await load(workspaceId,accountId);
    if(saved.revision!==data.expectedRevision)conflict();
    if(saved.invitations.length>=2000)fail('COLLABORATION_LIMIT',413);
    const email=validateMailMessage({to:data.email,subject:'Invitation',text:'Invitation'}).to.toLowerCase();
    if(!isEmailAllowed(email,domain))invalid();
    const current=currentTime(),token=generateRandomString(48);
    const invitation=validateInvitation({id:data.requestId,workspaceId,purpose:data.purpose,tokenHash:await digest(token),recipientEmail:email,recipientAccountId:null,issuerAccountId:accountId,
      role:data.role,pageId:data.pageId??null,includeDescendants:data.includeDescendants??false,expiresAt:new Date(Date.parse(current)+invitationTtlMs).toISOString(),revokedAt:null,acceptedAt:null});
    // This phase delegates a single page only. Descendant delegation requires a separate explicit review.
    if(invitation.includeDescendants||!canInvite(state,accountId,invitation))fail();
    const existing=saved.invitations.find(row=>row.invitation.id===invitation.id);
    if(existing)conflict();
    const row={invitation,generation:1,issuerMembershipId:actor.id,status:'pending'},job=await mailJob(invitation,1,token,current);
    const result=await commit({workspaceId,expectedRevision:saved.revision,payload,guards:[actor],invitationChange:{value:row},jobs:[job]});
    return {revision:result.revision,invitation:publicInvitation(row),mailStatus:'queued'};
  };
  const modify=async(accountId,workspaceId,id,data,resend)=>{
    object(data,['expectedRevision']);revision(data.expectedRevision);const {saved,actor,payload,state}=await load(workspaceId,accountId);
    if(data.expectedRevision!==saved.revision)conflict();
    const found=saved.invitations.find(row=>row.invitation.id===id);if(!found||found.status!=='pending'||!canInvite(state,accountId,found.invitation))fail();
    const current=currentTime(),invitation=structuredClone(found.invitation);let generation=found.generation,jobs=[];
    if(resend){
      if(!isEmailAllowed(invitation.recipientEmail,domain))invalid();if(generation>=Number.MAX_SAFE_INTEGER)invalid();
      const token=generateRandomString(48);invitation.tokenHash=await digest(token);invitation.issuerAccountId=accountId;invitation.expiresAt=new Date(Date.parse(current)+invitationTtlMs).toISOString();generation++;
      jobs=[await mailJob(invitation,generation,token,current)];
    }else invitation.revokedAt=current;
    const value={invitation:validateInvitation(invitation),generation,issuerMembershipId:resend?actor.id:found.issuerMembershipId,status:resend?'pending':'revoked'};
    const result=await commit({workspaceId,expectedRevision:saved.revision,payload,guards:[actor],invitationChange:{value,expectedGeneration:found.generation},jobs,cancelInvitationId:id});
    return {revision:result.revision,invitation:publicInvitation(value),...(resend?{mailStatus:'queued'}:{})};
  };
  const review=async(accountId,data)=>{
    object(data,['invitationId','token']);assertId(data.invitationId);
    if(typeof data.token!=='string'||!/^[A-Za-z0-9_-]{48}$/.test(data.token))fail();
    const found=await store.invitation(data.invitationId),account=await store.account(accountId);
    if(!found||found.status!=='pending'||!account?.emailVerified||!isEmailAllowed(account.email,domain))fail();
    const invitation=validateInvitation(found.invitation),tokenHash=await digest(data.token);
    if(!constantTimeEqual(tokenHash,invitation.tokenHash))fail();
    const workspaceId=invitation.workspaceId,saved=await store.load(workspaceId);if(!saved)fail();
    const currentInvite=saved.invitations.find(row=>row.invitation.id===invitation.id);
    if(!currentInvite||currentInvite.status!=='pending'||currentInvite.generation!==found.generation||!constantTimeEqual(currentInvite.invitation.tokenHash,tokenHash))fail();
    const issuer=saved.principals.find(p=>p.accountId===invitation.issuerAccountId&&p.id===found.issuerMembershipId&&p.emailVerified);if(!issuer)fail();
    if(!saved.principals.some(p=>p.accountId===accountId)&&saved.principals.length>=1000)fail('COLLABORATION_LIMIT',413);
    const payload=payloadOf(saved,workspaceId),state=policyOf(saved,payload,workspaceId,account),current=currentTime();
    const decision=evaluateInvitationAcceptance(state,{accountId,invitationId:invitation.id,purpose:invitation.purpose,tokenHash,now:current});if(!decision.allowed)fail();
    return {account,found,invitation,workspaceId,saved,currentInvite,issuer,payload,state,current,decision};
  };
  const preview=async(accountId,data)=>{
    const {invitation,workspaceId,saved,payload}=await review(accountId,data);
    const page=invitation.pageId?payload.pages.find(row=>row.page.id===invitation.pageId):null;
    return {invitationId:invitation.id,purpose:invitation.purpose,workspaceId,workspaceName:saved.workspaceName,
      pageId:invitation.pageId,pageTitle:page?.page.title??null,role:invitation.role,includeDescendants:invitation.includeDescendants,expiresAt:invitation.expiresAt};
  };
  const accept=async(accountId,data)=>{
    const {account,found,invitation,workspaceId,saved,issuer,payload,current,decision}=await review(accountId,data);
    const target=saved.principals.find(p=>p.accountId===accountId);
    let membershipChange=null,membershipId=target?.id;
    if(decision.plan.membershipRole){
      membershipId=target?.id??assertId(createId());
      membershipChange=target?{kind:'update',id:membershipId,accountId,previousRole:target.role,role:decision.plan.membershipRole}:
        {kind:'insert',id:membershipId,accountId,role:decision.plan.membershipRole,createdAt:current};
    }
    if(!membershipId)fail();
    if(decision.plan.pageGrant){
      const grantId=assertId(createId()),scope=decision.plan.pageGrant;
      payload.grants.push({id:grantId,workspaceId,pageId:scope.pageId,accountId,permission:scope.permission,includeDescendants:scope.includeDescendants,status:'active'});
      payload.grantBindings.push({grantId,membershipId});
    }
    const accepted=validateInvitation({...invitation,recipientAccountId:accountId,acceptedAt:current});
    const guards=[issuer,...(target&&target.id!==issuer.id?[target]:[])];
    const result=await commit({workspaceId,expectedRevision:saved.revision,payload:validateContentPayload(payload,workspaceId),guards,accountGuard:account,membershipChange,
      invitationChange:{value:{invitation:accepted,generation:found.generation,issuerMembershipId:found.issuerMembershipId,status:'accepted'},expectedGeneration:found.generation},cancelInvitationId:invitation.id});
    return {revision:result.revision,workspaceId,pageId:decision.plan.pageGrant?.pageId??null,role:decision.plan.membershipRole??target.role};
  };
  const changeMember=async(accountId,workspaceId,membershipId,data,remove)=>{
    object(data,remove?['expectedRevision']:['expectedRevision','role']);revision(data.expectedRevision);
    if(!remove&&!['owner','admin','member','guest'].includes(data.role))invalid();
    const {saved,actor,payload,state}=await load(workspaceId,accountId);
    const target=saved.principals.find(p=>p.id===membershipId);if(!target||!evaluateWorkspaceAccess(state,{accountId,workspaceId}).capabilities.includes('manageMembers'))fail();
    if(saved.revision!==data.expectedRevision)conflict();
    if(actor.role!=='owner'&&(target.role==='owner'||target.role==='admin'||!remove&&['owner','admin'].includes(data.role)))fail();
    const lastOwner=target.role==='owner'&&target.emailVerified&&(remove||data.role!=='owner');
    if(lastOwner&&saved.principals.filter(p=>p.role==='owner'&&p.emailVerified).length<2)fail('LAST_WORKSPACE_OWNER',409);
    if(!remove&&target.role===data.role)return {revision:saved.revision,changed:false};
    const guards=[actor,...(target.id===actor.id?[]:[target])];
    if(remove)for(const grant of payload.grants.filter(g=>g.accountId===target.accountId))grant.status='revoked';
    const resultingPrincipals=remove?saved.principals.filter(p=>p.id!==target.id):saved.principals.map(p=>p.id===target.id?{...p,role:data.role}:p);
    const resultingPolicy=policyOf({...saved,principals:resultingPrincipals},payload,workspaceId);if(!preserveTeamspaceOwners(state,resultingPolicy))fail('LAST_TEAMSPACE_OWNER',409);
    preservePageManagers(state,resultingPolicy,target.accountId,workspaceId);
    const membershipChange={kind:remove?'delete':'update',id:target.id,accountId:target.accountId,previousRole:target.role,...(remove?{}:{role:data.role})};
    const result=await commit({workspaceId,expectedRevision:saved.revision,payload:validateContentPayload(payload,workspaceId),guards,membershipChange,lastOwner,principalSnapshot:saved.principals});
    return {revision:result.revision,changed:true};
  };
  const handle=async request=>{
    try{
      const url=new URL(request.url),suppliedOrigin=request.headers.get('origin');
      if(url.origin!==origin||url.username||url.password||url.search||url.hash)fail('COLLABORATION_REQUEST_REJECTED',403);
      if(suppliedOrigin!==null&&suppliedOrigin!==origin||request.method!=='GET'&&suppliedOrigin!==origin)fail('COLLABORATION_REQUEST_REJECTED',403);
      const match=/^\/api\/collaboration\/workspaces\/([A-Za-z0-9._:-]+)\/(invitations|members)(?:\/([A-Za-z0-9._:-]+)(?:\/(resend))?)?$/.exec(url.pathname);
      const acceptance=url.pathname==='/api/collaboration/accept',previewing=url.pathname==='/api/collaboration/preview';if(!match&&!acceptance&&!previewing)return json({error:{code:'COLLABORATION_NOT_FOUND'}},404);
      const session=await resolveSession(request),accountId=session?.user?.id;
      if(!accountId||!session.user.emailVerified)fail();assertId(accountId);
      if((request.method!=='GET'||request.headers.has('x-yumunio-expected-account'))&&request.headers.get('x-yumunio-expected-account')!==accountId)fail();
      const account=await store.account(accountId);if(!account?.emailVerified)fail();
      if(acceptance||previewing){if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);return json(await (previewing?preview:accept)(accountId,await readJson(request)));}
      const [,workspaceId,kind,id,action]=match;assertId(workspaceId);if(id)assertId(id);
      if(kind==='members'){
        if(request.method==='GET'&&!id){
          const {saved,state}=await load(workspaceId,accountId);
          if(!evaluateWorkspaceAccess(state,{accountId,workspaceId}).capabilities.includes('manageMembers'))fail();
          return json({revision:saved.revision,members:saved.principals.map(p=>({id:p.id,accountId:p.accountId,email:p.email,emailVerified:p.emailVerified,role:p.role,currentUser:p.accountId===accountId}))});
        }
        if(!id||action||!['PATCH','DELETE'].includes(request.method))fail('METHOD_NOT_ALLOWED',405);
        return json(await changeMember(accountId,workspaceId,id,await readJson(request),request.method==='DELETE'));
      }
      if(request.method==='GET'&&!id){
        const {saved,state}=await load(workspaceId,accountId);
        return json({revision:saved.revision,invitations:saved.invitations.filter(row=>canInvite(state,accountId,row.invitation)).map(publicInvitation)});
      }
      if(request.method==='POST'&&!id)return json(await issue(accountId,workspaceId,await readJson(request)),201);
      if(id&&((action==='resend'&&request.method==='POST')||(!action&&request.method==='DELETE')))return json(await modify(accountId,workspaceId,id,await readJson(request),action==='resend'));
      fail('METHOD_NOT_ALLOWED',405);
    }catch(error){
      if(error instanceof CollaborationError)return json({error:{code:error.code,message:error.message}},error.status);
      if(error?.code==='INVALID_INPUT'||error?.code==='MAIL_INVALID_MESSAGE')return json({error:{code:'INVALID_COLLABORATION'}},400);
      return json({error:{code:'COLLABORATION_UNAVAILABLE'}},503);
    }
  };
  return Object.freeze({handle,queue,runJobs:queue.runDue,enqueueMail:queue.enqueue});
}
