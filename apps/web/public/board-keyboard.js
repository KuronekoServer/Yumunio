const validRect=rect=>rect&&['left','top','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0;
const center=rect=>({x:rect.left+rect.width/2,y:rect.top+rect.height/2});

/** Opaque, already-authorized target DTOs; DOM reading order follows the board direction. */
export function nextBoardKeyboardTarget({columns,targets,sourceColumn,sourceRect,currentKey=null,direction,rtl=false}){
 if(!['up','down','left','right'].includes(direction)||!validRect(sourceRect)||!Array.isArray(columns)||!Array.isArray(targets))return null;
 const shown=columns.filter(column=>validRect(column.rect));
 const order=new Map(shown.map((column,index)=>[column.id,index]));
 const candidates=targets.filter(target=>typeof target.key==='string'&&order.has(target.column)&&validRect(target.rect));
 const current=candidates.find(target=>target.key===currentKey),column=current?.column??sourceColumn,point=current?center(current.rect):center(sourceRect);
 const compareRows=(a,b)=>a.rect.top-b.rect.top||(a.order??0)-(b.order??0)||a.key.localeCompare(b.key);
 if(direction==='up'||direction==='down'){
  const rows=candidates.filter(target=>target.column===column).sort(compareRows),at=rows.findIndex(target=>target.key===currentKey);
  if(at>=0)return rows[at+(direction==='down'?1:-1)]??null;
  const rowsAhead=rows.filter(target=>direction==='down'?center(target.rect).y>point.y+.5:center(target.rect).y<point.y-.5);
  return direction==='down'?(rowsAhead[0]??null):(rowsAhead.at(-1)??null);
 }
 const physical=rtl?[...shown].reverse():shown;
 const at=physical.findIndex(target=>target.id===column);if(at<0)return null;
 const step=direction==='right'?1:-1;
 for(let index=at+step;index>=0&&index<physical.length;index+=step){
  const rows=candidates.filter(target=>target.column===physical[index].id).sort(compareRows);
  if(rows.length)return [...rows].sort((a,b)=>Math.abs(center(a.rect).y-point.y)-Math.abs(center(b.rect).y-point.y)||compareRows(a,b))[0];
 }
 return null;
}
