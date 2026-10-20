import {accountContentPolicy,pagePlacement} from './content-policy.js';
import {handlePageTools,validatePageFavorites} from './content-page-tools.js';
import {validateTeamspaceState,validateTeamspaceJoinRequests} from '@yumunio/domain';
import {ContentTeamspaceError,handleTeamspaceRequest,requireTeamspaceCreate} from './content-teamspaces.js';
import {validateGroupState} from '../../domain/src/groups.js';
import {ContentGroupsError,handleGroupRequest} from './content-groups.js';
import {requireAccessSubtreeManagement,protectAccessTransition} from './content-access-transition.js';
import {CONTENT_STORAGE_LIMITS} from './content-codec.js';
import {ContentPageLinksError,preparePageLinkBlocks} from './content-page-links.js';
import {prepareSyncedBlocks} from './content-synced.js';
import {ContentMentionsError,prepareMentionBlocks,projectMentionBlocks} from './content-mentions.js';
import {ContentPublicationError, validatePublications, handlePublicationRequest, createPublicPageApi} from './content-publication.js';
import { commitPageAttachment, listPageUploads, removePageAttachment,copyPageBlockAttachments } from './content-attachments.js';
import { ContentFormsError, validateForms, handleFormRequest, createPublicFormApi } from './content-forms.js';
import { ContentCommentsError, validateDiscussion, handleDiscussion } from './content-comments.js';
import {ContentActivityError,validateActivityNotifications,recordInlineMentions} from './content-activity.js';
import {
  assertId, assertJsonSerializable, assertPlainObject, validatePage, validateDocument,
  validatePageGrant, createPageAccessEvaluator, validateBlocks, assertTitle, validateCollection, validatePropertyDefinitions, validatePropertyValues,
} from '@yumunio/domain';
import { ContentCollectionsError, validateAccountCollections, handleCollectionRequest, projectAccountCollection } from './content-collections.js';
import { ContentAssetError, validateAssetPayload, validateImportAssets, consumeImportAssets, handleAssetRequest, downloadAttachment } from './content-assets.js';
import { validateRooms, invalidateRooms, handleRoom, isRoomError } from './content-room.js';
import { ContentHistoryError, validateHistory, rememberPage, trimHistory, handleHistory } from './content-history.js';
import { ContentBlocksError, handleBlockMove } from './content-blocks.js';
import { ContentPagesError, validateTrashGroups, handlePageLifecycle, listTrash, searchPages, exportPages } from './content-pages.js';
import { ContentBacklinksError, handleBacklinks } from './content-backlinks.js';
import { PersonalTemplatesError, validatePersonalTemplates, handlePersonalTemplates } from './personal-templates.js';

const MAX_REQUEST_BYTES = 256000;
const MAX_CONTENT_BYTES = CONTENT_STORAGE_LIMITS.logicalBytes;
const MAX_IMPORT_REQUEST_BYTES = 768000;
const MAX_IMPORT_PAGES = 500;
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
const json = (body, status = 200) => Response.json(body, { status, headers });
export class ContentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status = 400) => { throw new ContentError(code, status); };
const missing = () => fail('CONTENT_NOT_FOUND', 404);
function object(value, allowed, required = allowed) {
  assertJsonSerializable(value);
  assertPlainObject(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_CONTENT');
  return value;
}
const revision = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail('INVALID_REVISION');
  return value;
};

/** Internal aggregate only. HTTP never exposes this record or accepts wholesale replacement. */
export function validateContentPayload(value, workspaceId) {
  assertId(workspaceId);
  object(value, ['schemaVersion', 'pages', 'grants', 'grantBindings', 'imports', 'collections', 'pendingBlobs', 'attachments', 'trashGroups', 'history', 'rooms', 'discussion', 'forms', 'formGrants', 'formReceipts', 'publicFormReceipts', 'formRateCounters', 'publications', 'personalTemplates', 'personalTemplateReceipts', 'teamspaces', 'teamspaceMembers', 'teamspacePages', 'personalPageOwners','groups','groupMembers','groupGrants','teamspaceJoinRequests','activityNotifications','pageFavorites'], ['schemaVersion', 'pages', 'grants', 'grantBindings']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.pages) || value.pages.length > 1000 ||
      !Array.isArray(value.grants) || value.grants.length > 5000 || !Array.isArray(value.grantBindings) ||
      value.grantBindings.length !== value.grants.length) fail('INVALID_CONTENT');
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_CONTENT_BYTES) fail('CONTENT_TOO_LARGE', 413);
  const pages = new Map(); const grants = new Set(); let blocks = 0;
  for (const item of value.pages) {
    object(item, ['page', 'document', 'inheritPermissions']);
    object(item.page, ['id', 'workspaceId', 'title', 'parentId', 'createdAt', 'updatedAt', 'trashedAt','appearance'],['id', 'workspaceId', 'title', 'parentId', 'createdAt', 'updatedAt', 'trashedAt']);
    object(item.document, ['pageId', 'workspaceId', 'version', 'blocks', 'updatedAt']);
    validatePage(item.page); validateDocument(item.document);
    if (item.page.workspaceId !== workspaceId || item.document.workspaceId !== workspaceId ||
        item.page.id !== item.document.pageId || pages.has(item.page.id) || typeof item.inheritPermissions !== 'boolean') fail('INVALID_CONTENT');
    pages.set(item.page.id, item);
    blocks += item.document.blocks.length;
    if (blocks > 20000) fail('CONTENT_TOO_LARGE', 413);
  }
  for (const item of pages.values()) {
    const seen = new Set(); let cursor = item;
    while (cursor) {
      if (seen.has(cursor.page.id)) fail('INVALID_CONTENT');
      seen.add(cursor.page.id);
      if (cursor.page.parentId === null) break;
      cursor = pages.get(cursor.page.parentId);
      if (!cursor) fail('INVALID_CONTENT');
    }
  }
  validateTeamspaceState(value,{workspaceId,pages});
  validateTeamspaceJoinRequests(value,{workspaceId});
  validateGroupState(value,{workspaceId,pages});
  for (const grant of value.grants) {
    validatePageGrant(grant);
    if (grant.workspaceId !== workspaceId || !pages.has(grant.pageId) || grants.has(grant.id)) fail('INVALID_CONTENT');
    grants.add(grant.id);
  }
  const bound = new Set();
  for (const binding of value.grantBindings) {
    object(binding, ['grantId', 'membershipId']);
    assertId(binding.grantId); assertId(binding.membershipId);
    if (!grants.has(binding.grantId) || bound.has(binding.grantId)) fail('INVALID_CONTENT');
    bound.add(binding.grantId);
  }
  if (Object.hasOwn(value, 'imports')) {
    if (!Array.isArray(value.imports) || value.imports.length > 1000) fail('INVALID_CONTENT');
    const ids = new Set();
    for (const receipt of value.imports) {
      object(receipt, ['importId', 'accountId', 'membershipId', 'digest', 'rootPageId', 'pageCount', 'revision']);
      for (const key of ['importId','accountId','membershipId','rootPageId']) assertId(receipt[key]);
      if (ids.has(receipt.importId) || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest) ||
          !Number.isSafeInteger(receipt.pageCount) || receipt.pageCount < 1 || receipt.pageCount > MAX_IMPORT_PAGES ||
          !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > Number.MAX_SAFE_INTEGER ||
          !pages.has(receipt.rootPageId)) fail('INVALID_CONTENT');
      ids.add(receipt.importId);
    }
  }
  if (Object.hasOwn(value, 'collections')) validateAccountCollections(value.collections, pages, workspaceId);
  validateAssetPayload(value,pages); validateTrashGroups(value,pages); validateHistory(value,pages,workspaceId); validateRooms(value,pages,workspaceId); validateDiscussion(value,pages); validateActivityNotifications(value,pages); validateForms(value,pages,workspaceId); validatePublications(value,pages);
  validatePersonalTemplates(value);validatePageFavorites(value,pages);
  return structuredClone(value);
}

