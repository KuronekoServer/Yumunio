import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@yumunio/domain";
import { InMemoryStore } from "../src/index.js";

const errorCode = code => error => error instanceof DomainError && error.code === code;
const store = () => {
  let tick = 0;
  let nextId = 0;
  return new InMemoryStore({ now: () => new Date(Date.UTC(2026, 9, 15, 0, 0, tick++)).toISOString(),
    createId: () => "generated-" + (++nextId) });
};
const paragraph = (id, text) => ({ id, type: "paragraph", data: { text } });
const properties = [
  { id: "title", name: "Title", type: "text", required: true },
  { id: "points", name: "Points", type: "number" },
  { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
  { id: "date", name: "Date", type: "date" },
];
const record = (values = {}) => ({ id: "record-1", values: { title: "Plan", points: 3, status: "Todo", ...values } });

test("page creation initializes a scoped version-one document and isolated snapshots", async () => {
  const db = store();
  const blocks = [paragraph("block-1", "Original")];
  const page = await db.createPage("workspace-a", { id: "page-a", title: "Title", blocks });
  blocks[0].data.text = "Changed externally";
  page.title = "Changed externally";
  const document = await db.getDocument("workspace-a", "page-a");
  assert.equal(document.version, 1);
  assert.equal(document.workspaceId, "workspace-a");
  assert.equal(document.pageId, "page-a");
  assert.equal(document.blocks[0].data.text, "Original");
  document.blocks[0].data.text = "Changed returned value";
  assert.equal((await db.getDocument("workspace-a", "page-a")).blocks[0].data.text, "Original");
  assert.equal((await db.getPage("workspace-a", "page-a")).title, "Title");
  assert.equal((await db.createPage("workspace-a")).id, "generated-1");
});

test("concurrent same-version updates commit exactly one snapshot and reject stale CAS", async () => {
  const db = store();
  await db.createPage("workspace", { id: "page" });
  const results = await Promise.allSettled([
    db.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [paragraph("first", "A")] }),
    db.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [paragraph("second", "B")] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "VERSION_CONFLICT");
  assert.equal(rejected.reason.details.actualVersion, 2);
  const saved = await db.getDocument("workspace", "page");
  assert.equal(saved.version, 2);
  assert.equal(saved.blocks[0].id, "first");
  await assert.rejects(db.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [] }), errorCode("VERSION_CONFLICT"));
  assert.deepEqual(await db.getDocument("workspace", "page"), saved);
});

test("page and document operations cannot cross workspace scopes", async () => {
  const db = store();
  await db.createPage("a", { id: "shared-id", title: "A" });
  await db.createPage("b", { id: "shared-id", title: "B" });
  await db.createPage("a", { id: "only-a" });
  assert.equal((await db.getPage("a", "shared-id")).title, "A");
  assert.equal((await db.getPage("b", "shared-id")).title, "B");
  for (const request of [
    db.getPage("b", "only-a"), db.getDocument("b", "only-a"),
    db.updatePage("b", "only-a", { title: "Intrusion" }), db.trashPage("b", "only-a"),
    db.restorePage("b", "only-a"), db.updateDocument("b", "only-a", { expectedVersion: 1, blocks: [] }),
    db.createPage("b", { id: "child", parentId: "only-a" }),
  ]) await assert.rejects(request, errorCode("NOT_FOUND"));
  assert.equal((await db.getPage("a", "only-a")).trashedAt, null);
  assert.equal((await db.listPages("b")).length, 1);
  assert.deepEqual(await db.listPages("unknown"), []);
});

test("hierarchy updates reject direct and transitive cycles without changing parents", async () => {
  const db = store();
  await db.createPage("workspace", { id: "root" });
  await db.createPage("workspace", { id: "child", parentId: "root" });
  await db.createPage("workspace", { id: "grandchild", parentId: "child" });
  await assert.rejects(db.createPage("workspace", { id: "self", parentId: "self" }), errorCode("HIERARCHY_CYCLE"));
  await assert.rejects(db.updatePage("workspace", "root", { parentId: "root" }), errorCode("HIERARCHY_CYCLE"));
  await assert.rejects(db.updatePage("workspace", "root", { parentId: "grandchild" }), errorCode("HIERARCHY_CYCLE"));
  assert.equal((await db.getPage("workspace", "root")).parentId, null);
  assert.equal((await db.listPages("workspace", { parentId: "root" }))[0].id, "child");
  await db.updatePage("workspace", "grandchild", { parentId: null });
  assert.equal((await db.listPages("workspace", { parentId: null })).length, 2);
});

