-- 001_control_plane_expand.sql
-- Classification: REVERSIBLE (additive columns/tables only; drop-safe rollback of new objects)
-- Schema version step: TM_CONTROL_PLANE_V3_EXPAND
-- Non-destructive expand: never DROP/TRUNCATE production data; never guess PRODUCT.

-- Migration history (idempotent via IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  classification VARCHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  applied_by VARCHAR(160) NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (version),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Board-level monotonic revision + pinned snapshot identity
CREATE TABLE IF NOT EXISTS board_revisions (
  board_id VARCHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  lifecycle_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  canonical_snapshot_id VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-entity monotonic revisions (task / run / decision / lock / …)
CREATE TABLE IF NOT EXISTS entity_revisions (
  board_id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(160) NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Canonical snapshot registry (pinned aggregation identity)
CREATE TABLE IF NOT EXISTS control_plane_snapshots (
  board_id VARCHAR(64) NOT NULL,
  snapshot_id VARCHAR(64) NOT NULL,
  schema_version VARCHAR(64) NOT NULL,
  source_repo_id VARCHAR(160) NULL,
  source_commit_sha CHAR(64) NULL,
  payload_sha256 CHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  producer_version VARCHAR(64) NULL,
  payload_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, snapshot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Import receipts (fail-closed import audit; no secrets)
CREATE TABLE IF NOT EXISTS control_plane_imports (
  board_id VARCHAR(64) NOT NULL,
  import_id VARCHAR(64) NOT NULL,
  snapshot_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  actor_id VARCHAR(160) NULL,
  request_hash CHAR(64) NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 0,
  error_code VARCHAR(64) NULL,
  error_detail JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, import_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotency ledger: scope = actor + board + endpoint + key
-- Stores only status + body hash/redacted envelope — never secrets/private payloads.
CREATE TABLE IF NOT EXISTS control_plane_idempotency (
  scope_hash CHAR(64) NOT NULL,
  actor_id VARCHAR(160) NOT NULL,
  board_id VARCHAR(64) NOT NULL,
  endpoint VARCHAR(160) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INT NOT NULL,
  response_body_json JSON NULL,
  run_id VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (scope_hash),
  UNIQUE KEY uq_idem_scope (actor_id, board_id, endpoint, idempotency_key),
  UNIQUE KEY uq_idem_run (board_id, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Evidence receipts for lifecycle / G5 (program-emitted; no hand-typed PASS)
CREATE TABLE IF NOT EXISTS control_plane_evidence (
  board_id VARCHAR(64) NOT NULL,
  evidence_id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(160) NOT NULL,
  domain VARCHAR(64) NULL,
  stage_key VARCHAR(64) NULL,
  receipt_kind VARCHAR(64) NOT NULL,
  subject_hash CHAR(64) NOT NULL,
  subject_entity_rev BIGINT UNSIGNED NULL,
  subject_board_rev BIGINT UNSIGNED NULL,
  verifier_agent_id VARCHAR(160) NULL,
  verifier_model VARCHAR(160) NULL,
  verifier_run_id VARCHAR(160) NULL,
  verdict VARCHAR(32) NOT NULL,
  findings_json JSON NULL,
  captured_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, evidence_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- G5 nine-domain status (server-derived; g5Pass never client-writable)
CREATE TABLE IF NOT EXISTS control_plane_g5 (
  board_id VARCHAR(64) NOT NULL,
  domain VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  required TINYINT(1) NOT NULL DEFAULT 1,
  evidence_id VARCHAR(64) NULL,
  subject_hash CHAR(64) NULL,
  board_rev BIGINT UNSIGNED NULL,
  lifecycle_rev BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Run / dispatch plan support for C2 (structure only; empty until wired)
CREATE TABLE IF NOT EXISTS control_plane_run_plans (
  board_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  plan_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  dry_run_hash CHAR(64) NULL,
  payload_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Classification ledger (source-grounded; default UNCLASSIFIED; never guessed PRODUCT)
CREATE TABLE IF NOT EXISTS control_plane_classification (
  board_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  classification_receipt_id VARCHAR(64) NULL,
  classification_receipt_hash CHAR(64) NULL,
  proof_source VARCHAR(160) NULL,
  board_rev BIGINT UNSIGNED NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Expand tasks with V3 classification + revision columns (idempotent ADD via runner)
-- Legacy scope/phase remain namespaced/non-authoritative (never drive readiness).
-- Runner applies each ALTER with duplicate-column tolerance (errno 1060).
ALTER TABLE tasks ADD COLUMN task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED';
ALTER TABLE tasks ADD COLUMN disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED';
ALTER TABLE tasks ADD COLUMN classification_receipt_id VARCHAR(64) NULL;
ALTER TABLE tasks ADD COLUMN classification_receipt_hash CHAR(64) NULL;
ALTER TABLE tasks ADD COLUMN board_rev BIGINT UNSIGNED NULL;
ALTER TABLE tasks ADD COLUMN lifecycle_rev BIGINT UNSIGNED NULL;
ALTER TABLE tasks ADD COLUMN entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN subject_hash CHAR(64) NULL;
ALTER TABLE tasks ADD COLUMN created_at DATETIME(3) NULL;
ALTER TABLE tasks ADD COLUMN v3_namespace JSON NULL;

-- Expand board_docs with optional revision pin (legacy data JSON remains authoritative for current readers)
ALTER TABLE board_docs ADD COLUMN board_rev BIGINT UNSIGNED NULL;
ALTER TABLE board_docs ADD COLUMN subject_hash CHAR(64) NULL;
ALTER TABLE board_docs ADD COLUMN updated_at DATETIME(3) NULL;