function stringValues(properties, values) {
  object(values, properties.map(property=>property.id));
  if (Object.values(values).some(value=>typeof value !== 'string')) fail('INVALID_CONTENT');
}
function walkBlocks(items, visit) {
  for (const block of items) { visit(block); if (block.children) walkBlocks(block.children,visit); }
}
function validateImportLinks(blocks, pageSources, collectionSources, assetSources, sourcePageId) {
  walkBlocks(blocks, block=>{
    // Foreign account/page mention IDs are not workspace import bindings. Keep literal text instead.
    if (Array.isArray(block.data?.mentions) && block.data.mentions.some(mention => mention.kind !== 'date')) fail('INVALID_CONTENT');
    if (!Object.hasOwn(block.data ?? {},'links')) return;
    const {links,text}=block.data;
    if (typeof text !== 'string' || !Array.isArray(links) || links.length > 1000) fail('INVALID_CONTENT');
    let previous = 0;
    for (const link of links) {
      object(link,['start','end','label','sourcePageId','sourceCollectionId','sourceAssetId','fragment'],['start','end','label']);
      if (!Number.isSafeInteger(link.start) || !Number.isSafeInteger(link.end) || link.start < previous || link.end <= link.start || link.end > text.length ||
          typeof link.label !== 'string' || text.slice(link.start,link.end) !== link.label ||
          (link.start > 0 && /[\uD800-\uDBFF]/.test(text[link.start-1]) && /[\uDC00-\uDFFF]/.test(text[link.start])) ||
          (link.end < text.length && /[\uD800-\uDBFF]/.test(text[link.end-1]) && /[\uDC00-\uDFFF]/.test(text[link.end]))) fail('INVALID_CONTENT');
      const page = Object.hasOwn(link,'sourcePageId'); const collection = Object.hasOwn(link,'sourceCollectionId'); const asset = Object.hasOwn(link,'sourceAssetId');
      if (Number(page)+Number(collection)+Number(asset) !== 1 || (page && !pageSources.has(assertId(link.sourcePageId))) ||
          (collection && !collectionSources.has(assertId(link.sourceCollectionId))) ||
          (asset && !assetSources.get(assertId(link.sourceAssetId))?.pageSourceIds.includes(sourcePageId))) fail('INVALID_CONTENT');
      if (Object.hasOwn(link,'fragment') && (typeof link.fragment !== 'string' || link.fragment.length > 512 || /[\u0000-\u001f\u007f]/.test(link.fragment))) fail('INVALID_CONTENT');
      previous = link.end;
    }
  });
}
function projectDocument(document, visible, mentionContext = {}) {
  const clone = structuredClone(document);
  walkBlocks(clone.blocks, block=>{
    if (!Array.isArray(block.data?.links)) return;
    block.data.links = block.data.links.map(link=>{
      if (link && typeof link === 'object' && typeof link.pageId === 'string' && !visible.has(link.pageId)) {
        return {start:link.start,end:link.end,label:link.label,unavailable:true};
      }
      return link;
    });
  });
  clone.blocks = projectMentionBlocks({blocks:clone.blocks,pageId:document.pageId,canReadPage:id=>visible.has(id),...mentionContext});
  return clone;
}

const policy=accountContentPolicy;

