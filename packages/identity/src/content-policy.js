import {createPageAccessEvaluator,liveTeamspaceMember,pageTeamspace} from '@yumunio/domain';

/** One membership-generation-bound policy projection for every account content consumer. */
export function accountContentPolicy(payload,principals,workspaceId,{invitations=[],extraAccount}={}){
 const bindings=new Map(payload.grantBindings.map(row=>[row.grantId,row.membershipId])),memberships=new Map(principals.map(row=>[row.accountId,row.id]));
 const accounts=principals.map(row=>({id:row.accountId,email:row.email,emailVerified:row.emailVerified,status:'active',serverRole:'user'}));if(extraAccount&&!accounts.some(account=>account.id===extraAccount.id))accounts.push(extraAccount);
 return structuredClone({accounts,workspaces:[{id:workspaceId,status:'active'}],memberships:principals.map(row=>({id:row.id,accountId:row.accountId,workspaceId,role:row.role,status:'active'})),pages:payload.pages.map(({page,inheritPermissions})=>({id:page.id,workspaceId,parentId:page.parentId,trashedAt:page.trashedAt,inheritPermissions})),grants:payload.grants.filter(grant=>memberships.get(grant.accountId)===bindings.get(grant.id)),invitations,teamspaces:payload.teamspaces??[],teamspaceMembers:payload.teamspaceMembers??[],teamspacePages:payload.teamspacePages??[],personalPageOwners:payload.personalPageOwners??[],groups:payload.groups??[],groupMembers:payload.groupMembers??[],groupGrants:payload.groupGrants??[]});
}
export function teamspaceVisible(policy,teamspace,accountId){return Boolean(liveTeamspaceMember(policy,teamspace.id,accountId))||teamspace.visibility!=='private'&&policy.memberships.some(member=>member.workspaceId===teamspace.workspaceId&&member.accountId===accountId&&member.status==='active'&&member.role!=='guest');}
export function pagePlacement(policy,pageId,accountId,rawGrants=policy.grants){
 const workspaceId=policy.workspaces[0].id,teamspace=pageTeamspace(policy,workspaceId,pageId);
 if(teamspace)return{teamspaceId:teamspaceVisible(policy,teamspace,accountId)?teamspace.id:null,sidebarSection:teamspaceVisible(policy,teamspace,accountId)?'teamspace':'shared'};
 // Legacy shared grants remain authoritative, including temporarily unverified recipients.
 const pages=new Map(policy.pages.map(page=>[page.id,page])),scope=new Set();let page=pages.get(pageId);while(page&&!scope.has(page.id)){scope.add(page.id);if(!page.inheritPermissions)break;page=pages.get(page.parentId);}
 const grants=rawGrants.filter(grant=>grant.status==='active'&&scope.has(grant.pageId)&&(grant.pageId===pageId||grant.includeDescendants));
 const others=grants.some(grant=>grant.accountId!==accountId&&grant.permission!=='deny')||(policy.groupGrants??[]).some(grant=>grant.status==='active'&&grant.permission!=='deny'&&scope.has(grant.pageId)&&(grant.pageId===pageId||grant.includeDescendants)&&policy.groups.some(group=>group.id===grant.groupId&&group.archivedAt===null));
 const provenance=policy.personalPageOwners.find(owner=>scope.has(owner.pageId)&&owner.accountId===accountId&&policy.memberships.some(member=>member.accountId===accountId&&member.id===owner.membershipId));
 return{teamspaceId:null,sidebarSection:others?'shared':provenance?'personal':'legacy'};
}
/** Prevent workspace removal/demotion from orphaning a teamspace, even while it is archived. */
export function preserveTeamspaceOwners(before,after){
 for(const teamspace of before.teamspaces??[]){const had=(before.teamspaceMembers??[]).some(member=>member.teamspaceId===teamspace.id&&member.role==='owner'&&liveTeamspaceMember(before,teamspace.id,member.accountId));
  if(had&&!(after.teamspaceMembers??[]).some(member=>member.teamspaceId===teamspace.id&&member.role==='owner'&&liveTeamspaceMember(after,teamspace.id,member.accountId)))return false;
 }return true;
}
