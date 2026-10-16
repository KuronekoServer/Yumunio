import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../worker.js";
import { createDemoWorkspace } from "../../web/public/store.js";

const origin = "https://workspace.test";
const accessKey = "fixture-worker-" + "A".repeat(32);
const schema = readFileSync(new URL("../snapshot-schema.sql", import.meta.url), "utf8");

/** Real worker.fetch entry point, with a local SQLite D1-shaped binding rather than workerd. */
function fixture(t, { database = true, migration = true, key = accessKey, publicOrigin } = {}) {
  const queries = [];
  const assetRequests = [];
  const env = { ASSETS: { async fetch(request) {
    assetRequests.push(request.url);
    throw new Error("API requests must not reach static assets.");
  } } };
  let db;
  if (database) {
    db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    t.after(() => db.close());
    if (migration) db.exec(schema);
    env.DB = {
      prepare(sql) { return { bind(...params) { return { sql, params, async all() { return { success: true, results: db.prepare(sql).all(...params), meta: {} }; } }; } }; },
      async batch(statements) {
        queries.push(statements);
        db.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map(({ sql, params }) => {
            const before = db.prepare("SELECT total_changes() AS count").get().count;
            const rows = db.prepare(sql).all(...params);
            const after = db.prepare("SELECT total_changes() AS count").get().count;
            return { success: true, results: rows, meta: { changes: after - before } };
          });
          db.exec("COMMIT");
          return results;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
  if (key !== undefined) env.YUMUNIO_ACCESS_KEY = key;
  if (publicOrigin !== null) env.YUMUNIO_PUBLIC_ORIGIN = publicOrigin ?? origin;
  const request = (path, { method = "GET", body, cookie, headers = {}, urlOrigin = origin } = {}) => {
    const init = { method, headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return new Request(urlOrigin + path, init);
  };
  return { env, db, queries, assetRequests, request,
    fetch: (path, options) => worker.fetch(request(path, options), env) };
}
async function login(f) {
  const result = await f.fetch("/api/session", { method: "POST", body: { accessKey } });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { authenticated: true });
  const setCookie = result.headers.get("set-cookie");
  assert.match(setCookie, /^yumunio_session=v1\./);
  assert.match(setCookie, /Path=\/api/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  return setCookie.split(";")[0];
}


test("worker signed session saves and reads a D1 snapshot, while stale CAS returns 409 without overwrite", async t => {
  const f = fixture(t);
  const before = await f.fetch("/api/capabilities");
  assert.deepEqual(await before.json(), { storage: "d1", workspaceSync: true, authentication: "access-key", authenticated: false });
  const cookie = await login(f);
  assert.equal(f.queries.length, 0);
  const empty = await f.fetch("/api/workspace/snapshot", { cookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { revision: 0, snapshot: null });
  const initial = createDemoWorkspace();
  const saved = await f.fetch("/api/workspace/snapshot", { method: "PUT", cookie, body: { expectedRevision: 0, snapshot: initial } });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { revision: 1, snapshot: initial });
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.match(saved.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const persisted = await f.fetch("/api/workspace/snapshot", { cookie });
  assert.deepEqual(await persisted.json(), { revision: 1, snapshot: initial });
  const lost = structuredClone(initial);
  lost.name = "Stale replacement";
  const conflict = await f.fetch("/api/workspace/snapshot", { method: "PUT", cookie, body: { expectedRevision: 0, snapshot: lost } });
  assert.equal(conflict.status, 409);
  const failed = await conflict.json();
  assert.equal(failed.error.code, "VERSION_CONFLICT");
  assert.deepEqual(failed.error.details, { actualRevision: 1 });
  assert.deepEqual(await (await f.fetch("/api/workspace/snapshot", { cookie })).json(), { revision: 1, snapshot: initial });
  assert.equal((await (await f.fetch("/api/capabilities", { cookie })).json()).authenticated, true);
  const row = f.db.prepare("SELECT revision,updated_at FROM yumunio_prototype_snapshots WHERE id = 1").get();
  assert.equal(row.revision, 1);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(f.assetRequests, []);
});

test("worker rejects unauthenticated, incorrect-key, and modified-session requests before database access", async t => {
  const f = fixture(t);
  const unauthenticated = await f.fetch("/api/workspace/snapshot");
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, "UNAUTHORIZED");
  const wrong = await f.fetch("/api/session", { method: "POST", body: { accessKey: "wrong" } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  const cookie = await login(f);
  const signatureOffset = cookie.lastIndexOf(".") + 1;
  const changed = cookie.slice(0, signatureOffset) + (cookie[signatureOffset] === "A" ? "B" : "A") + cookie.slice(signatureOffset + 1);
  assert.equal((await f.fetch("/api/workspace/snapshot", { cookie: changed })).status, 401);
  assert.equal((await (await f.fetch("/api/capabilities", { cookie: changed })).json()).authenticated, false);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.assetRequests, []);
});

test("worker enforces origin and fetch-site rules even for an authenticated session", async t => {
  const f = fixture(t);
  const cookie = await login(f);
  const initial = createDemoWorkspace();
  for (const options of [
    { cookie, headers: { Origin: "https://attacker.test" } },
    { cookie, headers: { "Sec-Fetch-Site": "cross-site" } },
    { cookie, urlOrigin: "https://attacker.test", headers: { Origin: origin } },
    { method: "PUT", cookie, body: { expectedRevision: 0, snapshot: initial }, headers: { Origin: "" } },
    { method: "PUT", cookie, body: { expectedRevision: 0, snapshot: initial }, headers: { Origin: "https://attacker.test" } },
  ]) {
    const response = await f.fetch("/api/workspace/snapshot", options);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "ORIGIN_REJECTED");
  }
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.assetRequests, []);
});

test("worker without a D1 binding reports browser-local capabilities and never forwards API requests to assets", async t => {
  const f = fixture(t, { database: false });
  const capabilities = await f.fetch("/api/capabilities");
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), { storage: "browser-local", workspaceSync: false, authentication: "none", authenticated: false });
  const health = await f.fetch("/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).storage, "browser-local");
  for (const path of ["/api/workspace/snapshot", "/api", "/api/unknown"]) {
    const response = await f.fetch(path);
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, "NOT_IMPLEMENTED");
  }
  assert.equal((await f.fetch("/api/session", { method: "POST", body: { accessKey } })).status, 501);
  assert.deepEqual(f.assetRequests, []);
});

test("worker with D1 but no valid access key returns configuration-required 503 without querying storage", async t => {
  for (const key of ["", "short"]) {
    const f = fixture(t, { key });
    const health = await f.fetch("/health");
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, "configuration-required");
    const response = await f.fetch("/api/capabilities");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "SERVER_CONFIGURATION");
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.assetRequests, []);
  }
  const absent = fixture(t);
  delete absent.env.YUMUNIO_ACCESS_KEY;
  assert.equal((await absent.fetch("/api/workspace/snapshot")).status, 503);
  assert.deepEqual(absent.queries, []);
  assert.deepEqual(absent.assetRequests, []);
});

test("worker respects configured public origin and keeps schema failures private", async t => {
  const restricted = fixture(t, { publicOrigin: "https://configured.test" });
  const denied = await restricted.fetch("/api/capabilities");
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "ORIGIN_REJECTED");
  assert.deepEqual(restricted.queries, []);
  const missingSchema = fixture(t, { migration: false });
  const cookie = await login(missingSchema);
  const failed = await missingSchema.fetch("/api/workspace/snapshot", { cookie });
  assert.equal(failed.status, 500);
  const body = await failed.json();
  assert.equal(body.error.code, "STORAGE_ERROR");
  assert.doesNotMatch(body.error.message, /SELECT|sqlite|yumunio_prototype|no such table/i);
  assert.deepEqual(missingSchema.assetRequests, []);
});
