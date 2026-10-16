import { SnapshotError, validateSnapshot } from "@yumunio/prototype";

const readSql = "SELECT revision, payload_json FROM yumunio_prototype_snapshots WHERE id = 1";
const writeSql = `INSERT INTO yumunio_prototype_snapshots(id, revision, payload_json, updated_at)
  SELECT 1, 1, ?1, ?3 WHERE ?2 = 0 OR EXISTS (SELECT 1 FROM yumunio_prototype_snapshots WHERE id = 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1, payload_json = excluded.payload_json, updated_at = excluded.updated_at
  WHERE yumunio_prototype_snapshots.revision = ?2 AND yumunio_prototype_snapshots.revision < 9007199254740991`;

const parseRow = row => {
  if (!row) return { revision: 0, snapshot: null };
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new SnapshotError("STORAGE_ERROR", "Invalid stored workspace revision.", 500);
  }
  try {
    const snapshot = validateSnapshot(JSON.parse(row.payload_json));
    return { revision: row.revision, snapshot };
  } catch {
    throw new SnapshotError("STORAGE_ERROR", "Invalid stored workspace snapshot.", 500);
  }
};

/**
 * One prototype workspace over an existing D1Database binding.
 * Apply snapshot-schema.sql manually before use; no resource or migration is created.
 * Input and stored snapshots follow the shared prototype validator.
 */
export class D1SnapshotStore {
  #binding;
  #now;
  constructor(binding, { now = () => new Date().toISOString() } = {}) {
    if (!binding || typeof binding.prepare !== "function" || typeof binding.batch !== "function") {
      throw new SnapshotError("INVALID_INPUT", "Expected a D1 database binding.", 400);
    }
    if (typeof now !== "function") throw new SnapshotError("INVALID_INPUT", "Expected a UTC clock function.", 400);
    this.#binding = binding;
    this.#now = now;
  }

  async #batch(commands) {
    try {
      const statements = commands.map(({ sql, params = [] }) => this.#binding.prepare(sql).bind(...params));
      const results = await this.#binding.batch(statements);
      if (!Array.isArray(results) || results.length !== statements.length || results.some(result => result.success === false)) {
        throw new Error("Invalid database result");
      }
      return results;
    } catch {
      throw new SnapshotError("STORAGE_ERROR", "The workspace database operation failed.", 500);
    }
  }

  /** @returns {Promise<{revision: number, snapshot: object|null}>} */
  async read() {
    const results = await this.#batch([{ sql: readSql }]);
    return parseRow(results[0].results?.[0]);
  }

  /** @param {number} expectedRevision @param {object} snapshot @returns {Promise<{revision: number, snapshot: object}>} */
  async write(expectedRevision, snapshot) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new SnapshotError("INVALID_INPUT", "Expected a nonnegative safe workspace revision.", 400);
    }
    const captured = validateSnapshot(snapshot);
    const payload = JSON.stringify(captured);
    const stamp = this.#now();
    if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) {
      throw new SnapshotError("INVALID_INPUT", "Expected a canonical UTC timestamp.", 400);
    }
    const results = await this.#batch([
      { sql: writeSql, params: [payload, expectedRevision, stamp] },
      { sql: readSql },
    ]);
    const current = parseRow(results[1].results?.[0]);
    if (!(Number(results[0].meta?.changes) > 0)) {
      throw new SnapshotError("VERSION_CONFLICT", "The workspace changed before it could be saved.", 409,
        { actualRevision: current.revision });
    }
    return current;
  }
}
