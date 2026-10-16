import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1SnapshotStore } from "./snapshot-store.js";

const schema = readFileSync(new URL("./snapshot-schema.sql", import.meta.url), "utf8");
const stamp = "2026-10-15T00:00:00.000Z";
const errorCode = code => error => error.name === "SnapshotError" && error.code === code;
const snapshot = (title = "Plan") => ({ schemaVersion: 1, name: "Workspace", updatedAt: stamp,
  ui: { recentPageIds: ["page"], lastRoute: "#page/page" }, pages: [{ id: "page", title,
    parentId: null, kind: "document", blocks: [{ id: "block", type: "paragraph", text: "Saved", checked: false }],
    deletedAt: null, createdAt: stamp, updatedAt: stamp }] });

/** Local D1 API-shaped binding using SQLite. This is not a Workers/D1 runtime. */
function binding(t, { failStatement, failPrepare = false } = {}) {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  database.exec(schema);
  t.after(() => database.close());
  const calls = [];
  return {
    database, calls,
    prepare(sql) {
      if (failPrepare) throw new Error("Private preparation failure");
      return { bind(...params) { return { sql, params }; } };
    },
    async batch(statements) {
      calls.push(statements);
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, params }) => {
          if (failStatement?.(sql)) throw new Error("Private batch failure");
          const before = database.prepare("SELECT total_changes() AS count").get().count;
          const rows = database.prepare(sql).all(...params);
          const after = database.prepare("SELECT total_changes() AS count").get().count;
          return { success: true, results: rows, meta: { changes: after - before } };
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("D1 snapshot read/write follows the single-workspace contract and saves UTC metadata", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b, { now: () => stamp });
  assert.deepEqual(await db.read(), { revision: 0, snapshot: null });
  const initial = snapshot();
  assert.deepEqual(await db.write(0, initial), { revision: 1, snapshot: initial });
  const revised = snapshot("Revised");
  assert.deepEqual(await db.write(1, revised), { revision: 2, snapshot: revised });
  assert.deepEqual(await db.read(), { revision: 2, snapshot: revised });
  const row = b.database.prepare("SELECT * FROM yumunio_prototype_snapshots").get();
  assert.equal(row.id, 1);
  assert.equal(row.updated_at, stamp);
});

test("expected zero only initializes an empty store, and a missing positive revision cannot create data", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b);
  await assert.rejects(db.write(3, snapshot()), error => errorCode("VERSION_CONFLICT")(error) && error.status === 409 && error.details.actualRevision === 0);
  assert.deepEqual(await db.read(), { revision: 0, snapshot: null });
  await db.write(0, snapshot("Original"));
  await assert.rejects(db.write(0, snapshot("Reset")), error => errorCode("VERSION_CONFLICT")(error) && error.details.actualRevision === 1);
  assert.equal((await db.read()).snapshot.pages[0].title, "Original");
});

test("simultaneous initial and stale updates each accept only one version", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b);
  const initial = await Promise.allSettled([db.write(0, snapshot("First")), db.write(0, snapshot("Second"))]);
  assert.equal(initial.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(initial.find(result => result.status === "rejected").reason.details.actualRevision, 1);
  const updated = await Promise.allSettled([db.write(1, snapshot("A")), db.write(1, snapshot("B"))]);
  assert.equal(updated.filter(result => result.status === "fulfilled").length, 1);
  const stale = updated.find(result => result.status === "rejected").reason;
  assert.equal(stale.code, "VERSION_CONFLICT");
  assert.equal(stale.status, 409);
  assert.equal(stale.details.actualRevision, 2);
  assert.equal((await db.read()).snapshot.pages[0].title, "A");
});

test("validated inputs are captured before await, and returned snapshots are independent", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b);
  const input = snapshot("Captured");
  const pending = db.write(0, input);
  input.pages[0].title = "Changed externally";
  const saved = await pending;
  assert.equal(saved.snapshot.pages[0].title, "Captured");
  saved.snapshot.pages[0].title = "Changed returned value";
  assert.equal((await db.read()).snapshot.pages[0].title, "Captured");
});

test("invalid expected revisions, snapshots, and clocks never alter stored data", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b);
  for (const expected of [-1, 1.5, "0", NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(db.write(expected, snapshot()), errorCode("INVALID_INPUT"));
  }
  await assert.rejects(db.write(0, { ...snapshot(), schemaVersion: 2 }), errorCode("INVALID_SNAPSHOT"));
  const badClock = new D1SnapshotStore(b, { now: () => "2026-02-30T00:00:00.000Z" });
  await assert.rejects(badClock.write(0, snapshot()), errorCode("INVALID_INPUT"));
  assert.deepEqual(await db.read(), { revision: 0, snapshot: null });
});

test("single-row identity and version limits cannot be bypassed by snapshot CAS", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b);
  await db.write(0, snapshot());
  assert.throws(() => b.database.prepare("INSERT INTO yumunio_prototype_snapshots(id,revision,payload_json,updated_at) VALUES (?,?,?,?)")
    .run(2, 1, "{}", stamp), /CHECK constraint/);
  b.database.prepare("UPDATE yumunio_prototype_snapshots SET revision = ? WHERE id = 1").run(Number.MAX_SAFE_INTEGER);
  await assert.rejects(db.write(Number.MAX_SAFE_INTEGER, snapshot("Overflow")), error => errorCode("VERSION_CONFLICT")(error) && error.details.actualRevision === Number.MAX_SAFE_INTEGER);
  assert.equal((await db.read()).snapshot.pages[0].title, "Plan");
});

test("snapshot payloads remain bound values rather than SQL text", async t => {
  const b = binding(t);
  const db = new D1SnapshotStore(b);
  const title = "Robert'); DROP TABLE yumunio_prototype_snapshots; --";
  await db.write(0, snapshot(title));
  assert.equal((await db.read()).snapshot.pages[0].title, title);
  assert.equal(b.calls.flat().some(statement => statement.sql.includes(title)), false);
  assert.equal(b.calls.flat().some(statement => statement.params.some(value => typeof value === "string" && value.includes(title))), true);
});

test("failed batches roll back the UPSERT and sanitize database errors", async t => {
  const b = binding(t, { failStatement: sql => sql.startsWith("SELECT revision") });
  const db = new D1SnapshotStore(b);
  await assert.rejects(db.write(0, snapshot()), error => errorCode("STORAGE_ERROR")(error) && error.status === 500 && !error.message.includes("Private"));
  assert.equal(b.database.prepare("SELECT COUNT(*) AS count FROM yumunio_prototype_snapshots").get().count, 0);
});

test("preparation failures and invalid stored snapshots are sanitized storage errors", async t => {
  const b = binding(t, { failPrepare: true });
  const failed = new D1SnapshotStore(b);
  await assert.rejects(failed.read(), errorCode("STORAGE_ERROR"));
  const valid = binding(t);
  valid.database.prepare("INSERT INTO yumunio_prototype_snapshots(id,revision,payload_json,updated_at) VALUES (?,?,?,?)").run(1, 1, "{}", stamp);
  await assert.rejects(new D1SnapshotStore(valid).read(), errorCode("STORAGE_ERROR"));
  assert.throws(() => new D1SnapshotStore({}), errorCode("INVALID_INPUT"));
});
