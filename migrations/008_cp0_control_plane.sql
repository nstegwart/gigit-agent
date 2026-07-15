-- 008_cp0_control_plane.sql
-- Classification: REVERSIBLE-EXPAND (additive CP0 objects only)
-- Safe for an explicitly owner-authorized production expand after exact-SHA,
-- fresh-backup, checksum, lifecycle-mapping, and migration-apply gates pass.
-- Rollback is forward-compatible: leave these unused tables in place and roll
-- the app back. Destructive DROP is never part of the automated rollback path.

CREATE TABLE IF NOT EXISTS control_plane_spawn_budgets (
  board_id VARCHAR(64) NOT NULL,
  owner_run_id VARCHAR(160) NOT NULL,
  controller_run_id VARCHAR(160) NOT NULL,
  budget_version VARCHAR(64) NOT NULL,
  max_children INT UNSIGNED NOT NULL,
  active_children INT UNSIGNED NOT NULL DEFAULT 0,
  authorization_id VARCHAR(160) NOT NULL,
  lease_expires_at_ms BIGINT NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  record_json JSON NOT NULL,
  PRIMARY KEY (board_id, owner_run_id),
  UNIQUE KEY uq_cp0_spawn_authorization (board_id, authorization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_control_acks (
  board_id VARCHAR(64) NOT NULL,
  ack_id VARCHAR(64) NOT NULL,
  ack_version VARCHAR(64) NOT NULL,
  ack_type VARCHAR(32) NOT NULL,
  run_id VARCHAR(160) NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  acknowledged_at DATETIME(3) NOT NULL,
  payload_json JSON NOT NULL,
  PRIMARY KEY (board_id, ack_id),
  UNIQUE KEY uq_cp0_ack_idempotency (board_id, ack_type, idempotency_key),
  KEY idx_cp0_ack_run (board_id, run_id, ack_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_account_probes (
  board_id VARCHAR(64) NOT NULL,
  masked_account_id VARCHAR(160) NOT NULL,
  expires_at DATETIME(3) NULL,
  quota_remaining BIGINT NULL,
  quota_verdict VARCHAR(16) NOT NULL,
  chat_verdict VARCHAR(16) NOT NULL,
  probed_at DATETIME(3) NULL,
  adaptive_cap INT UNSIGNED NOT NULL DEFAULT 0,
  quarantine_reason VARCHAR(255) NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  record_json JSON NOT NULL,
  PRIMARY KEY (board_id, masked_account_id),
  KEY idx_cp0_probe_freshness (board_id, probed_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_sync_status (
  board_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  outbox_pending BIGINT UNSIGNED NULL,
  legacy_unreplayed BIGINT UNSIGNED NULL,
  effective_backlog BIGINT UNSIGNED NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  last_ack_revision BIGINT UNSIGNED NULL,
  freshness_at DATETIME(3) NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  record_json JSON NOT NULL,
  PRIMARY KEY (board_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
