-- Explicit migration only. Stop old webhook writers/runners first.
-- Preserves old rows; includes page_id in dedupe and permits seven metadata event types.
CREATE TABLE yumunio_webhook_jobs_event_v3 (
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
INSERT INTO yumunio_webhook_jobs_event_v3 (event_id,subscription_id,subscription_version,profile_hash,workspace_id,page_id,page_version,event_type,occurred_at,payload_json,payload_digest,status,attempts,next_attempt_at,lease_id,lease_until,last_code,created_at,updated_at,version) SELECT event_id,subscription_id,subscription_version,profile_hash,workspace_id,page_id,page_version,event_type,occurred_at,payload_json,payload_digest,status,attempts,next_attempt_at,lease_id,lease_until,last_code,created_at,updated_at,version FROM yumunio_webhook_jobs;
DROP TABLE yumunio_webhook_jobs;
ALTER TABLE yumunio_webhook_jobs_event_v3 RENAME TO yumunio_webhook_jobs;
CREATE INDEX yumunio_webhook_due ON yumunio_webhook_jobs(status,next_attempt_at,event_id);
CREATE INDEX yumunio_webhook_scope_jobs ON yumunio_webhook_jobs(subscription_id,status);
