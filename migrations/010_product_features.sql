-- 010_product_features.sql
-- Classification: REVERSIBLE (additive product-feature taxonomy layer only)
-- Safe expand: two NEW tables for FEAT-* product features + task join map.
-- Does NOT alter pin/lifecycle/classification tables (639 board pin untouched).
-- Does NOT alter rebuild lineage tables from 009.
-- Rollback is forward-compatible: leave unused tables in place and roll the app back.
-- Destructive DROP is never part of the automated rollback path.
-- SPEC: TM-KOMPAT-VISUAL V1 ADDENDUM V1.1 §B

CREATE TABLE IF NOT EXISTS product_features (
  feature_id VARCHAR(160) NOT NULL,
  nama_id VARCHAR(512) NOT NULL,
  domain_bisnis VARCHAR(191) NOT NULL,
  ringkasan_id TEXT NULL,
  platform_json JSON NULL,
  capabilities_json JSON NULL,
  fc_refs_json JSON NULL,
  curated TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (feature_id),
  KEY idx_pf_domain_bisnis (domain_bisnis),
  KEY idx_pf_curated (curated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feature_task_map (
  feature_id VARCHAR(160) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  join_source VARCHAR(32) NOT NULL,
  confidence DECIMAL(4,3) NOT NULL,
  PRIMARY KEY (feature_id, task_id),
  KEY idx_ftm_feature_id (feature_id),
  KEY idx_ftm_task_id (task_id),
  KEY idx_ftm_join_source (join_source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
