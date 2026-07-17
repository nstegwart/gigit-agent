-- 012_ultimate_map.sql
-- Classification: REVERSIBLE (additive ultimate page/API/nav knowledge layer only)
-- Safe expand: NEW tables for app pages, API endpoints, page↔API links, nav edges,
-- and knowledge aliases (EN↔ID). Also ensures 011 flow tables exist (IF NOT EXISTS)
-- so a host that skipped 011 still gets the Workflow foundation before ultimate map.
-- Does NOT alter product_features / feature_task_map (010).
-- Does NOT alter pin/lifecycle/classification tables.
-- feature_id on app_pages is a soft reference to product_features.feature_id
-- (nullable; no hard FK) so unmapped pages stay honest.
-- Rollback is forward-compatible: leave unused tables in place and roll the app back.
-- Destructive DROP is never part of the automated rollback path.
-- SPEC: W-TM-INGEST / owner ultimate map upload path (staging-safe)

-- ─── 011 flow tables (idempotent re-declare) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS app_flow_nodes (
  project_id VARCHAR(64) NOT NULL,
  node_id VARCHAR(160) NOT NULL,
  feature_id VARCHAR(160) NULL,
  label_id VARCHAR(512) NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'screen',
  sort_order INT NOT NULL DEFAULT 0,
  layout_col INT NOT NULL DEFAULT 0,
  layout_row INT NOT NULL DEFAULT 0,
  source_ref VARCHAR(512) NULL,
  meta_json JSON NULL,
  PRIMARY KEY (project_id, node_id),
  KEY idx_afn_feature_id (feature_id),
  KEY idx_afn_project_kind (project_id, kind),
  KEY idx_afn_project_sort (project_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_flow_edges (
  project_id VARCHAR(64) NOT NULL,
  edge_id VARCHAR(191) NOT NULL,
  from_node VARCHAR(160) NOT NULL,
  to_node VARCHAR(160) NOT NULL,
  edge_kind VARCHAR(64) NOT NULL DEFAULT 'nav',
  sort_order INT NOT NULL DEFAULT 0,
  meta_json JSON NULL,
  PRIMARY KEY (project_id, edge_id),
  KEY idx_afe_from (project_id, from_node),
  KEY idx_afe_to (project_id, to_node),
  KEY idx_afe_kind (project_id, edge_kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 012 ultimate map tables ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_pages (
  id VARCHAR(191) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  label_id VARCHAR(512) NOT NULL,
  route VARCHAR(1024) NOT NULL,
  area VARCHAR(512) NULL,
  feature_id VARCHAR(160) NULL,
  source_hash CHAR(64) NOT NULL,
  extracted_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ap_project (project_id),
  KEY idx_ap_feature_id (feature_id),
  KEY idx_ap_source_hash (source_hash),
  KEY idx_ap_project_area (project_id, area(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_endpoints (
  id VARCHAR(191) NOT NULL,
  method VARCHAR(16) NOT NULL,
  path VARCHAR(1024) NOT NULL,
  domain_id VARCHAR(191) NULL,
  label_id VARCHAR(512) NULL,
  repo VARCHAR(191) NULL,
  source_hash CHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ae_method_path (method, path(191)),
  KEY idx_ae_domain (domain_id),
  KEY idx_ae_repo (repo),
  KEY idx_ae_source_hash (source_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS page_api_calls (
  page_id VARCHAR(191) NOT NULL,
  endpoint_id VARCHAR(191) NOT NULL,
  evidence TEXT NULL,
  PRIMARY KEY (page_id, endpoint_id),
  KEY idx_pac_endpoint (endpoint_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS nav_edges (
  from_page VARCHAR(191) NOT NULL,
  to_page VARCHAR(191) NOT NULL,
  PRIMARY KEY (from_page, to_page),
  KEY idx_ne_to (to_page)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_aliases (
  alias VARCHAR(512) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(191) NOT NULL,
  PRIMARY KEY (alias(191)),
  KEY idx_ka_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