function readPayload(saved, workspaceId) {
  try {
    return validateContentPayload(saved.revision === 0 && saved.payload === null ?
      { schemaVersion: 1, pages: [], grants: [], grantBindings: [] } : saved.payload, workspaceId);
  } catch { fail('CONTENT_UNAVAILABLE', 503); }
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail('CONTENT_TYPE', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail('CONTENT_TOO_LARGE', 413);
  if (!request.body) fail('INVALID_CONTENT');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { try { await reader.cancel(); } catch {} fail('CONTENT_TOO_LARGE', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('INVALID_CONTENT'); }
  } finally { reader.releaseLock(); }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',') + '}';
}
async function importDigest(pages, collections = [], assets = []) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(assets.length ? {pages,collections,assets} : collections.length ? {pages,collections} : pages)));
  return Array.from(new Uint8Array(hash), byte=>byte.toString(16).padStart(2,'0')).join('');
}
function validateImport(data) {
  object(data, ['expectedRevision','importId','pages','collections','assets'], ['expectedRevision','importId','pages']);
  revision(data.expectedRevision); assertId(data.importId);
  if (!Array.isArray(data.pages) || data.pages.length < 1) fail('INVALID_CONTENT');
  if (data.pages.length > MAX_IMPORT_PAGES) fail('CONTENT_TOO_LARGE',413);
  const pages = new Map(); let root = null;
  for (const item of data.pages) {
    object(item, ['sourceId','parentSourceId','title','blocks']);
    assertId(item.sourceId); assertTitle(item.title); validateBlocks(item.blocks);
    if (item.parentSourceId !== null) assertId(item.parentSourceId);
    if (pages.has(item.sourceId)) fail('INVALID_CONTENT');
    pages.set(item.sourceId,item);
    if (item.parentSourceId === null) {
      if (root !== null) fail('INVALID_CONTENT');
      root = item.sourceId;
    }
  }
  if (root === null) fail('INVALID_CONTENT');
  // Resolve each parent edge once; adversarial ordering must not multiply tree walks.
  const resolved = new Set();
  for (const item of pages.values()) {
    const seen = new Set(); let cursor = item;
    while (!resolved.has(cursor.sourceId)) {
      if (seen.has(cursor.sourceId)) fail('INVALID_CONTENT');
      seen.add(cursor.sourceId);
      if (cursor.parentSourceId === null) break;
      cursor = pages.get(cursor.parentSourceId);
      if (!cursor) fail('INVALID_CONTENT');
    }
    for (const sourceId of seen) resolved.add(sourceId);
  }
  const collections = data.collections ?? [];
  if (!Array.isArray(collections) || collections.length > MAX_IMPORT_PAGES) fail('INVALID_CONTENT');
  const collectionSources = new Set(); const bound = new Set();
  for (const entry of collections) {
    object(entry,['sourceId','pageSourceId','properties','records']); assertId(entry.sourceId); assertId(entry.pageSourceId);
    if (collectionSources.has(entry.sourceId) || !pages.has(entry.pageSourceId) || bound.has(entry.pageSourceId) || !Array.isArray(entry.properties) ||
        entry.properties.length < 1 || entry.properties.length > 128 || !Array.isArray(entry.records) || entry.records.length > MAX_IMPORT_PAGES) fail('INVALID_CONTENT');
    collectionSources.add(entry.sourceId); bound.add(entry.pageSourceId);
    validatePropertyDefinitions(entry.properties);
    for (const property of entry.properties) {
      object(property,['id','name','type','sourceName'],['id','name','type']);
      if (property.type !== 'text' || (Object.hasOwn(property,'sourceName') && typeof property.sourceName !== 'string')) fail('INVALID_CONTENT');
    }
    const recordIds = new Set();
    for (const record of entry.records) {
      object(record,['sourceId','pageSourceId','values']); assertId(record.sourceId); assertId(record.pageSourceId);
      if (recordIds.has(record.sourceId) || !pages.has(record.pageSourceId) || bound.has(record.pageSourceId) ||
          pages.get(record.pageSourceId).parentSourceId !== entry.pageSourceId) fail('INVALID_CONTENT');
      recordIds.add(record.sourceId); bound.add(record.pageSourceId); stringValues(entry.properties,record.values);
    }
  }
  const assetSources = validateImportAssets(data,pages);
  for (const page of pages.values()) validateImportLinks(page.blocks,pages,collectionSources,assetSources,page.sourceId);
  return root;
}
function replayImport(payload, receipt, {accountId,actor,principals,workspaceId,digest}) {
  if (receipt.accountId !== accountId || receipt.membershipId !== actor.id || actor.role === 'guest') missing();
  const evaluate = createPageAccessEvaluator(policy(payload,principals,workspaceId));
  if (!evaluate({accountId,workspaceId,pageId:receipt.rootPageId}).capabilities.includes('manage')) missing();
  if (receipt.digest !== digest) fail('CONTENT_CONFLICT',409);
  return json({revision:receipt.revision,importId:receipt.importId,rootPageId:receipt.rootPageId,pageCount:receipt.pageCount,replayed:true});
}

