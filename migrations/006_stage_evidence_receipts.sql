-- 006_stage_evidence_receipts.sql
-- Classification: REVERSIBLE (additive table only; drop-safe rollback of new object)
-- Schema version step: TM_STAGE_EVIDENCE_RECEIPTS_V1
-- Immutable program-emitted lifecycle stage-evidence receipt registry.
-- advance_task accepts only receiptId+hash that exists here (no self-created promotion).
-- Never stores secrets; no FOREIGN KEY; insert-once by (board_id, receipt_id).

CREATE TABLE IF NOT EXISTS control_plane_stage_evidence_receipts (
  board_id VARCHAR(64) NOT NULL,
  receipt_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  to_stage VARCHAR(32) NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  emitting_run_id VARCHAR(160) NOT NULL,
  programmatic TINYINT(1) NOT NULL DEFAULT 1,
  task_hash CHAR(64) NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  author_run_id VARCHAR(160) NULL,
  verifier_run_id VARCHAR(160) NULL,
  verdict VARCHAR(32) NULL,
  issued_at DATETIME(3) NOT NULL,
  registered_at DATETIME(3) NOT NULL,
  fields_json JSON NOT NULL,
  receipt_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, receipt_id),
  KEY idx_stage_ev_task (board_id, task_id),
  KEY idx_stage_ev_hash (board_id, receipt_hash),
  KEY idx_stage_ev_stage (board_id, to_stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
