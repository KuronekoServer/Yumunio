export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 900000;

export class SnapshotError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message); this.name = 'SnapshotError'; this.code = code; this.status = status; this.details = details;
  }
}
const fail = message => { throw new SnapshotError('INVALID_SNAPSHOT', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const string = (value, length) => typeof value === 'string' && value.length <= length;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const date = value => value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

/** Validate the prototype schema, independently of future Domain/CRDT models. */
export function validateSnapshot(value) {
  let raw;
  try { raw = JSON.stringify(value); } catch { fail('Snapshot must be JSON serializable.'); }
  if (!raw || new TextEncoder().encode(raw).length > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotError('PAYLOAD_TOO_LARGE', 'Snapshot exceeds the prototype size limit.', 413);
  }
  const data = JSON.parse(raw);
  if (!fields(data, ['schemaVersion', 'name', 'pages', 'ui', 'updatedAt']) || data.schemaVersion !== 1 || !string(data.name, 200) || !Array.isArray(data.pages) || data.pages.length > 1000 || !time(data.updatedAt)) fail('Unsupported workspace snapshot.');
  const pages = new Map(); const blockIds = new Set(); let totalBlocks = 0;
  for (const page of data.pages) {
    if (!fields(page, ['id', 'title', 'parentId', 'kind', 'blocks', 'deletedAt', 'createdAt', 'updatedAt', 'collectionId', 'properties']) || !id(page.id) || pages.has(page.id) || !string(page.title, 500) || !['document', 'collection', 'record'].includes(page.kind) || !(page.parentId === null || id(page.parentId)) || !Array.isArray(page.blocks) || page.blocks.length > 2000 || !(page.deletedAt === null || time(page.deletedAt)) || !time(page.createdAt) || !time(page.updatedAt)) fail('Invalid page.');
    pages.set(page.id, page);
    totalBlocks += page.blocks.length;
    if (totalBlocks > 20000) fail('Too many blocks.');
    for (const block of page.blocks) {
      if (!fields(block, ['id', 'type', 'text', 'checked', 'marks', 'start', 'language']) || !id(block.id) || blockIds.has(block.id) || !['paragraph', 'heading1', 'heading2', 'heading3', 'checklist', 'bulleted-list', 'numbered-list', 'quote', 'divider', 'code'].includes(block.type) || !string(block.text, 100000) || typeof block.checked !== 'boolean') fail('Invalid block.');
      if(block.type==='divider'&&block.text!=='')fail('Invalid divider text.');
      if (Object.hasOwn(block,'start')&&(block.type!=='numbered-list'||!Number.isSafeInteger(block.start)||block.start<1||block.start>999999999))fail('Invalid numbered list start.');
      if (Object.hasOwn(block,'language')&&(block.type!=='code'||typeof block.language!=='string'||!/^[A-Za-z0-9_+.#-]{1,100}$/.test(block.language)))fail('Invalid code language.');
      if (Object.hasOwn(block,'marks')) { try { validateInlineMarks(block.text,block.marks); } catch { fail('Invalid inline formatting.'); } }
      blockIds.add(block.id);
    }
    if (page.kind === 'record') {
      if (!(page.collectionId === null || id(page.collectionId)) || !fields(page.properties, ['status', 'owner', 'date']) || !['準備', '進行中', 'レビュー', '完了'].includes(page.properties.status) || !['未設定', 'Aoi', 'Ren', 'Mika', 'Haru'].includes(page.properties.owner) || !date(page.properties.date)) fail('Invalid record properties.');
    } else if (page.collectionId !== undefined || page.properties !== undefined) fail('Only records have collection properties.');
  }
  for (const page of pages.values()) {
    const seen = new Set(); let current = page;
    while (current.parentId !== null) {
      if (seen.has(current.id) || !pages.has(current.parentId)) fail('Invalid page hierarchy.');
      seen.add(current.id); current = pages.get(current.parentId);
    }
    if (page.kind === 'record' && (page.collectionId !== page.parentId || (page.collectionId !== null && pages.get(page.collectionId)?.kind !== 'collection'))) fail('Record must belong to its parent collection or be restored at root.');
  }
  if (!fields(data.ui, ['recentPageIds', 'lastRoute']) || !Array.isArray(data.ui.recentPageIds) || data.ui.recentPageIds.length > 8 || !data.ui.recentPageIds.every(id) || !string(data.ui.lastRoute, 256) || !/^#(?:home|trash|page\/[A-Za-z0-9._:-]+)$/.test(data.ui.lastRoute)) fail('Invalid navigation metadata.');
  return data;
}
import { validateInlineMarks } from './inline-text.js';
