/** Only projected readable pages are supplied; never infer hidden ancestors. */
export function sidebarLayoutKey({pageRows,activeTeams,collapsedTeams,expandedPages,state}){
 return JSON.stringify([pageRows.map(({page,depth,hasChildren})=>[page.id,depth,hasChildren]),activeTeams.map(team=>team.id),collapsedTeams,expandedPages,state.pages.filter(page=>page.favorite).map(page=>page.id)]);
}
export function sidebarPageRows(pages,expanded=new Set()){
 const byId=new Map(pages.map(page=>[page.id,page])),children=new Map(),roots=[];
 for(const page of pages){if(!byId.has(page.parentId))roots.push(page);else{if(!children.has(page.parentId))children.set(page.parentId,[]);children.get(page.parentId).push(page);}}
 const rows=[],seen=new Set(),stack=roots.toReversed().map(page=>({page,depth:0}));
 while(stack.length){const {page,depth}=stack.pop();if(seen.has(page.id))continue;seen.add(page.id);const nested=children.get(page.id)??[];
  rows.push({page,depth,hasChildren:nested.length>0});
  if(expanded.has(page.id))for(let index=nested.length-1;index>=0;index--)stack.push({page:nested[index],depth:depth+1});
 }
 return rows;
}
export function revealSidebarPage(pages,pageId,expanded){
 const byId=new Map(pages.map(page=>[page.id,page])),seen=new Set([pageId]);let cursor=byId.get(pageId);
 while(cursor?.parentId&&byId.has(cursor.parentId)&&!seen.has(cursor.parentId)){expanded.add(cursor.parentId);seen.add(cursor.parentId);cursor=byId.get(cursor.parentId);}
}

export function sidebarSiblings(pages,pageId){
 const source=pages.find(page=>page.id===pageId);if(!source)return[];
 return pages.filter(page=>page.parentId===source.parentId&&(page.teamspaceId??null)===(source.teamspaceId??null)&&
  (source.parentId!==null||page.sidebarSection===source.sidebarSection));
}
export function sidebarSiblingPositions(pages){
 const groups=new Map(),result=new Map();
 for(const page of pages){const key=JSON.stringify([page.parentId,page.teamspaceId??null,page.parentId===null?page.sidebarSection??null:null]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(page.id);}
 for(const ids of groups.values())ids.forEach((id,index)=>result.set(id,{index,count:ids.length}));return result;
}
export function sidebarAncestors(pages,pageId){
 const byId=new Map(pages.map(page=>[page.id,page])),seen=new Set([pageId]),result=[];let cursor=byId.get(pageId);
 while(cursor?.parentId&&byId.has(cursor.parentId)&&!seen.has(cursor.parentId)){cursor=byId.get(cursor.parentId);seen.add(cursor.id);result.push(cursor);}
 return result.reverse();
}

/** The server checks the actual ancestry and permissions again before any write. */
export function sidebarDropPlacement(pages,sourceId,targetId,edge){
 const source=pages.find(page=>page.id===sourceId),target=pages.find(page=>page.id===targetId);
 if(!source||!target||source===target||source.recordId||source.templateId||(source.teamspaceId??null)!==(target.teamspaceId??null)||!['before','inside','after'].includes(edge))return null;
 const byId=new Map(pages.map(page=>[page.id,page])),parentId=edge==='inside'?target.id:target.parentId;
 let cursor=parentId;const seen=new Set();
 while(cursor!==null){if(cursor===source.id||seen.has(cursor))return null;seen.add(cursor);const ancestor=byId.get(cursor);if(!ancestor||!ancestor.capabilities?.includes('read'))return null;cursor=ancestor.parentId;}
 if(parentId!==source.parentId&&parentId!==null&&!byId.get(parentId)?.capabilities?.includes('manage'))return null;
 if(edge==='inside')return{parentId,beforeId:null};
 const siblings=sidebarSiblings(pages,targetId).filter(page=>page.id!==sourceId),index=siblings.findIndex(page=>page.id===targetId);
 return{parentId,beforeId:edge==='before'?target.id:siblings[index+1]?.id??null};
}

export function readSidebarDisclosure(storage,key){
 try{const text=storage.getItem(key);if(!text||text.length>256000)return null;const value=JSON.parse(text),ids=items=>Array.isArray(items)&&items.every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id));
  return value?.version===1&&ids(value.expanded)&&ids(value.collapsedTeams)?{expanded:new Set(value.expanded),collapsedTeams:new Set(value.collapsedTeams)}:null;
 }catch{return null;}
}
export function writeSidebarDisclosure(storage,key,expanded,collapsedTeams){
 try{storage.setItem(key,JSON.stringify({version:1,expanded:[...expanded],collapsedTeams:[...collapsedTeams]}));}catch{}
}
