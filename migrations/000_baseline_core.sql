-- 000_baseline_core.sql
-- Classification: REVERSIBLE (additive CREATE IF NOT EXISTS only; no DROP/TRUNCATE)
-- Schema version step: TM_BASELINE_CORE_PRE_EXPAND
-- Greenfield prerequisite for 001_control_plane_expand: tables that 001 ALTERs
-- (tasks, board_docs) and that 003 seeds from (boards), plus audit_log + migration ledger.
-- Grounded exactly in tests/unit BASE_DDL / ensureBaselineTables pre-expand columns.
-- Non-destructive: IF NOT EXISTS only; never guesses PRODUCT; safe on existing DBs.

-- Migration history ledger (required so recordApplied after 000 succeeds on empty DB).
-- 001 also CREATE IF NOT EXISTS this table — re-apply is a no-op.
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

-- Boards (003 backfill seeds board_revisions FROM boards)
CREATE TABLE IF NOT EXISTS boards (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  views JSON NULL,
  created_at VARCHAR(32) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tasks pre-expand (legacy cols through last_receipt_at; 001 ADDs V3 columns)
CREATE TABLE IF NOT EXISTS tasks (
  board_id VARCHAR(64) NOT NULL,
  id VARCHAR(160) NOT NULL,
  project_id VARCHAR(64) NULL,
  feature_contract_id VARCHAR(160) NULL,
  grp VARCHAR(191) NULL,
  phase VARCHAR(191) NULL,
  scope VARCHAR(64) NULL,
  title TEXT NULL,
  updated VARCHAR(40) NULL,
  summary JSON NULL,
  data JSON NULL,
  lifecycle_stage VARCHAR(64) NULL,
  implementer_run VARCHAR(160) NULL,
  rev INT NOT NULL DEFAULT 0,
  lifecycle JSON NULL,
  blocked_reason VARCHAR(400) NULL,
  last_receipt_at VARCHAR(40) NULL,
  PRIMARY KEY (board_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Board docs (001 ADDs board_rev / subject_hash / updated_at)
CREATE TABLE IF NOT EXISTS board_docs (
  board_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (board_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit log (baseline control-center; not altered by 001)
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  board_id VARCHAR(64) NOT NULL,
  ts VARCHAR(40) NOT NULL,
  actor VARCHAR(160) NULL,
  action VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NULL,
  from_stage VARCHAR(64) NULL,
  to_stage VARCHAR(64) NULL,
  detail JSON NULL,
  PRIMARY KEY (id),
  KEY idx_board (board_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
