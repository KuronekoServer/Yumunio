import { validatePageLinks } from './page-links.js';
import {validateRollupDefinition,validateRollupProperties,RollupError} from './rollup.js';
import {compileFormulaProperties,validateFormulaDefinition,parseFormula,FormulaError} from './formula.js';
import { validateInlineMarks } from './inline.js';
import {validateMentions} from './mentions.js';
import {validateSimpleTableData} from './simple-table.js';
import {isAttachmentBlock} from './attachment-block-model.js';
import {RICH_BLOCK_TYPES,GENERATED_BLOCK_TYPES,isBookmarkBlock,validateBlockPresentation} from './block-types.js';
export * from './block-types.js';
import {validatePageAppearance} from './page-appearance.js';
export * from './page-appearance.js';
export {isAttachmentBlock} from './attachment-block-model.js';
export * from './simple-table.js';
export {BLOCK_MOVE_NESTING,BlockForestMoveError,planBlockForestMove,moveBlockForest} from './block-forest.js';
/**
 * Independent, JSON-only models for the first Yumunio storage contract.
 * These models do not implement authentication, editor rendering, or CRDTs.
 *
 * @typedef {string} Id
 * @typedef {null|boolean|number|string|JsonValue[]|{[key: string]: JsonValue}} JsonValue
 * @typedef {{[key: string]: JsonValue}} JsonObject
 * @typedef {{id: Id, type: string, data?: JsonObject, children?: Block[]}} Block
 * @typedef {{id: Id, workspaceId: Id, title: string, parentId: Id|null,
 *   createdAt: string, updatedAt: string, trashedAt: string|null}} Page
 * @typedef {{pageId: Id, workspaceId: Id, version: number, blocks: Block[],
 *   updatedAt: string}} Document
 * @typedef {'text'|'number'|'checkbox'|'date'|'select'|'multi_select'|'person'|'relation'|'formula'|'rollup'} PropertyType
 * @typedef {{version: 1, relationPropertyId: Id, targetCollectionId: Id, targetPropertyId: Id|null, operation: 'count'|'sum'|'min'|'max', resultType: 'number'|'date'}} RollupDefinition
 * @typedef {{id: Id, name: string, type: PropertyType, required?: boolean,
 *   options?: string[], formula?: {version:1,expression:string,resultType:'number'|'text'|'checkbox'|'date'}, rollup?: RollupDefinition}} PropertyDefinition
 * @typedef {{id: Id, values: JsonObject}} CollectionRecord
 * @typedef {{id: Id, workspaceId: Id, title: string, properties: PropertyDefinition[],
 *   records: CollectionRecord[], createdAt: string, updatedAt: string}} Collection
 */

export const PROPERTY_TYPES = Object.freeze([
  "text", "number", "checkbox", "date", "select", "multi_select", "person", "relation", "formula", "rollup",
]);

/** A machine-readable validation or storage error without resource contents. */
export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

const invalid = (field, message) => {
  throw new DomainError("INVALID_INPUT", message, { field });
};

/** @param {unknown} value @param {string} [field] @returns {string} */
export function assertId(value, field = "id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    invalid(field, "An ID must start with an ASCII letter or digit and use 1 to 128 ASCII letters, digits, dots, colons, underscores, or hyphens.");
  }
  return value;
}

/** @param {unknown} value @param {string} [field] @returns {Record<string, unknown>} */
export function assertPlainObject(value, field = "value") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "Expected a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(field, "Expected a plain object.");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Reject values that JSON would silently omit, coerce, or invoke through getters.
 * Shared references are allowed; circular references are not.
 * @param {unknown} value
 * @param {string} [field]
 * @returns {JsonValue}
 */
