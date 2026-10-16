import { MAX_SNAPSHOT_BYTES, SnapshotError, validateSnapshot } from './snapshot.js';

const readSql = 'SELECT revision, payload_json FROM yumunio_prototype_snapshots WHERE id = 1';
const storageError = () => new SnapshotError('STORAGE_ERROR', 'The workspace database operation failed.', 500);
const invalidInput = message => new SnapshotError('INVALID_INPUT', message, 400);

function storedRevision(value) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) value = Number(value);
  if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 1) throw storageError();
  return value;
}

function storedRow(rows) {
  if (rows.length === 0) return { revision: 0, snapshot: null };
  if (rows.length !== 1) throw storageError();
  try {
    const row = rows[0];
    const revision = storedRevision(row.revision);
    if (typeof row.payload_json !== 'string' || new TextEncoder().encode(row.payload_json).length > MAX_SNAPSHOT_BYTES) throw storageError();
    return { revision, snapshot: validateSnapshot(JSON.parse(row.payload_json)) };
  } catch {
    throw storageError();
  }
}

/**
 * A single prototype snapshot over an already configured, autocommit SQL pool.
 * The bridge binds parameters and normalizes results to { rows, affectedRows }.
 * Use the separate MariaDB/MySQL-compatible or PostgreSQL snapshot schema first.
 * This class neither creates tables nor opens a transaction or remote connection.
 */
export class SqlSnapshotStore {
  #dialect;
  #query;
  #end;
  #now;
  #active = new Set();
  #closing = null;

  constructor(driver, { now = () => new Date().toISOString() } = {}) {
    if (!driver || !['mysql', 'postgres'].includes(driver.dialect) || typeof driver.query !== 'function' ||
        (driver.end !== undefined && typeof driver.end !== 'function')) {
      throw invalidInput('Expected a supported SQL pool bridge.');
    }
    if (typeof now !== 'function') throw invalidInput('Expected a UTC clock function.');
    this.#dialect = driver.dialect;
    this.#query = driver.query.bind(driver);
    this.#end = driver.end?.bind(driver);
    this.#now = now;
  }

  #assertOpen() {
    if (this.#closing) throw storageError();
  }

  async #operation(task) {
    this.#assertOpen();
    const pending = (async () => task())();
    this.#active.add(pending);
    try { return await pending; }
    finally { this.#active.delete(pending); }
  }

  async #execute(sql, params = [], duplicateIsConflict = false) {
    try {
      const result = await this.#query(sql, params);
      if (!result || !Array.isArray(result.rows)) throw storageError();
      return result;
    } catch (error) {
      if (duplicateIsConflict && (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062)) {
        return { rows: [], affectedRows: 0 };
      }
      throw storageError();
    }
  }

  async #read() {
    return storedRow((await this.#execute(readSql)).rows);
  }

  async read() {
    return this.#operation(() => this.#read());
  }

  async write(expectedRevision, snapshot) {
    this.#assertOpen();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new SnapshotError('INVALID_REVISION', 'Expected a writable nonnegative safe workspace revision.', 400);
    }
    const captured = validateSnapshot(snapshot);
    const payload = JSON.stringify(captured);
    const stamp = this.#now();
    if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) ||
        !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) {
      throw invalidInput('Expected a canonical UTC timestamp.');
    }
    return this.#operation(async () => {
      let result;
      if (expectedRevision === 0) {
        const sql = this.#dialect === 'mysql'
          ? 'INSERT INTO yumunio_prototype_snapshots(id, revision, payload_json, updated_at) VALUES (1, 1, ?, ?)'
          : 'INSERT INTO yumunio_prototype_snapshots(id, revision, payload_json, updated_at) VALUES (1, 1, $1, $2) ON CONFLICT (id) DO NOTHING';
        result = await this.#execute(sql, [payload, stamp], this.#dialect === 'mysql');
      } else {
        const sql = this.#dialect === 'mysql'
          ? 'UPDATE yumunio_prototype_snapshots SET revision = revision + 1, payload_json = ?, updated_at = ? WHERE id = 1 AND revision = ? AND revision < 9007199254740991'
          : 'UPDATE yumunio_prototype_snapshots SET revision = revision + 1, payload_json = $1, updated_at = $2 WHERE id = 1 AND revision = $3 AND revision < 9007199254740991';
        result = await this.#execute(sql, [payload, stamp, expectedRevision]);
      }
      if (result.affectedRows === 1) return { revision: expectedRevision + 1, snapshot: captured };
      if (result.affectedRows !== 0) throw storageError();
      const current = await this.#read();
      throw new SnapshotError('VERSION_CONFLICT', 'The workspace changed before it could be saved.', 409,
        { actualRevision: current.revision });
    });
  }

  /** Wait for admitted operations before closing the pool; never retry an uncertain write. */
  close() {
    if (!this.#closing) {
      this.#closing = (async () => {
        await Promise.allSettled([...this.#active]);
        try { await this.#end?.(); }
        catch { throw storageError(); }
      })();
    }
    return this.#closing;
  }
}
