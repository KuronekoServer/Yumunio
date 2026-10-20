const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const counter=value=>Number.isSafeInteger(value)&&value>=0;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const unique=items=>new Set(items).size===items.length;
export class TeamspaceClientError extends Error{
 constructor(code,status=0){super(code);this.name='TeamspaceClientError';this.code=code;this.status=status;}
}
const invalid=()=>{throw new TeamspaceClientError('INVALID_RESPONSE');};
function requestIntent(value,action){const fields=action==='request'?['expectedRevision','confirmRequest']:action==='cancel'?['expectedRevision','requestId','confirmCancel']:['expectedRevision','requestId','accountId','decision','confirmAccessChange'];if(!plain(value)||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))||!counter(value.expectedRevision)||value.expectedRevision>=Number.MAX_SAFE_INTEGER||action==='request'&&value.confirmRequest!==true||action==='cancel'&&(!id(value.requestId)||value.confirmCancel!==true)||action==='decision'&&(!id(value.requestId)||!id(value.accountId)||!['approve','reject'].includes(value.decision)||value.confirmAccessChange!==true))throw new TeamspaceClientError('INVALID_REQUEST',400);return structuredClone(value);}
export function validateTeamspace(value,workspaceId){
 if(!plain(value)||!id(value.id)||value.workspaceId!==workspaceId||typeof value.name!=='string'||!value.name.trim()||value.name.length>100||typeof value.description!=='string'||value.description.length>1000||!['open','closed','private'].includes(value.visibility)||!['viewer','commenter','editor'].includes(value.defaultPermission)||![null,'owner','member'].includes(value.role)||!counter(value.memberCount)||!Array.isArray(value.capabilities)||!unique(value.capabilities)||value.capabilities.some(item=>!['read','manage','join','createPage'].includes(item))||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string'||!(value.archivedAt===null||typeof value.archivedAt==='string'))invalid();
 return structuredClone(value);
}
export function validateTeamspaceList(value,workspaceId){
 if(!plain(value)||value.workspaceId!==workspaceId||!counter(value.revision)||typeof value.canCreate!=='boolean'||!Array.isArray(value.teamspaces))invalid();
 const teams=value.teamspaces.map(item=>validateTeamspace(item,workspaceId));if(!unique(teams.map(item=>item.id)))invalid();
 return {...structuredClone(value),teamspaces:teams};
}
export function validateTeamspaceDetail(value,workspaceId,teamspaceId){
 if(!plain(value)||value.workspaceId!==workspaceId||!counter(value.revision)||!Array.isArray(value.members)||value.members.length>1000)invalid();
 const teamspace=validateTeamspace(value.teamspace,workspaceId);if(teamspaceId&&teamspace.id!==teamspaceId)invalid();
 for(const member of value.members)if(!plain(member)||!id(member.id)||!id(member.accountId)||typeof member.name!=='string'||!['owner','member'].includes(member.role)||typeof member.currentUser!=='boolean')invalid();
 if(!unique(value.members.map(item=>item.id))||!unique(value.members.map(item=>item.accountId)))invalid();
 if(!Array.isArray(value.candidates)||value.candidates.length>1000||value.candidates.some(person=>!plain(person)||!id(person.accountId)||typeof person.name!=='string')||!unique(value.candidates.map(person=>person.accountId)))invalid();
 return {...structuredClone(value),teamspace};
}
export function validateTeamspaceReview(value,{workspaceId,pageId,revision,pageVersion,teamspaceId}){
 if(!plain(value)||value.workspaceId!==workspaceId||value.pageId!==pageId||value.revision!==revision||value.pageVersion!==pageVersion||value.teamspaceId!==teamspaceId||!counter(value.affectedPageCount)||value.affectedPageCount<1||['beforeReaders','afterReaders','addedReaders','removedReaders','outsideReadersPreserved'].some(key=>!counter(value[key]))||typeof value.teamspaceOwnersHaveFullAccess!=='boolean'||typeof value.actorCanReadAfter!=='boolean'||typeof value.actorCanManageAfter!=='boolean'||value.existingGrantsPreserved!==true||typeof value.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.reviewDigest))invalid();
 return structuredClone(value);
}
export function validateTeamspaceRequests(value,workspaceId,teamspaceId){
 const validRow=row=>plain(row)&&Object.keys(row).length===5&&id(row.id)&&id(row.accountId)&&typeof row.name==='string'&&row.name.length<=500&&typeof row.createdAt==='string'&&Number.isFinite(Date.parse(row.createdAt))&&new Date(row.createdAt).toISOString()===row.createdAt&&typeof row.currentUser==='boolean';
 if(!plain(value)||Object.keys(value).length!==7||value.workspaceId!==workspaceId||value.teamspaceId!==teamspaceId||!counter(value.revision)||typeof value.canReview!=='boolean'||typeof value.canRequest!=='boolean'||!Array.isArray(value.requests)||value.requests.length>1000||value.requests.some(row=>!validRow(row))||!unique(value.requests.map(row=>row.id))||!unique(value.requests.map(row=>row.accountId))||!(value.myRequest===null||validRow(value.myRequest)&&value.myRequest.currentUser===true)||!value.canReview&&value.requests.length||value.canReview&&value.myRequest!==null||value.canRequest&&(value.myRequest!==null||value.canReview))invalid();return structuredClone(value);
}
export function validateTeamspaceRequestAck(value,{workspaceId,teamspaceId,expectedRevision,requestId,accountId,action}){
 if(!plain(value)||Object.keys(value).length!==6||value.workspaceId!==workspaceId||value.teamspaceId!==teamspaceId||!counter(expectedRevision)||expectedRevision===Number.MAX_SAFE_INTEGER||value.revision!==expectedRevision+1||!id(value.requestId)||requestId&&value.requestId!==requestId||value.accountId!==accountId||value.action!==action||!['request','approve','reject','cancel'].includes(action))invalid();return structuredClone(value);
}
/** Cookie-bound UI client. Unknown write results require a fresh review, never an automatic retry. */
export class TeamspaceClient{
 constructor({workspaceId,accountId,fetcher=globalThis.fetch,signal}={}){
  if(!id(workspaceId)||!id(accountId)||typeof fetcher!=='function')throw new TypeError('INVALID_TEAMSPACE_CLIENT');
  this.workspaceId=workspaceId;this.accountId=accountId;this.fetcher=(...args)=>fetcher(...args);this.controller=new AbortController();this.signal=signal?AbortSignal.any([signal,this.controller.signal]):this.controller.signal;this.busy=false;this.uncertain=false;this.destroyed=false;
 }
 destroy(){this.destroyed=true;this.controller.abort();}
 async actor(){
  const value=await this.raw('/api/auth/get-session');
  if(value?.user?.id!==this.accountId||value.user.emailVerified!==true)throw new TeamspaceClientError('ACCOUNT_CHANGED',409);
 }
 async raw(path,{method='GET',body}={}){
  let response;
  try{response=await this.fetcher(path,{method,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([this.signal,AbortSignal.timeout(20000)]),headers:{'X-Yumunio-Expected-Account':this.accountId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw new TeamspaceClientError(this.destroyed?'DESTROYED':'REQUEST_UNCONFIRMED');}
  if(this.destroyed)throw new TeamspaceClientError('DESTROYED');
  let value;try{value=await response.json();}catch{throw new TeamspaceClientError('INVALID_RESPONSE',response.status);}
  if(!response.ok)throw new TeamspaceClientError(value?.error?.code||'TEAMSPACE_UNAVAILABLE',response.status);
  return value;
 }
 base(){return '/api/content/workspaces/'+encodeURIComponent(this.workspaceId);}
 async get(path,validate){await this.actor();const value=await this.raw(this.base()+path);await this.actor();return validate(value);}
 async write(path,method,body,validate){
  if(this.busy||this.uncertain||this.destroyed)throw new TeamspaceClientError(this.uncertain?'REQUEST_UNCONFIRMED':'BUSY');
  const captured=structuredClone(body);
  this.busy=true;let sent=false;
  try{await this.actor();sent=true;const value=await this.raw(this.base()+path,{method,body:captured});await this.actor();return validate(value,captured);}
  catch(error){if(sent&&(!error.status||error.status>=500||['INVALID_RESPONSE','ACCOUNT_CHANGED','REQUEST_UNCONFIRMED'].includes(error.code)))this.uncertain=true;throw error;}
  finally{this.busy=false;}
 }
 list(){return this.get('/teamspaces',value=>validateTeamspaceList(value,this.workspaceId));}
 read(teamspaceId){if(!id(teamspaceId))throw new TypeError('INVALID_TEAMSPACE');return this.get('/teamspaces/'+encodeURIComponent(teamspaceId),value=>validateTeamspaceDetail(value,this.workspaceId,teamspaceId));}
 acknowledged(value,body,teamspaceId){const result=validateTeamspaceDetail(value,this.workspaceId,teamspaceId);if(!counter(body.expectedRevision)||body.expectedRevision===Number.MAX_SAFE_INTEGER||result.revision!==body.expectedRevision+1)invalid();return result;}
 teamPath(teamspaceId){if(!id(teamspaceId))throw new TypeError('INVALID_TEAMSPACE');return '/teamspaces/'+encodeURIComponent(teamspaceId);}
 create(body){return this.write('/teamspaces','POST',body,(value,captured)=>this.acknowledged(value,captured));}
 duplicate(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/duplicate','POST',body,(value,captured)=>{
  const result=this.acknowledged(value,captured),team=result.teamspace;
  if(captured.confirmSettingsOnly!==true||team.id===teamspaceId||team.name!==captured.name||team.archivedAt!==null||team.role!=='owner'||team.memberCount!==1||!team.capabilities.includes('manage')||!team.capabilities.includes('createPage')||result.members.length!==1||result.members[0].accountId!==this.accountId||result.members[0].role!=='owner'||result.members[0].currentUser!==true)invalid();return result;
 });}
 update(teamspaceId,body){return this.write(this.teamPath(teamspaceId),'PATCH',body,(value,captured)=>this.acknowledged(value,captured,teamspaceId));}
 member(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/members','POST',body,(value,captured)=>this.acknowledged(value,captured,teamspaceId));}
 removeMember(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/members','DELETE',body,(value,captured)=>this.acknowledged(value,captured,teamspaceId));}
 join(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/join','POST',body,(value,captured)=>this.acknowledged(value,captured,teamspaceId));}
 archive(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/archive','POST',body,(value,captured)=>this.acknowledged(value,captured,teamspaceId));}
 requests(teamspaceId){return this.get(this.teamPath(teamspaceId)+'/requests',value=>validateTeamspaceRequests(value,this.workspaceId,teamspaceId));}
 async requestJoin(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/requests','POST',requestIntent(body,'request'),(value,captured)=>validateTeamspaceRequestAck(value,{workspaceId:this.workspaceId,teamspaceId,expectedRevision:captured.expectedRevision,accountId:this.accountId,action:'request'}));}
 async decideRequest(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/requests','PATCH',requestIntent(body,'decision'),(value,captured)=>validateTeamspaceRequestAck(value,{workspaceId:this.workspaceId,teamspaceId,expectedRevision:captured.expectedRevision,requestId:captured.requestId,accountId:captured.accountId,action:captured.decision}));}
 async cancelRequest(teamspaceId,body){return this.write(this.teamPath(teamspaceId)+'/requests','DELETE',requestIntent(body,'cancel'),(value,captured)=>validateTeamspaceRequestAck(value,{workspaceId:this.workspaceId,teamspaceId,expectedRevision:captured.expectedRevision,requestId:captured.requestId,accountId:this.accountId,action:'cancel'}));}
 reviewPage(pageId,body){return this.getReview(pageId,body);}
 async getReview(pageId,body){const captured=structuredClone(body);await this.actor();const value=await this.raw(this.base()+'/pages/'+encodeURIComponent(pageId)+'/teamspace-review',{method:'POST',body:captured});await this.actor();return validateTeamspaceReview(value,{workspaceId:this.workspaceId,pageId,revision:captured.expectedRevision,pageVersion:captured.expectedVersion,teamspaceId:captured.teamspaceId});}
 movePage(pageId,body){return this.write('/pages/'+encodeURIComponent(pageId)+'/teamspace','PATCH',body,(value,captured)=>{
  if(!plain(value)||Object.keys(value).length!==5||value.workspaceId!==this.workspaceId||value.pageId!==pageId||value.revision!==captured.expectedRevision+1||value.teamspaceId!==captured.teamspaceId||!counter(value.affectedPageCount)||value.affectedPageCount<1)invalid();return structuredClone(value);
 });}
}
