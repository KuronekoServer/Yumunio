import test from "node:test";
import assert from "node:assert/strict";
import { D1Store } from "../src/d1.js";
import { fakeD1, options, paragraph, errorCode } from "./helpers.js";

test("D1 binding-shaped adapter handles trigger-inclusive metadata and stale CAS", async t => {
  const binding = fakeD1(t);
  const db = new D1Store(binding, options());
  await db.createPage("workspace", { id: "root" });
  await db.createPage("workspace", { id: "child", parentId: "root" });
  const updated = await db.updateDocument("workspace", "root", { expectedVersion: 1, blocks: [paragraph("block", "Saved")] });
  assert.equal(updated.version, 2);
  assert.equal(binding.lastResults[0].meta.changes, 2);
  const savedPage = await db.getPage("workspace", "root");
  await assert.rejects(db.updateDocument("workspace", "root", { expectedVersion: 1, blocks: [] }), errorCode("VERSION_CONFLICT"));
  assert.equal(binding.lastResults[0].meta.changes, 0);
  assert.deepEqual(await db.getPage("workspace", "root"), savedPage);
  await db.trashPage("workspace", "root");
  assert.equal(binding.lastResults[0].meta.changes, 3);
  await db.restorePage("workspace", "root");
  assert.equal(binding.lastResults[0].meta.changes, 3);
  assert.equal((await db.getDocument("workspace", "root")).version, 4);
  assert.equal((await db.getDocument("workspace", "child")).version, 3);
});

test("D1 create uses one atomic batch and a failed document insert leaves no page", async t => {
  const binding = fakeD1(t, { failStatement: sql => sql.startsWith("INSERT INTO yumunio_documents") });
  const db = new D1Store(binding, options());
  await assert.rejects(db.createPage("workspace", { id: "page" }), errorCode("STORAGE_ERROR"));
  await assert.rejects(db.getPage("workspace", "page"), errorCode("NOT_FOUND"));
  assert.deepEqual(await db.listPages("workspace"), []);
  assert.equal(binding.calls[0].length, 3);
});

test("D1 prepares parameterized SQL and does not interpolate resource content", async t => {
  const binding = fakeD1(t);
  const db = new D1Store(binding, options());
  const title = "Robert'); DROP TABLE yumunio_pages; --";
  await db.createPage("workspace", { id: "page", title });
  assert.equal((await db.getPage("workspace", "page")).title, title);
  const statements = binding.calls.flat();
  assert.equal(statements.some(statement => statement.sql.includes(title)), false);
  assert.equal(statements.some(statement => statement.params.includes(title)), true);
  assert.throws(() => new D1Store({}), errorCode("INVALID_INPUT"));
});
