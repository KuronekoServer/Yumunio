const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export class InvitationFlowError extends Error{constructor(code='INVITATION_UNAVAILABLE',status=0){super(code);this.code=code;this.status=status;}}
export function readInvitationLink(url){
  const input=url instanceof URL?url:new URL(url);const present=input.searchParams.has('invite')||input.searchParams.has('token');
  const invitationId=input.searchParams.get('invite'),token=input.searchParams.get('token');
  return {present,invitationId:input.searchParams.getAll('invite').length===1&&id(invitationId)?invitationId:null,
    token:input.searchParams.getAll('token').length===1&&typeof token==='string'&&/^[A-Za-z0-9_-]{48}$/.test(token)?token:null};
}
export class InvitationFlow{
  #invitationId;#token;#fetch;#preview=null;#actor=null;#result=null;
  constructor(link,{fetcher=globalThis.fetch}={}){this.present=!!link?.present;this.#invitationId=link?.invitationId;this.#token=link?.token;this.#fetch=(...args)=>fetcher(...args);}
  get valid(){return id(this.#invitationId)&&typeof this.#token==='string'&&/^[A-Za-z0-9_-]{48}$/.test(this.#token);}
  get invitationId(){return this.valid?this.#invitationId:null;}
  get snapshot(){return structuredClone({present:this.present,valid:this.valid,preview:this.#preview,result:this.#result,actorId:this.#actor});}
  clearPreview(){this.#preview=null;this.#actor=null;this.#result=null;}
  async #request(path,accountId,body){
    let response,data;try{response=await this.#fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{...(accountId?{'X-Yumunio-Expected-Account':accountId}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});data=await response.json();}catch{throw new InvitationFlowError();}
    if(!response.ok)throw new InvitationFlowError('INVITATION_UNAVAILABLE',response.status);return data;
  }
  async #authenticate(accountId){
    if(!id(accountId))throw new InvitationFlowError('ACTOR_CHANGED');const session=await this.#request('/api/auth/get-session');
    if(session?.user?.id!==accountId){this.clearPreview();throw new InvitationFlowError('ACTOR_CHANGED',401);}
    if(session.user.emailVerified!==true){this.clearPreview();throw new InvitationFlowError('EMAIL_NOT_VERIFIED',403);}return session.user;
  }
  async preview(accountId){
    if(!this.valid)throw new InvitationFlowError();await this.#authenticate(accountId);this.clearPreview();
    const data=await this.#request('/api/collaboration/preview',accountId,{invitationId:this.#invitationId,token:this.#token});
    if(data?.invitationId!==this.#invitationId||!['workspace-member','page-guest'].includes(data.purpose)||!id(data.workspaceId)||typeof data.workspaceName!=='string'||data.workspaceName.length>240||
      (data.pageId!==null&&!id(data.pageId))||(data.pageTitle!==null&&data.pageTitle!==undefined&&typeof data.pageTitle!=='string')||data.includeDescendants!==false||
      typeof data.expiresAt!=='string'||!Number.isFinite(Date.parse(data.expiresAt))||!['member','admin','viewer','commenter','editor','full'].includes(data.role)||
      (data.purpose==='page-guest'&&data.pageId===null)||(data.purpose==='workspace-member'&&(data.pageId!==null||!['member','admin'].includes(data.role)))||(data.purpose==='page-guest'&&!['viewer','commenter','editor','full'].includes(data.role))||(data.issuerName!==undefined&&(typeof data.issuerName!=='string'||data.issuerName.length>100)))throw new InvitationFlowError();
    this.#actor=accountId;this.#preview=Object.fromEntries(['invitationId','purpose','workspaceId','workspaceName','pageId','pageTitle','role','includeDescendants','expiresAt','issuerName'].filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]]));return this.snapshot.preview;
  }
  async accept(accountId,{confirmed=false}={}){
    if(!confirmed||!this.valid||!this.#preview||this.#actor!==accountId)throw new InvitationFlowError('CONSENT_REQUIRED');await this.#authenticate(accountId);
    const data=await this.#request('/api/collaboration/accept',accountId,{invitationId:this.#invitationId,token:this.#token});
    if(data?.workspaceId!==this.#preview.workspaceId||data.pageId!==this.#preview.pageId||!Number.isSafeInteger(data.revision)||data.revision<1||!['owner','admin','member','guest'].includes(data.role))throw new InvitationFlowError();
    this.#result={revision:data.revision,workspaceId:data.workspaceId,pageId:data.pageId,role:data.role};this.#token=null;return structuredClone(this.#result);
  }
}