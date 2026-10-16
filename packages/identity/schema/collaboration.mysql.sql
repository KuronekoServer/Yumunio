-- Same common SQL contract as SQLite/PostgreSQL. No SDK table foreign keys.
CREATE TABLE IF NOT EXISTS yumunio_collaboration_invitations (
 id VARCHAR(128) NOT NULL PRIMARY KEY,workspace_id VARCHAR(128) NOT NULL,generation BIGINT NOT NULL,
 invitation_json TEXT NOT NULL,issuer_membership_id VARCHAR(128) NOT NULL,status VARCHAR(16) NOT NULL,
 INDEX yumunio_collaboration_invites_workspace (workspace_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS yumunio_mail_jobs (
 id VARCHAR(128) NOT NULL PRIMARY KEY,dedupe_key VARCHAR(256) NOT NULL UNIQUE,
 payload_ciphertext MEDIUMTEXT NOT NULL,payload_digest VARCHAR(64) NOT NULL,status VARCHAR(16) NOT NULL,
 attempts INTEGER NOT NULL,available_at VARCHAR(24) NOT NULL,lease_id VARCHAR(128),lease_until VARCHAR(24),
 created_at VARCHAR(24) NOT NULL,updated_at VARCHAR(24) NOT NULL,expires_at VARCHAR(24) NOT NULL,
 invitation_id VARCHAR(128),invitation_generation BIGINT,
 INDEX yumunio_mail_jobs_due (status,available_at),INDEX yumunio_mail_jobs_invitation (invitation_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE IF NOT EXISTS yumunio_transaction_guards (
 id VARCHAR(128) NOT NULL PRIMARY KEY,ok INTEGER NOT NULL,
 CONSTRAINT yumunio_transaction_guard CHECK (ok = 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
