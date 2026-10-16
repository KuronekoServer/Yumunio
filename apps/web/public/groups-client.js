import {TeamspaceClient,TeamspaceClientError} from './teamspace-client.js';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),count=value=>Number.isSafeInteger(value)&&value>=0;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value),stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const invalid=()=>{throw new TeamspaceClientError('INVALID_RESPONSE');};
const unique=(rows,key)=>new Set(rows.map(row=>row[key])).size===rows.length;
function group(value,workspaceId){if(!plain(value)||!id(value.id)||value.workspaceId!==workspaceId||typeof value.name!=='string'||!value.name.trim()||value.name!==value.name.trim()||/[\u0000-\u001f\u007f]/.test(value.name)||value.name.length>100||!count(value.memberCount)||value.memberCount>2000||!stamp(value.createdAt)||!stamp(value.updatedAt)||!(value.archivedAt===null||stamp(value.archivedAt)))invalid();}
export function validateGroups(value,workspaceId,{detail=false}={}){
 if(!plain(value)||value.workspaceId!==workspaceId||!count(value.revision)||typeof value.canManage!=='boolean')invalid();
 if(detail){group(value.group,workspaceId);for(const name of ['members','candidates'])if(!Array.isArray(value[name])||value[name].length>2000||value[name].some(person=>!plain(person)||!id(person.accountId)||typeof person.name!=='string'||person.name.length>500||name==='members'&&(!id(person.id)||typeof person.currentUser!=='boolean'))||!unique(value[name],'accountId'))invalid();if(!unique(value.members,'id')||value.members.filter(person=>person.currentUser).length>1||!value.canManage&&(value.members.length||value.candidates.length)||value.canManage&&value.group.memberCount!==value.members.length)invalid();}
 else{if(!Array.isArray(value.groups)||value.groups.length>100)invalid();value.groups.forEach(item=>group(item,workspaceId));if(!unique(value.groups,'id'))invalid();}
 return structuredClone(value);
}
export function validateGroupGrants(value,workspaceId,pageId){if(!plain(value)||value.workspaceId!==workspaceId||value.pageId!==pageId||!count(value.revision)||!Array.isArray(value.grants)||value.grants.length>2000||value.grants.some(row=>!plain(row)||!id(row.id)||!id(row.groupId)||row.workspaceId!==workspaceId||row.pageId!==pageId||!['viewer','commenter','editor','full','deny'].includes(row.permission)||typeof row.includeDescendants!=='boolean'||row.status!=='active'||typeof row.groupName!=='string'||row.groupName.length>100)||!unique(value.grants,'id')||!unique(value.grants,'groupId'))invalid();return structuredClone(value);}
export class GroupsClient extends TeamspaceClient{
 list(){return this.get('/groups',value=>validateGroups(value,this.workspaceId));}
 read(groupId){if(!id(groupId))invalid();return this.get('/groups/'+encodeURIComponent(groupId),value=>{const data=validateGroups(value,this.workspaceId,{detail:true});if(data.group.id!==groupId)invalid();return data;});}
 mutation(groupId,path,method,body,check){if(groupId!==null&&!id(groupId))invalid();return this.write('/groups'+(groupId?'/'+encodeURIComponent(groupId):'')+path,method,body,(value,captured)=>{const result=validateGroups(value,this.workspaceId,{detail:true});if(!count(captured.expectedRevision)||captured.expectedRevision===Number.MAX_SAFE_INTEGER||result.revision!==captured.expectedRevision+1||!result.canManage||groupId&&(result.group.id!==groupId||captured.confirmAccessChange!==true)||!check(result,captured))invalid();return result;});}
 create(body){return this.mutation(null,'','POST',body,(data,command)=>data.group.name===command.name&&data.group.archivedAt===null&&data.members.length===0&&data.group.memberCount===0);}
 rename(groupId,body){return this.mutation(groupId,'','PATCH',body,(data,command)=>data.group.name===command.name);}
 archive(groupId,body){return this.mutation(groupId,'/archive','POST',body,(data,command)=>(data.group.archivedAt!==null)===command.archived);}
 member(groupId,body){return this.mutation(groupId,'/members','POST',body,(data,command)=>data.members.some(person=>person.accountId===command.accountId));}
 remove(groupId,body){return this.mutation(groupId,'/members','DELETE',body,(data,command)=>!data.members.some(person=>person.id===command.memberId));}
 pageGrants(pageId){if(!id(pageId))invalid();return this.get('/pages/'+encodeURIComponent(pageId)+'/group-grants',value=>validateGroupGrants(value,this.workspaceId,pageId));}
 grant(pageId,body){return this.grantMutation(pageId,'POST',body,(data,command)=>data.grants.some(row=>row.groupId===command.groupId&&row.permission===command.permission&&row.includeDescendants===command.includeDescendants));}
 revoke(pageId,body){return this.grantMutation(pageId,'DELETE',body,(data,command)=>!data.grants.some(row=>row.id===command.grantId));}
 grantMutation(pageId,method,body,check){if(!id(pageId))invalid();return this.write('/pages/'+encodeURIComponent(pageId)+'/group-grants',method,body,(value,captured)=>{const result=validateGroupGrants(value,this.workspaceId,pageId);if(!count(captured.expectedRevision)||captured.expectedRevision===Number.MAX_SAFE_INTEGER||captured.confirmAccessChange!==true||result.revision!==captured.expectedRevision+1||!check(result,captured))invalid();return result;});}
}