export function assertJsonSerializable(value, field = "value") {
  const ancestors = new Set();
  let nodes = 0;
  const visit = (item, path, depth) => {
    if (++nodes > 100000 || depth > 64) invalid(field, "JSON data exceeds the validation limits.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid(path, "JSON numbers must be finite.");
      return;
    }
    if (typeof item !== "object") invalid(path, "Expected a JSON-compatible value.");
    if (ancestors.has(item)) invalid(path, "Circular JSON data is not supported.");
    const isArray = Array.isArray(item);
    if (isArray) {
      if (Object.getPrototypeOf(item) !== Array.prototype) invalid(path, "Expected a plain array.");
    } else {
      assertPlainObject(item, path);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (isArray && keys.length !== item.length + 1) {
      invalid(path, "Sparse arrays and additional array properties are not supported.");
    }
    ancestors.add(item);
    for (const key of keys) {
      if (isArray && key === "length") continue;
      if (typeof key !== "string") invalid(path, "Symbol properties are not JSON-compatible.");
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        invalid(path, "JSON data must use enumerable data properties.");
      }
      if (isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) {
        invalid(path, "Expected an array index.");
      }
      visit(descriptor.value, path + "." + key, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, field, 0);
  return /** @type {JsonValue} */ (value);
}

/** @param {unknown} value @param {string} [field] @returns {string} */
export function assertTitle(value, field = "title") {
  if (typeof value !== "string" || value.length > 240) invalid(field, "A title must be a string of at most 240 characters.");
  return value;
}

/** @param {unknown} value @param {string} [field] @returns {number} */
export function assertVersion(value, field = "version") {
  if (!Number.isSafeInteger(value) || value < 1) invalid(field, "A version must be a positive safe integer.");
  return value;
}

const assertTimestamp = (value, field) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    invalid(field, "Expected a canonical UTC timestamp.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid(field, "Expected a valid UTC timestamp.");
};

/**
 * Block payload fields are JSON-only and retained as supplied. Type identifiers
 * are extensible; editor-specific payload schemas will be added separately.
 * @param {unknown} blocks
 * @returns {Block[]}
 */
export function validateBlocks(blocks) {
  assertJsonSerializable(blocks, "blocks");
  if (!Array.isArray(blocks)) invalid("blocks", "Expected an array of blocks.");
  const ids = new Set();
  const visit = (items, path, parentType = null, inColumns = false) => {
    for (let index = 0; index < items.length; index++) {
      const field = path + "[" + index + "]";
      const block = assertPlainObject(items[index], field);
      const id = assertId(block.id, field + ".id");
      assertId(block.type, field + ".type");
      if(GENERATED_BLOCK_TYPES.includes(block.type)&&Object.hasOwn(block,'children'))invalid(field+'.children','This block cannot contain children.');
      if(block.type==='bookmark'&&block.data?.format==='web-link-v1'&&!isBookmarkBlock(block))invalid(field+'.data','Invalid web link.');
      if(block.type==='equation'&&(typeof block.data?.text!=='string'||block.data.text.length>10000||Object.hasOwn(block,'children')))invalid(field+'.data','Invalid equation.');
      if(['file','image'].includes(block.type)&&block.data?.format==='attachment-v1'&&!isAttachmentBlock(block))invalid(field+'.data','Invalid attachment block.');
      if(block.type==='table'&&block.data?.format==='simple-table-v1'){
        try{validateSimpleTableData(block.data);}catch{invalid(field+'.data','Invalid simple table.');}
        if(Object.hasOwn(block,'children'))invalid(field+'.children','A simple table cannot contain child blocks.');
      }
      if (block.type === 'columns' || block.type === 'column') {
        if (Object.keys(block).some(key => !['id','type','data','children'].includes(key)) || !Array.isArray(block.children)) invalid(field, 'Invalid column wrapper.');
        if (block.type === 'columns' && (inColumns || ![2,3].includes(block.children.length) || block.children.some(child => child?.type !== 'column'))) invalid(field, 'Columns require two or three direct column children and cannot be nested.');
        if (block.type === 'column' && parentType !== 'columns') invalid(field, 'A column must be a direct child of columns.');
      }
      if (ids.has(id)) invalid(field + ".id", "Block IDs must be unique within a document.");
      ids.add(id);
      if (Object.hasOwn(block, "data")) {
        assertPlainObject(block.data, field + ".data");
        if([...RICH_BLOCK_TYPES,'code','equation'].includes(block.type))try{validateBlockPresentation(block.data);}catch{invalid(field+'.data','Invalid block presentation.');}
        if (['columns','column'].includes(block.type) && Object.keys(block.data).length) invalid(field + '.data', 'Column wrapper data must be empty.');
        if (Object.hasOwn(block.data, "links")) {
          try { validatePageLinks(block.data.text, block.data.links, {allowUnavailable:true,allowSourceReferences:true}); }
          catch { invalid(field + ".data.links", "Invalid structured link ranges."); }
        }
        if (Object.hasOwn(block.data, "marks")) {
          if (!RICH_BLOCK_TYPES.includes(block.type) || block.data.purpose === "import-source") invalid(field + ".data.marks", "Inline formatting is unavailable for this block.");
          try { validateInlineMarks(block.data.text, block.data.marks); }
          catch { invalid(field + ".data.marks", "Invalid inline formatting ranges."); }
        }
        if (Object.hasOwn(block.data, 'mentions')) {
          if (!RICH_BLOCK_TYPES.includes(block.type) || block.data.purpose === 'import-source') invalid(field + '.data.mentions', 'Mentions are unavailable for this block.');
          try { validateMentions(block.data.text, block.data.mentions, {allowUnavailable:true,allowMembershipIds:true}); }
          catch { invalid(field + '.data.mentions', 'Invalid inline mention ranges.'); }
        }
      }
      if (Object.hasOwn(block, "children")) {
        if (!Array.isArray(block.children)) invalid(field + ".children", "Expected an array of child blocks.");
        visit(block.children, field + ".children", block.type, inColumns || block.type === 'columns');
      }
    }
  };
  visit(blocks, "blocks");
  return /** @type {Block[]} */ (blocks);
}

/** @param {unknown} value @returns {Page} */
export function validatePage(value) {
  assertJsonSerializable(value, "page");
  const page = assertPlainObject(value, "page");
  assertId(page.id);
  assertId(page.workspaceId, "workspaceId");
  assertTitle(page.title);
  if (page.parentId !== null) assertId(page.parentId, "parentId");
  if (page.id === page.parentId) throw new DomainError("HIERARCHY_CYCLE", "A page cannot be its own parent.");
  assertTimestamp(page.createdAt, "createdAt");
  assertTimestamp(page.updatedAt, "updatedAt");
  if (page.trashedAt !== null) assertTimestamp(page.trashedAt, "trashedAt");
  if(Object.hasOwn(page,'appearance'))try{validatePageAppearance(page.appearance);}catch{invalid('appearance','Invalid page appearance.');}
  return /** @type {Page} */ (page);
}

/** @param {unknown} value @returns {Document} */
export function validateDocument(value) {
  assertJsonSerializable(value, "document");
  const document = assertPlainObject(value, "document");
  assertId(document.pageId, "pageId");
  assertId(document.workspaceId, "workspaceId");
  assertVersion(document.version);
  validateBlocks(document.blocks);
  assertTimestamp(document.updatedAt, "updatedAt");
  return /** @type {Document} */ (document);
}

/** @param {unknown} value @returns {PropertyDefinition[]} */
function validateDefinitions(value, checkFormulas) {
  assertJsonSerializable(value, "properties");
  if (!Array.isArray(value)) invalid("properties", "Expected property definitions.");
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const field = "properties[" + index + "]";
    const property = assertPlainObject(value[index], field);
    const id = assertId(property.id, field + ".id");
    if (ids.has(id)) invalid(field + ".id", "Property IDs must be unique.");
    ids.add(id);
    if (typeof property.name !== "string" || !property.name.trim() || property.name.length > 128) {
      invalid(field + ".name", "A property name must contain 1 to 128 characters.");
    }
    if (!PROPERTY_TYPES.includes(property.type)) invalid(field + ".type", "Unsupported property type.");
    if (Object.hasOwn(property, "required") && typeof property.required !== "boolean") invalid(field + ".required", "Expected a boolean.");
    if (property.type === "formula") {
      try { validateFormulaDefinition(property.formula); parseFormula(property.formula.expression); } catch (error) { formulaInvalid(error, field + ".formula"); }
      if (property.required === true) invalid(field + ".required", "A computed property cannot require a stored value.");
    } else if (Object.hasOwn(property, "formula")) invalid(field + ".formula", "Only computed properties have a formula.");
    if (property.type === "rollup") {
      try { validateRollupDefinition(property.rollup); } catch (error) { rollupInvalid(error, field + ".rollup"); }
      if (property.required === true) invalid(field + ".required", "A computed property cannot require a stored value.");
    } else if (Object.hasOwn(property, "rollup")) invalid(field + ".rollup", "Only rollup properties have a rollup definition.");
    if (Object.hasOwn(property, "options")) {
      if (!["select", "multi_select"].includes(property.type)) invalid(field + ".options", "Only selection properties have options.");
      if (!Array.isArray(property.options)) invalid(field + ".options", "Expected selection options.");
      const options = new Set();
      for (const option of property.options) {
        if (typeof option !== "string" || !option.trim() || option.length > 128 || options.has(option)) {
          invalid(field + ".options", "Selection options must be distinct, nonempty strings of at most 128 characters.");
        }
        options.add(option);
      }
    }
  }
  if (checkFormulas) try { validateRollupProperties(value); } catch (error) { rollupInvalid(error, "properties"); }
  if (checkFormulas) try { compileFormulaProperties(value); } catch (error) { formulaInvalid(error, "properties"); }
  return /** @type {PropertyDefinition[]} */ (value);
}
function formulaInvalid(error, field) { if (!(error instanceof FormulaError)) throw error; throw new DomainError("INVALID_INPUT", "Invalid formula.", { field, formulaCode:error.code, ...(error.position === undefined ? {} : {position:error.position}) }); }
function rollupInvalid(error, field) { if (!(error instanceof RollupError)) throw error; throw new DomainError("INVALID_INPUT", "Invalid rollup.", {field,rollupCode:error.code}); }
export function validatePropertyDefinitions(value) { return validateDefinitions(value, true); }

/** @param {PropertyDefinition} property @param {unknown} value @returns {JsonValue} */
function validateValue(property, value, checkDefinition) {
  if (checkDefinition) validateDefinitions([property], false);
  const field = "values." + property.id;
  if (value === null || value === undefined) {
    if (property.required) invalid(field, "A required property is missing.");
    return null;
  }
  assertJsonSerializable(value, field);
  if (property.required && (value === "" || (Array.isArray(value) && value.length === 0))) {
    invalid(field, "A required property is empty.");
  }
  switch (property.type) {
    case "rollup":
    case "formula":
      invalid(field, "Computed values cannot be stored.");
      break;
    case "text":
      if (typeof value !== "string") invalid(field, "Expected text.");
      break;
    case "number":
      if (typeof value !== "number") invalid(field, "Expected a finite number.");
      break;
    case "checkbox":
      if (typeof value !== "boolean") invalid(field, "Expected a boolean.");
      break;
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(field, "Expected a YYYY-MM-DD date.");
      const date = new Date(value + "T00:00:00.000Z");
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(field, "Expected a valid calendar date.");
      break;
    }
    case "select":
      if (typeof value !== "string" || !(property.options ?? []).includes(value)) invalid(field, "Expected one of the configured options.");
      break;
    case "multi_select":
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(option => !(property.options ?? []).includes(option))) {
        invalid(field, "Expected a distinct list of configured options.");
      }
      break;
    case "person":
      assertId(value, field);
      break;
    case "relation":
      if (!Array.isArray(value) || new Set(value).size !== value.length) invalid(field, "Expected distinct related IDs.");
      for (const id of value) assertId(id, field);
      break;
  }
  return /** @type {JsonValue} */ (value);
}
export function validatePropertyValue(property, value) { return validateValue(property, value, true); }

