import {
  DomainError, assertId, assertJsonSerializable, assertNoHierarchyCycle,
  assertPlainObject, assertVersion, validateCollection, validateDocument, validatePage,
} from "@yumunio/domain";

/**
 * @typedef {import('@yumunio/domain').Page} Page
 * @typedef {import('@yumunio/domain').Document} Document
 * @typedef {import('@yumunio/domain').Block} Block
 * @typedef {import('@yumunio/domain').Collection} Collection
 * @typedef {import('@yumunio/domain').PropertyDefinition} PropertyDefinition
 * @typedef {import('@yumunio/domain').CollectionRecord} CollectionRecord
 * @typedef {{id?: string, title?: string, parentId?: string|null, blocks?: Block[]}} CreatePageInput
 * @typedef {{title?: string, parentId?: string|null}} PagePatch
 * @typedef {{includeTrashed?: boolean}} ReadOptions
 * @typedef {{includeTrashed?: boolean, parentId?: string|null}} ListPageOptions
 * @typedef {{expectedVersion: number, blocks: Block[]}} DocumentUpdate
 * @typedef {{title?: string, parentId?: string|null}} RestoreOptions
 * @typedef {{id?: string, title?: string, properties?: PropertyDefinition[], records?: CollectionRecord[]}} CreateCollectionInput
 * @typedef {{title?: string, properties?: PropertyDefinition[], records?: CollectionRecord[]}} CollectionPatch
 *
 * @typedef {object} WorkspaceStore
 * @property {(workspaceId: string, input?: CreatePageInput) => Promise<Page>} createPage
 * @property {(workspaceId: string, pageId: string, options?: ReadOptions) => Promise<Page>} getPage
 * @property {(workspaceId: string, options?: ListPageOptions) => Promise<Page[]>} listPages
 * @property {(workspaceId: string, pageId: string, patch: PagePatch) => Promise<Page>} updatePage
 * @property {(workspaceId: string, pageId: string) => Promise<Page>} trashPage
 * @property {(workspaceId: string, pageId: string, options?: RestoreOptions) => Promise<Page>} restorePage
 * @property {(workspaceId: string, pageId: string, options?: ReadOptions) => Promise<Document>} getDocument
 * @property {(workspaceId: string, pageId: string, update: DocumentUpdate) => Promise<Document>} updateDocument
 * @property {(workspaceId: string, input?: CreateCollectionInput) => Promise<Collection>} createCollection
 * @property {(workspaceId: string, collectionId: string) => Promise<Collection>} getCollection
 * @property {(workspaceId: string) => Promise<Collection[]>} listCollections
 * @property {(workspaceId: string, collectionId: string, patch: CollectionPatch) => Promise<Collection>} updateCollection
 * @property {(workspaceId: string, collectionId: string) => Promise<void>} deleteCollection
 */

const copy = value => structuredClone(value);
const fail = (code, message, details = {}) => { throw new DomainError(code, message, details); };
const ownOr = (value, key, fallback) => Object.hasOwn(value, key) ? value[key] : fallback;
const inputObject = (input, allowedKeys, field) => {
  assertJsonSerializable(input, field);
  const value = assertPlainObject(input, field);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail("INVALID_INPUT", "Unknown input field.", { field: field + "." + key });
  }
  return value;
};
const readOptions = (input, allowedKeys) => {
  const options = inputObject(input, allowedKeys, "options");
  if (Object.hasOwn(options, "includeTrashed") && typeof options.includeTrashed !== "boolean") {
    fail("INVALID_INPUT", "includeTrashed must be a boolean.");
  }
  if (Object.hasOwn(options, "parentId") && options.parentId !== null) assertId(options.parentId, "parentId");
  return options;
};

/**
 * Ephemeral reference adapter; every operation is isolated by the supplied scope.
 * The caller must authorize that scope before using this internal contract.
 * Mutations validate and clone before committing, with no await inside a commit.
 * @implements {WorkspaceStore}
 */
export class InMemoryStore {
  #workspaces = new Map();
  #now;
  #createId;

  /** @param {{now?: () => string, createId?: () => string}} [options] */
  constructor({ now = () => new Date().toISOString(), createId = () => globalThis.crypto.randomUUID() } = {}) {
    if (typeof now !== "function" || typeof createId !== "function") fail("INVALID_INPUT", "Expected clock and ID factory functions.");
    this.#now = now;
    this.#createId = createId;
  }