test("trash hides descendants and invalidates pre-trash document versions after restore", async () => {
  const db = store();
  await db.createPage("workspace", { id: "root" });
  await db.createPage("workspace", { id: "child", parentId: "root", blocks: [paragraph("block", "Saved")] });
  await db.trashPage("workspace", "root");
  await assert.rejects(db.getPage("workspace", "child"), errorCode("NOT_FOUND"));
  await assert.rejects(db.getDocument("workspace", "child"), errorCode("NOT_FOUND"));
  await assert.rejects(db.updateDocument("workspace", "child", { expectedVersion: 2, blocks: [] }), errorCode("NOT_FOUND"));
  assert.equal((await db.listPages("workspace")).length, 0);
  assert.equal((await db.listPages("workspace", { includeTrashed: true })).length, 2);
  assert.equal((await db.getDocument("workspace", "child", { includeTrashed: true })).version, 2);
  await db.restorePage("workspace", "root");
  const document = await db.getDocument("workspace", "child");
  assert.equal(document.version, 3);
  assert.equal(document.blocks[0].data.text, "Saved");
  await assert.rejects(db.updateDocument("workspace", "child", { expectedVersion: 1, blocks: [] }), errorCode("VERSION_CONFLICT"));
  assert.equal((await db.listPages("workspace")).length, 2);
});

test("parent restore preserves an independently trashed child; repeated trash is idempotent", async () => {
  const db = store();
  await db.createPage("workspace", { id: "root" });
  await db.createPage("workspace", { id: "child", parentId: "root" });
  await db.trashPage("workspace", "child");
  const initial = await db.getDocument("workspace", "child", { includeTrashed: true });
  await db.trashPage("workspace", "child");
  assert.deepEqual(await db.getDocument("workspace", "child", { includeTrashed: true }), initial);
  await db.trashPage("workspace", "root");
  await db.restorePage("workspace", "root");
  await assert.rejects(db.getPage("workspace", "child"), errorCode("NOT_FOUND"));
  assert.notEqual((await db.getPage("workspace", "child", { includeTrashed: true })).trashedAt, null);
  await db.restorePage("workspace", "child");
  assert.equal((await db.getPage("workspace", "child")).parentId, "root");
});

test("a child under a trashed parent requires an available explicit restore destination", async () => {
  const db = store();
  await db.createPage("workspace", { id: "root" });
  await db.createPage("workspace", { id: "child", parentId: "root" });
  await db.trashPage("workspace", "root");
  await assert.rejects(db.restorePage("workspace", "child"), errorCode("DESTINATION_UNAVAILABLE"));
  await assert.rejects(db.createPage("workspace", { id: "new-child", parentId: "root" }), errorCode("DESTINATION_UNAVAILABLE"));
  const restored = await db.restorePage("workspace", "child", { parentId: null, title: "Recovered" });
  assert.equal(restored.parentId, null);
  assert.equal(restored.title, "Recovered");
  assert.equal((await db.listPages("workspace")).length, 1);
  await assert.rejects(db.restorePage("workspace", "child"), errorCode("INVALID_INPUT"));
});

test("invalid document payloads and immutable field injections do not mutate snapshots", async () => {
  const db = store();
  await db.createPage("workspace", { id: "page", blocks: [paragraph("one", "Saved")] });
  const before = await db.getDocument("workspace", "page");
  await assert.rejects(db.updateDocument("workspace", "page", { expectedVersion: 1,
    blocks: [{ id: "duplicate", type: "text" }, { id: "duplicate", type: "text" }] }), errorCode("INVALID_INPUT"));
  await assert.rejects(db.updatePage("workspace", "page", { workspaceId: "other" }), errorCode("INVALID_INPUT"));
  await assert.rejects(db.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [], workspaceId: "other" }), errorCode("INVALID_INPUT"));
  assert.deepEqual(await db.getDocument("workspace", "page"), before);
  assert.equal((await db.getPage("workspace", "page")).workspaceId, "workspace");
});

