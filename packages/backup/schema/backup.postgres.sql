CREATE TABLE IF NOT EXISTS yumunio_backup_jobs (
 id TEXT NOT NULL PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('queued','leased','complete','failed','cancelled')),
 phase TEXT NOT NULL,state_json TEXT NOT NULL CHECK(octet_length(state_json)<=1000000),
 attempts BIGINT NOT NULL CHECK(attempts>=0),lease_id TEXT,lease_until TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error_code TEXT
);
CREATE INDEX IF NOT EXISTS yumunio_backup_jobs_due ON yumunio_backup_jobs(status,lease_until);
CREATE TABLE IF NOT EXISTS yumunio_backup_fragments (
 job_id TEXT NOT NULL,resource TEXT NOT NULL,ordinal BIGINT NOT NULL CHECK(ordinal>=0),
 descriptor_json TEXT NOT NULL CHECK(octet_length(descriptor_json)<=8192),
 ciphertext_base64 TEXT NOT NULL CHECK(octet_length(ciphertext_base64)<=1500000),
 stored INTEGER NOT NULL CHECK(stored IN (0,1)),PRIMARY KEY(job_id,resource,ordinal)
);
CREATE TABLE IF NOT EXISTS yumunio_backup_guards (id TEXT NOT NULL PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE IF NOT EXISTS yumunio_recovery_state (
 id INTEGER NOT NULL PRIMARY KEY CHECK(id=1),restore_id TEXT NOT NULL,manifest_digest TEXT NOT NULL,plan_digest TEXT NOT NULL,target_profile_id TEXT NOT NULL,prepared_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('restoring','ready')),row_cursor BIGINT NOT NULL CHECK(row_cursor>=0),
 row_count BIGINT NOT NULL CHECK(row_count>=0),updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yumunio_backup_artifacts (
 backup_id TEXT NOT NULL, object_key TEXT NOT NULL,
 cipher_checksum TEXT NOT NULL, cipher_size BIGINT NOT NULL CHECK(cipher_size>=1 AND cipher_size<=1048592),
 confirmed BIGINT NOT NULL CHECK(confirmed IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(backup_id,object_key)
);
CREATE TABLE IF NOT EXISTS yumunio_backup_cleanup_approval (
 id BIGINT NOT NULL PRIMARY KEY CHECK(id=1), policy_digest TEXT NOT NULL,
 approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, revoked_at TEXT,
 version BIGINT NOT NULL CHECK(version>=1)
);
CREATE TABLE IF NOT EXISTS yumunio_backup_cleanups (
 id TEXT NOT NULL PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, backup_id TEXT NOT NULL UNIQUE,
 policy_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','leased','complete','blocked','failed')),
 reason TEXT NOT NULL CHECK(reason IN ('retention','failed')), object_cursor BIGINT NOT NULL CHECK(object_cursor>=0),
 plan_json TEXT NOT NULL CHECK(octet_length(plan_json)<=1000000),
 lease_id TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT
);
