import {validateCollectionEnvelope,validateCollectionValue,validateRecordSaveResponse,isComputedProperty} from './collections-model.js';
import {orderedBoardIds,moveVisibleBoardRecord,validateBoardOrder} from './board-order.js';
const TYPES=new Set(['text','number','checkbox','date','select','status']),key=value=>JSON.stringify(value),same=(a,b)=>key(a)===key(b);
export class BoardMoveError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new BoardMoveError(code);};
function captured(envelope){try{if(![envelope?.collection?.workspaceId,envelope?.collection?.id].every(value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)))throw new Error();return validateCollectionEnvelope(envelope,{workspaceId:envelope?.collection?.workspaceId,collectionId:envelope?.collection?.id});}catch{fail('BOARD_INVALID_RESPONSE');}}
function groupReason(property){if(isComputedProperty(property))return'BOARD_COMPUTED_GROUP';if(property?.type==='person')return'BOARD_REFERENCE_GROUP';return TYPES.has(property?.type)?null:'BOARD_UNSUPPORTED_GROUP';}
function targetValid(property,value){try{validateCollectionValue(property,value);return !(property.required&&(value===null||value===''));}catch{return false;}}
/** Groups use only ACL-projected records; empty choices come from the visible schema. */
export function collectionBoardModel(envelope){
 const data=captured(envelope),view=data.view;if(view?.type!=='board')fail('BOARD_NOT_BOARD');
 const property=data.collection.properties.find(property=>property.id===view.groupBy);if(!property)fail('BOARD_INVALID_RESPONSE');
 const reason=groupReason(property),groups=[],byValue=new Map();
 const add=value=>{const id=key(value);if(!byValue.has(id)){const group={value,records:[]};byValue.set(id,group);groups.push(group);}return byValue.get(id);};
 const ordered=data.view.sorts.length?data.collection.records:orderedBoardIds(data.collection.records.map(row=>row.id),data.view.boardOrder).map(id=>data.collection.records.find(row=>row.id===id));
 for(const record of ordered)add(record.values[property.id]).records.push(record);
 if(!reason){if(['select','status'].includes(property.type))for(const value of property.options??[])if(targetValid(property,value))add(value);if(property.type==='checkbox')for(const value of [false,true])add(value);if(targetValid(property,null))add(null);}
 const targets=reason?[]:groups.filter(group=>targetValid(property,group.value)).map(group=>group.value);
 const reasonFor=recordId=>{const row=data.collection.records.find(row=>row.id===recordId);if(!row)return'BOARD_ROW_UNAVAILABLE';if(reason)return reason;if(row.redactedProperties?.includes(property.id))return'BOARD_REDACTED_GROUP';if(!row.capabilities.includes('editRecordValues'))return'BOARD_READ_ONLY';return null;};
 const orderReasonFor=recordId=>reasonFor(recordId)??(view.sorts.length?'BOARD_SORTED':!data.capabilities.includes('manage')?'BOARD_ORDER_READ_ONLY':null);
 return{property,groups,targets,reason,reasonFor,canMove:recordId=>reasonFor(recordId)===null,orderReasonFor,canReorder:recordId=>orderReasonFor(recordId)===null};
}
/** One reviewed visible permutation plus a typed group change; the server merges invisible slots atomically. */
export function prepareBoardOrderMove(envelope,{recordId,targetValue,beforeRecordId=null}){
 const data=captured(envelope),model=collectionBoardModel(data),reason=model.orderReasonFor(recordId);if(reason)fail(reason);
 const record=data.collection.records.find(row=>row.id===recordId),property=model.property;
 if(!targetValid(property,targetValue)||!model.targets.some(value=>same(value,targetValue)))fail('BOARD_TARGET_UNAVAILABLE');
 const visibleRecordIds=orderedBoardIds(data.collection.records.map(row=>row.id),data.view.boardOrder),rows=visibleRecordIds.map(id=>data.collection.records.find(row=>row.id===id));
 let desired;try{desired=moveVisibleBoardRecord(rows,{recordId,targetValue,beforeRecordId,groupBy:property.id});}catch{fail('BOARD_TARGET_UNAVAILABLE');}
 if(same(record.values[property.id],targetValue)&&same(desired,visibleRecordIds))return null;
 const move=Object.freeze({recordId,targetValue:structuredClone(targetValue),beforeRecordId,visibleRecordIds:Object.freeze(visibleRecordIds)}),body=Object.freeze({expectedRevision:data.revision,boardMove:move});
 return Object.freeze({workspaceId:data.collection.workspaceId,collectionId:data.collection.id,viewId:data.view.id,recordId,targetValue,beforeRecordId,body,validateResponse(value){
  try{if(!value||Object.keys(value).sort().join(',')!=='boardOrder,collectionId,record,revision,viewId'||value.revision!==data.revision+1||value.viewId!==data.view.id)throw new Error();validateBoardOrder(value.boardOrder);if(!same(value.boardOrder.recordIds,desired))throw new Error();validateRecordSaveResponse(value,{envelope:data,recordId,values:{[property.id]:targetValue},title:record.title});if(data.collection.properties.some(field=>field.id!==property.id&&!isComputedProperty(field)&&!same(value.record.values[field.id],record.values[field.id])))throw new Error();return structuredClone(value);}catch{fail('BOARD_INVALID_RESPONSE');}
 }});
}
/** Captures one explicit field change; no title, original cells or unrelated values are sent. */
export function prepareBoardMove(envelope,{recordId,targetValue}){
 const data=captured(envelope),model=collectionBoardModel(data),reason=model.reasonFor(recordId);if(reason)fail(reason);
 const record=data.collection.records.find(record=>record.id===recordId),property=model.property;
 if(!targetValid(property,targetValue)||!model.targets.some(value=>same(value,targetValue)))fail('BOARD_TARGET_UNAVAILABLE');
 if(same(record.values[property.id],targetValue))return null;
 const changed={};Object.defineProperty(changed,property.id,{value:structuredClone(targetValue),enumerable:true});Object.freeze(changed);
 const body=Object.freeze({expectedRevision:data.revision,values:changed});
 return Object.freeze({workspaceId:data.collection.workspaceId,collectionId:data.collection.id,recordId,propertyId:property.id,fromValue:record.values[property.id],targetValue,body,
  validateResponse(response){try{return validateRecordSaveResponse(response,{envelope:data,recordId,values:changed,title:record.title});}catch{fail('BOARD_INVALID_RESPONSE');}}
 });
}