test("invalid collection values and schema changes reject atomically", async () => {
  const db = store();
  for (const values of [{ points: "3" }, { status: "Missing" }, { date: "2026-02-30" }, { title: "" }, { extra: "unknown" }]) {
    await assert.rejects(db.createCollection("workspace", { id: "collection", properties, records: [record(values)] }), errorCode("INVALID_INPUT"));
  }
  assert.deepEqual(await db.listCollections("workspace"), []);
  const saved = await db.createCollection("workspace", { id: "collection", title: "Tasks", properties, records: [record()] });
  await assert.rejects(db.updateCollection("workspace", "collection", { records: [record({ points: "3" })] }), errorCode("INVALID_INPUT"));
  await assert.rejects(db.updateCollection("workspace", "collection", { properties: properties.filter(item => item.id !== "points") }), errorCode("INVALID_INPUT"));
  assert.deepEqual(await db.getCollection("workspace", "collection"), saved);
  const updated = await db.updateCollection("workspace", "collection", { records: [record({ points: 4, status: "Done" })] });
  assert.equal(updated.records[0].values.points, 4);
});

test("collection CRUD is workspace-scoped and returned snapshots cannot alter storage", async () => {
  const db = store();
  const input = { id: "collection", properties, records: [record()] };
  await db.createCollection("a", input);
  await db.createCollection("b", { id: "collection", title: "B" });
  input.records[0].values.points = 99;
  const collection = await db.getCollection("a", "collection");
  assert.equal(collection.records[0].values.points, 3);
  collection.records[0].values.points = 42;
  const listed = await db.listCollections("a");
  listed[0].properties[0].name = "Changed";
  assert.equal((await db.getCollection("a", "collection")).records[0].values.points, 3);
  assert.equal((await db.getCollection("a", "collection")).properties[0].name, "Title");
  await assert.rejects(db.getCollection("c", "collection"), errorCode("NOT_FOUND"));
  await assert.rejects(db.updateCollection("c", "collection", { title: "Other" }), errorCode("NOT_FOUND"));
  await assert.rejects(db.deleteCollection("c", "collection"), errorCode("NOT_FOUND"));
  await db.deleteCollection("a", "collection");
  assert.deepEqual(await db.listCollections("a"), []);
  assert.equal((await db.getCollection("b", "collection")).title, "B");
});

test("explicit invalid defaults, duplicate IDs, and malformed scope/options reject", async () => {
  const db = store();
  for (const input of [{ id: null }, { title: null }, { blocks: null }, { parentId: undefined }]) {
    await assert.rejects(db.createPage("workspace", input), errorCode("INVALID_INPUT"));
  }
  for (const input of [{ id: null }, { title: null }, { properties: null }, { records: null }]) {
    await assert.rejects(db.createCollection("workspace", input), errorCode("INVALID_INPUT"));
  }
  assert.deepEqual(await db.listPages("workspace"), []);
  await db.createPage("workspace", { id: "page" });
  await db.createCollection("workspace", { id: "collection" });
  await assert.rejects(db.createPage("workspace", { id: "page" }), errorCode("ALREADY_EXISTS"));
  await assert.rejects(db.createCollection("workspace", { id: "collection" }), errorCode("ALREADY_EXISTS"));
  await assert.rejects(db.listPages("../workspace"), errorCode("INVALID_INPUT"));
  await assert.rejects(db.getPage("workspace", "page", { includeTrashed: "true" }), errorCode("INVALID_INPUT"));
  await assert.rejects(db.listPages("workspace", { unknown: true }), errorCode("INVALID_INPUT"));
});

test("a failing clock cannot partially replace a stored document", async () => {
  let failClock = false;
  const db = new InMemoryStore({ now: () => failClock ? "bad-date" : "2026-10-15T00:00:00.000Z" });
  await db.createPage("workspace", { id: "page", blocks: [paragraph("saved", "Saved")] });
  const document = await db.getDocument("workspace", "page");
  failClock = true;
  await assert.rejects(db.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [] }), errorCode("INVALID_INPUT"));
  await assert.rejects(db.trashPage("workspace", "page"), errorCode("INVALID_INPUT"));
  assert.deepEqual(await db.getDocument("workspace", "page"), document);
  assert.equal((await db.getPage("workspace", "page")).trashedAt, null);
});
