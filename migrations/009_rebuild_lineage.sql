-- 009_rebuild_lineage.sql
-- Classification: REVERSIBLE (additive rebuild lineage layer only)
-- Safe expand: four NEW tables for rebuild parity/lineage/feature directory.
-- Does NOT alter pin/lifecycle/classification tables (639 board pin untouched).
-- Rollback is forward-compatible: leave unused tables in place and roll the app back.
-- Destructive DROP is never part of the automated rollback path.

CREATE TABLE IF NOT EXISTS rebuild_lineage_records (
  board_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  disposition VARCHAR(32) NULL,
  repository VARCHAR(191) NULL,
  origin VARCHAR(64) NULL,
  feature_contract_id VARCHAR(160) NULL,
  parity_verdict VARCHAR(64) NULL,
  acceptance_covered VARCHAR(64) NULL,
  verifier_model VARCHAR(128) NULL,
  verified_at DATETIME(3) NULL,
  stage1_json JSON NULL,
  evidence_json JSON NULL,
  gaps_json JSON NULL,
  implementation_json JSON NULL,
  source_hash CHAR(64) NOT NULL,
  synced_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_id, task_id),
  KEY idx_rlr_task_id (task_id),
  KEY idx_rlr_feature_contract_id (feature_contract_id),
  KEY idx_rlr_parity_verdict (parity_verdict),
  KEY idx_rlr_board_origin (board_id, origin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parity_rollups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  captured_at DATETIME(3) NOT NULL,
  mapped_100 INT UNSIGNED NOT NULL DEFAULT 0,
  partial_n INT UNSIGNED NOT NULL DEFAULT 0,
  missing_n INT UNSIGNED NOT NULL DEFAULT 0,
  pending_n INT UNSIGNED NOT NULL DEFAULT 0,
  l0_n INT UNSIGNED NOT NULL DEFAULT 0,
  measured_n INT UNSIGNED NOT NULL DEFAULT 0,
  total_n INT UNSIGNED NOT NULL DEFAULT 2501,
  source_file VARCHAR(512) NULL,
  raw_text MEDIUMTEXT NULL,
  source_hash CHAR(64) NULL,
  PRIMARY KEY (id),
  KEY idx_parity_rollups_captured_at (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feature_units (
  unit_id VARCHAR(160) NOT NULL,
  feature_contract_id VARCHAR(160) NULL,
  unit_type VARCHAR(64) NULL,
  identifier VARCHAR(512) NULL,
  anchor VARCHAR(512) NULL,
  notes TEXT NULL,
  coverage_status VARCHAR(64) NULL,
  repo VARCHAR(191) NULL,
  source_hash CHAR(64) NULL,
  synced_at DATETIME(3) NULL,
  PRIMARY KEY (unit_id),
  KEY idx_fu_feature_contract_id (feature_contract_id),
  KEY idx_fu_unit_type (unit_type),
  KEY idx_fu_repo (repo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feature_directory (
  feature_contract_id VARCHAR(160) NOT NULL,
  judul_id VARCHAR(512) NULL,
  domain_bisnis VARCHAR(191) NULL,
  ringkasan_id TEXT NULL,
  doc_md MEDIUMTEXT NULL,
  delivery_status VARCHAR(64) NULL,
  links_json JSON NULL,
  source_hash CHAR(64) NOT NULL,
  synced_at DATETIME(3) NULL,
  PRIMARY KEY (feature_contract_id),
  KEY idx_fd_domain_bisnis (domain_bisnis),
  KEY idx_fd_delivery_status (delivery_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
