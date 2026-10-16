import {pageBlocksEqual} from './page-save-result.js';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** Creation retains its legacy raw Page acknowledgement; access is confirmed by GET. */
export function validateCreatedPage(submitted,value,{workspaceId}={}){
 if(!Number.isSafeInteger(submitted?.expectedRevision)||submitted.expectedRevision<0||submitted.expectedRevision>=Number.MAX_SAFE_INTEGER||value?.revision!==submitted.expectedRevision+1||!id(value.page?.id)||value.page.workspaceId!==workspaceId||value.page.title!==submitted.title||value.document?.pageId!==value.page.id||value.document.workspaceId!==workspaceId||value.document.version!==1||!pageBlocksEqual(value.document.blocks,submitted.blocks)){
  const error=new Error('INVALID_CREATE_RESPONSE');error.code='INVALID_CREATE_RESPONSE';error.status=0;throw error;
 }
 return value;
}
export function validateCreatedPageProjection(created,value,{workspaceId,teamspaceId=null}={}){
 if(!Number.isSafeInteger(value?.revision)||value.revision<created.revision||value.page?.id!==created.page.id||value.page.workspaceId!==workspaceId||value.page.teamspaceId!==teamspaceId||value.document?.pageId!==created.page.id||value.document.workspaceId!==workspaceId||!Number.isSafeInteger(value.document.version)||value.document.version<1||!Array.isArray(value.page.capabilities)||!['read','editBody','manage'].every(cap=>value.page.capabilities.includes(cap))){
  const error=new Error('INVALID_CREATE_RESPONSE');error.code='INVALID_CREATE_RESPONSE';error.status=0;throw error;
 }
 return value;
}
