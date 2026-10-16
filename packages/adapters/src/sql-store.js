import {
  DomainError, assertId, assertJsonSerializable, assertPlainObject, assertVersion,
  validatePage, validateDocument, validateCollection,
} from "@yumunio/domain";

const pageQuery = `SELECT page.*, CASE WHEN active.id IS NULL THEN 0 ELSE 1 END AS is_active
  FROM yumunio_pages page LEFT JOIN yumunio_active_pages active
  ON active.workspace_id = page.workspace_id AND active.id = page.id
  WHERE page.workspace_id = ? AND page.id = ?`;
const documentQuery = `SELECT document.*, CASE WHEN active.id IS NULL THEN 0 ELSE 1 END AS is_active
  FROM yumunio_documents document LEFT JOIN yumunio_active_pages active
  ON active.workspace_id = document.workspace_id AND active.id = document.page_id
  WHERE document.workspace_id = ? AND document.page_id = ?`;
const collectionQuery = "SELECT * FROM yumunio_collections WHERE workspace_id = ? AND id = ?";
const ownOr = (value, key, fallback) => Object.hasOwn(value, key) ? value[key] : fallback;
const fail = (code, message, details = {}) => { throw new DomainError(code, message, details); };
const inputObject = (input, allowedKeys, field) => {
  assertJsonSerializable(input, field);
  const value = assertPlainObject(input, field);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail("INVALID_INPUT", "Unknown input field.", { field: field + "." + key });
  }
  return structuredClone(value);
};
const optionsObject = (input, keys) => {
  const options = inputObject(input, keys, "options");
  if (Object.hasOwn(options, "includeTrashed") && typeof options.includeTrashed !== "boolean") fail("INVALID_INPUT", "includeTrashed must be a boolean.");
  if (Object.hasOwn(options, "parentId") && options.parentId !== null) assertId(options.parentId, "parentId");
  return options;
};
const mapPage = row => validatePage({ id: row.id, workspaceId: row.workspace_id, title: row.title,
  parentId: row.parent_id, createdAt: row.created_at, updatedAt: row.updated_at, trashedAt: row.trashed_at });
const mapDocument = row => validateDocument({ pageId: row.page_id, workspaceId: row.workspace_id,
  version: row.version, blocks: JSON.parse(row.blocks_json), updatedAt: row.updated_at });
const mapCollection = row => validateCollection({ id: row.id, workspaceId: row.workspace_id,
  title: row.title, properties: JSON.parse(row.properties_json), records: JSON.parse(row.records_json),
  createdAt: row.created_at, updatedAt: row.updated_at });
const databaseError = error => {
  if (error instanceof DomainError) return error;
  const message = String(error?.message ?? "");
  const marker = message.match(/YUMUNIO_(HIERARCHY_CYCLE|NOT_FOUND|DESTINATION_UNAVAILABLE|VERSION_CONFLICT|INVALID_INPUT)/);
  if (marker) return new DomainError(marker[1], "The database rejected the operation.");
  if (message.includes("UNIQUE constraint failed")) return new DomainError("ALREADY_EXISTS", "The ID already exists in this workspace.");
  if (message.includes("FOREIGN KEY constraint failed")) return new DomainError("NOT_FOUND", "The referenced page is not in this workspace.");
  if (message.includes("CHECK constraint failed")) return new DomainError("INVALID_INPUT", "The database rejected an invalid value.");
  return new DomainError("STORAGE_ERROR", "The database operation failed.");
};

/**
 * Internal shared SQL implementation of the WorkspaceStore contract.
 * SQL input is always bound. The caller must authorize workspaceId separately.
 * SQL triggers protect hierarchy and trash epochs at the actual write boundary.
 * @implements {import('@yumunio/storage').WorkspaceStore}
 */
