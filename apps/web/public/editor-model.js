const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const EDITABLE_BLOCK_TYPES = Object.freeze(['paragraph', 'heading', 'checklist', 'bulleted-list', 'numbered-list', 'quote', 'divider', 'code']);

/** Recognize a complete prefix only; code contents and pasted HTML remain plain text. */
export function markdownPrefix(text) {
  if (typeof text !== 'string') return null;
  const heading = /^(#{1,3}) $/.exec(text);
  if (heading) return { type: 'heading', data: { text: '', level: heading[1].length } };
  if (/^[-*+] $/.test(text)) return { type: 'bulleted-list', data: { text: '' } };
  const ordered = /^([1-9][0-9]{0,8})[.)] $/.exec(text);
  if (ordered) return { type: 'numbered-list', data: { text: '', start: Number(ordered[1]) } };
  if (text === '> ') return { type: 'quote', data: { text: '' } };
  if (/^\[(?: |x|X)?\] $/.test(text)) return { type: 'checklist', data: { text: '', checked: /[xX]/.test(text) } };
  const fence = /^```([A-Za-z0-9_+.#-]{0,100}) $/.exec(text);
  if (fence) return { type: 'code', data: { text: '', ...(fence[1] ? { language: fence[1] } : {}) } };
  if (text === '--- ') return { type: 'divider', data: {} };
  return null;
}

function snapshot(draft, selection) {
  if (!draft || typeof draft.title !== 'string' || !Array.isArray(draft.blocks)) throw new TypeError('INVALID_EDITOR_DRAFT');
  const result = { draft: clone(draft), selection: selection ? clone(selection) : null };
  if (bytes(result) > 900000) throw new RangeError('EDITOR_HISTORY_TOO_LARGE');
  return result;
}

/** Local undo is bounded and never silently rebases a server revision or discards a conflict. */
export class EditorHistory {
  constructor(draft, { maxSteps = 100, maxBytes = 8 * 1024 * 1024, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200 || !Number.isInteger(maxBytes) || maxBytes < 900000 || maxBytes > 32 * 1024 * 1024 || typeof now !== 'function') throw new TypeError('INVALID_EDITOR_HISTORY');
    this.maxSteps = maxSteps; this.maxBytes = maxBytes; this.now = now; this.reset(draft);
  }
  reset(draft, selection = null) {
    this.current = snapshot(draft, selection); this.past = []; this.future = []; this.group = null; this.changedAt = 0;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  #trim() {
    while (this.past.length > this.maxSteps || bytes([this.past, this.current, this.future]) > this.maxBytes) {
      if (this.past.length) this.past.shift(); else if (this.future.length) this.future.shift(); else break;
    }
  }
  record(draft, { group = null, selection = null } = {}) {
    const next = snapshot(draft, selection), stamp = this.now();
    if (JSON.stringify(next.draft) === JSON.stringify(this.current.draft)) { this.current.selection = next.selection; return false; }
    if (group === null || group !== this.group || stamp - this.changedAt > 750 || stamp < this.changedAt || this.future.length) this.past.push(this.current);
    this.current = next; this.future = []; this.group = group; this.changedAt = stamp; this.#trim(); return true;
  }
  undo() {
    if (!this.canUndo) return null;
    this.future.push(this.current); this.current = this.past.pop(); this.group = null; this.#trim(); return clone(this.current);
  }
  redo() {
    if (!this.canRedo) return null;
    this.past.push(this.current); this.current = this.future.pop(); this.group = null; this.#trim(); return clone(this.current);
  }
}

/** Same-document tree movement keeps stable IDs, and rejects a drop into its own subtree. */
export function moveEditorBlock(blocks, { blockId, parentId = null, index }) {
  if (!Array.isArray(blocks) || typeof blockId !== 'string' || (parentId !== null && typeof parentId !== 'string') || !Number.isInteger(index) || index < 0) throw new TypeError('INVALID_BLOCK_MOVE');
  const next = clone(blocks), locations = new Map();
  const visit = (items, ancestors = []) => {
    for (const block of items) {
      if (!block || typeof block.id !== 'string' || locations.has(block.id)) throw new TypeError('INVALID_BLOCK_TREE');
      locations.set(block.id, { block, items, ancestors });
      if (block.children !== undefined) { if (!Array.isArray(block.children)) throw new TypeError('INVALID_BLOCK_TREE'); visit(block.children, [...ancestors, block.id]); }
    }
  };
  visit(next);
  const source = locations.get(blockId), parent = parentId === null ? null : locations.get(parentId);
  if (!source || parentId !== null && !parent) throw new TypeError('BLOCK_NOT_FOUND');
  if (parentId === blockId || parent?.ancestors.includes(blockId)) throw new TypeError('BLOCK_MOVE_CYCLE');
  if (parent && !['paragraph', 'bulleted-list', 'numbered-list', 'quote', 'checklist'].includes(parent.block.type)) throw new TypeError('BLOCK_PARENT_UNSUPPORTED');
  const destination = parent ? (parent.block.children ??= []) : next;
  const sourceIndex = source.items.indexOf(source.block);
  if (index > destination.length) throw new RangeError('INVALID_BLOCK_INDEX');
  source.items.splice(sourceIndex, 1);
  destination.splice(source.items === destination && sourceIndex < index ? index - 1 : index, 0, source.block);
  return next;
}
