import { invalidateRooms } from './content-room.js';
import { rememberPage, trimHistory } from './content-history.js';
import { assertId, assertPlainObject, assertJsonSerializable, validateDocument, createPageAccessEvaluator, moveBlockForest, BlockForestMoveError } from '@yumunio/domain';
import {prepareMentionBlocks} from './content-mentions.js';
import {preparePageLinkBlocks} from './content-page-links.js';
export class ContentBlocksError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const fail = (code = 'INVALID_CONTENT', status = 400) => { throw new ContentBlocksError(code, status); };
const missing = () => fail('CONTENT_NOT_FOUND', 404), conflict = () => fail('CONTENT_CONFLICT', 409);
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
function locate(blocks) {
  const result = new Map();
  const visit = (items, ancestors = []) => { for (const block of items) { result.set(block.id, { block, items, ancestors }); if (block.children) visit(block.children, [...ancestors, block.id]); } };
  visit(blocks); return result;
}
export function moveDocumentBlock(source, target, { blockId, parentBlockId = null, index }) {
  let moved;try{moved=moveBlockForest(source.blocks,target.blocks,{blockIds:[blockId],parentBlockId,index,sameDocument:source===target});}catch(error){if(error instanceof BlockForestMoveError)fail(error.code,error.status);throw error;}
  source.blocks=moved.sourceBlocks;target.blocks=moved.targetBlocks;
  return blockId;
}
export async function handleBlockMove({ request, pageId, store, saved, payload, actor, accountId, workspaceId, access, policy, readJson, readPayload, validatePayload, now, createId }) {
  if (request.method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
  const source = payload.pages.find(row => row.page.id === pageId);
  if (!source || !access(pageId).includes('editBody')) missing();
  const data = await readJson(request); assertPlainObject(data); assertJsonSerializable(data);
  const common = ['expectedRevision', 'expectedVersion', 'targetPageId', 'targetExpectedVersion', 'parentBlockId', 'index'],single=Object.hasOwn(data,'blockId'),multiple=Object.hasOwn(data,'blockIds');
  if(single===multiple||Object.keys(data).some(key=>![...common,single?'blockId':'blockIds'].includes(key))||common.some(key=>!Object.hasOwn(data,key)))fail();
  assertId(data.targetPageId);if(single)assertId(data.blockId);if(data.parentBlockId!==null)assertId(data.parentBlockId);
  const target = payload.pages.find(row => row.page.id === data.targetPageId);
  if (!target || !access(target.page.id).includes('editBody')) missing();
  if (![data.expectedRevision, data.expectedVersion, data.targetExpectedVersion].every(value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER)) fail('INVALID_REVISION');
  if (saved.revision !== data.expectedRevision || source.document.version !== data.expectedVersion || target.document.version !== data.targetExpectedVersion) conflict();
  let moved;try{moved=moveBlockForest(source.document.blocks,target.document.blocks,{blockIds:single?[data.blockId]:data.blockIds,parentBlockId:data.parentBlockId,index:data.index,sameDocument:source===target});}catch(error){if(error instanceof BlockForestMoveError)fail(error.code,error.status);throw error;}
  const targetLocations=locate(moved.targetBlocks),blocks=moved.blockIds.map(id=>targetLocations.get(id).block),evaluate=createPageAccessEvaluator(policy(payload,saved.principals,workspaceId));
  const prepared=prepareMentionBlocks({blocks:preparePageLinkBlocks({blocks,previousBlocks:source===target?blocks:[],access,attachments:payload.attachments??[],pageId:target.page.id}),previousBlocks:source===target?blocks:[],access,principals:saved.principals,personCanRead:(recipientId,destinationId)=>evaluate({accountId:recipientId,workspaceId,pageId:destinationId}).capabilities.includes('read'),pageId:target.page.id});
  for(let index=0;index<moved.blockIds.length;index++){const location=targetLocations.get(moved.blockIds[index]);location.items[location.items.indexOf(location.block)]=prepared.blocks[index];}
  // The final destination must remain editable under the same whole-document recipient limit as PATCH.
  const destination=prepareMentionBlocks({blocks:moved.targetBlocks,previousBlocks:target.document.blocks,access,principals:saved.principals,personCanRead:(recipientId,destinationId)=>evaluate({accountId:recipientId,workspaceId,pageId:destinationId}).capabilities.includes('read'),pageId:target.page.id});
  moved.targetBlocks=destination.blocks;if(source===target)moved.sourceBlocks=destination.blocks;
  invalidateRooms(payload,[pageId,target.page.id]);
  for (const item of new Set([source, target])) rememberPage(payload,item,{actorId:accountId,kind:'block-move',now,createId});
  source.document.blocks=moved.sourceBlocks;target.document.blocks=moved.targetBlocks;
  const stamp = now();
  for (const item of new Set([source, target])) {
    item.page.updatedAt = stamp;
    item.document = validateDocument({ ...item.document, version: item.document.version + 1, updatedAt: stamp });
  }
  trimHistory(payload); const captured = validatePayload(payload, workspaceId);
  try {
    const written = await store.write(workspaceId, accountId, { expectedRevision: saved.revision, payload: captured,
      actorMembershipId: actor.id, actorRole: actor.role, guardMemberships: destination.guards });
    return Response.json({ revision: written.revision, ...(single?{blockId:data.blockId}:{blockIds:moved.blockIds}), sourcePageId: pageId, targetPageId: target.page.id,
      sourceVersion: source.document.version, targetVersion: target.document.version }, { headers });
  } catch (error) {
    if (error?.code !== 'CONTENT_CONFLICT') throw error;
    const fresh = await store.read(workspaceId, accountId);
    if (!fresh?.principals.some(row => row.accountId === accountId && row.id === actor.id && row.emailVerified && row.role === actor.role)) missing();
    const latest = readPayload(fresh, workspaceId), evaluate = createPageAccessEvaluator(policy(latest, fresh.principals, workspaceId));
    for (const id of new Set([pageId, target.page.id])) if (!evaluate({ accountId, workspaceId, pageId: id }).capabilities.includes('editBody')) missing();
    conflict();
  }
}
