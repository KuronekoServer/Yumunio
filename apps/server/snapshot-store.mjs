import { DatabaseSync } from 'node:sqlite';
import { SnapshotError, validateSnapshot } from '@yumunio/prototype';

/** Single-user prototype snapshot. Kept separate from Domain entity tables. */
export class SqliteSnapshotStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename, { timeout: 5000 });
    try {
      this.database.exec("CREATE TABLE IF NOT EXISTS yumunio_prototype_snapshots (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), updated_at TEXT NOT NULL);");
    } catch (error) { this.database.close(); throw error; }
  }
  async read() {
    const row = this.database.prepare('SELECT revision, payload_json FROM yumunio_prototype_snapshots WHERE id = 1').get();
    return row ? { revision: row.revision, snapshot: validateSnapshot(JSON.parse(row.payload_json)) } : { revision: 0, snapshot: null };
  }
  async write(expectedRevision, snapshot) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new SnapshotError('INVALID_REVISION', 'Invalid revision.');
    const data = validateSnapshot(snapshot);
    const row = this.database.prepare("INSERT INTO yumunio_prototype_snapshots(id, revision, payload_json, updated_at) SELECT 1, 1, ?, ? WHERE ? = 0 ON CONFLICT(id) DO NOTHING RETURNING revision").get(JSON.stringify(data), new Date().toISOString(), expectedRevision);
    if (row) return { revision: row.revision, snapshot: data };
    const updated = this.database.prepare("UPDATE yumunio_prototype_snapshots SET revision = revision + 1, payload_json = ?, updated_at = ? WHERE id = 1 AND revision = ? RETURNING revision").get(JSON.stringify(data), new Date().toISOString(), expectedRevision);
    if (updated) return { revision: updated.revision, snapshot: data };
    const current = await this.read();
    throw new SnapshotError('VERSION_CONFLICT', 'The server has a newer snapshot.', 409, { actualRevision: current.revision });
  }
  close() { this.database.close(); }
}
