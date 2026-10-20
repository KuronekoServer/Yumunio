import {assertId,assertPlainObject,assertJsonSerializable,createPageAccessEvaluator,liveTeamspaceMember,pageTeamspace,TEAMSPACE_LIMITS,createTeamspaceCopy} from '@yumunio/domain';
import {accountContentPolicy,teamspaceVisible,pagePlacement,preserveTeamspaceOwners} from './content-policy.js';
import {invalidateRooms} from './content-room.js';
import {rememberPage,trimHistory} from './content-history.js';
import {handleTeamspaceJoinRequest} from './content-teamspace-requests.js';

export class ContentTeamspaceError extends Error{constructor(code='INVALID_TEAMSPACE',status=400){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new ContentTeamspaceError(code,status);},missing=()=>fail('CONTENT_NOT_FOUND',404),conflict=()=>fail('CONTENT_CONFLICT',409);
const json=value=>Response.json(value,{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
function exact(value,fields){assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key)))fail('INVALID_TEAMSPACE',400);}
function version(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('INVALID_REVISION',400);}
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
const currentPolicy=ctx=>accountContentPolicy(ctx.payload,ctx.saved.principals,ctx.workspaceId);
function teamFor(ctx,id){const team=ctx.payload.teamspaces?.find(team=>team.id===id);if(!team||!teamspaceVisible(currentPolicy(ctx),team,ctx.accountId))missing();return team;}
function memberFor(ctx,team){return liveTeamspaceMember(currentPolicy(ctx),team.id,ctx.accountId);}
function manage(ctx,team){if(memberFor(ctx,team)?.role!=='owner')missing();}
function eligible(ctx){return ctx.actor.emailVerified&&ctx.actor.role!=='guest';}
export function requireTeamspaceCreate(payload,principals,workspaceId,accountId,teamspaceId){
 const policy=accountContentPolicy(payload,principals,workspaceId),team=policy.teamspaces.find(team=>team.id===teamspaceId),member=team&&liveTeamspaceMember(policy,team.id,accountId);
 if(!team||team.archivedAt!==null||!member||member.role!=='owner'&&team.defaultPermission!=='editor')missing();return team;
}
function projectTeam(ctx,team,policy=currentPolicy(ctx)){
 const member=liveTeamspaceMember(policy,team.id,ctx.accountId),capabilities=teamspaceVisible(policy,team,ctx.accountId)?['read']:[];
 if(member?.role==='owner')capabilities.push('manage');
 if(team.archivedAt===null&&member&&(member.role==='owner'||team.defaultPermission==='editor'))capabilities.push('createPage');
 if(team.archivedAt===null&&eligible(ctx)&&!member&&team.visibility==='open')capabilities.push('join');
 return{...structuredClone(team),role:member?.role??null,capabilities,memberCount:!teamspaceVisible(policy,team,ctx.accountId)?0:(ctx.payload.teamspaceMembers??[]).filter(row=>row.teamspaceId===team.id&&liveTeamspaceMember(policy,team.id,row.accountId)).length};
}
function detail(ctx,team){
 const policy=currentPolicy(ctx),member=liveTeamspaceMember(policy,team.id,ctx.accountId),manager=member?.role==='owner';
 const members=member?(ctx.payload.teamspaceMembers??[]).filter(row=>row.teamspaceId===team.id&&liveTeamspaceMember(policy,team.id,row.accountId)).map(row=>{const person=ctx.saved.principals.find(person=>person.accountId===row.accountId);return{id:row.id,accountId:row.accountId,name:person.displayName||person.accountId,role:row.role,currentUser:row.accountId===ctx.accountId};}):[];
 return{workspaceId:ctx.workspaceId,revision:ctx.saved.revision,teamspace:projectTeam(ctx,team,policy),members,candidates:manager?ctx.saved.principals.filter(person=>person.emailVerified&&person.role!=='guest').map(person=>({accountId:person.accountId,name:person.displayName||person.accountId})):[]};
}
function teamPages(ctx,teamspaceId){const policy=currentPolicy(ctx);return ctx.payload.pages.filter(item=>pageTeamspace(policy,ctx.workspaceId,item.page.id)?.id===teamspaceId).map(item=>item.page.id);}
function ensureOwners(before,after){if(!preserveTeamspaceOwners(before,after))fail('LAST_TEAMSPACE_OWNER',409);}
function ensureManagers(before,after,principals,workspaceId){
 const untrash=policy=>({...policy,pages:policy.pages.map(page=>({...page,trashedAt:null})),teamspaces:(policy.teamspaces??[]).map(team=>({...team,archivedAt:null}))}),prior=createPageAccessEvaluator(untrash(before)),next=createPageAccessEvaluator(untrash(after));
 for(const page of before.pages){if(!principals.some(person=>prior({accountId:person.accountId,workspaceId,pageId:page.id}).capabilities.includes('manage')))continue;
  if(!principals.some(person=>next({accountId:person.accountId,workspaceId,pageId:page.id}).capabilities.includes('manage')))fail('LAST_PAGE_MANAGER',409);
 }
}
async function commit(ctx,{guards=[],snapshot=ctx.saved.principals,authorizeFresh}={}){
 const payload=ctx.validatePayload(ctx.payload,ctx.workspaceId);
 try{const result=await ctx.store.write(ctx.workspaceId,ctx.accountId,{expectedRevision:ctx.saved.revision,payload,actorMembershipId:ctx.actor.id,actorRole:ctx.actor.role,guardMemberships:guards,guardPrincipalSnapshot:snapshot});ctx.saved={...ctx.saved,revision:result.revision,payload};ctx.payload=payload;return result;}
 catch(error){if(error?.code!=='CONTENT_CONFLICT')throw error;const saved=await ctx.store.read(ctx.workspaceId,ctx.accountId),actor=saved?.principals.find(row=>row.accountId===ctx.accountId&&row.id===ctx.actor.id&&row.role===ctx.actor.role&&row.emailVerified);if(!actor)missing();const fresh={...ctx,saved,actor,payload:ctx.readPayload(saved,ctx.workspaceId)};authorizeFresh?.(fresh);conflict();}
}
function subtree(payload,pageId){const found=new Set([pageId]);for(let pass=0;pass<payload.pages.length;pass++){let changed=false;for(const item of payload.pages)if(item.page.parentId!==null&&found.has(item.page.parentId)&&!found.has(item.page.id)){found.add(item.page.id);changed=true;}if(!changed)break;}return payload.pages.filter(item=>found.has(item.page.id));}
function addPersonalGrant(ctx,payload,pageId){
 const bindingIds=new Set(payload.grantBindings.filter(row=>row.membershipId===ctx.actor.id).map(row=>row.grantId));
 if(payload.grants.some(row=>bindingIds.has(row.id)&&row.pageId===pageId&&row.accountId===ctx.accountId&&row.permission==='full'&&row.includeDescendants&&row.status==='active'))return;
 const grantId=assertId(ctx.createId());if(payload.grants.some(row=>row.id===grantId))fail('CONTENT_UNAVAILABLE',503);
 payload.grants.push({id:grantId,workspaceId:ctx.workspaceId,pageId,accountId:ctx.accountId,permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId,membershipId:ctx.actor.id});
}
async function assignmentReview(ctx,input){
 const item=ctx.payload.pages.find(item=>item.page.id===ctx.pageId);if(!item||item.page.trashedAt!==null||ctx.actor.role==='guest')missing();
 if(input.teamspaceId!==null){assertId(input.teamspaceId);requireTeamspaceCreate(ctx.payload,ctx.saved.principals,ctx.workspaceId,ctx.accountId,input.teamspaceId);}
 if(ctx.saved.revision!==input.expectedRevision||item.document.version!==input.expectedVersion)conflict();
 const affected=subtree(ctx.payload,ctx.pageId),before=currentPolicy(ctx),untrashed={...before,pages:before.pages.map(page=>({...page,trashedAt:null}))},can=createPageAccessEvaluator(untrashed);
 if(!affected.every(row=>can({accountId:ctx.accountId,workspaceId:ctx.workspaceId,pageId:row.page.id}).capabilities.includes('manage')))missing();
 const next=structuredClone(ctx.payload),root=next.pages.find(row=>row.page.id===ctx.pageId);root.page.parentId=null;root.inheritPermissions=false;
 next.teamspacePages=(next.teamspacePages??[]).filter(binding=>binding.pageId!==ctx.pageId);
 next.personalPageOwners=(next.personalPageOwners??[]).filter(owner=>owner.pageId!==ctx.pageId);
 if(input.teamspaceId!==null)next.teamspacePages.push({workspaceId:ctx.workspaceId,pageId:ctx.pageId,teamspaceId:input.teamspaceId});
 else next.personalPageOwners.push({workspaceId:ctx.workspaceId,pageId:ctx.pageId,accountId:ctx.accountId,membershipId:ctx.actor.id});
 addPersonalGrant(ctx,next,ctx.pageId);
 const after=accountContentPolicy(next,ctx.saved.principals,ctx.workspaceId),beforeAccess=createPageAccessEvaluator(before),afterAccess=createPageAccessEvaluator(after),readers=policy=>new Set(ctx.saved.principals.filter(person=>affected.some(row=>policy({accountId:person.accountId,workspaceId:ctx.workspaceId,pageId:row.page.id}).capabilities.includes('read'))).map(person=>person.accountId));
 const beforeReaders=readers(beforeAccess),afterReaders=readers(afterAccess),outside=[...afterReaders].filter(accountId=>accountId!==ctx.accountId&&(!input.teamspaceId||!liveTeamspaceMember(after,input.teamspaceId,accountId))).length;
 ensureManagers(before,after,ctx.saved.principals,ctx.workspaceId);
 const actorAfter=afterAccess({accountId:ctx.accountId,workspaceId:ctx.workspaceId,pageId:ctx.pageId});
 const review={workspaceId:ctx.workspaceId,revision:ctx.saved.revision,pageId:ctx.pageId,pageVersion:item.document.version,teamspaceId:input.teamspaceId,affectedPageCount:affected.length,beforeReaders:beforeReaders.size,afterReaders:afterReaders.size,addedReaders:[...afterReaders].filter(id=>!beforeReaders.has(id)).length,removedReaders:[...beforeReaders].filter(id=>!afterReaders.has(id)).length,outsideReadersPreserved:outside,existingGrantsPreserved:true,teamspaceOwnersHaveFullAccess:input.teamspaceId!==null,actorCanReadAfter:actorAfter.capabilities.includes('read'),actorCanManageAfter:actorAfter.capabilities.includes('manage')};
 const reviewDigest=await hash({purpose:'yumunio-teamspace-page-review-v1',accountId:ctx.accountId,review,payload:ctx.payload,principals:ctx.saved.principals.map(person=>[person.id,person.accountId,person.role,person.emailVerified]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)});
 return{review:{...review,reviewDigest},next,affected};
}
export async function handleTeamspaceRequest(ctx){
 const{request,teamspaceId,action}=ctx;
 if(ctx.pageId){
  if(request.method!==(action==='teamspace-review'?'POST':'PATCH'))fail('METHOD_NOT_ALLOWED',405);
  const body=await ctx.readJson(request);exact(body,action==='teamspace-review'?['expectedRevision','expectedVersion','teamspaceId']:['expectedRevision','expectedVersion','teamspaceId','reviewDigest','confirmAccessChange']);version(body.expectedRevision);version(body.expectedVersion);
  const reviewed=await assignmentReview(ctx,body);if(action==='teamspace-review')return json(reviewed.review);
  if(body.confirmAccessChange!==true||typeof body.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(body.reviewDigest))fail('INVALID_TEAMSPACE',400);if(body.reviewDigest!==reviewed.review.reviewDigest)fail('TEAMSPACE_REVIEW_CHANGED',409);
  ctx.payload=reviewed.next;const stamp=ctx.now();for(const prior of reviewed.affected){const item=ctx.payload.pages.find(row=>row.page.id===prior.page.id);if(item.document.version>=Number.MAX_SAFE_INTEGER)conflict();rememberPage(ctx.payload,item,{actorId:ctx.accountId,kind:'block-move',now:ctx.now,createId:ctx.createId});item.page.updatedAt=stamp;item.document.updatedAt=stamp;item.document.version++;}
  trimHistory(ctx.payload);invalidateRooms(ctx.payload,reviewed.affected.map(item=>item.page.id));await commit(ctx,{snapshot:ctx.saved.principals,authorizeFresh:fresh=>{const access=createPageAccessEvaluator(currentPolicy(fresh));if(!access({accountId:ctx.accountId,workspaceId:ctx.workspaceId,pageId:ctx.pageId}).capabilities.includes('manage'))missing();}});
  return json({workspaceId:ctx.workspaceId,revision:ctx.saved.revision,pageId:ctx.pageId,affectedPageCount:reviewed.affected.length,teamspaceId:body.teamspaceId});
 }
 if(!teamspaceId){
  if(request.method==='GET'){const policy=currentPolicy(ctx);return json({workspaceId:ctx.workspaceId,revision:ctx.saved.revision,canCreate:eligible(ctx),teamspaces:(ctx.payload.teamspaces??[]).filter(team=>teamspaceVisible(policy,team,ctx.accountId)).map(team=>projectTeam(ctx,team,policy))});}
  if(request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);if(!eligible(ctx))missing();
  const body=await ctx.readJson(request);exact(body,['expectedRevision','name','description','visibility','defaultPermission']);version(body.expectedRevision);if(body.expectedRevision!==ctx.saved.revision)conflict();
  const id=assertId(ctx.createId()),memberId=assertId(ctx.createId()),stamp=ctx.now();if(ctx.payload.teamspaces?.some(team=>team.id===id)||ctx.payload.teamspaceMembers?.some(member=>member.id===memberId))fail('CONTENT_UNAVAILABLE',503);
  const team={id,workspaceId:ctx.workspaceId,name:body.name,description:body.description,visibility:body.visibility,defaultPermission:body.defaultPermission,createdAt:stamp,updatedAt:stamp,archivedAt:null};
  ctx.payload.teamspaces??=[];ctx.payload.teamspaceMembers??=[];ctx.payload.teamspaces.push(team);ctx.payload.teamspaceMembers.push({id:memberId,workspaceId:ctx.workspaceId,teamspaceId:id,accountId:ctx.accountId,membershipId:ctx.actor.id,role:'owner'});await commit(ctx);return json(detail(ctx,team));
 }
 const team=teamFor(ctx,teamspaceId);if(action==='requests')return handleTeamspaceJoinRequest(ctx,{team,commit,teamFor,manage,exact,version,fail,missing,ensureOwners,ensureManagers,teamPages});if(request.method==='GET'&&action==='detail')return json(detail(ctx,team));
 const methods={detail:'PATCH',members:['POST','DELETE'],join:'POST',archive:'POST',duplicate:'POST'},allowed=methods[action];if(!(Array.isArray(allowed)?allowed.includes(request.method):request.method===allowed))fail('METHOD_NOT_ALLOWED',405);
 const deletingMember=action==='members'&&request.method==='DELETE';
 if(action!=='join'&&!deletingMember)manage(ctx,team);
 if(team.archivedAt!==null&&action!=='archive'&&!deletingMember)fail('TEAMSPACE_ARCHIVED',409);
 const body=await ctx.readJson(request);version(body?.expectedRevision);if(body.expectedRevision!==ctx.saved.revision)conflict();
 if(action==='duplicate'){
  exact(body,['expectedRevision','name','confirmSettingsOnly']);if(body.confirmSettingsOnly!==true)fail('INVALID_TEAMSPACE',400);
  const id=assertId(ctx.createId()),memberId=assertId(ctx.createId());if(ctx.payload.teamspaces?.some(value=>value.id===id)||ctx.payload.teamspaceMembers?.some(value=>value.id===memberId))fail('CONTENT_UNAVAILABLE',503);
  const copy=createTeamspaceCopy(team,{id,name:body.name,createdAt:ctx.now()});
  ctx.payload.teamspaces.push(copy);ctx.payload.teamspaceMembers??=[];ctx.payload.teamspaceMembers.push({id:memberId,workspaceId:ctx.workspaceId,teamspaceId:id,accountId:ctx.accountId,membershipId:ctx.actor.id,role:'owner'});
  await commit(ctx,{authorizeFresh:fresh=>{const original=teamFor(fresh,team.id);manage(fresh,original);if(original.archivedAt!==null)fail('TEAMSPACE_ARCHIVED',409);}});return json(detail(ctx,copy));
 }
 const before=currentPolicy(ctx),affected=teamPages(ctx,team.id),guards=[];
 if(action==='detail'){exact(body,['expectedRevision','name','description','visibility','defaultPermission','confirmAccessChange']);if(body.confirmAccessChange!==true)fail('INVALID_TEAMSPACE',400);for(const key of ['name','description','visibility','defaultPermission'])team[key]=body[key];if(team.visibility!=='closed'&&ctx.payload.teamspaceJoinRequests)ctx.payload.teamspaceJoinRequests=ctx.payload.teamspaceJoinRequests.filter(row=>row.teamspaceId!==team.id);}
 else if(action==='archive'){exact(body,['expectedRevision','archived']);if(typeof body.archived!=='boolean')fail('INVALID_TEAMSPACE',400);team.archivedAt=body.archived?ctx.now():null;}
 else if(action==='join'){
  exact(body,['expectedRevision']);if(!eligible(ctx)||team.archivedAt!==null||team.visibility!=='open')missing();if(memberFor(ctx,team))conflict();
  if((ctx.payload.teamspaceMembers??[]).filter(row=>row.teamspaceId===team.id).length>=TEAMSPACE_LIMITS.members)fail('CONTENT_TOO_LARGE',413);
  ctx.payload.teamspaceMembers??=[];ctx.payload.teamspaceMembers=ctx.payload.teamspaceMembers.filter(member=>member.teamspaceId!==team.id||member.accountId!==ctx.accountId);ctx.payload.teamspaceMembers.push({id:assertId(ctx.createId()),workspaceId:ctx.workspaceId,teamspaceId:team.id,accountId:ctx.accountId,membershipId:ctx.actor.id,role:'member'});
 }else if(request.method==='DELETE'){
  exact(body,['expectedRevision','memberId']);assertId(body.memberId);const member=ctx.payload.teamspaceMembers?.find(member=>member.teamspaceId===team.id&&member.id===body.memberId);if(!member)missing();if(member.accountId!==ctx.accountId||member.membershipId!==ctx.actor.id){manage(ctx,team);if(team.archivedAt!==null)fail('TEAMSPACE_ARCHIVED',409);}ctx.payload.teamspaceMembers=ctx.payload.teamspaceMembers.filter(row=>row!==member);
 }else{
  exact(body,['expectedRevision','accountId','role']);assertId(body.accountId);if(!['owner','member'].includes(body.role))fail('INVALID_TEAMSPACE',400);const person=ctx.saved.principals.find(person=>person.accountId===body.accountId&&person.emailVerified&&person.role!=='guest');if(!person)missing();
  ctx.payload.teamspaceMembers??=[];const existing=ctx.payload.teamspaceMembers.find(member=>member.teamspaceId===team.id&&member.accountId===person.accountId);
  if(!existing&&ctx.payload.teamspaceMembers.filter(row=>row.teamspaceId===team.id).length>=TEAMSPACE_LIMITS.members)fail('CONTENT_TOO_LARGE',413);
  if(existing){if(existing.membershipId!==person.id)existing.id=assertId(ctx.createId());existing.membershipId=person.id;existing.role=body.role;}
  else ctx.payload.teamspaceMembers.push({id:assertId(ctx.createId()),workspaceId:ctx.workspaceId,teamspaceId:team.id,accountId:person.accountId,membershipId:person.id,role:body.role});
  guards.push({id:person.id,accountId:person.accountId,role:person.role});
 }
 if(ctx.payload.teamspaceJoinRequests&&(action==='join'||action==='members'&&request.method==='POST')){const account=action==='join'?ctx.accountId:body.accountId;ctx.payload.teamspaceJoinRequests=ctx.payload.teamspaceJoinRequests.filter(row=>row.teamspaceId!==team.id||row.accountId!==account);}
 team.updatedAt=ctx.now();const after=currentPolicy(ctx);ensureOwners(before,after);ensureManagers(before,after,ctx.saved.principals,ctx.workspaceId);invalidateRooms(ctx.payload,affected);
 await commit(ctx,{guards,authorizeFresh:fresh=>{const current=teamFor(fresh,team.id);if(action==='join'){if(current.visibility!=='open'||!eligible(fresh)||current.archivedAt!==null)missing();}else if(!deletingMember||body.memberId!==before.teamspaceMembers.find(member=>member.teamspaceId===team.id&&member.accountId===ctx.accountId&&member.membershipId===ctx.actor.id)?.id)manage(fresh,current);}});return json(detail(ctx,team));
}
