import test from "node:test";
import assert from "node:assert/strict";
import { fixture, paragraph, properties, record, errorCode } from "./helpers.js";

test("SQLite schema is accepted and survives constructor migration replay", async t => {
  const f = fixture(t);
  const db = f.open();
  await db.createPage("workspace", { id: "page", title: "Persistent", blocks: [paragraph("block", "Saved")] });
  const document = await db.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [paragraph("block", "Revised")] });
  await db.createCollection("workspace", { id: "collection", properties, records: [record()] });
  f.close(db);
  const reopened = f.open();
  assert.equal((await reopened.getPage("workspace", "page")).title, "Persistent");
  assert.deepEqual(await reopened.getDocument("workspace", "page"), document);
  assert.equal((await reopened.getCollection("workspace", "collection")).records[0].values.points, 3);
  assert.equal(f.raw().prepare("SELECT COUNT(*) AS count FROM yumunio_schema_migrations").get().count, 1);
});

test("document CAS across two SQLite connections rejects the stale writer without touching page metadata", async t => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  await first.createPage("workspace", { id: "page" });
  const results = await Promise.allSettled([
    first.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [paragraph("first", "A")] }),
    second.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [paragraph("second", "B")] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "VERSION_CONFLICT");
  const saved = await first.getDocument("workspace", "page");
  const page = await first.getPage("workspace", "page");
  await assert.rejects(second.updateDocument("workspace", "page", { expectedVersion: 1, blocks: [] }), errorCode("VERSION_CONFLICT"));
  assert.deepEqual(await first.getDocument("workspace", "page"), saved);
  assert.deepEqual(await first.getPage("workspace", "page"), page);
});

test("all SQL resources and parent references remain workspace-scoped", async t => {
  const f = fixture(t);
  const db = f.open();
  await db.createPage("a", { id: "same", title: "A" });
  await db.createPage("b", { id: "same", title: "B" });
  await db.createPage("a", { id: "only-a" });
  await db.createCollection("a", { id: "collection", title: "A" });
  await db.createCollection("b", { id: "collection", title: "B" });
  await assert.rejects(db.createPage("b", { id: "child", parentId: "only-a" }), errorCode("NOT_FOUND"));
  await assert.rejects(db.updateDocument("b", "only-a", { expectedVersion: 1, blocks: [] }), errorCode("NOT_FOUND"));
  await assert.rejects(db.trashPage("b", "only-a"), errorCode("NOT_FOUND"));
  assert.equal((await db.getPage("a", "same")).title, "A");
  assert.equal((await db.getPage("b", "same")).title, "B");
  await db.deleteCollection("a", "collection");
  assert.equal((await db.getCollection("b", "collection")).title, "B");
  const raw = f.raw();
  assert.throws(() => raw.prepare("UPDATE yumunio_pages SET parent_id = ? WHERE workspace_id = ? AND id = ?").run("only-a", "b", "same"), /YUMUNIO_NOT_FOUND/);
  assert.deepEqual(await db.listCollections("a"), []);
});

