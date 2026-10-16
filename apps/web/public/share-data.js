export const validShareId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export class SharingError extends Error{constructor(code='REQUEST_FAILED',status=0){super(code);this.code=code;this.status=status;}}
export class SharingClient{
  constructor({workspaceId,pageId=null,accountId,fetcher=globalThis.fetch}={}){
    if(!validShareId(workspaceId)||pageId!==null&&!validShareId(pageId)||!validShareId(accountId))throw new SharingError('INVALID_CONTEXT');
    this.workspaceId=workspaceId;this.pageId=pageId;this.accountId=accountId;this.fetcher=(...args)=>fetcher(...args);this.lifecycle=new AbortController();this.destroyed=false;
    this.content='/api/content/workspaces/'+encodeURIComponent(workspaceId);this.collaboration='/api/collaboration/workspaces/'+encodeURIComponent(workspaceId);
  }
  async request(path,{method='GET',body}={}){
    if(this.destroyed)throw new SharingError('ACTOR_CHANGED',401);
    let response,data;try{response=await this.fetcher(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([this.lifecycle.signal,AbortSignal.timeout(15000)]),
      headers:{'X-Yumunio-Expected-Account':this.accountId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});data=await response.json();}catch{throw new SharingError('NETWORK_FAILED');}
    if(this.destroyed)throw new SharingError('ACTOR_CHANGED',401);if(!response.ok)throw new SharingError(typeof data?.error?.code==='string'&&/^[A-Z_]{1,80}$/.test(data.error.code)?data.error.code:'REQUEST_FAILED',response.status);return data;
  }
  destroy(){this.destroyed=true;this.lifecycle.abort();}
  async verifyActor(){const session=await this.request('/api/auth/get-session');if(session?.user?.id!==this.accountId)throw new SharingError('ACTOR_CHANGED',401);if(session.user.emailVerified!==true)throw new SharingError('UNVERIFIED',403);return session.user;}
  async load(){
    const user=await this.verifyActor();
    const [organizations,pages,invitations]=await Promise.all([this.request('/api/auth/organization/list'),this.request(this.content+'/pages'),this.request(this.collaboration+'/invitations')]);
    if(!Array.isArray(organizations)||!Array.isArray(pages?.pages)||!['owner','admin','member','guest'].includes(pages.role)||!Number.isSafeInteger(pages.revision)||pages.revision<0||!Array.isArray(invitations?.invitations))throw new SharingError('INVALID_RESPONSE');
    const workspace=organizations.find(item=>item.id===this.workspaceId);if(!workspace)throw new SharingError('NOT_FOUND',404);
    const page=this.pageId?pages.pages.find(item=>item.id===this.pageId):null;if(this.pageId&&!page)throw new SharingError('NOT_FOUND',404);
    const canManageMembers=['owner','admin'].includes(pages.role),canManagePage=!!page?.capabilities?.includes('manage'),canInvitePage=!!page?.capabilities?.includes('invite');
    const [members,grants]=await Promise.all([canManageMembers?this.request(this.collaboration+'/members'):Promise.resolve(null),canManagePage?this.request(this.content+'/pages/'+encodeURIComponent(this.pageId)+'/grants'):Promise.resolve(null)]);
    if([invitations,members,grants].filter(Boolean).some(data=>data.revision!==pages.revision))throw new SharingError('COLLABORATION_CONFLICT',409);
    if(members&&!Array.isArray(members.members)||grants&&!Array.isArray(grants.grants))throw new SharingError('INVALID_RESPONSE');await this.verifyActor();
    return{user,workspaceName:typeof workspace.name==='string'?workspace.name:'',role:pages.role,revision:pages.revision,pages:pages.pages,page,
      invitations:invitations.invitations.filter(item=>!this.pageId||item.pageId===this.pageId),members:members?.members??[],grants:grants?.grants??[],canManageMembers,canManagePage,canInvitePage,
      canInviteMember:canManageMembers,canInviteAdmin:pages.role==='owner'};
  }
  async mutate(path,method,body){
    if(!Number.isSafeInteger(body?.expectedRevision)||body.expectedRevision<0)throw new SharingError('INVALID_REVISION');await this.verifyActor();return this.request(path,{method,body});
  }
  invite(body){return this.mutate(this.collaboration+'/invitations','POST',body);}
  invitation(id,action,expectedRevision){if(!validShareId(id)||!['resend','cancel'].includes(action))throw new SharingError('INVALID_CONTEXT');return this.mutate(this.collaboration+'/invitations/'+encodeURIComponent(id)+(action==='resend'?'/resend':''),action==='resend'?'POST':'DELETE',{expectedRevision});}
  member(id,{expectedRevision,role,remove=false}){if(!validShareId(id))throw new SharingError('INVALID_CONTEXT');return this.mutate(this.collaboration+'/members/'+encodeURIComponent(id),remove?'DELETE':'PATCH',{expectedRevision,...(remove?{}:{role})});}
  async grant({expectedRevision,accountId,permission,includeDescendants}){
    if(!this.pageId||!validShareId(accountId)||!['viewer','commenter','editor','full','deny'].includes(permission)||includeDescendants!==undefined&&typeof includeDescendants!=='boolean')throw new SharingError('INVALID_CONTEXT');
    const result=await this.mutate(this.content+'/pages/'+encodeURIComponent(this.pageId)+'/grants','POST',{expectedRevision,accountId,permission,...(includeDescendants===undefined?{}:{includeDescendants})});await this.verifyActor();
    const grant=result?.grant;if(result?.revision!==expectedRevision+1||Object.keys(result).sort().join(',')!=='grant,revision'||!grant||!validShareId(grant.id)||grant.workspaceId!==this.workspaceId||grant.pageId!==this.pageId||grant.accountId!==accountId||grant.permission!==permission||grant.includeDescendants!==(includeDescendants===true)||grant.status!=='active')throw new SharingError('INVALID_RESPONSE');return result;
  }
  async revoke(grantId,expectedRevision){
    if(!this.pageId||!validShareId(grantId))throw new SharingError('INVALID_CONTEXT');const result=await this.mutate(this.content+'/pages/'+encodeURIComponent(this.pageId)+'/grants/'+encodeURIComponent(grantId),'DELETE',{expectedRevision});await this.verifyActor();
    if(result?.revision!==expectedRevision+1||result.revoked!==true||Object.keys(result).sort().join(',')!=='revision,revoked')throw new SharingError('INVALID_RESPONSE');return result;
  }
}
