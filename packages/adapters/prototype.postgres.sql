-- Prototype snapshot only. Apply to a dedicated database before starting the server.
CREATE TABLE IF NOT EXISTS yumunio_prototype_snapshots (
  id INTEGER NOT NULL PRIMARY KEY,
  revision BIGINT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at VARCHAR(24) NOT NULL
);