test("SQL triggers reject crossed concurrent parent changes and direct-SQL cycles", async t => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  await first.createPage("workspace", { id: "a" });
  await first.createPage("workspace", { id: "b" });
  const results = await Promise.allSettled([
    first.updatePage("workspace", "a", { parentId: "b" }),
    second.updatePage("workspace", "b", { parentId: "a" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "HIERARCHY_CYCLE");
  const a = await first.getPage("workspace", "a");
  const b = await first.getPage("workspace", "b");
  assert.equal(a.parentId === "b" && b.parentId === "a", false);
  const raw = f.raw();
  const child = a.parentId === "b" ? "a" : "b";
  const parent = child === "a" ? "b" : "a";
  assert.throws(() => raw.prepare("UPDATE yumunio_pages SET parent_id = ? WHERE workspace_id = ? AND id = ?").run(child, "workspace", parent), /YUMUNIO_HIERARCHY_CYCLE/);
  assert.throws(() => raw.prepare("UPDATE yumunio_pages SET parent_id = ? WHERE workspace_id = ? AND id = ?").run(parent, "workspace", parent), /YUMUNIO_HIERARCHY_CYCLE/);
});

test("trash/restore bumps all descendant documents, preserves independent trash, and persists recovery", async t => {
  const f = fixture(t);
  const db = f.open();
  await db.createPage("workspace", { id: "root" });
  const child = await db.createPage("workspace", { id: "child", parentId: "root", blocks: [paragraph("block", "Keep")] });
  await db.createPage("workspace", { id: "independent", parentId: "root" });
  await db.trashPage("workspace", "independent");
  await db.trashPage("workspace", "root");
  assert.equal((await db.listPages("workspace")).length, 0);
  await assert.rejects(db.getDocument("workspace", "child"), errorCode("NOT_FOUND"));
  assert.equal((await db.getDocument("workspace", "child", { includeTrashed: true })).version, 2);
  await assert.rejects(db.restorePage("workspace", "child"), errorCode("DESTINATION_UNAVAILABLE"));
  await db.restorePage("workspace", "root");
  assert.equal((await db.getDocument("workspace", "child")).version, 3);
  assert.equal((await db.getPage("workspace", "child")).updatedAt, child.updatedAt);
  await assert.rejects(db.updateDocument("workspace", "child", { expectedVersion: 1, blocks: [] }), errorCode("VERSION_CONFLICT"));
  await assert.rejects(db.getPage("workspace", "independent"), errorCode("NOT_FOUND"));
  await db.restorePage("workspace", "independent");
  f.close(db);
  const reopened = f.open();
  assert.equal((await reopened.getDocument("workspace", "child")).blocks[0].data.text, "Keep");
  assert.equal((await reopened.listPages("workspace")).length, 3);
});

test("a version-limit failure rolls back the complete subtree trash transition", async t => {
  const f = fixture(t);
  const db = f.open();
  await db.createPage("workspace", { id: "root" });
  await db.createPage("workspace", { id: "child", parentId: "root" });
  const raw = f.raw();
  raw.exec("BEGIN IMMEDIATE");
  raw.prepare("DELETE FROM yumunio_documents WHERE workspace_id = ? AND page_id = ?").run("workspace", "child");
  raw.prepare("INSERT INTO yumunio_documents(workspace_id,page_id,version,blocks_json,updated_at) VALUES (?,?,?,?,?)")
    .run("workspace", "child", Number.MAX_SAFE_INTEGER, "[]", "2026-10-15T00:00:00.000Z");
  raw.exec("COMMIT");
  await assert.rejects(db.trashPage("workspace", "root"), errorCode("VERSION_CONFLICT"));
  assert.equal((await db.getPage("workspace", "root")).trashedAt, null);
  assert.equal((await db.getDocument("workspace", "root")).version, 1);
  assert.equal((await db.getDocument("workspace", "child")).version, Number.MAX_SAFE_INTEGER);
});

test("invalid typed snapshots reject without changing a collection; concurrent patches preserve separate fields", async t => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  const saved = await first.createCollection("workspace", { id: "collection", title: "Old", properties, records: [record()] });
  await assert.rejects(first.updateCollection("workspace", "collection", { records: [record({ points: "3" })] }), errorCode("INVALID_INPUT"));
  await assert.rejects(first.updateCollection("workspace", "collection", { properties: properties.filter(property => property.id !== "points") }), errorCode("INVALID_INPUT"));
  assert.deepEqual(await first.getCollection("workspace", "collection"), saved);
  await Promise.all([
    first.updateCollection("workspace", "collection", { title: "New" }),
    second.updateCollection("workspace", "collection", { records: [record({ points: 4 })] }),
  ]);
  const updated = await first.getCollection("workspace", "collection");
  assert.equal(updated.title, "New");
  assert.equal(updated.records[0].values.points, 4);
});

test("concurrent collection schema/record changes cannot commit an invalid combination", async t => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  await first.createCollection("workspace", { id: "collection", properties, records: [record()] });
  const changed = properties.map(property => property.id === "points" ? { ...property, type: "text" } : property);
  const results = await Promise.allSettled([
    first.updateCollection("workspace", "collection", { properties: changed, records: [record({ points: "Adjusted" })] }),
    second.updateCollection("workspace", "collection", { records: [record({ points: 4 })] }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  const saved = await first.getCollection("workspace", "collection");
  assert.equal(saved.properties.find(property => property.id === "points").type, "text");
  assert.equal(saved.records[0].values.points, "Adjusted");
  if (results[1].status === "rejected") assert.equal(results[1].reason.code, "INVALID_INPUT");
});

test("titles and JSON are bound SQL values; invalid IDs and duplicate keys retain domain errors", async t => {
  const f = fixture(t);
  const db = f.open();
  const title = "Robert'); DROP TABLE yumunio_pages; --";
  await db.createPage("workspace", { id: "page", title, blocks: [paragraph("block", title)] });
  assert.equal((await db.getPage("workspace", "page")).title, title);
  assert.equal((await db.getDocument("workspace", "page")).blocks[0].data.text, title);
  await assert.rejects(db.getPage("workspace", undefined), errorCode("INVALID_INPUT"));
  await assert.rejects(db.getDocument("workspace", undefined), errorCode("INVALID_INPUT"));
  await assert.rejects(db.createPage("workspace", { id: "page" }), errorCode("ALREADY_EXISTS"));
  assert.equal((await db.listPages("workspace")).length, 1);
});

test("async patches capture caller input before the first database await", async t => {
  const f = fixture(t);
  const db = f.open();
  await db.createPage("workspace", { id: "page" });
  await db.createCollection("workspace", { id: "collection", properties, records: [record()] });
  const pagePatch = { title: "Captured" };
  const pageUpdate = db.updatePage("workspace", "page", pagePatch);
  pagePatch.title = "Changed externally";
  assert.equal((await pageUpdate).title, "Captured");
  const collectionPatch = { records: [record({ points: 4 })] };
  const collectionUpdate = db.updateCollection("workspace", "collection", collectionPatch);
  collectionPatch.records[0].values.points = 99;
  assert.equal((await collectionUpdate).records[0].values.points, 4);
  await db.trashPage("workspace", "page");
  const restorePatch = { title: "Recovered" };
  const restore = db.restorePage("workspace", "page", restorePatch);
  restorePatch.title = "Changed externally";
  assert.equal((await restore).title, "Recovered");
});
