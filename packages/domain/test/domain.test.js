import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainError, assertId, assertJsonSerializable, validateBlocks,
  validateCollection, validateDocument, validatePage,
  validatePropertyDefinitions, validatePropertyValue, validatePropertyValues,
} from "../src/index.js";

const invalid = error => error instanceof DomainError && error.code === "INVALID_INPUT";
const stamp = "2026-10-15T00:00:00.000Z";
const property = (type, extra = {}) => ({ id: "value", name: "Value", type, ...extra });

test("stable IDs reject empty, path-like, Unicode, and oversized values", () => {
  for (const id of ["", "../page", "page/child", " page", "ページ", "_first", "a".repeat(129), null, 4]) {
    assert.throws(() => assertId(id), invalid);
  }
  assert.equal(assertId("page.1:part_a-b"), "page.1:part_a-b");
});

test("JSON validation rejects lossy values and never invokes getters", () => {
  let invoked = false;
  const getter = Object.defineProperty({}, "text", { enumerable: true, get() { invoked = true; return "secret"; } });
  const symbol = { [Symbol("private")]: "value" };
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  const circular = {};
  circular.self = circular;
  const extraArray = [1];
  extraArray.extra = 2;
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), { nested: undefined },
    getter, symbol, hidden, circular, new Array(2), extraArray]) {
    assert.throws(() => assertJsonSerializable(value), invalid);
  }
  assert.equal(invoked, false);
  const shared = { text: "same value" };
  assert.doesNotThrow(() => assertJsonSerializable({ left: shared, right: shared, empty: [], nil: null }));
});

test("JSON depth limits bound nested payload validation", () => {
  let payload = null;
  for (let index = 0; index < 66; index++) payload = { child: payload };
  assert.throws(() => assertJsonSerializable(payload), invalid);
});

test("blocks support independent JSON payloads and reject duplicate IDs across the tree", () => {
  const blocks = [{ id: "parent", type: "paragraph", content: "Hello", data: { text: "Hello", marks: [{ start: 0, end: 5, styles: ["bold"] }], independent: true },
    children: [{ id: "child", type: "custom_widget", data: { value: 2 } }] }];
  assert.equal(validateBlocks(blocks), blocks);
  assert.throws(() => validateBlocks([{ id: "same", type: "paragraph", children: [{ id: "same", type: "text" }] }]), invalid);
  assert.throws(() => validateBlocks([{ id: "one", type: "text", children: null }]), invalid);
  assert.throws(() => validateBlocks([{ id: "one", type: "text", data: [] }]), invalid);
});

test("page and document metadata require explicit scope, canonical dates, and positive versions", () => {
  const page = { id: "page", workspaceId: "workspace", title: "", parentId: null,
    createdAt: stamp, updatedAt: stamp, trashedAt: null };
  assert.doesNotThrow(() => validatePage(page));
  assert.throws(() => validatePage({ ...page, parentId: "page" }), error => error.code === "HIERARCHY_CYCLE");
  assert.throws(() => validatePage({ ...page, updatedAt: "2026-02-30T00:00:00.000Z" }), invalid);
  assert.throws(() => validatePage({ ...page, workspaceId: undefined }), invalid);
  const document = { pageId: "page", workspaceId: "workspace", version: 1, blocks: [], updatedAt: stamp };
  assert.doesNotThrow(() => validateDocument(document));
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.throws(() => validateDocument({ ...document, version }), invalid);
  }
});

test("typed values reject coercion, invalid dates, unknown options, and duplicate relations", () => {
  const cases = [
    [property("text"), "text", 4],
    [property("number"), 3.25, "3.25"],
    [property("checkbox"), false, 0],
    [property("date"), "2024-02-29", "2026-02-30"],
    [property("select", { options: ["Todo", "Done"] }), "Done", "Unknown"],
    [property("multi_select", { options: ["A", "B"] }), ["A", "B"], ["A", "A"]],
    [property("person"), "member-a", "invalid/id"],
    [property("relation"), ["record-a", "record-b"], ["record-a", "record-a"]],
  ];
  for (const [definition, good, bad] of cases) {
    assert.deepEqual(validatePropertyValue(definition, good), good);
    assert.throws(() => validatePropertyValue(definition, bad), invalid);
  }
});

test("required fields distinguish valid false or zero from missing and empty values", () => {
  assert.equal(validatePropertyValue(property("checkbox", { required: true }), false), false);
  assert.equal(validatePropertyValue(property("number", { required: true }), 0), 0);
  for (const value of [null, undefined, ""]) {
    assert.throws(() => validatePropertyValue(property("text", { required: true }), value), invalid);
  }
  assert.throws(() => validatePropertyValue(property("relation", { required: true }), []), invalid);
  assert.equal(validatePropertyValue(property("text"), undefined), null);
});

test("definitions and records reject unknown fields and inherited property values", () => {
  assert.throws(() => validatePropertyDefinitions([property("formula")]), invalid);
  assert.throws(() => validatePropertyDefinitions([property("text", { options: ["A"] })]), invalid);
  assert.throws(() => validatePropertyDefinitions([property("select", { options: ["A", "A"] })]), invalid);
  assert.throws(() => validatePropertyDefinitions([property("text"), property("number")]), invalid);
  assert.throws(() => validatePropertyValues([property("text")], { other: "value" }), invalid);
  const reserved = [{ id: "constructor", name: "Constructor", type: "text" }];
  assert.doesNotThrow(() => validatePropertyValues(reserved, {}));
  assert.doesNotThrow(() => validatePropertyValues(reserved, { constructor: "Own value" }));
  assert.throws(() => validatePropertyValues([{ ...reserved[0], required: true }], {}), invalid);
});

test("collection schema validation rejects duplicate records before accepting a snapshot", () => {
  const collection = { id: "collection", workspaceId: "workspace", title: "Tasks",
    properties: [property("number")], records: [{ id: "row", values: { value: 1 } }],
    createdAt: stamp, updatedAt: stamp };
  assert.doesNotThrow(() => validateCollection(collection));
  assert.throws(() => validateCollection({ ...collection, records: [...collection.records, ...collection.records] }), invalid);
  assert.throws(() => validateCollection({ ...collection, records: [{ id: "row", values: { value: "1" } }] }), invalid);
});
