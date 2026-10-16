-- Account-owned content only. Apply explicitly; never imports or replaces prototype snapshots.
-- Shared MySQL/MariaDB/TiDB subset. Target-version interoperability still requires live verification.
-- No FK into SDK-owned identity tables: their ID types/collations are managed by the pinned SDK.
CREATE TABLE IF NOT EXISTS yumunio_account_content (
  workspace_id VARCHAR(128) NOT NULL PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  payload_json LONGTEXT NOT NULL CHECK (OCTET_LENGTH(payload_json) <= 900000)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS yumunio_content_chunks (
  workspace_id VARCHAR(128) NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 32),
  payload_text MEDIUMTEXT NOT NULL CHECK (OCTET_LENGTH(payload_text) >= 1 AND OCTET_LENGTH(payload_text) <= 256000),
  PRIMARY KEY (workspace_id, revision, ordinal)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS yumunio_content_guards (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
