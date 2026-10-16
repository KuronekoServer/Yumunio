CREATE TABLE IF NOT EXISTS yumunio_webhook_approvals (
 profile_hash CHAR(64) NOT NULL PRIMARY KEY,
 approved_by VARCHAR(128) NOT NULL,
 approved_at CHAR(24) NOT NULL,
 revoked_at CHAR(24),
 version BIGINT NOT NULL CHECK(version>=1 AND version<9007199254740991)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS yumunio_webhook_subscriptions (
 id VARCHAR(128) NOT NULL PRIMARY KEY,
 workspace_id VARCHAR(128) NOT NULL,
 page_id VARCHAR(128) NOT NULL,
 issuer_account_id VARCHAR(128) NOT NULL,
 membership_id VARCHAR(128) NOT NULL,
 actor_role VARCHAR(16) NOT NULL CHECK(actor_role IN ('owner','admin','member','guest')),
 profile_hash CHAR(64) NOT NULL,
 authority_fingerprint CHAR(64) NOT NULL,
 start_version BIGINT NOT NULL CHECK(start_version>=1 AND start_version<9007199254740991),
 status VARCHAR(16) NOT NULL CHECK(status IN ('active','paused','cancelled','quarantined')),
 reason VARCHAR(16) CHECK(reason IN ('capacity','restore','authority','profile','approval','user')),
 missed_from_version BIGINT,
 missed_through_version BIGINT,
 gap_acknowledged_at CHAR(24),
 created_at CHAR(24) NOT NULL,
 updated_at CHAR(24) NOT NULL,
 version BIGINT NOT NULL CHECK(version>=1 AND version<9007199254740991),
 UNIQUE(workspace_id,page_id),
 CHECK((missed_from_version IS NULL AND missed_through_version IS NULL) OR (missed_from_version IS NOT NULL AND missed_from_version>=1 AND missed_through_version IS NOT NULL AND missed_through_version>=missed_from_version))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS yumunio_webhook_jobs (
 event_id VARCHAR(128) NOT NULL PRIMARY KEY,
 subscription_id VARCHAR(128) NOT NULL,
 subscription_version BIGINT NOT NULL CHECK(subscription_version>=1),
 profile_hash CHAR(64) NOT NULL,
 workspace_id VARCHAR(128) NOT NULL,
 page_id VARCHAR(128) NOT NULL,
 page_version BIGINT NOT NULL CHECK(page_version>=1 AND page_version<9007199254740991),
 event_type VARCHAR(32) NOT NULL,
 occurred_at CHAR(24) NOT NULL,
 payload_json TEXT NOT NULL CHECK(length(payload_json)<=1024),
 payload_digest CHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL CHECK(status IN ('queued','leased','delivered','failed','cancelled','quarantined')),
 attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=4),
 next_attempt_at CHAR(24) NOT NULL,
 lease_id VARCHAR(128),
 lease_until CHAR(24),
 last_code VARCHAR(32),
 created_at CHAR(24) NOT NULL,
 updated_at CHAR(24) NOT NULL,
 version BIGINT NOT NULL CHECK(version>=1 AND version<9007199254740991),
 INDEX yumunio_webhook_due(status,next_attempt_at,event_id),
 INDEX yumunio_webhook_scope_jobs(subscription_id,status),
 CONSTRAINT yumunio_webhook_job_scope UNIQUE(subscription_id,subscription_version,page_id,page_version,event_type),
 CHECK((status='leased' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'leased' AND lease_id IS NULL AND lease_until IS NULL)),
 CONSTRAINT yumunio_webhook_event_type CHECK(event_type IN ('page.updated','page.title.updated','page.document.updated','page.created','page.moved','page.trashed','page.restored'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;


CREATE TABLE IF NOT EXISTS yumunio_webhook_guards (
 id VARCHAR(128) NOT NULL PRIMARY KEY,
 ok INTEGER NOT NULL CHECK(ok=1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
