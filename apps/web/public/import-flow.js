const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const acknowledgementKeys = ['csvTextTypes', 'csvReference', 'linksUnconverted', 'excludedAssets', 'nativeSubset'];
export class ImportFlowError extends Error {
  constructor(code, status = 0) { super(code); this.name = 'ImportFlowError'; this.code = code; this.status = status; }
}
export class AccountImportFlow {
  constructor({ prepare, build, fetcher = globalThis.fetch?.bind(globalThis), createId = () => 'import-' + crypto.randomUUID(), timeoutMs = 15000 } = {}) {
    if (typeof prepare !== 'function' || typeof build !== 'function' || typeof fetcher !== 'function') throw new TypeError('INVALID_IMPORT_FLOW');
    this.prepareAdapter = prepare; this.buildAdapter = build; this.fetcher = fetcher; this.createId = createId; this.timeoutMs = timeoutMs;
    this.actor = null; this.workspace = null; this.prepared = null; this.body = null; this.plan = null; this.rootTitle = '';
    this.options = null;
    this.phase = 'idle'; this.pending = false; this.attempted = false; this.error = null; this.result = null; this.generation = 0;
  }
  get locked() { return this.attempted || this.pending; }
  setActor(user) {
    if (this.pending) throw new ImportFlowError('IMPORT_BUSY');
    const next = user && id(user.id) ? { id: user.id, emailVerified: user.emailVerified === true } : null;
    if (this.attempted && this.actor?.id !== next?.id) {
      this.phase = next ? 'account-changed' : 'auth-required'; this.error = new ImportFlowError(next ? 'ACCOUNT_CHANGED' : 'UNAUTHORIZED', 401);
      throw this.error;
    }
    if (this.actor?.id !== next?.id) { this.workspace = null; this.invalidate(); this.generation++; }
    this.actor = next;
    if (next?.emailVerified && ['account-changed', 'auth-required'].includes(this.phase) && this.prepared) { this.phase = 'review'; this.error = null; }
  }
  invalidate() {
    if (this.locked) throw new ImportFlowError('IMPORT_LOCKED');
    this.prepared = null; this.body = null; this.plan = null; this.options = null; this.result = null; this.error = null;
    this.phase = this.workspace ? 'ready' : 'idle';
  }
  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(path, { method, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let value; try { value = await response.json(); } catch { throw new ImportFlowError('INVALID_RESPONSE'); }
      if (!response.ok) throw new ImportFlowError(typeof value?.error?.code === 'string' ? value.error.code : 'IMPORT_FAILED', response.status);
      return value;
    } catch (error) { if (error instanceof ImportFlowError) throw error; throw new ImportFlowError('NETWORK_UNCERTAIN'); }
    finally { clearTimeout(timer); }
  }
  path(workspaceId = this.workspace?.id) {
    if (!id(workspaceId)) throw new ImportFlowError('SELECT_WORKSPACE');
    return '/api/content/workspaces/' + encodeURIComponent(workspaceId);
  }
  validateMetadata(value, workspaceId) {
    if (value?.workspaceId !== workspaceId || !revision(value.revision) || !['owner', 'admin', 'member', 'guest'].includes(value.role) || !Array.isArray(value.pages)) throw new ImportFlowError('INVALID_RESPONSE');
    if (value.role === 'guest') throw new ImportFlowError('GUEST_IMPORT_FORBIDDEN', 404);
    return { revision: value.revision, role: value.role, attachmentsEnabled: value.attachmentsEnabled === true };
  }
  async selectWorkspace(workspace) {
    if (this.locked) throw new ImportFlowError('IMPORT_LOCKED');
    if (!this.actor?.emailVerified) throw new ImportFlowError('VERIFIED_ACCOUNT_REQUIRED', 401);
    this.generation++; const marker = this.generation;
    this.workspace = null; this.invalidate();
    if (!workspace) return;
    if (!id(workspace.id) || typeof workspace.name !== 'string') throw new ImportFlowError('SELECT_WORKSPACE');
    this.phase = 'loading';
    try {
      const value = await this.request(this.path(workspace.id) + '/pages');
      if (marker !== this.generation) return;
      const metadata = this.validateMetadata(value, workspace.id);
      this.workspace = { id: workspace.id, name: workspace.name, ...metadata }; this.phase = 'ready';
    } catch (error) { if (marker !== this.generation) return; this.error = error; this.phase = error.code === 'GUEST_IMPORT_FORBIDDEN' ? 'forbidden' : 'failed'; throw error; }
  }
  prepare(plan, rootTitle, options = {}) {
    if (this.locked) throw new ImportFlowError('IMPORT_LOCKED');
    if (!this.actor?.emailVerified || !this.workspace) throw new ImportFlowError('SELECT_WORKSPACE');
    const importId = this.createId();
    if (!id(importId)) throw new ImportFlowError('INVALID_IMPORT_ID');
    const importOptions = { csvMode: options.csvMode ?? 'native', rowPageMappings: clone(options.rowPageMappings ?? []), ...(options.assets?.length ? { assets: clone(options.assets) } : {}) };
    const prepared = this.prepareAdapter(plan, { ...importOptions, expectedRevision: this.workspace.revision, importId, rootTitle });
    if (!prepared?.body || prepared.body.importId !== importId || !Array.isArray(prepared.body.pages) ||
      !Array.isArray(prepared.requiredAcknowledgements) || prepared.requiredAcknowledgements.some(key => !acknowledgementKeys.includes(key))) throw new ImportFlowError('INVALID_PREVIEW');
    this.prepared = freeze(clone(prepared)); this.plan = freeze(clone(plan)); this.options = freeze(importOptions); this.rootTitle = rootTitle;
    this.body = this.prepared.body; this.error = null; this.phase = 'review';
    return this.prepared;
  }
  async submit({ acknowledgements = {}, consent = false } = {}) {
    if (this.pending || this.result) throw new ImportFlowError('IMPORT_BUSY');
    if (!this.prepared || !this.body || !this.workspace || !this.actor?.emailVerified) throw new ImportFlowError('IMPORT_NOT_REVIEWED');
    if (!['review', 'uncertain', 'auth-required'].includes(this.phase)) throw new ImportFlowError('IMPORT_REVIEW_REQUIRED');
    if (!consent || this.prepared.requiredAcknowledgements.some(key => acknowledgements[key] !== true)) throw new ImportFlowError('ACKNOWLEDGEMENT_REQUIRED');
    if (!this.attempted) {
      const built = this.buildAdapter(this.plan, { ...this.options, expectedRevision: this.body.expectedRevision, importId: this.body.importId, rootTitle: this.rootTitle, acknowledgements });
      if (JSON.stringify(built.body) !== JSON.stringify(this.body)) throw new ImportFlowError('PREVIEW_CHANGED');
    }
    const requestLimit = this.plan?.source === 'appflowy-native' && this.plan?.schemaVersion === 2 ? 768000 : 256000;
    if (new TextEncoder().encode(JSON.stringify(this.body)).length > requestLimit) { this.error = new ImportFlowError('CONTENT_TOO_LARGE', 413); this.phase = 'failed'; throw this.error; }
    this.pending = true; this.phase = 'saving'; this.error = null;
    const actorId = this.actor.id, workspaceId = this.workspace.id, body = this.body, marker = ++this.generation;
    try {
      const session = await this.request('/api/auth/get-session');
      if (session?.user?.id !== actorId) throw new ImportFlowError(session?.user ? 'ACCOUNT_CHANGED' : 'UNAUTHORIZED', 401);
      if (session.user.emailVerified !== true) throw new ImportFlowError('VERIFIED_ACCOUNT_REQUIRED', 401);
      // Once a POST may be sent, this body and import ID remain immutable for every retry.
      this.attempted = true;
      const result = await this.request(this.path(workspaceId) + '/imports', { method: 'POST', body, headers: { 'X-Yumunio-Expected-Account': actorId } });
      if (marker !== this.generation || this.workspace?.id !== workspaceId || this.actor.id !== actorId) throw new ImportFlowError('CONTEXT_CHANGED');
      if (result?.importId !== body.importId || !id(result.rootPageId) || !revision(result.revision) || result.revision < 1 ||
        result.pageCount !== body.pages.length || typeof result.replayed !== 'boolean') throw new ImportFlowError('INVALID_RESPONSE');
      this.result = freeze(clone(result)); this.phase = 'success';
      try {
        const fresh = await this.request(this.path(workspaceId) + '/pages');
        const metadata = this.validateMetadata(fresh, workspaceId);
        this.workspace = { ...this.workspace, ...metadata };
      } catch { /* A committed import stays successful even when the following read fails. */ }
      return this.result;
    } catch (error) {
      this.error = error;
      this.phase = error.status === 409 ? 'conflict' : error.code === 'ACCOUNT_CHANGED' ? 'account-changed' :
        error.status === 401 ? 'auth-required' : error.status === 404 || error.status === 403 ? 'forbidden' :
        error.status === 400 || error.status === 413 ? 'failed' : this.attempted ? 'uncertain' : 'failed';
      throw error;
    } finally { this.pending = false; }
  }
  async recheckConflict() {
    if (this.pending || !this.workspace || !this.body || !['conflict', 'forbidden'].includes(this.phase)) throw new ImportFlowError('IMPORT_REVIEW_REQUIRED');
    this.pending = true; this.error = null;
    try {
      const metadata = this.validateMetadata(await this.request(this.path() + '/pages'), this.workspace.id);
      this.workspace = { ...this.workspace, ...metadata };
      this.body = freeze({ ...this.body, expectedRevision: metadata.revision });
      this.prepared = freeze({ ...this.prepared, body: this.body, summary: { ...this.prepared.summary, bodyBytes: new TextEncoder().encode(JSON.stringify(this.body)).length } });
      this.phase = 'review'; return this.prepared;
    } catch (error) { this.error = error; this.phase = 'forbidden'; throw error; }
    finally { this.pending = false; }
  }
  resetKnownFailure() {
    if (this.pending || (this.attempted && !['success', 'failed'].includes(this.phase))) throw new ImportFlowError('IMPORT_LOCKED');
    this.attempted = false; this.invalidate();
  }
}
