-- 011_feature_flow_edges.sql
-- Classification: REVERSIBLE (additive app-flow nav graph layer only)
-- Safe expand: two NEW tables for per-project navigation Workflow graphs.
-- Does NOT alter product_features / feature_task_map (010) or pin/lifecycle tables.
-- Does NOT alter rebuild lineage tables from 009.
-- feature_id is a soft reference to product_features.feature_id (nullable; no hard FK)
-- so unmapped screens can exist honestly as kind=screen without a product feature.
-- Rollback is forward-compatible: leave unused tables in place and roll the app back.
-- Destructive DROP is never part of the automated rollback path.
-- SPEC: W-FLOW-AUDIT G2 / F2-WF-0 data foundation

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