/** @param {PropertyDefinition[]} properties @param {unknown} value @returns {JsonObject} */
function validateValues(properties, value, checkDefinitions) {
  if (checkDefinitions) validatePropertyDefinitions(properties);
  assertJsonSerializable(value, "values");
  const values = assertPlainObject(value, "values");
  const known = new Set(properties.map(property => property.id));
  for (const id of Object.keys(values)) {
    if (!known.has(id)) invalid("values." + id, "Unknown property ID.");
  }
  for (const property of properties) validateValue(property, Object.hasOwn(values, property.id) ? values[property.id] : undefined, false);
  return /** @type {JsonObject} */ (values);
}
export function validatePropertyValues(properties, value) { return validateValues(properties, value, true); }

/** @param {unknown} value @returns {Collection} */
export function validateCollection(value) {
  assertJsonSerializable(value, "collection");
  const collection = assertPlainObject(value, "collection");
  assertId(collection.id);
  assertId(collection.workspaceId, "workspaceId");
  assertTitle(collection.title);
  const properties = validatePropertyDefinitions(collection.properties);
  if (!Array.isArray(collection.records)) invalid("records", "Expected an array of records.");
  const ids = new Set();
  for (let index = 0; index < collection.records.length; index++) {
    const record = assertPlainObject(collection.records[index], "records[" + index + "]");
    const id = assertId(record.id, "records[" + index + "].id");
    if (ids.has(id)) invalid("records", "Record IDs must be unique within a collection.");
    ids.add(id);
    validateValues(properties, record.values, false);
  }
  assertTimestamp(collection.createdAt, "createdAt");
  assertTimestamp(collection.updatedAt, "updatedAt");
  return /** @type {Collection} */ (collection);
}

