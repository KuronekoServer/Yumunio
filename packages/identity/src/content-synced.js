import {isSyncedBlock} from '@yumunio/domain';
import {ContentPageLinksError} from './content-page-links.js';
/** Existing hidden references can survive text edits. New references require source read access. */
export function prepareSyncedBlocks({blocks,previousBlocks=[],access,pageId}){
 const previous=new Map(),visit=(items,fn)=>{for(const block of items){fn(block);if(block.children)visit(block.children,fn);}};visit(previousBlocks,block=>{if(isSyncedBlock(block))previous.set(block.id,block.data.pageId);});
 visit(blocks,block=>{if(!isSyncedBlock(block))return;if(previous.get(block.id)===block.data.pageId)return;if(block.data.pageId===pageId||!access(block.data.pageId).includes('read'))throw new ContentPageLinksError('CONTENT_NOT_FOUND',404);});return blocks;
}
