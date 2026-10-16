-- Account-owned content only. Apply explicitly; never imports or replaces prototype snapshots.
-- SDK-owned identity tables remain separate. Every read/write verifies the live workspace and membership.
CREATE TABLE IF NOT EXISTS yumunio_account_content (
  workspace_id TEXT NOT NULL PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  payload_json TEXT NOT NULL CHECK (OCTET_LENGTH(payload_json) <= 900000)
);
CREATE TABLE IF NOT EXISTS yumunio_content_chunks (
  workspace_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 32),
  payload_text TEXT NOT NULL CHECK (OCTET_LENGTH(payload_text) >= 1 AND OCTET_LENGTH(payload_text) <= 256000),
  PRIMARY KEY (workspace_id, revision, ordinal)
);
CREATE TABLE IF NOT EXISTS yumunio_content_guards (
  id TEXT NOT NULL PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
