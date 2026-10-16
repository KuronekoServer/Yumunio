import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/sqlite.js";

export const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
export const errorCode = code => error => error?.name === "DomainError" && error.code === code;
export const paragraph = (id, text) => ({ id, type: "paragraph", data: { text } });
export const properties = [
  { id: "title", name: "Title", type: "text", required: true },
  { id: "points", name: "Points", type: "number" },
  { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
];
export const record = (extra = {}) => ({ id: "record", values: { title: "Plan", points: 3, status: "Todo", ...extra } });
export function options() {
  let tick = 0;
  let id = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 15, 0, 0, tick++)).toISOString(), createId: () => "generated-" + (++id) };
}

/** Only the exact named test directory is recursively removed, after all handles close. */
export function fixture(t) {
  const parent = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(parent, "yumunio-adapters-")));
  const handles = new Set();
  const filename = join(directory, "store.sqlite");
  const track = handle => { handles.add(handle); return handle; };
  t.after(() => {
    for (const handle of handles) handle.close();
    handles.clear();
    const checked = realpathSync(directory);
    const child = relative(parent, checked);
    if (resolve(checked) !== resolve(directory) || !child || child.startsWith("..") || isAbsolute(child) || !basename(checked).startsWith("yumunio-adapters-")) {
      throw new Error("Refusing cleanup outside the exact named test directory.");
    }
    rmSync(checked, { recursive: true, force: true });
  });
  return {
    filename,
    open: (config = options()) => track(new SqliteStore(filename, config)),
    raw: () => track(new DatabaseSync(filename, { enableForeignKeyConstraints: true })),
    track,
    close: handle => { handle.close(); handles.delete(handle); },
  };
}

/** Local API-shaped fake backed by SQLite, not a D1 runtime. */
export function fakeD1(t, { failStatement } = {}) {
  const f = fixture(t);
  const database = f.raw();
  database.exec(schema);
  const calls = [];
  const binding = {
    calls,
    prepare(sql) {
      return { bind(...params) { return { sql, params }; } };
    },
    async batch(statements) {
      calls.push(statements.map(statement => ({ ...statement, params: [...statement.params] })));
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, params }) => {
          if (failStatement?.(sql)) throw new Error("Injected local binding failure");
          const before = database.prepare("SELECT total_changes() AS count").get().count;
          const rows = database.prepare(sql).all(...params);
          const after = database.prepare("SELECT total_changes() AS count").get().count;
          return { success: true, results: rows, meta: { changes: after - before } };
        });
        database.exec("COMMIT");
        binding.lastResults = results;
        return results;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw new Error("D1_ERROR: " + error.message);
      }
    },
  };
  return binding;
}
