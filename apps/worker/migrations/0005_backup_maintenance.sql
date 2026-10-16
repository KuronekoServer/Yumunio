-- Apply explicitly before enabling backup cleanup. No artifacts are deleted by this migration.

CREATE TABLE IF NOT EXISTS yumunio_backup_artifacts (
 backup_id TEXT NOT NULL, object_key TEXT NOT NULL,
 cipher_checksum TEXT NOT NULL, cipher_size INTEGER NOT NULL CHECK(cipher_size>=1 AND cipher_size<=1048592),
 confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(backup_id,object_key)
);
CREATE TABLE IF NOT EXISTS yumunio_backup_cleanup_approval (
 id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), policy_digest TEXT NOT NULL,
 approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, revoked_at TEXT,
 version INTEGER NOT NULL CHECK(version>=1)
);
CREATE TABLE IF NOT EXISTS yumunio_backup_cleanups (
 id TEXT NOT NULL PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, backup_id TEXT NOT NULL UNIQUE,
 policy_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','leased','complete','blocked','failed')),
 reason TEXT NOT NULL CHECK(reason IN ('retention','failed')), object_cursor INTEGER NOT NULL CHECK(object_cursor>=0),
 plan_json TEXT NOT NULL CHECK(length(CAST(plan_json AS BLOB))<=1000000),
 lease_id TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT
);
