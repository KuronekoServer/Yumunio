import {assertId,assertPlainObject,assertJsonSerializable,createPageAccessEvaluator} from '@yumunio/domain';
import {GROUP_LIMITS} from '../../domain/src/groups.js';
import {accountContentPolicy} from './content-policy.js';
import {requireAccessSubtreeManagement,protectAccessTransition} from './content-access-transition.js';
export class ContentGroupsError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new ContentGroupsError(code,status);},missing=()=>fail('CONTENT_NOT_FOUND',404);
const exact=(value,keys)=>{assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))fail('INVALID_GROUP');};
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
const manage=ctx=>['owner','admin'].includes(ctx.actor.role),eligible=ctx=>ctx.actor.role!=='guest';
const policy=ctx=>accountContentPolicy(ctx.payload,ctx.saved.principals,ctx.workspaceId);
const groupFor=(ctx,id)=>{const group=(ctx.payload.groups??[]).find(row=>row.id===id);if(!group||!eligible(ctx))missing();return group;};
const liveMembers=(ctx,id)=>(ctx.payload.groupMembers??[]).filter(member=>member.groupId===id&&ctx.saved.principals.some(person=>person.id===member.membershipId&&person.accountId===member.accountId&&person.emailVerified&&person.role!=='guest'));
const project=(ctx,group)=>({...group,memberCount:liveMembers(ctx,group.id).length});
const detail=(ctx,group)=>({workspaceId:ctx.workspaceId,revision:ctx.saved.revision,canManage:manage(ctx),group:project(ctx,group),members:manage(ctx)?liveMembers(ctx,group.id).map(member=>({id:member.id,accountId:member.accountId,name:ctx.saved.principals.find(p=>p.accountId===member.accountId).displayName||member.accountId,currentUser:member.accountId===ctx.accountId})):[],candidates:manage(ctx)?ctx.saved.principals.filter(p=>p.emailVerified&&p.role!=='guest').map(p=>({accountId:p.accountId,name:p.displayName||p.accountId})):[]});
function safeTransition(ctx,before){
 protectAccessTransition({...ctx,principals:ctx.saved.principals,fail},before);
}
async function commit(ctx,before){
 safeTransition(ctx,before);ctx.payload=ctx.validatePayload(ctx.payload,ctx.workspaceId);
 const result=await ctx.store.write(ctx.workspaceId,ctx.accountId,{expectedRevision:ctx.saved.revision,payload:ctx.payload,actorMembershipId:ctx.actor.id,actorRole:ctx.actor.role,guardPrincipalSnapshot:ctx.saved.principals});ctx.saved={...ctx.saved,revision:result.revision};
}
function newId(ctx,rows){const id=assertId(ctx.createId());if(rows.some(row=>row.id===id))fail('CONTENT_UNAVAILABLE',503);return id;}
function requireSubtreeManage(ctx,state){
 requireAccessSubtreeManagement({...ctx,fail},state);
}
export async function handleGroupRequest(ctx){
 const {request,pageId,groupId,action}=ctx;if(!eligible(ctx))missing();
 if(pageId){
  const can=createPageAccessEvaluator(policy(ctx))({accountId:ctx.accountId,workspaceId:ctx.workspaceId,pageId}).capabilities;
  if(!can.includes('manage'))missing();
  const listing=()=>({workspaceId:ctx.workspaceId,pageId,revision:ctx.saved.revision,grants:(ctx.payload.groupGrants??[]).filter(grant=>grant.pageId===pageId&&grant.status==='active').map(grant=>({...grant,groupName:(ctx.payload.groups??[]).find(group=>group.id===grant.groupId)?.name??''}))});
  if(request.method==='GET')return json(listing());
  if(!['POST','DELETE'].includes(request.method))fail('METHOD_NOT_ALLOWED',405);
  const body=await ctx.readJson(request);exact(body,request.method==='POST'?['expectedRevision','groupId','permission','includeDescendants','confirmAccessChange']:['expectedRevision','grantId','confirmAccessChange']);checkRevision(ctx,body);if(body.confirmAccessChange!==true)fail('INVALID_GROUP');const before=policy(ctx);
  ctx.payload.groupGrants??=[];
  if(request.method==='POST'){
   const group=groupFor(ctx,assertId(body.groupId));if(group.archivedAt!==null)fail('GROUP_ARCHIVED',409);if(!['viewer','commenter','editor','full','deny'].includes(body.permission)||typeof body.includeDescendants!=='boolean')fail('INVALID_GROUP');
   const existing=ctx.payload.groupGrants.find(grant=>grant.groupId===group.id&&grant.pageId===pageId);if(body.includeDescendants||existing?.includeDescendants)requireSubtreeManage(ctx,before);
   if(existing)Object.assign(existing,{permission:body.permission,includeDescendants:body.includeDescendants,status:'active'});else{if(ctx.payload.groupGrants.length>=GROUP_LIMITS.groupGrants)fail('CONTENT_TOO_LARGE',413);ctx.payload.groupGrants.push({id:newId(ctx,ctx.payload.groupGrants),workspaceId:ctx.workspaceId,pageId,groupId:group.id,permission:body.permission,includeDescendants:body.includeDescendants,status:'active'});}
  }else{const grant=ctx.payload.groupGrants.find(row=>row.id===assertId(body.grantId)&&row.pageId===pageId&&row.status==='active');if(!grant)missing();if(grant.includeDescendants)requireSubtreeManage(ctx,before);grant.status='revoked';}
  await commit(ctx,before);return json(listing());
 }
 if(!groupId&&request.method==='GET')return json({workspaceId:ctx.workspaceId,revision:ctx.saved.revision,canManage:manage(ctx),groups:(ctx.payload.groups??[]).map(group=>project(ctx,group))});
 const group=groupId?groupFor(ctx,groupId):null;
 if(group&&request.method==='GET'&&action==='detail')return json(detail(ctx,group));
 if(!manage(ctx))missing();if(!group&&request.method!=='POST'||group&&!({detail:['PATCH'],members:['POST','DELETE'],archive:['POST']}[action]??[]).includes(request.method))fail('METHOD_NOT_ALLOWED',405);
 if(group?.archivedAt!==null&&group!==null&&action!=='archive')fail('GROUP_ARCHIVED',409);
 const body=await ctx.readJson(request);checkRevision(ctx,body);const before=policy(ctx);ctx.payload.groups??=[];ctx.payload.groupMembers??=[];
 let target=group;
 if(!group){exact(body,['expectedRevision','name']);if(ctx.payload.groups.length>=GROUP_LIMITS.groups)fail('CONTENT_TOO_LARGE',413);const stamp=ctx.now();target={id:newId(ctx,ctx.payload.groups),workspaceId:ctx.workspaceId,name:body.name,createdAt:stamp,updatedAt:stamp,archivedAt:null};ctx.payload.groups.push(target);}
 else{
  if(body.confirmAccessChange!==true)fail('INVALID_GROUP');
  if(action==='detail'){exact(body,['expectedRevision','name','confirmAccessChange']);target.name=body.name;}
  else if(action==='archive'){exact(body,['expectedRevision','archived','confirmAccessChange']);if(typeof body.archived!=='boolean')fail('INVALID_GROUP');target.archivedAt=body.archived?ctx.now():null;}
  else if(request.method==='POST'){exact(body,['expectedRevision','accountId','confirmAccessChange']);const person=ctx.saved.principals.find(p=>p.accountId===assertId(body.accountId)&&p.emailVerified&&p.role!=='guest');if(!person)missing();const existing=ctx.payload.groupMembers.find(member=>member.groupId===group.id&&member.accountId===person.accountId);if(existing&&existing.membershipId===person.id)fail('CONTENT_CONFLICT',409);if(existing){existing.id=newId(ctx,ctx.payload.groupMembers);existing.membershipId=person.id;}else{if(ctx.payload.groupMembers.length>=GROUP_LIMITS.groupMembers)fail('CONTENT_TOO_LARGE',413);ctx.payload.groupMembers.push({id:newId(ctx,ctx.payload.groupMembers),workspaceId:ctx.workspaceId,groupId:group.id,accountId:person.accountId,membershipId:person.id});}}
  else{exact(body,['expectedRevision','memberId','confirmAccessChange']);const member=ctx.payload.groupMembers.find(row=>row.id===assertId(body.memberId)&&row.groupId===group.id);if(!member)missing();ctx.payload.groupMembers=ctx.payload.groupMembers.filter(row=>row!==member);}
  target.updatedAt=ctx.now();
 }
 await commit(ctx,before);return json(detail(ctx,target));
}
function checkRevision(ctx,body){if(!Number.isSafeInteger(body?.expectedRevision)||body.expectedRevision<0||body.expectedRevision>=Number.MAX_SAFE_INTEGER)fail('INVALID_GROUP');if(body.expectedRevision!==ctx.saved.revision)fail('CONTENT_CONFLICT',409);}