  #scope(workspaceId, create = false) {
    assertId(workspaceId, "workspaceId");
    let scope = this.#workspaces.get(workspaceId);
    if (!scope && create) {
      scope = { pages: new Map(), documents: new Map(), collections: new Map() };
      this.#workspaces.set(workspaceId, scope);
    }
    return scope;
  }

  #isTrashed(scope, page) {
    const seen = new Set();
    let cursor = page;
    while (cursor) {
      if (seen.has(cursor.id)) fail("HIERARCHY_CYCLE", "Invalid existing page hierarchy.");
      seen.add(cursor.id);
      if (cursor.trashedAt !== null) return true;
      cursor = cursor.parentId === null ? undefined : scope.pages.get(cursor.parentId);
    }
    return false;
  }

  #page(scope, pageId, includeTrashed = false) {
    assertId(pageId, "pageId");
    const page = scope?.pages.get(pageId);
    if (!page || (!includeTrashed && this.#isTrashed(scope, page))) fail("NOT_FOUND", "Page not found in this workspace.");
    return page;
  }

  #parent(scope, pageId, parentId) {
    assertNoHierarchyCycle(pageId, parentId, id => {
      const parent = scope?.pages.get(id);
      if (!parent) fail("NOT_FOUND", "Parent not found in this workspace.");
      if (this.#isTrashed(scope, parent)) fail("DESTINATION_UNAVAILABLE", "The parent is in the trash.");
      return parent.parentId;
    });
  }

  #subtreeIds(scope, pageId) {
    const ids = new Set([pageId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const page of scope.pages.values()) {
        if (page.parentId !== null && ids.has(page.parentId) && !ids.has(page.id)) {
          ids.add(page.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  #bumpedDocuments(scope, pageId, stamp) {
    return Array.from(this.#subtreeIds(scope, pageId), id => {
      const document = scope.documents.get(id);
      if (document.version === Number.MAX_SAFE_INTEGER) fail("VERSION_CONFLICT", "Document version limit reached.");
      return [id, validateDocument({ ...document, version: document.version + 1, updatedAt: stamp })];
    });
  }

  /** @param {string} workspaceId @param {CreatePageInput} [input] @returns {Promise<Page>} */
  async createPage(workspaceId, input = {}) {
    const data = inputObject(input, ["id", "title", "parentId", "blocks"], "page");
    const scope = this.#scope(workspaceId);
    const id = assertId(Object.hasOwn(data, "id") ? data.id : this.#createId(), "id");
    if (scope?.pages.has(id)) fail("ALREADY_EXISTS", "Page ID already exists in this workspace.");
    const parentId = ownOr(data, "parentId", null);
    this.#parent(scope, id, parentId);
    const stamp = this.#now();
    const page = validatePage({ id, workspaceId, title: ownOr(data, "title", ""), parentId,
      createdAt: stamp, updatedAt: stamp, trashedAt: null });
    const document = validateDocument({ pageId: id, workspaceId, version: 1,
      blocks: ownOr(data, "blocks", []), updatedAt: stamp });
    const pageCopy = copy(page);
    const documentCopy = copy(document);
    const target = this.#scope(workspaceId, true);
    target.pages.set(id, pageCopy);
    target.documents.set(id, documentCopy);
    return copy(pageCopy);
  }

  /** @param {string} workspaceId @param {string} pageId @param {ReadOptions} [options] @returns {Promise<Page>} */
  async getPage(workspaceId, pageId, options = {}) {
    const data = readOptions(options, ["includeTrashed"]);
    return copy(this.#page(this.#scope(workspaceId), pageId, data.includeTrashed));
  }

  /** @param {string} workspaceId @param {ListPageOptions} [options] @returns {Promise<Page[]>} */
  async listPages(workspaceId, options = {}) {
    const data = readOptions(options, ["includeTrashed", "parentId"]);
    const scope = this.#scope(workspaceId);
    return Array.from(scope?.pages.values() ?? [])
      .filter(page => (data.includeTrashed || !this.#isTrashed(scope, page)) &&
        (!Object.hasOwn(data, "parentId") || page.parentId === data.parentId))
      .map(copy);
  }

  /** @param {string} workspaceId @param {string} pageId @param {PagePatch} patch @returns {Promise<Page>} */
  async updatePage(workspaceId, pageId, patch) {
    const data = inputObject(patch, ["title", "parentId"], "patch");
    const scope = this.#scope(workspaceId);
    const current = this.#page(scope, pageId);
    const parentId = ownOr(data, "parentId", current.parentId);
    this.#parent(scope, pageId, parentId);
    const page = validatePage({ ...current, ...data, parentId, updatedAt: this.#now() });
    scope.pages.set(pageId, copy(page));
    return copy(page);
  }

  /** @param {string} workspaceId @param {string} pageId @returns {Promise<Page>} */
  async trashPage(workspaceId, pageId) {
    const scope = this.#scope(workspaceId);
    const current = this.#page(scope, pageId, true);
    if (current.trashedAt !== null) return copy(current);
    const stamp = this.#now();
    const page = validatePage({ ...current, trashedAt: stamp, updatedAt: stamp });
    const documents = this.#bumpedDocuments(scope, pageId, stamp);
    scope.pages.set(pageId, copy(page));
    for (const [id, document] of documents) scope.documents.set(id, document);
    return copy(page);
  }

  /** @param {string} workspaceId @param {string} pageId @param {RestoreOptions} [options] @returns {Promise<Page>} */
  async restorePage(workspaceId, pageId, options = {}) {
    const data = inputObject(options, ["title", "parentId"], "restore");
    const scope = this.#scope(workspaceId);
    const current = this.#page(scope, pageId, true);
    if (!this.#isTrashed(scope, current)) fail("INVALID_INPUT", "Page is not in the trash.");
    const parentId = ownOr(data, "parentId", current.parentId);
    this.#parent(scope, pageId, parentId);
    const stamp = this.#now();
    const page = validatePage({ ...current, ...data, parentId, trashedAt: null, updatedAt: stamp });
    const documents = this.#bumpedDocuments(scope, pageId, stamp);
    scope.pages.set(pageId, copy(page));
    for (const [id, document] of documents) scope.documents.set(id, document);
    return copy(page);
  }

  /** @param {string} workspaceId @param {string} pageId @param {ReadOptions} [options] @returns {Promise<Document>} */
  async getDocument(workspaceId, pageId, options = {}) {
    const data = readOptions(options, ["includeTrashed"]);
    const scope = this.#scope(workspaceId);
    this.#page(scope, pageId, data.includeTrashed);
    return copy(scope.documents.get(pageId));
  }

  /** @param {string} workspaceId @param {string} pageId @param {DocumentUpdate} update @returns {Promise<Document>} */
  async updateDocument(workspaceId, pageId, update) {
    const data = inputObject(update, ["expectedVersion", "blocks"], "document");
    assertVersion(data.expectedVersion, "expectedVersion");
    const scope = this.#scope(workspaceId);
    const currentPage = this.#page(scope, pageId);
    const current = scope.documents.get(pageId);
    if (data.expectedVersion !== current.version || current.version === Number.MAX_SAFE_INTEGER) {
      fail("VERSION_CONFLICT", "Document version does not match.", { expectedVersion: data.expectedVersion, actualVersion: current.version });
    }
    const stamp = this.#now();
    const document = validateDocument({ ...current, blocks: data.blocks, version: current.version + 1, updatedAt: stamp });
    const page = validatePage({ ...currentPage, updatedAt: stamp });
    const documentCopy = copy(document);
    scope.documents.set(pageId, documentCopy);
    scope.pages.set(pageId, page);
    return copy(documentCopy);
  }

  /** @param {string} workspaceId @param {CreateCollectionInput} [input] @returns {Promise<Collection>} */
  async createCollection(workspaceId, input = {}) {
    const data = inputObject(input, ["id", "title", "properties", "records"], "collection");
    const scope = this.#scope(workspaceId);
    const id = assertId(Object.hasOwn(data, "id") ? data.id : this.#createId(), "id");
    if (scope?.collections.has(id)) fail("ALREADY_EXISTS", "Collection ID already exists in this workspace.");
    const stamp = this.#now();
    const collection = validateCollection({ id, workspaceId, title: ownOr(data, "title", ""),
      properties: ownOr(data, "properties", []), records: ownOr(data, "records", []), createdAt: stamp, updatedAt: stamp });
    const collectionCopy = copy(collection);
    this.#scope(workspaceId, true).collections.set(id, collectionCopy);
    return copy(collectionCopy);
  }

  #collection(scope, collectionId) {
    assertId(collectionId, "collectionId");
    const collection = scope?.collections.get(collectionId);
    if (!collection) fail("NOT_FOUND", "Collection not found in this workspace.");
    return collection;
  }

  /** @param {string} workspaceId @param {string} collectionId @returns {Promise<Collection>} */
  async getCollection(workspaceId, collectionId) {
    return copy(this.#collection(this.#scope(workspaceId), collectionId));
  }

  /** @param {string} workspaceId @returns {Promise<Collection[]>} */
  async listCollections(workspaceId) {
    return Array.from(this.#scope(workspaceId)?.collections.values() ?? []).map(copy);
  }

  /** @param {string} workspaceId @param {string} collectionId @param {CollectionPatch} patch @returns {Promise<Collection>} */
  async updateCollection(workspaceId, collectionId, patch) {
    const data = inputObject(patch, ["title", "properties", "records"], "patch");
    const scope = this.#scope(workspaceId);
    const current = this.#collection(scope, collectionId);
    const collection = validateCollection({ ...current, ...data, updatedAt: this.#now() });
    const collectionCopy = copy(collection);
    scope.collections.set(collectionId, collectionCopy);
    return copy(collectionCopy);
  }

  /** @param {string} workspaceId @param {string} collectionId @returns {Promise<void>} */
  async deleteCollection(workspaceId, collectionId) {
    const scope = this.#scope(workspaceId);
    this.#collection(scope, collectionId);
    scope.collections.delete(collectionId);
  }
}
