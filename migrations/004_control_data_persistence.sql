-- 004_control_data_persistence.sql
-- Classification: REVERSIBLE (additive columns/tables only; drop-safe rollback of new objects)
-- Schema version step: TM_CONTROL_DATA_PERSISTENCE_V1
-- Foundation for durable G5 domains, classification receipts, DecisionV3,
-- canonical import pins, idempotency in-progress, and revision/hash pins.
-- Non-destructive: CREATE IF NOT EXISTS + ADD COLUMN (runner tolerates errno 1060).
-- Never drop or truncate data; never guess PRODUCT; no FOREIGN KEY; no secrets columns.

-- ---------------------------------------------------------------------------
-- Board revision pin expand (canonical import + lifecycle hash pins)
-- ---------------------------------------------------------------------------
ALTER TABLE board_revisions ADD COLUMN canonical_hash CHAR(64) NULL;
ALTER TABLE board_revisions ADD COLUMN last_snapshot_id VARCHAR(64) NULL;
ALTER TABLE board_revisions ADD COLUMN last_snapshot_generated_at DATETIME(3) NULL;
ALTER TABLE board_revisions ADD COLUMN last_payload_sha256 CHAR(64) NULL;
ALTER TABLE board_revisions ADD COLUMN import_entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE board_revisions ADD COLUMN dispatch_blocked TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE board_revisions ADD COLUMN dispatch_blocked_reason VARCHAR(400) NULL;

-- ---------------------------------------------------------------------------
-- Idempotency: explicit in-progress flag (status=0 alone is ambiguous)
-- ---------------------------------------------------------------------------
ALTER TABLE control_plane_idempotency ADD COLUMN in_progress TINYINT(1) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- G5 domain full record payload (001 status columns remain indexed filters)
-- ---------------------------------------------------------------------------
ALTER TABLE control_plane_g5 ADD COLUMN scope VARCHAR(160) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN evidence_ids_json JSON NULL;
ALTER TABLE control_plane_g5 ADD COLUMN evidence_hashes_json JSON NULL;
ALTER TABLE control_plane_g5 ADD COLUMN verifier_agent VARCHAR(160) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN verifier_model VARCHAR(160) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN verifier_run_id VARCHAR(160) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN author_run_id VARCHAR(160) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN subject_revision BIGINT UNSIGNED NULL;
ALTER TABLE control_plane_g5 ADD COLUMN expected_rev BIGINT UNSIGNED NULL;
ALTER TABLE control_plane_g5 ADD COLUMN findings TEXT NULL;
ALTER TABLE control_plane_g5 ADD COLUMN blocker VARCHAR(400) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN captured_at DATETIME(3) NULL;
ALTER TABLE control_plane_g5 ADD COLUMN programmatic_evidence TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE control_plane_g5 ADD COLUMN independent_verifier TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE control_plane_g5 ADD COLUMN record_json JSON NULL;

-- ---------------------------------------------------------------------------
-- Classification ledger: full receipt + pin fields (defaults stay UNCLASSIFIED)
-- ---------------------------------------------------------------------------
ALTER TABLE control_plane_classification ADD COLUMN receipt_json JSON NULL;
ALTER TABLE control_plane_classification ADD COLUMN canonical_snapshot_id VARCHAR(64) NULL;
ALTER TABLE control_plane_classification ADD COLUMN canonical_hash CHAR(64) NULL;
ALTER TABLE control_plane_classification ADD COLUMN task_hash CHAR(64) NULL;
ALTER TABLE control_plane_classification ADD COLUMN lifecycle_rev BIGINT UNSIGNED NULL;
ALTER TABLE control_plane_classification ADD COLUMN control_plane_target_gate VARCHAR(160) NULL;
ALTER TABLE control_plane_classification ADD COLUMN control_plane_gate_verified_pass TINYINT(1) NULL;
ALTER TABLE control_plane_classification ADD COLUMN control_plane_root_accepted TINYINT(1) NULL;

