import {DomainError,assertId,assertPlainObject,assertJsonSerializable} from './index.js';

export const TEAMSPACE_LIMITS=Object.freeze({teamspaces:64,members:1000,pages:1000,requests:1000});
export const TEAMSPACE_VISIBILITIES=Object.freeze(['open','closed','private']);
export const TEAMSPACE_ROLES=Object.freeze(['owner','member']);
export const TEAMSPACE_PERMISSIONS=Object.freeze(['viewer','commenter','editor']);
const fail=()=>{throw new DomainError('INVALID_INPUT','Invalid teamspace data.');};
function exact(value,fields){assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key)))fail();}
function stamp(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail();}
export function validateTeamspace(value){
 exact(value,['id','workspaceId','name','description','visibility','defaultPermission','createdAt','updatedAt','archivedAt']);assertId(value.id);assertId(value.workspaceId);
 if(typeof value.name!=='string'||!value.name.trim()||value.name!==value.name.trim()||value.name.length>100||/[\u0000-\u001f\u007f]/.test(value.name)||typeof value.description!=='string'||value.description.length>1000||!TEAMSPACE_VISIBILITIES.includes(value.visibility)||!TEAMSPACE_PERMISSIONS.includes(value.defaultPermission))fail();
 stamp(value.createdAt);stamp(value.updatedAt);if(value.archivedAt!==null)stamp(value.archivedAt);return structuredClone(value);
}
/** Copy settings only. Memberships, page bindings, archive state and identity are never copied. */
export function createTeamspaceCopy(source,options){
 const original=validateTeamspace(source);exact(options,['id','name','createdAt']);
 return validateTeamspace({id:options.id,workspaceId:original.workspaceId,name:options.name,description:original.description,visibility:original.visibility,defaultPermission:original.defaultPermission,createdAt:options.createdAt,updatedAt:options.createdAt,archivedAt:null});
}
export function validateTeamspaceMember(value){exact(value,['id','workspaceId','teamspaceId','accountId','membershipId','role']);for(const key of ['id','workspaceId','teamspaceId','accountId','membershipId'])assertId(value[key]);if(!TEAMSPACE_ROLES.includes(value.role))fail();return structuredClone(value);}
export function validateTeamspacePage(value){exact(value,['workspaceId','pageId','teamspaceId']);for(const key of ['workspaceId','pageId','teamspaceId'])assertId(value[key]);return structuredClone(value);}
export function validatePersonalPageOwner(value){exact(value,['workspaceId','pageId','accountId','membershipId']);for(const key of ['workspaceId','pageId','accountId','membershipId'])assertId(value[key]);return structuredClone(value);}
/** Pending workflow metadata does not grant page access and is not part of the ACL state. */
export function validateTeamspaceJoinRequests(value,{workspaceId}={}){
 assertPlainObject(value);assertJsonSerializable(value);const requests=Object.hasOwn(value,'teamspaceJoinRequests')?value.teamspaceJoinRequests:[];
 if(!Array.isArray(requests)||requests.length>TEAMSPACE_LIMITS.requests)fail();const ids=new Set(),pairs=new Set(),teams=new Map((value.teamspaces??[]).map(team=>[team.id,team]));
 for(const request of requests){exact(request,['id','workspaceId','teamspaceId','accountId','membershipId','createdAt']);for(const key of ['id','workspaceId','teamspaceId','accountId','membershipId'])assertId(request[key]);stamp(request.createdAt);const team=teams.get(request.teamspaceId),pair=request.teamspaceId+'\0'+request.accountId;if(!team||team.workspaceId!==request.workspaceId||workspaceId&&request.workspaceId!==workspaceId||ids.has(request.id)||pairs.has(pair))fail();ids.add(request.id);pairs.add(pair);}
 return structuredClone(requests);
}
/** Missing arrays mean the pre-teamspace policy, never an implicit assignment of old pages. */
export function validateTeamspaceState(value,{workspaceId,pages}={}){
 assertPlainObject(value);assertJsonSerializable(value);
 const result={teamspaces:[],teamspaceMembers:[],teamspacePages:[],personalPageOwners:[]},validators={teamspaces:validateTeamspace,teamspaceMembers:validateTeamspaceMember,teamspacePages:validateTeamspacePage,personalPageOwners:validatePersonalPageOwner},limits={teamspaces:64,teamspaceMembers:1000,teamspacePages:1000,personalPageOwners:1000};
 for(const name of Object.keys(result)){const entries=Object.hasOwn(value,name)?value[name]:[];if(!Array.isArray(entries)||entries.length>limits[name])fail();result[name]=entries.map(validators[name]);if(workspaceId&&result[name].some(row=>row.workspaceId!==workspaceId))fail();}
 const teams=new Map(),memberIds=new Set(),memberKeys=new Set(),pageIds=new Set();
 for(const team of result.teamspaces){if(teams.has(team.id))fail();teams.set(team.id,team);}
 for(const member of result.teamspaceMembers){const team=teams.get(member.teamspaceId),key=member.teamspaceId+'\0'+member.accountId;if(!team||member.workspaceId!==team.workspaceId||memberIds.has(member.id)||memberKeys.has(key))fail();memberIds.add(member.id);memberKeys.add(key);}
 for(const binding of result.teamspacePages){const team=teams.get(binding.teamspaceId),page=pages?.get(binding.workspaceId+'\0'+binding.pageId)??pages?.get(binding.pageId),model=page?.page??page;if(!team||binding.workspaceId!==team.workspaceId||pageIds.has(binding.pageId)||pages&&(!model||model.workspaceId!==binding.workspaceId||model.parentId!==null))fail();pageIds.add(binding.pageId);}
 const personalIds=new Set();for(const owner of result.personalPageOwners){const page=pages?.get(owner.workspaceId+'\0'+owner.pageId)??pages?.get(owner.pageId),model=page?.page??page;if(personalIds.has(owner.pageId)||pageIds.has(owner.pageId)||pages&&(!model||model.workspaceId!==owner.workspaceId||model.parentId!==null))fail();personalIds.add(owner.pageId);}
 return result;
}
export function liveTeamspaceMember(state,teamspaceId,accountId){
 const workspace=state.teamspaces.find(team=>team.id===teamspaceId)?.workspaceId;
 const principal=state.memberships.find(member=>member.workspaceId===workspace&&member.accountId===accountId&&member.status==='active'&&member.role!=='guest');
 const account=state.accounts.find(item=>item.id===accountId&&item.status==='active'&&item.emailVerified);
 return principal&&account?state.teamspaceMembers.find(member=>member.teamspaceId===teamspaceId&&member.accountId===accountId&&member.membershipId===principal.id)??null:null;
}
/** Physical placement is separate from inheritance and from permission to discover its teamspace. */
export function pageTeamspace(state,workspaceId,pageId){
 const pages=new Map(state.pages.filter(page=>page.workspaceId===workspaceId).map(page=>[page.id,page])),seen=new Set();let page=pages.get(pageId);
 while(page&&!seen.has(page.id)){seen.add(page.id);const binding=state.teamspacePages.find(row=>row.workspaceId===workspaceId&&row.pageId===page.id);if(binding)return state.teamspaces.find(team=>team.id===binding.teamspaceId&&team.workspaceId===workspaceId)??null;page=pages.get(page.parentId);}
 return null;
}