/**
 * Validate a prospective parent using an already workspace-scoped lookup.
 * @param {Id} pageId
 * @param {Id|null} parentId
 * @param {(id: Id) => Id|null} getParentId
 */
export function assertNoHierarchyCycle(pageId, parentId, getParentId) {
  assertId(pageId, "pageId");
  const seen = new Set([pageId]);
  let cursor = parentId;
  while (cursor !== null) {
    assertId(cursor, "parentId");
    if (seen.has(cursor)) throw new DomainError("HIERARCHY_CYCLE", "The parent would create a hierarchy cycle.");
    seen.add(cursor);
    cursor = getParentId(cursor);
  }
}

export { validateAccount, validateWorkspace, validateMembership, validatePageAccess, validatePageGrant, validateInvitation, validateAccessState, createPageAccessEvaluator, evaluatePageAccess, evaluateWorkspaceAccess, evaluateInvitationAcceptance, WORKSPACE_ROLES, PAGE_PERMISSIONS } from './access.js';

export * from './inline.js';
export * from './mentions.js';

export {FormulaError,FORMULA_LIMITS,parseFormula,validateFormulaDefinition,compileFormulaProperties,evaluateFormulaRow} from './formula.js';

export {RollupError,ROLLUP_LIMITS,validateRollupDefinition,validateRollupProperties,aggregateRollupValues} from './rollup.js';

export { MAX_PAGE_LINKS, PageLinksError, isPageLinkBoundary, validatePageLinks, replacePageLinks, rebasePageLinks, removePageLinks, setPageLink, splitPageLinks, joinPageLinks } from './page-links.js';

export {ChartError,CHART_TYPES,CHART_AGGREGATIONS,CHART_UNAVAILABLE_REASONS,validateChartDefinition,chartInputsAvailable,aggregateChart,validateChartResult} from './charts.js';

export { importSourceText } from './import-source.js';
export * from './teamspaces.js';
export * from './groups.js';
export * from './board-order.js';
export * from './property-conversion.js';