-- Immutable classification receipt archive (idempotent by receipt id)
CREATE TABLE IF NOT EXISTS control_plane_classification_receipts (
  board_id VARCHAR(64) NOT NULL,
  receipt_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  membership_portfolio_id VARCHAR(160) NULL,
  membership_proof_hash CHAR(64) NULL,
  canonical_snapshot_id VARCHAR(64) NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  task_hash CHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  issued_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NULL,
  receipt_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, receipt_id),
  KEY idx_class_receipt_task (board_id, task_id),
  KEY idx_class_receipt_hash (board_id, receipt_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- DecisionV3 durable store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_decisions (
  board_id VARCHAR(64) NOT NULL,
  decision_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NULL,
  feature_id VARCHAR(160) NULL,
  task_id VARCHAR(160) NULL,
  run_id VARCHAR(160) NULL,
  type VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  title VARCHAR(400) NOT NULL,
  question TEXT NOT NULL,
  evidence_json JSON NULL,
  options_json JSON NOT NULL,
  agent_recommendation TEXT NULL,
  blocking TINYINT(1) NOT NULL DEFAULT 0,
  due_at DATETIME(3) NULL,
  due_at_ms BIGINT NULL,
  created_at DATETIME(3) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  snoozed_until DATETIME(3) NULL,
  snoozed_until_ms BIGINT NULL,
  status VARCHAR(32) NOT NULL,
  owner_id VARCHAR(160) NULL,
  resolver_id VARCHAR(160) NULL,
  selected_option_id VARCHAR(64) NULL,
  comment TEXT NULL,
  expected_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  scoped_approval_id VARCHAR(64) NULL,
  audit_ids_json JSON NULL,
  expires_at DATETIME(3) NULL,
  expires_at_ms BIGINT NULL,
  record_json JSON NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, decision_id),
  KEY idx_decisions_status (board_id, status, blocking),
  KEY idx_decisions_severity (board_id, severity),
  KEY idx_decisions_created (board_id, created_at_ms),
  KEY idx_decisions_task (board_id, task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Canonical import audit expand (receipt already in 001)
-- ---------------------------------------------------------------------------
ALTER TABLE control_plane_imports ADD COLUMN payload_sha256 CHAR(64) NULL;
ALTER TABLE control_plane_imports ADD COLUMN canonical_hash CHAR(64) NULL;
ALTER TABLE control_plane_imports ADD COLUMN board_rev BIGINT UNSIGNED NULL;
ALTER TABLE control_plane_imports ADD COLUMN lifecycle_rev BIGINT UNSIGNED NULL;
ALTER TABLE control_plane_imports ADD COLUMN entity_rev BIGINT UNSIGNED NULL;
ALTER TABLE control_plane_imports ADD COLUMN provenance_json JSON NULL;

-- ---------------------------------------------------------------------------
-- Immutable material audit for canonical import appendAudit (board-isolated)
-- Insert-once by (board_id, audit_id); content_hash enables exact-replay /
-- tamper-reject. Never stores secrets or private decision text.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_import_audit (
  board_id VARCHAR(64) NOT NULL,
  audit_id VARCHAR(64) NOT NULL,
  import_id VARCHAR(64) NULL,
  snapshot_id VARCHAR(64) NULL,
  event VARCHAR(64) NOT NULL,
  actor_id VARCHAR(160) NULL,
  payload_sha256 CHAR(64) NULL,
  canonical_hash CHAR(64) NULL,
  board_rev BIGINT UNSIGNED NULL,
  lifecycle_rev BIGINT UNSIGNED NULL,
  entity_rev BIGINT UNSIGNED NULL,
  content_hash CHAR(64) NOT NULL,
  captured_at DATETIME(3) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, audit_id),
  KEY idx_import_audit_import (board_id, import_id),
  KEY idx_import_audit_snapshot (board_id, snapshot_id),
  KEY idx_import_audit_captured (board_id, captured_at),
  KEY idx_import_audit_content (board_id, content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Snapshot payload already optional in 001; index for latest-by-board
ALTER TABLE control_plane_snapshots ADD KEY idx_snap_generated (board_id, generated_at);

-- Import pin lookup on board_revisions
ALTER TABLE board_revisions ADD KEY idx_board_rev_snapshot (last_snapshot_id);
ALTER TABLE board_revisions ADD KEY idx_board_rev_canonical (canonical_snapshot_id);

-- ---------------------------------------------------------------------------
-- Human display (versioned owner copy; board/entity scoped; never invent PRODUCT)
-- Schema step: TM_HUMAN_DISPLAY_PERSISTENCE_V1
-- REVIEWED rows are immutable per content_version; stale/missing → CONTENT_REVIEW_REQUIRED
-- at the application read path. Soft board_id isolation (no FK). No secrets columns.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_human_display (
  board_id VARCHAR(64) NOT NULL,
  entity_kind VARCHAR(32) NOT NULL,
  entity_id VARCHAR(160) NOT NULL,
  content_version INT UNSIGNED NOT NULL DEFAULT 1,
  locale VARCHAR(16) NOT NULL DEFAULT 'id-ID',
  review_status VARCHAR(48) NOT NULL,
  source_hash CHAR(64) NOT NULL,
  reviewed_at DATETIME(3) NULL,
  content_json JSON NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  schema_version VARCHAR(32) NOT NULL DEFAULT 'TM_HUMAN_DISPLAY_V1',
  content_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, entity_kind, entity_id),
  KEY idx_hd_review (board_id, review_status),
  KEY idx_hd_source (board_id, source_hash),
  KEY idx_hd_version (board_id, content_version),
  KEY idx_hd_entity_rev (board_id, entity_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable put/audit receipts for human display (insert-once by audit_id)
CREATE TABLE IF NOT EXISTS control_plane_human_display_audit (
  board_id VARCHAR(64) NOT NULL,
  audit_id VARCHAR(64) NOT NULL,
  entity_kind VARCHAR(32) NOT NULL,
  entity_id VARCHAR(160) NOT NULL,
  content_version INT UNSIGNED NOT NULL,
  event VARCHAR(64) NOT NULL,
  actor_id VARCHAR(160) NULL,
  source_hash CHAR(64) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  review_status VARCHAR(48) NOT NULL,
  entity_rev BIGINT UNSIGNED NULL,
  board_rev BIGINT UNSIGNED NULL,
  captured_at DATETIME(3) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, audit_id),
  KEY idx_hd_audit_entity (board_id, entity_kind, entity_id),
  KEY idx_hd_audit_content (board_id, content_hash),
  KEY idx_hd_audit_captured (board_id, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
