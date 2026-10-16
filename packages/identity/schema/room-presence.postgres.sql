CREATE TABLE IF NOT EXISTS yumunio_room_presence (
 id VARCHAR(32) NOT NULL PRIMARY KEY,
 workspace_id VARCHAR(128) NOT NULL,
 page_id VARCHAR(128) NOT NULL,
 epoch VARCHAR(128) NOT NULL,
 account_id VARCHAR(128) NOT NULL,
 membership_id VARCHAR(128) NOT NULL,
 session_id VARCHAR(128) NOT NULL,
 actor_role VARCHAR(16) NOT NULL CHECK (actor_role IN ('owner','admin','member','guest')),
 client_id VARCHAR(36) NOT NULL,
 sequence BIGINT NOT NULL CHECK (sequence>=1 AND sequence<9007199254740991),
 document_version BIGINT NOT NULL CHECK (document_version>=1 AND document_version<9007199254740991),
 cursor_json TEXT NOT NULL,
 expires_at VARCHAR(24) NOT NULL,
 slot INTEGER NOT NULL CHECK (slot>=0 AND slot<64),
 account_slot INTEGER NOT NULL CHECK (account_slot>=0 AND account_slot<8),
 UNIQUE (workspace_id,page_id,slot),
 UNIQUE (workspace_id,page_id,account_id,account_slot)
);
CREATE INDEX IF NOT EXISTS yumunio_room_presence_expiry ON yumunio_room_presence(expires_at);
