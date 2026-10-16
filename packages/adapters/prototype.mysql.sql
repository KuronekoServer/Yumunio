-- Prototype snapshot only. Apply to a dedicated database before starting the server.
-- Shared MySQL/MariaDB subset; TiDB must still be verified against its target version.
CREATE TABLE IF NOT EXISTS yumunio_prototype_snapshots (
  id INTEGER NOT NULL PRIMARY KEY,
  revision BIGINT NOT NULL,
  payload_json LONGTEXT NOT NULL,
  updated_at VARCHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
