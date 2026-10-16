import {DomainError,assertId,assertJsonSerializable,assertPlainObject} from './index.js';
const invalid=()=>{throw new DomainError('INVALID_INPUT','Invalid group policy.');};
const exact=(value,keys)=>{assertPlainObject(value);assertJsonSerializable(value);if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))invalid();};
const stamp=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)invalid();};
export const GROUP_LIMITS=Object.freeze({groups:100,groupMembers:2000,groupGrants:2000});
/** Group membership belongs to one current workspace-membership generation. */
export function validateGroupState(value,{workspaceId,pages}={}){
 assertPlainObject(value);assertJsonSerializable(value);
 const result={groups:[],groupMembers:[],groupGrants:[]};
 for(const name of Object.keys(result)){const rows=Object.hasOwn(value,name)?value[name]:[];if(!Array.isArray(rows)||rows.length>GROUP_LIMITS[name])invalid();result[name]=structuredClone(rows);}
 const groups=new Map(),members=new Set(),memberIds=new Set(),grants=new Set(),scopes=new Set();
 for(const group of result.groups){exact(group,['id','workspaceId','name','createdAt','updatedAt','archivedAt']);assertId(group.id);assertId(group.workspaceId);if(workspaceId&&group.workspaceId!==workspaceId||groups.has(group.id)||typeof group.name!=='string'||!group.name.trim()||group.name!==group.name.trim()||group.name.length>100||/[\u0000-\u001f\u007f]/.test(group.name))invalid();stamp(group.createdAt);stamp(group.updatedAt);if(group.archivedAt!==null)stamp(group.archivedAt);groups.set(group.id,group);}
 for(const member of result.groupMembers){exact(member,['id','workspaceId','groupId','accountId','membershipId']);for(const key of Object.keys(member))assertId(member[key]);const group=groups.get(member.groupId),scope=member.groupId+'\0'+member.accountId;if(!group||group.workspaceId!==member.workspaceId||memberIds.has(member.id)||members.has(scope))invalid();memberIds.add(member.id);members.add(scope);}
 for(const grant of result.groupGrants){exact(grant,['id','workspaceId','groupId','pageId','permission','includeDescendants','status']);for(const key of ['id','workspaceId','groupId','pageId'])assertId(grant[key]);const group=groups.get(grant.groupId),page=pages?.get(grant.workspaceId+'\0'+grant.pageId)??pages?.get(grant.pageId),model=page?.page??page,scope=grant.groupId+'\0'+grant.pageId;if(!group||group.workspaceId!==grant.workspaceId||grants.has(grant.id)||scopes.has(scope)||!['viewer','commenter','editor','full','deny'].includes(grant.permission)||typeof grant.includeDescendants!=='boolean'||!['active','revoked'].includes(grant.status)||pages&&(!model||model.workspaceId!==grant.workspaceId))invalid();grants.add(grant.id);scopes.add(scope);}
 return result;
}
export function liveGroupIds(state,workspaceId,accountId){
 const principal=state.memberships.find(row=>row.workspaceId===workspaceId&&row.accountId===accountId&&row.status==='active'&&row.role!=='guest'),account=state.accounts.find(row=>row.id===accountId&&row.status==='active'&&row.emailVerified);
 if(!principal||!account)return new Set();
 return new Set((state.groupMembers??[]).filter(row=>row.workspaceId===workspaceId&&row.accountId===accountId&&row.membershipId===principal.id&&(state.groups??[]).some(group=>group.id===row.groupId&&group.archivedAt===null)).map(row=>row.groupId));
}
