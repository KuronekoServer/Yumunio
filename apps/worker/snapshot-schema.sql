CREATE TABLE IF NOT EXISTS yumunio_prototype_snapshots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1 AND revision <= 9007199254740991),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
);
