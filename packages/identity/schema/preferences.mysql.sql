-- Exact account IDs, common MySQL/MariaDB/TiDB subset; live target verification remains separate.
CREATE TABLE IF NOT EXISTS yumunio_account_preferences (
 account_id VARCHAR(128) NOT NULL PRIMARY KEY,
 revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
 preferences_json TEXT NOT NULL CHECK (OCTET_LENGTH(preferences_json) <= 4096)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
