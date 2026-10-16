-- Explicit upgrade for an existing original read-only token table. Back up first.
-- The application D1 helper uses one atomic batch and detects repeated application.
CREATE TABLE yumunio_api_tokens_scope_v2 (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 32),
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner','admin','member','guest')),
  name TEXT NOT NULL CHECK (length(name) >= 1 AND length(name) <= 80),
  scopes_json TEXT NOT NULL CONSTRAINT yumunio_api_token_scopes CHECK (scopes_json IN ('["page:read"]','["page:read","document:read"]','["page:read","document:read","document:write"]','["page:read","mcp:connect"]','["page:read","document:read","mcp:connect"]','["page:read","document:read","document:write","mcp:connect"]')),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1 AND version <= 9007199254740991),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  active_slot INTEGER CHECK (active_slot >= 1 AND active_slot <= 20),
  metadata_slot INTEGER NOT NULL CHECK (metadata_slot >= 1 AND metadata_slot <= 50),
  UNIQUE (account_id,request_id),
  UNIQUE (account_id,active_slot),
  UNIQUE (account_id,metadata_slot),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR active_slot IS NULL)
);
INSERT INTO yumunio_api_tokens_scope_v2 (id,account_id,workspace_id,page_id,membership_id,actor_role,name,scopes_json,token_hash,expires_at,created_at,revoked_at,version,request_id,request_digest,active_slot,metadata_slot) SELECT id,account_id,workspace_id,page_id,membership_id,actor_role,name,scopes_json,token_hash,expires_at,created_at,revoked_at,version,request_id,request_digest,active_slot,metadata_slot FROM yumunio_api_tokens;
DROP TABLE yumunio_api_tokens;
ALTER TABLE yumunio_api_tokens_scope_v2 RENAME TO yumunio_api_tokens;
