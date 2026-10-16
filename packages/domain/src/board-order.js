/** Saved board order is independent of grouping values and never changes row identity. */
export class BoardOrderError extends Error{constructor(code='INVALID_BOARD_ORDER'){super(code);this.code=code;}}
const fail=()=>{throw new BoardOrderError();};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function ids(value){if(!Array.isArray(value)||value.length>1000||value.some(value=>!id(value))||new Set(value).size!==value.length)fail();return value;}
export function validateBoardOrder(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'recordIds'))fail();ids(value.recordIds);return value;}
export function orderedBoardIds(recordIds,order){ids(recordIds);if(order!==undefined)validateBoardOrder(order);const available=new Set(recordIds),saved=(order?.recordIds??[]).filter(id=>available.has(id)),seen=new Set(saved);return[...saved,...recordIds.filter(id=>!seen.has(id))];}
/** Only the reviewed visible slots change; hidden/filtered records retain their positions. */
export function mergeVisibleBoardOrder(base,visible,desired){ids(base);ids(visible);ids(desired);const all=new Set(base),visibleSet=new Set(visible);if(visible.length!==desired.length||visible.some(id=>!all.has(id))||desired.some(id=>!visibleSet.has(id)))fail();let index=0;return base.map(id=>visibleSet.has(id)?desired[index++]:id);}
/** beforeRecordId=null appends to the target column. JSON scalar equality preserves types. */
export function moveVisibleBoardRecord(records,{recordId,targetValue,beforeRecordId,groupBy}){
 if(!Array.isArray(records))fail();const before=records.map(record=>record.id);ids(before);if(!id(recordId)||!id(groupBy)||!before.includes(recordId)||beforeRecordId!==null&&!id(beforeRecordId))fail();
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),others=records.filter(record=>record.id!==recordId),anchor=beforeRecordId===null?null:others.find(record=>record.id===beforeRecordId);
 if(beforeRecordId!==null&&(!anchor||!same(anchor.values[groupBy]??null,targetValue)))fail();
 const desired=others.map(record=>record.id);let index=anchor?desired.indexOf(anchor.id):-1;
 if(!anchor){for(let i=others.length-1;i>=0;i--)if(same(others[i].values[groupBy]??null,targetValue)){index=i+1;break;}if(index<0)index=desired.length;}
 desired.splice(index,0,recordId);return desired;
}
