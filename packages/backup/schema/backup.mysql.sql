CREATE TABLE IF NOT EXISTS yumunio_backup_jobs (
 id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 request_key VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 status VARCHAR(16) NOT NULL,
 phase VARCHAR(64) NOT NULL,
 state_json MEDIUMTEXT NOT NULL,
 attempts BIGINT NOT NULL,
 lease_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin,
 lease_until VARCHAR(24),
 created_at VARCHAR(24) NOT NULL,
 updated_at VARCHAR(24) NOT NULL,
 error_code VARCHAR(80),
 CHECK(status IN ('queued','leased','complete','failed','cancelled')),
 CHECK(OCTET_LENGTH(state_json)<=1000000),
 CHECK(attempts>=0),
 INDEX yumunio_backup_jobs_due(status,lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS yumunio_backup_fragments (
 job_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 resource VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 ordinal BIGINT NOT NULL,
 descriptor_json TEXT NOT NULL,
 ciphertext_base64 MEDIUMTEXT NOT NULL,
 stored TINYINT NOT NULL,
 PRIMARY KEY(job_id,resource,ordinal),
 CHECK(ordinal>=0),CHECK(OCTET_LENGTH(descriptor_json)<=8192),CHECK(OCTET_LENGTH(ciphertext_base64)<=1500000),CHECK(stored IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS yumunio_backup_guards (
 id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 ok TINYINT NOT NULL CHECK(ok=1)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS yumunio_recovery_state (
 id TINYINT NOT NULL PRIMARY KEY CHECK(id=1),
 restore_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 manifest_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 plan_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 target_profile_id VARCHAR(128) NOT NULL,
 prepared_at VARCHAR(24) NOT NULL,
 status VARCHAR(16) NOT NULL CHECK(status IN ('restoring','ready')),
 row_cursor BIGINT NOT NULL CHECK(row_cursor>=0),
 row_count BIGINT NOT NULL CHECK(row_count>=0),
 updated_at VARCHAR(24) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS yumunio_backup_artifacts (
 backup_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 cipher_checksum VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, cipher_size BIGINT NOT NULL CHECK(cipher_size>=1 AND cipher_size<=1048592),
 confirmed BIGINT NOT NULL CHECK(confirmed IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(backup_id,object_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS yumunio_backup_cleanup_approval (
 id BIGINT NOT NULL PRIMARY KEY CHECK(id=1), policy_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, revoked_at TEXT,
 version BIGINT NOT NULL CHECK(version>=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS yumunio_backup_cleanups (
 id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, request_key VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE, backup_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 policy_digest VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','leased','complete','blocked','failed')),
 reason TEXT NOT NULL CHECK(reason IN ('retention','failed')), object_cursor BIGINT NOT NULL CHECK(object_cursor>=0),
 plan_json MEDIUMTEXT NOT NULL CHECK(OCTET_LENGTH(plan_json)<=1000000),
 lease_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
