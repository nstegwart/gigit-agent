-- 014_cp0_sync_backlog_sources.sql
-- Classification: REVERSIBLE (additive REVERSIBLE-EXPAND; CP0 backlog source tables only)
-- Schema version step: TM_CP0_SYNC_BACKLOG_SOURCES
--
-- Purpose:
--   Authoritative durable sources for future dual-count measures:
--     outbox_pending  ← COUNT control_plane_sync_outbox WHERE status IN
--                       ('PENDING','IN_FLIGHT','FAILED')  -- ACKED/DEAD excluded
--     legacy_unreplayed ← COUNT control_plane_legacy_residuals WHERE status IN
--                       ('UNREPLAYED','REPLAYING')  -- REPLAYED/ABANDONED excluded
--   control_plane_sync_status remains the denormalized SINK only (008); this
--   migration does NOT backfill rows, invent zeros, or mutate sink columns.
--
-- Design (P3B audit a192; both counts were C) NO SOURCE before this expand):
--   - Board-scoped PK + UNIQUE idempotency (no double-count under UNIQUE)
--   - Explicit NOT NULL status closed by CHECK (no NULL status coercion)
--   - Pin bind at enqueue/discovery (board_rev, lifecycle_rev, canonical_hash)
--   - Bounded attempt/error metadata; no secrets columns; no opaque payload blobs
--   - Soft board_id isolation (no FK requirement)
--
-- Future writers / measurers / scheduler / publisher enablement / legacy file
-- backfill are OUT OF SCOPE for this packet (schema/registry/gate only).
--
-- Non-destructive: CREATE TABLE IF NOT EXISTS only.
-- No seed DML (no row writes). No initial seed rows.
-- Rollback: app-disable / leave tables unused (forward-compatible).
-- Automated rollback never drops objects.

-- ---------------------------------------------------------------------------
-- control_plane_sync_outbox — durable CP0 sync outbox (pending COUNT source)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_sync_outbox (
  board_id VARCHAR(64) NOT NULL,
  outbox_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  subject_hash CHAR(64) NOT NULL,
  payload_hash CHAR(64) NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  enqueued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  acked_at DATETIME(3) NULL,
  next_attempt_at DATETIME(3) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64) NULL,
  last_error_class VARCHAR(64) NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY (board_id, outbox_id),
  UNIQUE KEY uq_cp0_outbox_idempotency (board_id, idempotency_key),
  KEY idx_cp0_outbox_status (board_id, status),
  KEY idx_cp0_outbox_claim (board_id, status, next_attempt_at, enqueued_at),
  CONSTRAINT chk_cp0_outbox_status CHECK (
    status IN ('PENDING', 'IN_FLIGHT', 'ACKED', 'FAILED', 'DEAD')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- control_plane_legacy_residuals — durable legacy residual ledger (COUNT source)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_legacy_residuals (
  board_id VARCHAR(64) NOT NULL,
  residual_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  run_id VARCHAR(160) NULL,
  receipt_id VARCHAR(64) NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  discovered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  replayed_at DATETIME(3) NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY (board_id, residual_id),
  UNIQUE KEY uq_cp0_legacy_idempotency (board_id, idempotency_key),
  UNIQUE KEY uq_cp0_legacy_receipt_hash (board_id, receipt_hash),
  KEY idx_cp0_legacy_status (board_id, status),
  CONSTRAINT chk_cp0_legacy_status CHECK (
    status IN ('UNREPLAYED', 'REPLAYING', 'REPLAYED', 'ABANDONED')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