export class SqlStore {
  #driver;
  #now;
  #createId;
  /** @param {{batch: Function}} driver @param {{now?: () => string, createId?: () => string}} [options] */
  constructor(driver, { now = () => new Date().toISOString(), createId = () => globalThis.crypto.randomUUID() } = {}) {
    if (typeof now !== "function" || typeof createId !== "function") fail("INVALID_INPUT", "Expected clock and ID factory functions.");
    this.#driver = driver;
    this.#now = now;
    this.#createId = createId;
  }
  async #batch(commands) {
    try { return await this.#driver.batch(commands); } catch (error) { throw databaseError(error); }
  }
  #ids(workspaceId, ...ids) { assertId(workspaceId, "workspaceId"); for (const id of ids) assertId(id); }
  #pageResult(row, includeTrashed = false) {
    if (!row || (!includeTrashed && !row.is_active)) fail("NOT_FOUND", "Page not found in this workspace.");
    return mapPage(row);
  }
  async #pageRow(workspaceId, pageId, includeTrashed = false) {
    this.#ids(workspaceId, pageId);
    const result = await this.#batch([{ sql: pageQuery, params: [workspaceId, pageId] }]);
    const row = result[0].rows[0];
    this.#pageResult(row, includeTrashed);
    return row;
  }
  #collectionResult(row) {
    if (!row) fail("NOT_FOUND", "Collection not found in this workspace.");
    return mapCollection(row);
  }

  /** @param {string} workspaceId @param {import('@yumunio/storage').CreatePageInput} [input] */
  async createPage(workspaceId, input = {}) {
    this.#ids(workspaceId);
    const data = inputObject(input, ["id", "title", "parentId", "blocks"], "page");
    const id = assertId(Object.hasOwn(data, "id") ? data.id : this.#createId());
    const stamp = this.#now();
    const page = validatePage({ id, workspaceId, title: ownOr(data, "title", ""), parentId: ownOr(data, "parentId", null),
      createdAt: stamp, updatedAt: stamp, trashedAt: null });
    const document = validateDocument({ pageId: id, workspaceId, version: 1, blocks: ownOr(data, "blocks", []), updatedAt: stamp });
    const result = await this.#batch([
      { sql: "INSERT INTO yumunio_pages(workspace_id,id,title,parent_id,created_at,updated_at,trashed_at) VALUES (?,?,?,?,?,?,?)",
        params: [workspaceId, id, page.title, page.parentId, stamp, stamp, null], write: true },
      { sql: "INSERT INTO yumunio_documents(workspace_id,page_id,version,blocks_json,updated_at) VALUES (?,?,?,?,?)",
        params: [workspaceId, id, 1, JSON.stringify(document.blocks), stamp], write: true },
      { sql: pageQuery, params: [workspaceId, id] },
    ]);
    return this.#pageResult(result[2].rows[0]);
  }

  /** @param {string} workspaceId @param {string} pageId @param {import('@yumunio/storage').ReadOptions} [options] */
  async getPage(workspaceId, pageId, options = {}) {
    const data = optionsObject(options, ["includeTrashed"]);
    return mapPage(await this.#pageRow(workspaceId, pageId, data.includeTrashed));
  }

  /** @param {string} workspaceId @param {import('@yumunio/storage').ListPageOptions} [options] */
  async listPages(workspaceId, options = {}) {
    this.#ids(workspaceId);
    const data = optionsObject(options, ["includeTrashed", "parentId"]);
    const result = await this.#batch([{ sql: `SELECT page.* FROM yumunio_pages page
      LEFT JOIN yumunio_active_pages active ON active.workspace_id = page.workspace_id AND active.id = page.id
      WHERE page.workspace_id = ? AND (? = 1 OR active.id IS NOT NULL) AND (? = 0 OR page.parent_id IS ?)
      ORDER BY page.rowid`,
      params: [workspaceId, data.includeTrashed ? 1 : 0, Object.hasOwn(data, "parentId") ? 1 : 0, ownOr(data, "parentId", null)] }]);
    return result[0].rows.map(mapPage);
  }

  /** @param {string} workspaceId @param {string} pageId @param {import('@yumunio/storage').PagePatch} patch */
  async updatePage(workspaceId, pageId, patch) {
    const data = inputObject(patch, ["title", "parentId"], "patch");
    const current = mapPage(await this.#pageRow(workspaceId, pageId));
    const page = validatePage({ ...current, ...data, updatedAt: this.#now() });
    const result = await this.#batch([
      { sql: `UPDATE yumunio_pages SET title = CASE WHEN ? = 1 THEN ? ELSE title END,
        parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND EXISTS (
          SELECT 1 FROM yumunio_active_pages active WHERE active.workspace_id = ? AND active.id = ?
        )`, params: [Object.hasOwn(data, "title") ? 1 : 0, page.title, Object.hasOwn(data, "parentId") ? 1 : 0,
        page.parentId, page.updatedAt, workspaceId, pageId, workspaceId, pageId], write: true },
      { sql: pageQuery, params: [workspaceId, pageId] },
    ]);
    return this.#pageResult(result[1].rows[0]);
  }

  /** @param {string} workspaceId @param {string} pageId */
  async trashPage(workspaceId, pageId) {
    const current = mapPage(await this.#pageRow(workspaceId, pageId, true));
    if (current.trashedAt !== null) return current;
    const stamp = this.#now();
    validatePage({ ...current, trashedAt: stamp, updatedAt: stamp });
    const result = await this.#batch([
      { sql: `UPDATE yumunio_pages SET trashed_at = ?, updated_at = ?, epoch = epoch + 1
        WHERE workspace_id = ? AND id = ? AND trashed_at IS NULL`, params: [stamp, stamp, workspaceId, pageId], write: true },
      { sql: pageQuery, params: [workspaceId, pageId] },
    ]);
    return this.#pageResult(result[1].rows[0], true);
  }

  /** @param {string} workspaceId @param {string} pageId @param {import('@yumunio/storage').RestoreOptions} [options] */
  async restorePage(workspaceId, pageId, options = {}) {
    const data = inputObject(options, ["title", "parentId"], "restore");
    const currentRow = await this.#pageRow(workspaceId, pageId, true);
    if (currentRow.is_active) fail("INVALID_INPUT", "Page is not in the trash.");
    const page = validatePage({ ...mapPage(currentRow), ...data, trashedAt: null, updatedAt: this.#now() });
    const result = await this.#batch([
      { sql: `UPDATE yumunio_pages SET title = CASE WHEN ? = 1 THEN ? ELSE title END,
        parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END, trashed_at = NULL, updated_at = ?, epoch = epoch + 1
        WHERE workspace_id = ? AND id = ? AND NOT EXISTS (
          SELECT 1 FROM yumunio_active_pages active WHERE active.workspace_id = ? AND active.id = ?
        )`, params: [Object.hasOwn(data, "title") ? 1 : 0, page.title, Object.hasOwn(data, "parentId") ? 1 : 0,
        page.parentId, page.updatedAt, workspaceId, pageId, workspaceId, pageId], write: true },
      { sql: pageQuery, params: [workspaceId, pageId] },
    ]);
    const restored = this.#pageResult(result[1].rows[0], true);
    if (!result[0].changes) fail("INVALID_INPUT", "Page is not in the trash.");
    return restored;
  }

  /** @param {string} workspaceId @param {string} pageId @param {import('@yumunio/storage').ReadOptions} [options] */
  async getDocument(workspaceId, pageId, options = {}) {
    this.#ids(workspaceId, pageId);
    const data = optionsObject(options, ["includeTrashed"]);
    const result = await this.#batch([{ sql: documentQuery, params: [workspaceId, pageId] }]);
    const row = result[0].rows[0];
    if (!row || (!data.includeTrashed && !row.is_active)) fail("NOT_FOUND", "Page not found in this workspace.");
    return mapDocument(row);
  }

  /** @param {string} workspaceId @param {string} pageId @param {import('@yumunio/storage').DocumentUpdate} update */
  async updateDocument(workspaceId, pageId, update) {
    this.#ids(workspaceId, pageId);
    const data = inputObject(update, ["expectedVersion", "blocks"], "document");
    assertVersion(data.expectedVersion, "expectedVersion");
    const stamp = this.#now();
    const validated = validateDocument({ pageId, workspaceId, version: 1, blocks: data.blocks, updatedAt: stamp });
    const result = await this.#batch([
      { sql: `UPDATE yumunio_documents SET blocks_json = ?, version = version + 1, updated_at = ?, cause = 'edit'
        WHERE workspace_id = ? AND page_id = ? AND version = ? AND version < 9007199254740991 AND EXISTS (
          SELECT 1 FROM yumunio_active_pages active WHERE active.workspace_id = ? AND active.id = ?
        )`, params: [JSON.stringify(validated.blocks), stamp, workspaceId, pageId, data.expectedVersion, workspaceId, pageId], write: true },
      { sql: documentQuery, params: [workspaceId, pageId] },
    ]);
    const row = result[1].rows[0];
    if (!row || !row.is_active) fail("NOT_FOUND", "Page not found in this workspace.");
    if (!result[0].changes) fail("VERSION_CONFLICT", "Document version does not match.", {
      expectedVersion: data.expectedVersion, actualVersion: row.version,
    });
    return mapDocument(row);
  }

  /** @param {string} workspaceId @param {import('@yumunio/storage').CreateCollectionInput} [input] */
  async createCollection(workspaceId, input = {}) {
    this.#ids(workspaceId);
    const data = inputObject(input, ["id", "title", "properties", "records"], "collection");
    const id = assertId(Object.hasOwn(data, "id") ? data.id : this.#createId());
    const stamp = this.#now();
    const collection = validateCollection({ id, workspaceId, title: ownOr(data, "title", ""),
      properties: ownOr(data, "properties", []), records: ownOr(data, "records", []), createdAt: stamp, updatedAt: stamp });
    const result = await this.#batch([
      { sql: "INSERT INTO yumunio_collections(workspace_id,id,title,properties_json,records_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        params: [workspaceId, id, collection.title, JSON.stringify(collection.properties), JSON.stringify(collection.records), stamp, stamp], write: true },
      { sql: collectionQuery, params: [workspaceId, id] },
    ]);
    return this.#collectionResult(result[1].rows[0]);
  }

  /** @param {string} workspaceId @param {string} collectionId */
  async getCollection(workspaceId, collectionId) {
    this.#ids(workspaceId, collectionId);
    const result = await this.#batch([{ sql: collectionQuery, params: [workspaceId, collectionId] }]);
    return this.#collectionResult(result[0].rows[0]);
  }

  /** @param {string} workspaceId */
  async listCollections(workspaceId) {
    this.#ids(workspaceId);
    const result = await this.#batch([{ sql: "SELECT * FROM yumunio_collections WHERE workspace_id = ? ORDER BY rowid", params: [workspaceId] }]);
    return result[0].rows.map(mapCollection);
  }

  /** @param {string} workspaceId @param {string} collectionId @param {import('@yumunio/storage').CollectionPatch} patch */
  async updateCollection(workspaceId, collectionId, patch) {
    const data = inputObject(patch, ["title", "properties", "records"], "patch");
    this.#ids(workspaceId, collectionId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.#batch([{ sql: collectionQuery, params: [workspaceId, collectionId] }]);
      const row = snapshot[0].rows[0];
      const current = this.#collectionResult(row);
      const collection = validateCollection({ ...current, ...data, updatedAt: this.#now() });
      const result = await this.#batch([
        { sql: `UPDATE yumunio_collections SET title = CASE WHEN ? = 1 THEN ? ELSE title END,
          properties_json = CASE WHEN ? = 1 THEN ? ELSE properties_json END,
          records_json = CASE WHEN ? = 1 THEN ? ELSE records_json END, updated_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND id = ? AND revision = ? AND revision < 9007199254740991`,
          params: [Object.hasOwn(data, "title") ? 1 : 0, collection.title,
            Object.hasOwn(data, "properties") ? 1 : 0, JSON.stringify(collection.properties),
            Object.hasOwn(data, "records") ? 1 : 0, JSON.stringify(collection.records),
            collection.updatedAt, workspaceId, collectionId, row.revision], write: true },
        { sql: collectionQuery, params: [workspaceId, collectionId] },
      ]);
      const saved = this.#collectionResult(result[1].rows[0]);
      if (result[0].changes) return saved;
    }
    fail("VERSION_CONFLICT", "Collection changed while applying the patch.");
  }

  /** @param {string} workspaceId @param {string} collectionId */
  async deleteCollection(workspaceId, collectionId) {
    this.#ids(workspaceId, collectionId);
    const result = await this.#batch([{ sql: "DELETE FROM yumunio_collections WHERE workspace_id = ? AND id = ?",
      params: [workspaceId, collectionId], write: true }]);
    if (!result[0].changes) fail("NOT_FOUND", "Collection not found in this workspace.");
  }
}