async function importPages({request,store,saved,payload,actor,accountId,workspaceId,now,createId,blobStore}) {
  if (request.method !== 'POST') fail('METHOD_NOT_ALLOWED',405);
  if (!['owner','admin','member'].includes(actor.role)) missing();
  const data = await readJson(request, MAX_IMPORT_REQUEST_BYTES);
  const sourceRoot = validateImport(data);
  const digest = await importDigest(data.pages,data.collections,data.assets);
  const receipt = payload.imports?.find(item=>item.importId === data.importId);
  if (receipt) return replayImport(payload,receipt,{accountId,actor,principals:saved.principals,workspaceId,digest});
  if (data.expectedRevision !== saved.revision) fail('CONTENT_CONFLICT',409);
  if (payload.pages.length + data.pages.length > 1000 || payload.grants.length + 1 > 5000 || (payload.imports?.length ?? 0) >= 1000) fail('CONTENT_TOO_LARGE',413);
  const used = new Set([...payload.pages.map(item=>item.page.id),...payload.grants.map(item=>item.id),
    ...(payload.collections ?? []).flatMap(item=>[item.collection.id,...item.collection.properties.map(property=>property.id),...item.collection.records.map(record=>record.id)]),
    ...(payload.pendingBlobs ?? []).map(item=>item.id),...(payload.attachments ?? []).map(item=>item.id)]);
  const mint = () => {
    let id;
    try { id = assertId(createId()); } catch { fail('CONTENT_UNAVAILABLE',503); }
    if (used.has(id)) fail('CONTENT_UNAVAILABLE',503);
    used.add(id); return id;
  };
  const ids = new Map(data.pages.map(item=>[item.sourceId,mint()]));
  const sourceCollections = new Map((data.collections ?? []).map(item=>[item.sourceId,item]));
  const assetBindings = consumeImportAssets({data,payload,actor,accountId,pageIds:ids,mint,blobStore});
  const remapBlocks = (items,sourcePageId) => items.map(item=>({...item,id:mint(),
    ...(item.data?.links ? {data:{...item.data,links:item.data.links.map(link=>({start:link.start,end:link.end,label:link.label,
      ...(link.sourceAssetId ? assetBindings.get(JSON.stringify([link.sourceAssetId,sourcePageId])) : {pageId:ids.get(link.sourcePageId ?? sourceCollections.get(link.sourceCollectionId).pageSourceId)}),
      ...(Object.hasOwn(link,'fragment') ? {fragment:link.fragment} : {})}))}} : {}),
    ...(Object.hasOwn(item,'children') ? {children:remapBlocks(item.children,sourcePageId)} : {})}));
  const stamp = now();
  for (const source of data.pages) {
    const id = ids.get(source.sourceId);
    const page = validatePage({id,workspaceId,title:source.title,parentId:source.parentSourceId === null ? null : ids.get(source.parentSourceId),
      createdAt:stamp,updatedAt:stamp,trashedAt:null});
    const document = validateDocument({pageId:id,workspaceId,version:1,blocks:remapBlocks(source.blocks,source.sourceId),updatedAt:stamp});
    payload.pages.push({page,document,inheritPermissions:source.parentSourceId !== null});
  }
  if (data.collections?.length) {
    payload.collections ??= [];
    for (const source of data.collections) {
      const propertyIds = new Map(source.properties.map(property=>[property.id,mint()]));
      const properties = source.properties.map(property=>({id:propertyIds.get(property.id),name:property.name,type:'text'}));
      const records = []; const recordPages = [];
      for (const row of source.records) {
        const id = mint(); const values = Object.fromEntries(source.properties.map(property=>[propertyIds.get(property.id),row.values[property.id]]));
        records.push({id,values}); recordPages.push({recordId:id,pageId:ids.get(row.pageSourceId),sourceValues:structuredClone(values)});
      }
      const pageId = ids.get(source.pageSourceId);
      payload.collections.push({collection:{id:mint(),workspaceId,title:payload.pages.find(item=>item.page.id === pageId).page.title,
        properties,records,createdAt:stamp,updatedAt:stamp},pageId,recordPages,sourceHeaders:source.properties.map(property=>property.sourceName ?? property.name)});
    }
  }
  const rootPageId = ids.get(sourceRoot); const grantId = mint();
  payload.grants.push({id:grantId,workspaceId,pageId:rootPageId,accountId,permission:'full',includeDescendants:true,status:'active'});
  payload.grantBindings.push({grantId,membershipId:actor.id});
  const committed = {importId:data.importId,accountId,membershipId:actor.id,digest,rootPageId,pageCount:data.pages.length,revision:saved.revision+1};
  payload.imports ??= []; payload.imports.push(committed);
  const captured = validateContentPayload(payload,workspaceId);
  try {
    const written = await store.write(workspaceId,accountId,{expectedRevision:saved.revision,payload:captured,
      actorMembershipId:actor.id,actorRole:actor.role,guardMemberships:[]});
    return json({revision:written.revision,importId:data.importId,rootPageId,pageCount:data.pages.length,replayed:false},201);
  } catch (cause) {
    if (cause?.code !== 'CONTENT_CONFLICT') throw cause;
    const fresh = await store.read(workspaceId,accountId);
    const principal = fresh?.principals.find(item=>item.accountId === accountId && item.id === actor.id && item.emailVerified);
    if (!principal || principal.role !== actor.role || !['owner','admin','member'].includes(principal.role)) missing();
    const current = readPayload(fresh,workspaceId);
    const sameImport = current.imports?.find(item=>item.importId === data.importId);
    if (sameImport) return replayImport(current,sameImport,{accountId,actor:principal,principals:fresh.principals,workspaceId,digest});
    fail('CONTENT_CONFLICT',409);
  }
}
/** Page-scoped account content. The store must CAS policy and content together, with live membership guards. */
export function createAccountContentApi({ store, resolveSession, origin, blobStore = null, roomSecret = null, roomPresenceStore = null, publicationSecret = roomSecret,
  inlineMentionNotifications = true, now = () => new Date().toISOString(), createId = () => crypto.randomUUID() } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' || typeof resolveSession !== 'function' ||
      new URL(origin).origin !== origin || typeof inlineMentionNotifications!=='boolean' || (roomSecret !== null && (typeof roomSecret !== 'string' || roomSecret.length < 32 || roomSecret.length > 4096)) || typeof now !== 'function' || typeof createId !== 'function') throw new Error('Invalid account content service configuration.');
  const publicPages=createPublicPageApi({store,secret:publicationSecret,origin,readPayload,policy});
  const publicForms=createPublicFormApi({store,secret:publicationSecret,origin,readPayload,validatePayload:validateContentPayload,policy,readJson,now,createId});
  return async request => {
    try {
      const url = new URL(request.url);
      if(url.pathname.startsWith('/api/public/forms/'))return await publicForms(request);
      if(url.pathname==='/api/public'||url.pathname.startsWith('/api/public/'))return await publicPages(request);
      const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
      if (url.origin !== origin || (request.headers.has('origin') && request.headers.get('origin') !== origin) ||
          !['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site')) ||
          (mutation && request.headers.get('origin') !== origin)) fail('ORIGIN_REJECTED', 403);
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) fail('METHOD_NOT_ALLOWED', 405);
      const searching = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/search$/.exec(url.pathname);
      const exporting = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/export$/.exec(url.pathname);
      const trashing = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/trash$/.exec(url.pathname);
      if ((searching || exporting || trashing) && request.method !== 'GET') fail('METHOD_NOT_ALLOWED',405);
      if (searching || exporting) {
        const key = searching ? 'q' : 'format';
        if (Array.from(url.searchParams.keys()).length !== 1 || url.searchParams.getAll(key).length !== 1) fail('INVALID_CONTENT');
      } else if (url.search) fail('INVALID_CONTENT');
      const publishing = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/publication(?:\/(review))?$/.exec(url.pathname);
      const pageTools=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/(appearance|duplicate|favorite)$/.exec(url.pathname);
      const discussing = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/comments(?:\/([A-Za-z0-9._:-]+)(?:\/(resolve|messages)(?:\/([A-Za-z0-9._:-]+))?)?)?$/.exec(url.pathname);
      const uploading = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/uploads(?:\/([A-Za-z0-9._:-]+)\/assets(?:\/([A-Za-z0-9._:-]+)(?:\/(commit))?)?)?$/.exec(url.pathname);
      const copyingAttachments=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/attachment-copies$/.exec(url.pathname);
      const managingForm = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/collections\/([A-Za-z0-9._:-]+)\/forms(?:\/([A-Za-z0-9._:-]+)(?:\/(acceptance))?)?$/.exec(url.pathname);
      const respondingForm = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/forms\/([A-Za-z0-9._:-]+)(?:\/(responses))?$/.exec(url.pathname);
      const people = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/people$/.exec(url.pathname);
      const notifying = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/notifications$/.exec(url.pathname);
      const rooming = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/room(?:\/(open|updates|renew|presence))?$/.exec(url.pathname);
      if (rooming && (rooming[3]==='presence'?!['GET','POST','DELETE'].includes(request.method):request.method !== (rooming[3] ? 'POST' : 'GET'))) fail('METHOD_NOT_ALLOWED',405);
      const historical = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/history(?:\/([A-Za-z0-9._:-]+)(\/restore)?)?$/.exec(url.pathname);
      if (historical && !((request.method === 'GET' && !historical[4]) || (request.method === 'POST' && historical[3] && historical[4]))) fail('METHOD_NOT_ALLOWED',405);
      const teamspaces = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/teamspaces(?:\/([A-Za-z0-9._:-]+)(?:\/(members|join|archive|duplicate|requests))?)?$/.exec(url.pathname);
      const teamspacePage = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/(teamspace-review|teamspace)$/.exec(url.pathname);
      const groups=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/groups(?:\/([A-Za-z0-9._:-]+)(?:\/(members|archive))?)?$/.exec(url.pathname);
      const groupGrants=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/group-grants$/.exec(url.pathname);
      const movingBlock = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/blocks\/move$/.exec(url.pathname);
      if (movingBlock && request.method !== 'POST') fail('METHOD_NOT_ALLOWED',405);
      const lifecycle = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/(location|restore)$/.exec(url.pathname);
      if (lifecycle && request.method !== (lifecycle[3] === 'location' ? 'PATCH' : 'POST')) fail('METHOD_NOT_ALLOWED',405);
      const importing = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/imports$/.exec(url.pathname);
      const staging = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/imports\/([A-Za-z0-9._:-]+)\/assets(?:\/([A-Za-z0-9._:-]+))?$/.exec(url.pathname);
      const downloading = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/attachments\/([A-Za-z0-9._:-]+)(?:\/(preview))?$/.exec(url.pathname);
      if(downloading?.[4]&&request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
      const backlinks=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/backlinks$/.exec(url.pathname);
      if(backlinks&&(request.method!=='GET'||url.search))fail(request.method!=='GET'?'METHOD_NOT_ALLOWED':'INVALID_CONTENT',request.method!=='GET'?405:400);
      const templateList = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/templates$/.exec(url.pathname);
      const templateItem = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/templates\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
      const templateReview = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages\/([A-Za-z0-9._:-]+)\/template-review$/.exec(url.pathname);
      const templateApply = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/templates\/([A-Za-z0-9._:-]+)\/applications$/.exec(url.pathname);
      const templateReceipt = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/template-requests\/([a-f0-9-]{36})$/.exec(url.pathname);
      const templating = templateList ?? templateItem ?? templateReview ?? templateApply ?? templateReceipt;
      const templateKind = templateList ? 'list' : templateItem ? 'item' : templateReview ? 'review' : templateApply ? 'apply' : 'receipt';
      const previewingFormula=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/collections\/([A-Za-z0-9._:-]+)\/formulas\/preview$/.exec(url.pathname);
      const previewingRollup=/^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/collections\/([A-Za-z0-9._:-]+)\/rollups\/preview$/.exec(url.pathname);
      if((previewingFormula||previewingRollup)&&request.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
      const collecting = /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/collections(?:\/([A-Za-z0-9._:-]+)(?:\/(records|views|query|templates|property-conversions)(?:\/([A-Za-z0-9._:-]+))?)?)?$/.exec(url.pathname);
      const match = copyingAttachments ?? pageTools ?? groups ?? groupGrants ?? teamspaces ?? teamspacePage ?? templating ?? backlinks ?? previewingRollup ?? previewingFormula ?? publishing ?? uploading ?? managingForm ?? respondingForm ?? people ?? discussing ?? notifying ?? rooming ?? historical ?? movingBlock ?? importing ?? staging ?? collecting ?? downloading ?? lifecycle ?? searching ?? exporting ?? trashing ?? /^\/api\/content\/workspaces\/([A-Za-z0-9._:-]+)\/pages(?:\/([A-Za-z0-9._:-]+)(?:\/(grants)(?:\/([A-Za-z0-9._:-]+))?)?)?$/.exec(url.pathname);
      if (!match) missing();
      if (request.method === 'PUT' && !staging && !uploading) fail('METHOD_NOT_ALLOWED',405);
      const [, workspaceId] = match;
      const collectionId = previewingRollup?.[2] ?? previewingFormula?.[2] ?? collecting?.[2], collectionKind = previewingRollup ? 'rollupPreview' : previewingFormula ? 'formulaPreview' : collecting?.[3] ?? 'collection';
      const recordId = collectionKind === 'records' ? collecting?.[4] : undefined, viewId = collectionKind === 'views' ? collecting?.[4] : undefined;
      const collectionTemplateId=collectionKind==='templates'?collecting?.[4]:undefined;if(collectionKind==='query'&&collecting?.[4])missing();
      const pageId = groupGrants?.[2] ?? teamspacePage?.[2] ?? templateReview?.[2] ?? (!groups && !teamspaces && !templating && !previewingRollup && !previewingFormula && !managingForm && !respondingForm && !collecting && !staging ? match[2] : undefined);
      const grantsPath = !pageTools && !teamspaces && !teamspacePage && !templating && !backlinks && !previewingRollup && !previewingFormula && !publishing && !uploading && !managingForm && !respondingForm && !people && !discussing && !notifying && !rooming && !historical && !movingBlock && !lifecycle && !downloading && !collecting && !staging ? match[3] : undefined;
      const grantId = !pageTools && !teamspaces && !teamspacePage && !templating && !backlinks && !previewingRollup && !previewingFormula && !publishing && !uploading && !managingForm && !respondingForm && !people && !discussing && !notifying && !rooming && !historical && !movingBlock && !lifecycle && !downloading && !collecting && !staging ? match[4] : undefined;
      const lifecycleAction = lifecycle?.[3] ?? (request.method === 'DELETE' && pageId && !groups && !groupGrants && !templating && !publishing && !grantsPath && !downloading && !uploading && !discussing ? 'trash' : null);
      if (collectionId) assertId(collectionId); if (recordId) assertId(recordId); if (viewId) assertId(viewId);
      assertId(workspaceId); if (pageId) assertId(pageId); if (grantId) assertId(grantId);
      const session = await resolveSession(request);
      if (!session?.user?.id || session.user.emailVerified !== true) fail('UNAUTHORIZED', 401);
      const accountId = assertId(session.user.id);
      if (importing && request.method !== 'POST') fail('METHOD_NOT_ALLOWED',405);
      if (copyingAttachments || pageTools || groups || groupGrants || teamspaces || teamspacePage || (downloading && mutation) || templating || backlinks || publishing || uploading || managingForm || respondingForm || people || discussing || notifying || previewingRollup || previewingFormula || (collecting && mutation) || rooming || (historical && mutation) || movingBlock || importing || staging || lifecycleAction || request.headers.has('x-yumunio-expected-account')) {
        let expectedAccount;
        try { expectedAccount = assertId(request.headers.get('x-yumunio-expected-account')); }
        catch { fail('INVALID_CONTENT'); }
        // A matching client expectation is a guard, never an authentication source.
        if (expectedAccount !== accountId) missing();
      }
      const saved = await store.read(workspaceId, accountId);
      if (!saved) missing();
      const actor = saved.principals.find(row => row.accountId === accountId);
      if (!actor?.emailVerified || !['owner', 'admin', 'member', 'guest'].includes(actor.role)) missing();
      const payload = readPayload(saved, workspaceId);
      if (importing) return await importPages({request,store,saved,payload,actor,accountId,workspaceId,now,createId,blobStore});
      if (staging) return await handleAssetRequest({request,importId:staging[2],assetId:staging[3],blobStore,store,saved,payload,actor,accountId,workspaceId,
        readJson,readPayload,validatePayload:validateContentPayload});
      const state = () => policy(payload, saved.principals, workspaceId);
      const currentState = state(); const evaluate = createPageAccessEvaluator(currentState); const decisions = new Map();
      const access = id => {
        if (!decisions.has(id)) decisions.set(id, evaluate({ accountId, workspaceId, pageId: id }).capabilities);
        return decisions.get(id);
      };
      const visible = new Set(payload.pages.filter(item => access(item.page.id).includes('read')).map(item => item.page.id));
      const personCanRead = (recipientId, sourcePageId) => evaluate({accountId:recipientId,workspaceId,pageId:sourcePageId}).capabilities.includes('read');
      const projectAccountDocument = (document, readable) => projectDocument(document,readable,{principals:saved.principals,personCanRead});
      const prepareDocumentBlocks = (blocks, previousBlocks, sourcePageId, referenceAccess = access, recipientAccess = personCanRead) => prepareMentionBlocks({
        blocks:preparePageLinkBlocks({blocks:prepareSyncedBlocks({blocks,previousBlocks,access:referenceAccess,pageId:sourcePageId}),previousBlocks,access:referenceAccess,attachments:payload.attachments??[],pageId:sourcePageId}),
        previousBlocks,access:referenceAccess,principals:saved.principals,personCanRead:recipientAccess,pageId:sourcePageId});
      const bindings = new Map();
      for (const entry of payload.collections ?? []) {
        if (!visible.has(entry.pageId)) continue;
        bindings.set(entry.pageId,{collectionId:entry.collection.id});
        for (const row of entry.recordPages) bindings.set(row.pageId,{collectionId:entry.collection.id,recordId:row.recordId});
        for (const template of entry.templates??[]) bindings.set(template.pageId,{collectionId:entry.collection.id,templateId:template.id});
      }
      const project = item => ({ ...item.page,...pagePlacement(currentState,item.page.id,accountId,payload.grants), parentId: visible.has(item.page.parentId) ? item.page.parentId : null,
        version: item.document.version, capabilities: access(item.page.id),...((payload.pageFavorites??[]).some(row=>row.membershipId===actor.id&&row.accountId===accountId&&row.pageId===item.page.id)?{favorite:true}:{}),...(bindings.get(item.page.id) ?? {}) });
      if(teamspaces||teamspacePage)return await handleTeamspaceRequest({request,teamspaceId:teamspaces?.[2],action:teamspacePage?.[3]??teamspaces?.[3]??'detail',pageId:teamspacePage?.[2],store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      if(groups||groupGrants)return await handleGroupRequest({request,groupId:groups?.[2],action:groups?.[3]??'detail',pageId:groupGrants?.[2],store,saved,payload,actor,accountId,workspaceId,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      if (templating) return await handlePersonalTemplates({request,kind:templateKind,pageId:templateReview?.[2],templateId:templateItem?.[2]??templateApply?.[2],requestId:templateReceipt?.[2],store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      if(pageTools)return await handlePageTools({request,action:pageTools[3],pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      if (publishing) return await handlePublicationRequest({request,kind:publishing[3]?'review':'manage',pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId,publicationSecret});
      if(copyingAttachments)return await copyPageBlockAttachments({request,pageId,payload,saved,actor,accountId,workspaceId,access,policy,readJson,readPayload,store,validatePayload:validateContentPayload});
      if (uploading) {
        const context={request,pageId,importId:uploading[3],assetId:uploading[4],blobStore,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload};
        return !uploading[3]?listPageUploads(context):uploading[5]?await commitPageAttachment(context):await handleAssetRequest(context);
      }
      if (managingForm || respondingForm) return await handleFormRequest({request,kind:respondingForm?(respondingForm[3]?'submit':'respond'):managingForm[4]?'acceptance':managingForm[3]?'manage':'manage-list',collectionId:managingForm?.[2],formId:respondingForm?.[2]??managingForm?.[3],store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId,publicationSecret});
      if (people || discussing || notifying) {
        if (discussing?.[4] === 'resolve' && discussing[5] || discussing?.[4] === 'messages' && !discussing[5]) missing();
        return await handleDiscussion({request,action:people?'people':notifying?'notifications':discussing[4]==='resolve'?'resolve':'comments',threadId:discussing?.[3],messageId:discussing?.[5],pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      }
      if (rooming) return await handleRoom({request,action:rooming[3] || 'state',pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,projectDocument:projectAccountDocument,now,createId,roomSecret,roomPresenceStore,session});
      if (historical) return await handleHistory({request,historyId:historical[3],pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,projectDocument:projectAccountDocument,visible,now,createId});
      if (movingBlock) return await handleBlockMove({request,pageId,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      if (lifecycleAction) return await handlePageLifecycle({request,action:lifecycleAction,pageId,store,saved,payload,actor,accountId,workspaceId,access,
        policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      if (trashing) return listTrash({payload,saved,workspaceId,accountId,actor,policy});
      if (searching) return searchPages({query:url.searchParams.get('q'),payload,saved,workspaceId,visible,project});
      if (backlinks) return handleBacklinks({request,pageId,payload,saved,access});
      if (exporting) { const projectionContext={payload,saved,workspaceId,accountId,access}; return exportPages({format:url.searchParams.get('format'),payload,saved,workspaceId,visible,projectDocument:(document,readable)=>projectDocument(document,readable,{stripReferences:true}),now,projectCollection:entry=>projectAccountCollection(entry,projectionContext)}); }
      if (collecting || previewingFormula || previewingRollup) return await handleCollectionRequest({request,kind:collectionKind,collectionId,recordId,viewId,templateId:collectionTemplateId,prepareDocumentBlocks,conversionAction:collectionKind==='property-conversions'?collecting?.[4]:undefined,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload,now,createId});
      const item = pageId ? payload.pages.find(row => row.page.id === pageId) : null;
      if (pageId && (!item || !visible.has(pageId))) missing();
      if (downloading) {
        if(request.method==='DELETE')return await removePageAttachment({request,pageId,assetId:downloading[3],blobStore,store,saved,payload,actor,accountId,workspaceId,access,policy,readJson,readPayload,validatePayload:validateContentPayload});
        if (request.method !== 'GET') fail('METHOD_NOT_ALLOWED',405);
        const attachment = payload.attachments?.find(row=>row.id === downloading[3] && row.pageId === pageId); if (!attachment) missing();
        return await downloadAttachment({blobStore,attachment,preview:downloading[4]==='preview',range:request.headers.get('Range'),authorize:async()=>{
          const fresh = await store.read(workspaceId,accountId);
          if (!fresh?.principals.some(row=>row.accountId === accountId && row.id === actor.id && row.emailVerified)) return false;
          const latest = readPayload(fresh,workspaceId);
          if (!latest.attachments?.some(row=>row.id === attachment.id && row.pageId === pageId && row.profileId === attachment.profileId && row.objectKey === attachment.objectKey && row.checksum === attachment.checksum)) return false;
          return createPageAccessEvaluator(policy(latest,fresh.principals,workspaceId))({accountId,workspaceId,pageId}).capabilities.includes('read');
        }});
      }
      if (request.method === 'GET') {
        if (!pageId) return json({ workspaceId, revision: saved.revision, role: actor.role, attachmentsEnabled: Boolean(blobStore),
          pages: payload.pages.filter(item => visible.has(item.page.id)).map(project) });
        if (grantsPath) {
          if (grantId || !access(pageId).includes('manage')) missing();
          return json({ revision: saved.revision, grants: currentState.grants.filter(row => row.pageId === pageId && row.status === 'active') });
        }
        const attachments = (payload.attachments ?? []).filter(row=>row.pageId === pageId).map(row=>({id:row.id,name:row.name,mediaType:row.mediaType,size:row.size}));
        return json({ revision: saved.revision, page: project(item), document: projectAccountDocument(item.document,visible),...(attachments.length ? {attachments} : {}) });
      }
      const data = await readJson(request);
      revision(data?.expectedRevision);
      // Reject unauthorized operations before returning any revision information.
      if (!pageId) {
        if (request.method !== 'POST' || actor.role === 'guest') missing();
      } else if (!access(pageId).includes(grantsPath ? 'manage' : 'editBody')) missing();
      if (data.expectedRevision !== saved.revision) fail('CONTENT_CONFLICT', 409);
      let result; const guards = [];
      if (!pageId) {
        object(data, ['expectedRevision', 'title', 'blocks', 'parentId','teamspaceId'], ['expectedRevision', 'title']);
        const parentId = data.parentId ?? null;
        const teamspaceId=data.teamspaceId??null;if(teamspaceId!==null){assertId(teamspaceId);if(parentId!==null)fail('INVALID_CONTENT');requireTeamspaceCreate(payload,saved.principals,workspaceId,accountId,teamspaceId);}
        if (parentId !== null && !access(assertId(parentId)).includes('manage')) missing();
        const stamp = now(); const id = assertId(createId());
        const page = validatePage({ id, workspaceId, title: data.title, parentId, createdAt: stamp, updatedAt: stamp, trashedAt: null });
        const document = validateDocument({ pageId: id, workspaceId, version: 1, blocks: [], updatedAt: stamp });
        payload.pages.push({ page, document, inheritPermissions: parentId !== null });
        if(teamspaceId!==null){payload.teamspacePages??=[];payload.teamspacePages.push({workspaceId,pageId:id,teamspaceId});}else if(parentId===null){payload.personalPageOwners??=[];payload.personalPageOwners.push({workspaceId,pageId:id,accountId,membershipId:actor.id});}
        const grantId = assertId(createId());
        payload.grants.push({ id: grantId, workspaceId, pageId: id, accountId, permission: 'full', includeDescendants: true, status: 'active' });
        payload.grantBindings.push({ grantId, membershipId: actor.id });
        const createdAccess = createPageAccessEvaluator(policy(payload,saved.principals,workspaceId));
        const recipientAccess = (recipientId,sourcePageId) => createdAccess({accountId:recipientId,workspaceId,pageId:sourcePageId}).capabilities.includes('read');
        const prepared = prepareDocumentBlocks(data.blocks??[],[],id,targetId=>createdAccess({accountId,workspaceId,pageId:targetId}).capabilities,recipientAccess);
        document.blocks = prepared.blocks; guards.push(...prepared.guards);
        result = { page, document:projectDocument(document,new Set([...visible,id]),{principals:saved.principals,personCanRead:recipientAccess}) };
      } else if (!grantsPath) {
        if (request.method !== 'PATCH') fail('METHOD_NOT_ALLOWED', 405);
        object(data, ['expectedRevision', 'expectedVersion', 'title', 'blocks'], ['expectedRevision', 'expectedVersion']);
        if (data.expectedVersion !== item.document.version || item.document.version === Number.MAX_SAFE_INTEGER) fail('CONTENT_CONFLICT', 409);
        if (!Object.hasOwn(data, 'title') && !Object.hasOwn(data, 'blocks')) fail('INVALID_CONTENT');
        const prepared = Object.hasOwn(data,'blocks') ? prepareDocumentBlocks(data.blocks,item.document.blocks,pageId) : null;
        if (prepared) guards.push(...prepared.guards);
        if(prepared&&inlineMentionNotifications)for(const guard of recordInlineMentions({payload,saved,actor,accountId,workspaceId,policy,now,createId},pageId,item.document.blocks,prepared.blocks))if(!guards.some(item=>item.id===guard.id))guards.push(guard);
        invalidateRooms(payload,[pageId]);
        rememberPage(payload,item,{actorId:accountId,now,createId});
        const stamp = now();
        item.page = validatePage({ ...item.page, ...(Object.hasOwn(data, 'title') ? { title: data.title } : {}), updatedAt: stamp });
        item.document = validateDocument({ ...item.document, ...(prepared ? { blocks: prepared.blocks } : {}),
          version: item.document.version + 1, updatedAt: stamp });
        result = { page: project(item), document: projectAccountDocument(item.document,visible), attachments: (payload.attachments ?? []).filter(row=>row.pageId===pageId).map(row=>({id:row.id,name:row.name,mediaType:row.mediaType,size:row.size})) };
      } else {
        if (grantId) {
          if (request.method !== 'DELETE') fail('METHOD_NOT_ALLOWED', 405);
          object(data, ['expectedRevision']);
          const grant = payload.grants.find(row => row.id === grantId && row.pageId === pageId && row.status === 'active');
          if (!grant) missing();
          if(grant.includeDescendants)requireAccessSubtreeManagement({payload,workspaceId,accountId,pageId,fail},currentState);
          grant.status = 'revoked';
          result = { revoked: true };
        } else {
          if (request.method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
          object(data, ['expectedRevision', 'accountId', 'permission','includeDescendants'],['expectedRevision','accountId','permission']);
          if(Object.hasOwn(data,'includeDescendants')&&typeof data.includeDescendants!=='boolean')fail('INVALID_CONTENT');
          assertId(data.accountId);
          if (!['viewer', 'commenter', 'editor', 'full', 'deny'].includes(data.permission)) fail('INVALID_CONTENT');
          const target = saved.principals.find(row => row.accountId === data.accountId && row.emailVerified);
          if (!target) missing();
          if(data.includeDescendants||payload.grants.some(grant=>grant.pageId===pageId&&grant.accountId===target.accountId&&grant.status==='active'&&grant.includeDescendants))requireAccessSubtreeManagement({payload,workspaceId,accountId,pageId,fail},currentState);
          guards.push({ id: target.id, accountId: target.accountId, role: target.role });
          for (const grant of payload.grants) if (grant.pageId === pageId && grant.accountId === target.accountId) grant.status = 'revoked';
          const grant = { id: assertId(createId()), workspaceId, pageId, accountId: target.accountId,
            permission: data.permission, includeDescendants: data.includeDescendants===true, status: 'active' };
          payload.grants.push(grant); payload.grantBindings.push({ grantId: grant.id, membershipId: target.id }); result = { grant };
        }
        protectAccessTransition({payload,principals:saved.principals,workspaceId,fail},currentState);
      }
      trimHistory(payload);
      const captured = validateContentPayload(payload, workspaceId);
      let written;
      try {
        written = await store.write(workspaceId, accountId, { expectedRevision: saved.revision, payload: captured,
          actorMembershipId: actor.id, actorRole: actor.role, guardMemberships: guards,...(grantsPath?{guardPrincipalSnapshot:saved.principals}:{}) });
      } catch (cause) {
        if (cause?.code !== 'CONTENT_CONFLICT') throw cause;
        // A revoked membership/grant must not receive a newer revision or hidden content.
        const fresh = await store.read(workspaceId, accountId);
        if (!fresh) missing();
        const principal = fresh.principals.find(row => row.accountId === accountId && row.id === actor.id && row.emailVerified);
        if (!principal || (!pageId && principal.role === 'guest')) missing();
        if (pageId) {
          const latest = readPayload(fresh, workspaceId);
          const capability = grantsPath ? 'manage' : 'editBody';
          const evaluateLatest = createPageAccessEvaluator(policy(latest, fresh.principals, workspaceId));
          if (!evaluateLatest({ accountId, workspaceId, pageId }).capabilities.includes(capability)) missing();
        }
        if (guards.some(guard => !fresh.principals.some(row => row.id === guard.id && row.accountId === guard.accountId && row.role === guard.role && row.emailVerified))) missing();
        fail('CONTENT_CONFLICT', 409);
      }
      return json({ revision: written.revision, ...result }, pageId ? 200 : 201);
    } catch (cause) {
      const code = cause?.code;
      if (isRoomError(cause) || cause instanceof ContentGroupsError || cause instanceof PersonalTemplatesError || cause instanceof ContentMentionsError || cause instanceof ContentPageLinksError || cause instanceof ContentBacklinksError || cause instanceof ContentPublicationError || cause instanceof ContentFormsError || cause instanceof ContentCommentsError || cause instanceof ContentActivityError || cause instanceof ContentCollectionsError || cause instanceof ContentError || cause instanceof ContentAssetError || cause instanceof ContentPagesError || cause instanceof ContentTeamspaceError || cause instanceof ContentBlocksError || cause instanceof ContentHistoryError) return json({ error: { code, message: code === 'CONTENT_CONFLICT' ? 'Content changed. Reload before saving.' : 'The content request could not be completed.' } }, cause.status);
      if (code === 'CONTENT_CONFLICT') return json({ error: { code, message: 'Content changed. Reload before saving.' } }, 409);
      if (code === 'CONTENT_NOT_FOUND') return json({ error: { code, message: 'The content request could not be completed.' } }, 404);
      if (code === 'INVALID_INPUT' || code === 'HIERARCHY_CYCLE') return json({ error: { code: 'INVALID_CONTENT', message: 'Invalid page content.' } }, 400);
      return json({ error: { code: 'CONTENT_UNAVAILABLE', message: 'Account content is unavailable.' } }, 503);
    }
  };
}
