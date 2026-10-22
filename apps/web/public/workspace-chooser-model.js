export const validChooserId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export const recentWorkspaceKey=accountId=>'yumunio.recent-workspace.v1:'+accountId;

/** Remember the last workspace an account opened so the next sign-in lands there. */
export function rememberWorkspace(storage,accountId,workspaceId){
 if(!storage||typeof storage.setItem!=='function'||!validChooserId(accountId)||!validChooserId(workspaceId))return false;
 try{storage.setItem(recentWorkspaceKey(accountId),workspaceId);return true;}catch{return false;}
}
export function readRecentWorkspace(storage,accountId){
 if(!storage||typeof storage.getItem!=='function'||!validChooserId(accountId))return '';
 try{const value=storage.getItem(recentWorkspaceKey(accountId));return validChooserId(value)?value:'';}catch{return '';}
}

/** One workspace opens straight away; several open the last one, otherwise the Slack-like list. */
export function chooseWorkspace({workspaces,recentId=''}={}){
 const list=Array.isArray(workspaces)?workspaces.filter(item=>validChooserId(item?.id)):[];
 if(!list.length)return Object.freeze({mode:'empty'});
 if(list.length===1)return Object.freeze({mode:'open',workspace:list[0]});
 const recent=validChooserId(recentId)?list.find(item=>item.id===recentId):null;
 return Object.freeze(recent?{mode:'open',workspace:recent}:{mode:'list'});
}

/** Derive the 1-character tile shown next to a workspace name. */
export function workspaceMonogram(name){
 const text=typeof name==='string'?name.trim():'';
 const[first='?']=Array.from(text);
 return /[a-z]/.test(first)?first.toUpperCase():first;
}

/** Suggest the URL slug used by the create form; empty for names without latin letters. */
export function workspaceSlugSuggestion(name){
 const text=typeof name==='string'?name.trim().toLowerCase():'';
 return text.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100);
}
