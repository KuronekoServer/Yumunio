import {createPageAccessEvaluator} from '@yumunio/domain';
import {accountContentPolicy} from './content-policy.js';
import {invalidateRooms} from './content-room.js';

// Evaluate recoverable pages too: restoring trash or an archived team must not
// revive access which the operator was not allowed to change.
const recoverable=state=>({...state,pages:state.pages.map(page=>({...page,trashedAt:null})),teamspaces:state.teamspaces.map(team=>({...team,archivedAt:null}))});
export function requireAccessSubtreeManagement({payload,workspaceId,accountId,pageId,fail},before){
 const scope=new Set([pageId]);
 for(let pass=0;pass<payload.pages.length;pass++){
  let changed=false;for(const item of payload.pages)if(scope.has(item.page.parentId)&&!scope.has(item.page.id)){scope.add(item.page.id);changed=true;}
  if(!changed)break;
 }
 const evaluate=createPageAccessEvaluator(recoverable(before));
 if([...scope].some(id=>!evaluate({workspaceId,pageId:id,accountId}).capabilities.includes('manage')))fail('CONTENT_NOT_FOUND',404);
}
export function protectAccessTransition({payload,principals,workspaceId,fail},before){
 const oldAccess=createPageAccessEvaluator(recoverable(before)),newAccess=createPageAccessEvaluator(recoverable(accountContentPolicy(payload,principals,workspaceId))),affected=[];
 for(const page of before.pages){
  let priorManager=false,nextManager=false,changed=false;
  for(const principal of principals){const request={workspaceId,pageId:page.id,accountId:principal.accountId},a=oldAccess(request).capabilities,b=newAccess(request).capabilities;priorManager||=a.includes('manage');nextManager||=b.includes('manage');changed||=a.length!==b.length||a.some(capability=>!b.includes(capability));}
  if(priorManager&&!nextManager)fail('LAST_PAGE_MANAGER',409);
  if(changed)affected.push(page.id);
 }
 invalidateRooms(payload,affected);
}
