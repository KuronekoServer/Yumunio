import {assertId,liveTeamspaceMember,TEAMSPACE_LIMITS} from '@yumunio/domain';
import {accountContentPolicy} from './content-policy.js';
import {invalidateRooms} from './content-room.js';
const json=value=>Response.json(value,{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
const policy=ctx=>accountContentPolicy(ctx.payload,ctx.saved.principals,ctx.workspaceId);
const personFor=(ctx,row)=>ctx.saved.principals.find(person=>person.accountId===row.accountId&&person.id===row.membershipId&&person.emailVerified&&person.role!=='guest');
const live=(ctx,row,state)=>{const team=ctx.payload.teamspaces?.find(team=>team.id===row.teamspaceId);return team?.visibility==='closed'&&personFor(ctx,row)&&!liveTeamspaceMember(state,team.id,row.accountId);};
function project(ctx,row){const person=personFor(ctx,row);return{id:row.id,accountId:row.accountId,name:person.displayName||person.accountId,createdAt:row.createdAt,currentUser:row.accountId===ctx.accountId};}

/** The outer content handler has verified cookie, Origin, expected account and workspace membership. */
export async function handleTeamspaceJoinRequest(ctx,{team,commit,teamFor,manage,exact,version,fail,missing,ensureOwners,ensureManagers,teamPages}){
 const state=policy(ctx),method=ctx.request.method,member=liveTeamspaceMember(state,team.id,ctx.accountId),owner=member?.role==='owner',rows=ctx.payload.teamspaceJoinRequests??[],own=rows.find(row=>row.teamspaceId===team.id&&row.accountId===ctx.accountId&&row.membershipId===ctx.actor.id&&live(ctx,row,state));
 if(method==='GET')return json({workspaceId:ctx.workspaceId,revision:ctx.saved.revision,teamspaceId:team.id,canReview:owner,canRequest:team.visibility==='closed'&&team.archivedAt===null&&ctx.actor.emailVerified&&ctx.actor.role!=='guest'&&!member&&!own,requests:owner?rows.filter(row=>row.teamspaceId===team.id&&live(ctx,row,state)).map(row=>project(ctx,row)):[],myRequest:own?project(ctx,own):null});
 if(!['POST','PATCH','DELETE'].includes(method))fail('METHOD_NOT_ALLOWED',405);
 const body=await ctx.readJson(ctx.request);exact(body,method==='POST'?['expectedRevision','confirmRequest']:method==='PATCH'?['expectedRevision','requestId','accountId','decision','confirmAccessChange']:['expectedRevision','requestId','confirmCancel']);version(body.expectedRevision);if(body.expectedRevision!==ctx.saved.revision)fail('CONTENT_CONFLICT',409);
 if(method!=='DELETE'&&team.archivedAt!==null)fail('TEAMSPACE_ARCHIVED',409);
 let requested,action,guards=[],nextPolicy=state;const before=state;
 if(method==='POST'){
  if(body.confirmRequest!==true)fail('INVALID_TEAMSPACE',400);if(team.visibility!=='closed'||!ctx.actor.emailVerified||ctx.actor.role==='guest'||member)missing();if(own)fail('TEAMSPACE_REQUEST_EXISTS',409);
  ctx.payload.teamspaceJoinRequests=rows.filter(row=>live(ctx,row,state));if(ctx.payload.teamspaceJoinRequests.length>=TEAMSPACE_LIMITS.requests)fail('CONTENT_TOO_LARGE',413);
  const id=assertId(ctx.createId());if(ctx.payload.teamspaceJoinRequests.some(row=>row.id===id))fail('CONTENT_UNAVAILABLE',503);
  requested={id,workspaceId:ctx.workspaceId,teamspaceId:team.id,accountId:ctx.accountId,membershipId:ctx.actor.id,createdAt:ctx.now()};ctx.payload.teamspaceJoinRequests.push(requested);action='request';
 }else{
  assertId(body.requestId);requested=rows.find(row=>row.id===body.requestId&&row.teamspaceId===team.id);if(!requested)missing();
  if(method==='DELETE'){
   if(body.confirmCancel!==true)fail('INVALID_TEAMSPACE',400);if(requested.accountId!==ctx.accountId||requested.membershipId!==ctx.actor.id||!personFor(ctx,requested))missing();action='cancel';
  }else{
   manage(ctx,team);assertId(body.accountId);if(body.accountId!==requested.accountId)missing();if(body.confirmAccessChange!==true||!['approve','reject'].includes(body.decision))fail('INVALID_TEAMSPACE',400);action=body.decision;
   if(action==='approve'){
    if(!live(ctx,requested,state))fail('TEAMSPACE_REQUEST_STALE',409);const person=personFor(ctx,requested);ctx.payload.teamspaceMembers??=[];const existing=ctx.payload.teamspaceMembers.find(row=>row.teamspaceId===team.id&&row.accountId===person.accountId);
    if(!existing&&ctx.payload.teamspaceMembers.filter(row=>row.teamspaceId===team.id).length>=TEAMSPACE_LIMITS.members)fail('CONTENT_TOO_LARGE',413);const id=assertId(ctx.createId());if(ctx.payload.teamspaceMembers.some(row=>row.id===id))fail('CONTENT_UNAVAILABLE',503);
    const approved={id,workspaceId:ctx.workspaceId,teamspaceId:team.id,accountId:person.accountId,membershipId:person.id,role:'member'};if(existing)Object.assign(existing,approved);else ctx.payload.teamspaceMembers.push(approved);
    guards.push({id:person.id,accountId:person.accountId,role:person.role});team.updatedAt=ctx.now();const after=policy(ctx);nextPolicy=after;ensureOwners(before,after);ensureManagers(before,after,ctx.saved.principals,ctx.workspaceId);invalidateRooms(ctx.payload,teamPages(ctx,team.id));
   }
  }
  ctx.payload.teamspaceJoinRequests=rows.filter(row=>row.id!==requested.id&&live(ctx,row,nextPolicy));
 }
 await commit(ctx,{guards,authorizeFresh:fresh=>{const current=teamFor(fresh,team.id);if(method==='PATCH')manage(fresh,current);else if(method==='POST'&&(current.visibility!=='closed'||current.archivedAt!==null||liveTeamspaceMember(policy(fresh),team.id,ctx.accountId)))missing();}});
 return json({workspaceId:ctx.workspaceId,revision:ctx.saved.revision,teamspaceId:team.id,requestId:requested.id,accountId:requested.accountId,action});
}
