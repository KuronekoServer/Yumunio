import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "@yumunio/storage";
import { D1Store } from "../src/d1.js";
import { fixture, fakeD1, options, paragraph, properties, record, errorCode } from "./helpers.js";

const normalized = value => {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ["createdAt", "updatedAt", "trashedAt"].includes(key) && item !== null ? "timestamp" : normalized(item)]));
};
async function scenario(db) {
  await db.createPage("a", { id: "root", title: "Plan", blocks: [paragraph("root-block", "Initial")] });
  await db.createPage("a", { id: "child", parentId: "root" });
  await db.createPage("b", { id: "root", title: "Other" });
  await db.updatePage("a", "child", { title: "Child" });
  await db.updateDocument("a", "root", { expectedVersion: 1, blocks: [paragraph("root-block", "Updated")] });
  await db.createCollection("a", { id: "collection", title: "Tasks", properties, records: [record()] });
  const collection = await db.updateCollection("a", "collection", { title: "Roadmap", records: [record({ points: 4, status: "Done" })] });
  await db.trashPage("a", "child");
  const trashed = await db.getDocument("a", "child", { includeTrashed: true });
  await db.trashPage("a", "child");
  assert.deepEqual(await db.getDocument("a", "child", { includeTrashed: true }), trashed);
  await db.trashPage("a", "root");
  assert.deepEqual(await db.listPages("a"), []);
  await assert.rejects(db.getDocument("a", "child"), errorCode("NOT_FOUND"));
  await db.restorePage("a", "root");
  await assert.rejects(db.getPage("a", "child"), errorCode("NOT_FOUND"));
  await db.restorePage("a", "child", { parentId: null });
  await assert.rejects(db.restorePage("a", "child"), errorCode("INVALID_INPUT"));
  await assert.rejects(db.getDocument("b", "child"), errorCode("NOT_FOUND"));
  await assert.rejects(db.updateDocument("a", "root", { expectedVersion: 1, blocks: [] }), errorCode("VERSION_CONFLICT"));
  await assert.rejects(db.updateCollection("a", "collection", { records: [record({ points: "4" })] }), errorCode("INVALID_INPUT"));
  await assert.rejects(db.getPage("a", undefined), errorCode("INVALID_INPUT"));
  await db.deleteCollection("a", "collection");
  return normalized({ pagesA: await db.listPages("a"), pagesB: await db.listPages("b"),
    document: await db.getDocument("a", "root"), childDocument: await db.getDocument("a", "child"),
    collection, collections: await db.listCollections("a") });
}

for (const [name, factory] of [
  ["SQLite", t => fixture(t).open(options())],
  ["D1 binding-shaped fake", t => new D1Store(fakeD1(t), options())],
]) {
  test(name + " matches the reference WorkspaceStore shapes and recovery semantics", async t => {
    const expected = await scenario(new InMemoryStore(options()));
    assert.deepEqual(await scenario(factory(t)), expected);
  });
}
