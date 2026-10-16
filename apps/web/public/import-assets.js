const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const validRevision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const hex = value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
export class ImportAssetError extends Error {
  constructor(code, status = 0) { super(code); this.name = 'ImportAssetError'; this.code = code; this.status = status; }
}
const fail = (code, status = 0) => { throw new ImportAssetError(code, status); };

/** Private in-memory bytes; only server-issued asset references enter the final JSON bundle. */
export class AccountImportAssets {
  constructor({ fetcher = globalThis.fetch?.bind(globalThis), createHash = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes)), timeoutMs = 60000 } = {}) {
    if (typeof fetcher !== 'function' || typeof createHash !== 'function') throw new TypeError('INVALID_ASSET_FLOW');
    this.fetcher = fetcher; this.createHash = createHash; this.timeoutMs = timeoutMs;
    this.context = null; this.items = []; this.reservations = new Map();
    this.revision = 0; this.phase = 'idle'; this.pending = false; this.started = false; this.error = null;
  }
  get locked() { return this.pending || this.started; }
  snapshot() {
    return { phase: this.phase, revision: this.revision, count: this.items.length,
      bytes: this.items.reduce((total, item) => total + item.size, 0),
      ready: this.items.filter(item => this.reservations.get(item.sourceId)?.status === 'ready').length };
  }
  async prepare({ workspaceId, accountId, importId, revision, assets }) {
    if (this.locked) fail('ASSETS_LOCKED');
    if (![workspaceId, accountId, importId].every(validId) || !validRevision(revision) || !Array.isArray(assets) || !assets.length || assets.length > 100) fail('INVALID_ASSET_PLAN');
    const seen = new Set(), captured = []; let total = 0;
    for (const item of assets) {
      if (!validId(item.sourceId) || seen.has(item.sourceId) || typeof item.name !== 'string' || !item.name || item.name.length > 255 ||
          /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(item.name) ||
          !(item.bytes instanceof Uint8Array) || item.bytes.length > 16 * 1024 * 1024) fail('INVALID_ASSET_PLAN');
      seen.add(item.sourceId); total += item.bytes.length;
      if (total > 64 * 1024 * 1024) fail('ASSETS_TOO_LARGE', 413);
      // Capture all input before the first asynchronous hash.
      captured.push({ sourceId: item.sourceId, name: item.name, mediaType: 'application/octet-stream', size: item.bytes.length, bytes: item.bytes.slice() });
    }
    this.pending = true;
    try {
      for (const item of captured) { item.checksum = await this.createHash(item.bytes); if (!/^[a-f0-9]{64}$/.test(item.checksum)) fail('INVALID_ASSET_PLAN'); }
      this.context = Object.freeze({ workspaceId, accountId, importId }); this.items = captured;
      this.revision = revision; this.reservations.clear(); this.phase = 'prepared'; this.error = null;
      return this.snapshot();
    } finally { this.pending = false; }
  }
  path() {
    if (!this.context) fail('ASSETS_NOT_PREPARED');
    return '/api/content/workspaces/' + encodeURIComponent(this.context.workspaceId) + '/imports/' + encodeURIComponent(this.context.importId) + '/assets';
  }
  async request(path, { method = 'GET', body, binary = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'X-Yumunio-Expected-Account': this.context.accountId,
      ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
      ...(binary || method === 'DELETE' ? { 'X-Yumunio-Expected-Revision': String(this.revision) } : {}) };
    try {
      const response = await this.fetcher(path, { method, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: controller.signal, headers, ...(body === undefined ? {} : { body: binary ? body.slice() : JSON.stringify(body) }) });
      let value; try { value = await response.json(); } catch { fail('INVALID_ASSET_RESPONSE'); }
      if (!response.ok) fail(typeof value?.error?.code === 'string' ? value.error.code : 'ASSETS_FAILED', response.status);
      return value;
    } catch (error) { if (error instanceof ImportAssetError) throw error; fail('ASSETS_NETWORK_UNCERTAIN'); }
    finally { clearTimeout(timer); }
  }
  advance(value) {
    if (!validRevision(value?.revision) || value.revision < this.revision) fail('INVALID_ASSET_RESPONSE');
    this.revision = value.revision;
  }
  async recover() {
    const data = await this.request(this.path());
    if (!Array.isArray(data?.assets) || data.assets.length > 100) fail('INVALID_ASSET_RESPONSE');
    const reservations = new Map();
    for (const row of data.assets) {
      const item = this.items.find(item => item.sourceId === row.sourceId);
      if (!item || reservations.has(row.sourceId) || !validId(row.assetId) || !['reserved', 'ready', 'deleting'].includes(row.status) ||
          row.name !== item.name || row.mediaType !== item.mediaType || row.size !== item.size || row.checksum !== item.checksum) fail('ASSET_CONTEXT_CHANGED');
      reservations.set(row.sourceId, { assetId: row.assetId, sourceId: row.sourceId, status: row.status });
    }
    this.advance(data); this.reservations = reservations;
    return data;
  }
  failed(error, cancelling = false) {
    this.error = error;
    this.phase = cancelling ? 'cancel-uncertain' : error.status === 409 ? 'conflict' :
      [401, 403, 404].includes(error.status) ? 'forbidden' : error.status === 400 || error.status === 413 || error.code === 'ASSET_CONTEXT_CHANGED' ? 'failed' : 'uncertain';
  }
  async upload(onProgress = () => {}) {
    if (this.pending || !this.context || !['prepared', 'uncertain', 'rechecked', 'uploaded'].includes(this.phase)) fail('ASSETS_RECHECK_REQUIRED');
    this.pending = true; this.error = null;
    try {
      if (this.started) await this.recover();
      this.phase = 'uploading';
      for (const item of this.items) {
        let reservation = this.reservations.get(item.sourceId);
        if (reservation?.status === 'deleting') fail('ASSET_CONTEXT_CHANGED');
        if (!reservation) {
          this.started = true;
          const { bytes, ...metadata } = item;
          const result = await this.request(this.path(), { method: 'POST', body: { expectedRevision: this.revision, ...metadata } });
          if (!validId(result?.assetId) || !['reserved', 'ready'].includes(result.status)) fail('INVALID_ASSET_RESPONSE');
          this.advance(result); reservation = { assetId: result.assetId, sourceId: item.sourceId, status: result.status };
          this.reservations.set(item.sourceId, reservation);
        }
        if (reservation.status !== 'ready') {
          const result = await this.request(this.path() + '/' + encodeURIComponent(reservation.assetId), { method: 'PUT', body: item.bytes, binary: true });
          if (result?.assetId !== reservation.assetId || result.status !== 'ready') fail('INVALID_ASSET_RESPONSE');
          this.advance(result); reservation.status = 'ready';
        }
        onProgress(this.snapshot());
      }
      this.phase = 'uploaded';
      return { revision: this.revision, assets: this.items.map(item => ({ sourceId: item.sourceId, assetId: this.reservations.get(item.sourceId).assetId })) };
    } catch (error) { this.failed(error); throw error; }
    finally { this.pending = false; }
  }
  async recheck() {
    if (this.pending || !this.context || ['committed', 'cancelled'].includes(this.phase)) fail('ASSETS_RECHECK_REQUIRED');
    this.pending = true;
    try { await this.recover(); this.phase = 'rechecked'; this.error = null; return this.snapshot(); }
    catch (error) { this.failed(error); throw error; }
    finally { this.pending = false; }
  }
  async cancel() {
    if (this.pending || !this.context || this.phase === 'committed') fail('ASSETS_LOCKED');
    this.pending = true;
    try {
      if (this.started) {
        await this.recover(); this.phase = 'cancelling';
        for (const [sourceId, row] of this.reservations) {
          const result = await this.request(this.path() + '/' + encodeURIComponent(row.assetId), { method: 'DELETE', body: { expectedRevision: this.revision } });
          if (result?.removed !== true) fail('INVALID_ASSET_RESPONSE');
          this.advance(result); this.reservations.delete(sourceId);
        }
      }
      this.phase = 'cancelled'; this.started = false; this.error = null; this.items = [];
      return this.snapshot();
    } catch (error) { this.failed(error, true); throw error; }
    finally { this.pending = false; }
  }
  markCommitted() {
    if (this.pending || this.phase !== 'uploaded') fail('ASSETS_LOCKED');
    for (const item of this.items) item.bytes = new Uint8Array();
    this.phase = 'committed';
  }
}
