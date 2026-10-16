CREATE TABLE IF NOT EXISTS yumunio_webhook_approvals (
 profile_hash TEXT NOT NULL PRIMARY KEY,
 approved_by TEXT NOT NULL,
 approved_at TEXT NOT NULL,
 revoked_at TEXT,
 version INTEGER NOT NULL CHECK(version>=1 AND version<9007199254740991)
);
CREATE TABLE IF NOT EXISTS yumunio_webhook_subscriptions (
 id TEXT NOT NULL PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 issuer_account_id TEXT NOT NULL,
 membership_id TEXT NOT NULL,
 actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','member','guest')),
 profile_hash TEXT NOT NULL,
 authority_fingerprint TEXT NOT NULL,
 start_version INTEGER NOT NULL CHECK(start_version>=1 AND start_version<9007199254740991),
 status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled','quarantined')),
 reason TEXT CHECK(reason IN ('capacity','restore','authority','profile','approval','user')),
 missed_from_version INTEGER,
 missed_through_version INTEGER,
 gap_acknowledged_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1 AND version<9007199254740991),
 UNIQUE(workspace_id,page_id),
 CHECK((missed_from_version IS NULL AND missed_through_version IS NULL) OR (missed_from_version IS NOT NULL AND missed_from_version>=1 AND missed_through_version IS NOT NULL AND missed_through_version>=missed_from_version))
);
CREATE TABLE IF NOT EXISTS yumunio_webhook_jobs (
 event_id TEXT NOT NULL PRIMARY KEY,
 subscription_id TEXT NOT NULL,
 subscription_version INTEGER NOT NULL CHECK(subscription_version>=1),
 profile_hash TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 page_id TEXT NOT NULL,
 page_version INTEGER NOT NULL CHECK(page_version>=1 AND page_version<9007199254740991),
 event_type TEXT NOT NULL CONSTRAINT yumunio_webhook_event_type CHECK(event_type IN ('page.updated','page.title.updated','page.document.updated','page.created','page.moved','page.trashed','page.restored')),
 occurred_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(length(payload_json)<=1024),
 payload_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','leased','delivered','failed','cancelled','quarantined')),
 attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=4),
 next_attempt_at TEXT NOT NULL,
 lease_id TEXT,
 lease_until TEXT,
 last_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1 AND version<9007199254740991),
 CONSTRAINT yumunio_webhook_job_scope UNIQUE(subscription_id,subscription_version,page_id,page_version,event_type),
 CHECK((status='leased' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'leased' AND lease_id IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS yumunio_webhook_due ON yumunio_webhook_jobs(status,next_attempt_at,event_id);
CREATE INDEX IF NOT EXISTS yumunio_webhook_scope_jobs ON yumunio_webhook_jobs(subscription_id,status);
CREATE TABLE IF NOT EXISTS yumunio_webhook_guards (
 id TEXT NOT NULL PRIMARY KEY,
 ok INTEGER NOT NULL CHECK(ok=1)
);