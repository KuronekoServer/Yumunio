import { invalidateRooms } from './content-room.js';
import {CONTENT_STORAGE_LIMITS} from './content-codec.js';
import { assertId, assertPlainObject, assertJsonSerializable, assertTitle, validateDocument, createPageAccessEvaluator } from '@yumunio/domain';
const encoder = new TextEncoder(), MAX_SNAPSHOTS = 32, MAX_BYTES = 300000;
const size = value => encoder.encode(JSON.stringify(value)).length;
export class ContentHistoryError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const fail = (code = 'INVALID_CONTENT', status = 400) => { throw new ContentHistoryError(code, status); };
const missing = () => fail('CONTENT_NOT_FOUND', 404), conflict = () => fail('CONTENT_CONFLICT', 409);
function exact(value, fields) { assertPlainObject(value); assertJsonSerializable(value); if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail(); }
export function validateHistory(payload, pages, workspaceId) {
  if (!Object.hasOwn(payload, 'history')) return;
  if (!Array.isArray(payload.history) || payload.history.length > MAX_SNAPSHOTS || size(payload.history) > MAX_BYTES) fail();
  const ids = new Set();
  for (const row of payload.history) {
    exact(row, ['id', 'pageId', 'title', 'document', 'actorId', 'recordedAt', 'kind']);
    assertId(row.id); assertId(row.pageId); assertId(row.actorId); assertTitle(row.title); validateDocument(row.document);
    if (ids.has(row.id) || !pages.has(row.pageId) || row.document.pageId !== row.pageId || row.document.workspaceId !== workspaceId || row.document.version >= pages.get(row.pageId).document.version ||
        !['edit', 'block-move', 'restore'].includes(row.kind) || typeof row.recordedAt !== 'string' || !Number.isFinite(Date.parse(row.recordedAt)) || new Date(row.recordedAt).toISOString() !== row.recordedAt) fail();
    ids.add(row.id);
  }
}
/** Bounded full snapshots share the same CAS as the new content. Older snapshots may be pruned. */
export function rememberPage(payload, item, { actorId, kind = 'edit', now, createId }) {
  const record = { id: assertId(createId()), pageId: item.page.id, title: item.page.title, document: structuredClone(item.document), actorId: assertId(actorId), recordedAt: now(), kind };
  if (payload.history?.some(row => row.id === record.id)) fail('CONTENT_UNAVAILABLE', 503);
  payload.history ??= []; payload.history.push(record);
}
export function trimHistory(payload) {
  if (!payload.history) return;
  while (payload.history.length && (payload.history.length > MAX_SNAPSHOTS || size(payload.history) > MAX_BYTES || size(payload) > CONTENT_STORAGE_LIMITS.logicalBytes)) payload.history.shift();
  if (!payload.history.length) delete payload.history;
}
export async function handleHistory({ request, historyId, pageId, store, saved, payload, actor, accountId, workspaceId, access, policy, readJson, readPayload, validatePayload, projectDocument, visible, now, createId }) {
  const item = payload.pages.find(row => row.page.id === pageId);
  if (!item || !access(pageId).includes('manage')) missing();
  const versions = (payload.history ?? []).filter(row => row.pageId === pageId);
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  if (request.method === 'GET') {
    if (historyId) {
      const snapshot = versions.find(row => row.id === historyId); if (!snapshot) missing();
      return Response.json({ revision: saved.revision, pageId, snapshot: { ...snapshot, document: projectDocument(snapshot.document, visible) } }, { headers });
    }
    return Response.json({ revision: saved.revision, pageId, currentVersion: item.document.version,
      retention: { kind: 'bounded-workspace-snapshots', maxSnapshots: MAX_SNAPSHOTS, maxBytes: MAX_BYTES },
      versions: versions.map(({ id, title, actorId, recordedAt, kind, document }) => ({ id, title, actorId, recordedAt, kind, version: document.version })).reverse() }, { headers });
  }
  if (request.method !== 'POST' || !historyId) fail('METHOD_NOT_ALLOWED', 405);
  const data = await readJson(request); exact(data, ['expectedRevision', 'expectedVersion']);
  if (![data.expectedRevision, data.expectedVersion].every(value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER)) fail('INVALID_REVISION');
  if (data.expectedRevision !== saved.revision || data.expectedVersion !== item.document.version) conflict();
  const selected = versions.find(row => row.id === historyId); if (!selected) missing();
  const title = selected.title, blocks = structuredClone(selected.document.blocks);
  invalidateRooms(payload,[pageId]);
  rememberPage(payload, item, { actorId: accountId, kind: 'restore', now, createId });
  const stamp = now(); item.page.title = title; item.page.updatedAt = stamp;
  item.document = validateDocument({ ...item.document, blocks, version: item.document.version + 1, updatedAt: stamp });
  trimHistory(payload); const captured = validatePayload(payload, workspaceId);
  try {
    const written = await store.write(workspaceId, accountId, { expectedRevision: saved.revision, payload: captured, actorMembershipId: actor.id, actorRole: actor.role, guardMemberships: [] });
    return Response.json({ revision: written.revision, pageId, version: item.document.version, restoredFromVersion: selected.document.version }, { headers });
  } catch (error) {
    if (error?.code !== 'CONTENT_CONFLICT') throw error;
    const fresh = await store.read(workspaceId, accountId);
    if (!fresh?.principals.some(row => row.accountId === accountId && row.id === actor.id && row.role === actor.role && row.emailVerified)) missing();
    const latest = readPayload(fresh, workspaceId);
    if (!createPageAccessEvaluator(policy(latest, fresh.principals, workspaceId))({ accountId, workspaceId, pageId }).capabilities.includes('manage')) missing();
    conflict();
  }
}
