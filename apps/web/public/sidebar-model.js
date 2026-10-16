/** Only projected readable pages are supplied; never infer hidden ancestors. */
export function sidebarPageRows(pages,expanded=new Set()){
 const byId=new Map(pages.map(page=>[page.id,page])),parents=new Set(pages.filter(page=>byId.has(page.parentId)).map(page=>page.parentId));
 return pages.flatMap(page=>{
  let cursor=page,depth=0;const seen=new Set([page.id]);
  while(cursor.parentId&&byId.has(cursor.parentId)){
   if(seen.has(cursor.parentId)||!expanded.has(cursor.parentId))return[];
   seen.add(cursor.parentId);cursor=byId.get(cursor.parentId);depth++;
  }
  return[{page,depth:Math.min(depth,5),hasChildren:parents.has(page.id)}];
 });
}
export function revealSidebarPage(pages,pageId,expanded){
 const byId=new Map(pages.map(page=>[page.id,page])),seen=new Set([pageId]);let cursor=byId.get(pageId);
 while(cursor?.parentId&&byId.has(cursor.parentId)&&!seen.has(cursor.parentId)){expanded.add(cursor.parentId);seen.add(cursor.parentId);cursor=byId.get(cursor.parentId);}
}
