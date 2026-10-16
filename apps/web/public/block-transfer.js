import {planBlockForestMove} from './block-forest.js';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const counter=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
export class BlockTransferError extends TypeError{constructor(code='INVALID_BLOCK_TRANSFER'){super(code);this.code=code;}}
function envelope(value){
 if(!value||!validId(value.page?.id)||!validId(value.page.workspaceId)||!Array.isArray(value.page.capabilities)||!value.page.capabilities.includes('editBody')||value.document?.pageId!==value.page.id||value.document.workspaceId!==value.page.workspaceId||!counter(value.revision)||!counter(value.document.version)||value.document.version<1||!Array.isArray(value.document.blocks))throw new BlockTransferError();
}
/** Capture the exact reviewed forest and both versions; later selection changes cannot alter it. */
export function createPageBlockTransfer(source,target,blockIds,{parentBlockId=null,index=target?.document?.blocks?.length}={}){
 envelope(source);envelope(target);
 if(source.page.id===target.page.id||source.page.workspaceId!==target.page.workspaceId||target.revision<source.revision)throw new BlockTransferError();
 const plan=planBlockForestMove(source.document.blocks,target.document.blocks,{blockIds,parentBlockId,index});
 const ids=Object.freeze([...plan.blockIds]);
 return Object.freeze({sourcePageId:source.page.id,targetPageId:target.page.id,sourceVersion:source.document.version,targetVersion:target.document.version,
  body:Object.freeze({expectedRevision:target.revision,expectedVersion:source.document.version,targetPageId:target.page.id,targetExpectedVersion:target.document.version,blockIds:ids,parentBlockId:plan.parentBlockId,index:plan.index})});
}
/** A malformed or stale acknowledgement is uncertain: never remove local blocks or auto-retry. */
export function validatePageBlockTransferResult(result,transfer){
 const keys=['revision','blockIds','sourcePageId','targetPageId','sourceVersion','targetVersion'];
 if(!result||Array.isArray(result)||Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key))||result.revision!==transfer.body.expectedRevision+1||result.sourcePageId!==transfer.sourcePageId||result.targetPageId!==transfer.targetPageId||result.sourceVersion!==transfer.sourceVersion+1||result.targetVersion!==transfer.targetVersion+1||!Array.isArray(result.blockIds)||result.blockIds.length!==transfer.body.blockIds.length||result.blockIds.some((id,index)=>id!==transfer.body.blockIds[index]))throw new BlockTransferError('INVALID_BLOCK_TRANSFER_RESPONSE');
 return result;
}
