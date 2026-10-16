-- Collaboration state and encrypted durable mail. Apply explicitly alongside the SDK and content schema.
CREATE TABLE IF NOT EXISTS yumunio_collaboration_invitations (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  invitation_json TEXT NOT NULL CHECK (length(CAST(invitation_json AS BLOB)) <= 10000),
  issuer_membership_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked'))
);
CREATE INDEX IF NOT EXISTS yumunio_collaboration_invites_workspace ON yumunio_collaboration_invitations (workspace_id);
CREATE TABLE IF NOT EXISTS yumunio_mail_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_ciphertext TEXT NOT NULL CHECK (length(CAST(payload_ciphertext AS BLOB)) <= 140000),
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','accepted','dead','cancelled')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_id TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  invitation_id TEXT,
  invitation_generation INTEGER
);
CREATE INDEX IF NOT EXISTS yumunio_mail_jobs_due ON yumunio_mail_jobs (status,available_at);
CREATE INDEX IF NOT EXISTS yumunio_mail_jobs_invitation ON yumunio_mail_jobs (invitation_id);
-- D1 batch: a failed affected-row assertion must abort and roll back the whole batch.
CREATE TABLE IF NOT EXISTS yumunio_transaction_guards (
  id TEXT NOT NULL PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT yumunio_transaction_guard CHECK (ok = 1)
);
