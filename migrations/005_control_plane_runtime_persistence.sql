-- 005_control_plane_runtime_persistence.sql
-- Classification: REVERSIBLE (additive tables only; drop-safe rollback of new objects)
-- Schema version step: TM_CONTROL_PLANE_RUNTIME_PERSISTENCE_V1
-- MySQL foundation for dispatch plans, V3 runs, collision/integration locks,
-- account sync/readbacks, reconciler leader/dryrun/apply, and retention policy.
-- Uses idempotency/revision/fencing columns. Soft board_id isolation (no FK).
-- Non-destructive: CREATE IF NOT EXISTS only. Never DROP/TRUNCATE; no secrets columns.
-- Note: control_plane_run_plans (001) remains legacy; V3 runs live in control_plane_runs.

-- ---------------------------------------------------------------------------
-- Dispatch plans (ROOT-only write at app layer; sole NEXT source)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_dispatch_plans (
  board_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(64) NOT NULL,
  plan_version INT UNSIGNED NOT NULL DEFAULT 1,
  plan_hash CHAR(64) NOT NULL,
  canonical_snapshot_id VARCHAR(64) NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  board_rev_at_publish BIGINT UNSIGNED NOT NULL DEFAULT 0,
  issued_at DATETIME(3) NOT NULL,
  issued_at_ms BIGINT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  stage VARCHAR(160) NULL,
  status VARCHAR(32) NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  generated_at_ms BIGINT NOT NULL,
  superseded_by_plan_id VARCHAR(64) NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  fencing_token VARCHAR(160) NULL,
  items_json JSON NOT NULL,
  record_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, plan_id),
  KEY idx_dispatch_status (board_id, status, generated_at_ms),
  KEY idx_dispatch_hash (board_id, plan_hash),
  KEY idx_dispatch_entity_rev (board_id, entity_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_dispatch_plan_items (
  board_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(64) NOT NULL,
  rank_n INT UNSIGNED NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  target_gate VARCHAR(160) NOT NULL,
  role VARCHAR(64) NOT NULL,
  selection_reason VARCHAR(400) NOT NULL,
  priority_portfolio_id VARCHAR(160) NULL,
  dependency_proof_json JSON NULL,
  collision_scope_lock_ids_json JSON NULL,
  expected_entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expected_board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, plan_id, rank_n),
  UNIQUE KEY uq_dispatch_item_task (board_id, plan_id, task_id),
  KEY idx_dispatch_item_task (board_id, task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- V3 runs (lease + fencing + heartbeat sequence; history in JSON)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_runs (
  board_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(160) NOT NULL,
  state VARCHAR(32) NOT NULL,
  plan_id VARCHAR(64) NULL,
  plan_item_rank INT UNSIGNED NULL,
  task_id VARCHAR(160) NOT NULL,
  target_gate VARCHAR(160) NOT NULL,
  role VARCHAR(64) NOT NULL,
  agent_id VARCHAR(160) NOT NULL,
  model VARCHAR(160) NOT NULL,
  effort VARCHAR(64) NOT NULL DEFAULT '',
  masked_account_ref VARCHAR(160) NULL,
  canonical_hash CHAR(64) NULL,
  collision_scope_lock_ids_json JSON NULL,
  fencing_token VARCHAR(160) NULL,
  fencing_version INT UNSIGNED NOT NULL DEFAULT 0,
  registered_at_ms BIGINT NULL,
  heartbeat_at_ms BIGINT NULL,
  lease_expires_at_ms BIGINT NULL,
  material_progress_at_ms BIGINT NULL,
  heartbeat_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expected_entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expected_board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
  stalled TINYINT(1) NOT NULL DEFAULT 0,
  history_json JSON NULL,
  last_heartbeat_response_json JSON NULL,
  controller_run_id VARCHAR(160) NULL,
  parent_run_id VARCHAR(160) NULL,
  idempotency_key VARCHAR(191) NULL,
  subject_hash CHAR(64) NULL,
  record_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, run_id),
  KEY idx_runs_state (board_id, state, lease_expires_at_ms),
  KEY idx_runs_task (board_id, task_id),
  KEY idx_runs_agent (board_id, agent_id),
  KEY idx_runs_fence (board_id, fencing_token),
  KEY idx_runs_idem (board_id, idempotency_key),
  KEY idx_runs_plan (board_id, plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Collision-scope locks (lease + fencing)
-- Multi-process invariant: at most one HELD lock per (board_id, scope_id).
-- Terminal history (RELEASED/EXPIRED/...) uses NULL active key so many rows OK.
-- MySQL 8 STORED generated + UNIQUE (NULLs not equal → history unrestricted).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_collision_locks (
  board_id VARCHAR(64) NOT NULL,
  lock_id VARCHAR(64) NOT NULL,
  scope_id VARCHAR(400) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  run_id VARCHAR(160) NOT NULL,
  agent_id VARCHAR(160) NOT NULL,
  role VARCHAR(64) NOT NULL,
  fencing_token VARCHAR(160) NOT NULL,
  fencing_version INT UNSIGNED NOT NULL DEFAULT 1,
  state VARCHAR(32) NOT NULL,
  lease_expires_at_ms BIGINT NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  released_at_ms BIGINT NULL,
  superseded_by_lock_id VARCHAR(64) NULL,
  supersedes_lock_id VARCHAR(64) NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  record_json JSON NULL,
  -- Active key: non-NULL only while HELD; UNIQUE enforces one HELD per board+scope.
  held_scope_key VARCHAR(400)
    GENERATED ALWAYS AS (CASE WHEN state = 'HELD' THEN scope_id ELSE NULL END) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, lock_id),
  UNIQUE KEY uq_collision_held_scope (board_id, held_scope_key),
  KEY idx_collision_scope (board_id, scope_id, state),
  KEY idx_collision_run (board_id, run_id),
  KEY idx_collision_fence (board_id, fencing_token),
  KEY idx_collision_lease (board_id, state, lease_expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Integration locks (exactly one live COMMIT_INTEGRATE per repo+branch)
-- Multi-process invariant: at most one HELD per (board_id, repo_id, tracking_branch).
-- Terminal history: held_* generated columns NULL → multiple history rows allowed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_integration_locks (
  board_id VARCHAR(64) NOT NULL,
  lock_id VARCHAR(64) NOT NULL,
  repo_id VARCHAR(160) NOT NULL,
  tracking_branch VARCHAR(255) NOT NULL,
  run_id VARCHAR(160) NOT NULL,
  agent_id VARCHAR(160) NOT NULL,
  integrator_model VARCHAR(160) NOT NULL,
  root_acceptance_id VARCHAR(160) NOT NULL,
  checkpoint_id VARCHAR(160) NOT NULL,
  pathspecs_json JSON NOT NULL,
  fencing_token VARCHAR(160) NOT NULL,
  fencing_version INT UNSIGNED NOT NULL DEFAULT 1,
  state VARCHAR(32) NOT NULL,
  lease_expires_at_ms BIGINT NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  released_at_ms BIGINT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  record_json JSON NULL,
  held_repo_id VARCHAR(160)
    GENERATED ALWAYS AS (CASE WHEN state = 'HELD' THEN repo_id ELSE NULL END) STORED,
  held_tracking_branch VARCHAR(255)
    GENERATED ALWAYS AS (CASE WHEN state = 'HELD' THEN tracking_branch ELSE NULL END) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, lock_id),
  UNIQUE KEY uq_integration_held_repo_branch (board_id, held_repo_id, held_tracking_branch),
  KEY idx_integration_repo_branch (board_id, repo_id, tracking_branch, state),
  KEY idx_integration_fence (board_id, fencing_token),
  KEY idx_integration_lease (board_id, state, lease_expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Account sync snapshots + multi-surface readbacks (masked only — no secrets)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_account_snapshots (
  board_id VARCHAR(64) NOT NULL,
  source_revision BIGINT UNSIGNED NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  generated_at_ms BIGINT NOT NULL,
  published_at_ms BIGINT NOT NULL,
  last_periodic_health_at_ms BIGINT NULL,
  stale TINYINT(1) NOT NULL DEFAULT 0,
  stale_reason VARCHAR(160) NULL,
  usable_capacity INT NOT NULL DEFAULT 0,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  accounts_json JSON NOT NULL,
  capacity_json JSON NULL,
  readback_surfaces_json JSON NULL,
  record_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id),
  KEY idx_account_snap_rev (board_id, source_revision),
  KEY idx_account_snap_stale (board_id, stale)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_account_readbacks (
  board_id VARCHAR(64) NOT NULL,
  surface VARCHAR(16) NOT NULL,
  source_revision BIGINT UNSIGNED NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  generated_at_ms BIGINT NOT NULL,
  recorded_at_ms BIGINT NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (board_id, surface),
  KEY idx_account_readback_rev (board_id, source_revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Reconciler: single-leader fencing, dry-run store, last-apply hash, task flags
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_reconciler_leaders (
  board_id VARCHAR(64) NOT NULL,
  leader_id VARCHAR(160) NOT NULL,
  fencing_token VARCHAR(160) NOT NULL,
  lease_expires_at_ms BIGINT NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id),
  KEY idx_reconciler_leader_fence (board_id, fencing_token),
  KEY idx_reconciler_leader_lease (lease_expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_reconciler_dryruns (
  board_id VARCHAR(64) NOT NULL,
  dry_run_hash CHAR(64) NOT NULL,
  dry_run_id VARCHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  leader_token VARCHAR(160) NOT NULL,
  cursor_val VARCHAR(255) NULL,
  next_cursor VARCHAR(255) NULL,
  max_actions INT UNSIGNED NOT NULL,
  time_budget_ms INT UNSIGNED NOT NULL,
  items_json JSON NOT NULL,
  counts_json JSON NOT NULL,
  generated_at_ms BIGINT NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  record_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, dry_run_hash),
  KEY idx_reconciler_dryrun_id (board_id, dry_run_id),
  KEY idx_reconciler_dryrun_gen (board_id, generated_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_reconciler_apply (
  board_id VARCHAR(64) NOT NULL,
  last_apply_dry_run_hash CHAR(64) NOT NULL,
  applied_at_ms BIGINT NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  fencing_token VARCHAR(160) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_reconciler_task_flags (
  board_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  completed TINYINT(1) NOT NULL DEFAULT 0,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, task_id),
  KEY idx_reconciler_task_completed (board_id, completed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Retention policy + hot run state (heartbeat mutates hot only; no secrets)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_plane_retention_policies (
  board_id VARCHAR(64) NOT NULL,
  policy_id VARCHAR(160) NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  heartbeat_sample_interval INT UNSIGNED NOT NULL,
  hot_state_retention_ms BIGINT NOT NULL,
  sampled_event_retention_ms BIGINT NOT NULL,
  rollup_retention_ms BIGINT NOT NULL,
  compaction_interval_ms BIGINT NOT NULL,
  approved_for_json JSON NOT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  record_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id),
  KEY idx_retention_policy_id (policy_id, policy_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_retention_hot_state (
  board_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(160) NOT NULL,
  last_heartbeat_at_ms BIGINT NOT NULL,
  heartbeat_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(64) NOT NULL,
  material_progress_at_ms BIGINT NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  fencing_token VARCHAR(160) NULL,
  record_json JSON NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, run_id),
  KEY idx_retention_hot_board (board_id, last_heartbeat_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS control_plane_retention_audit_sample (
  board_id VARCHAR(64) NOT NULL,
  audit_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(160) NULL,
  event_class VARCHAR(32) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  at_ms BIGINT NOT NULL,
  immutable TINYINT(1) NOT NULL DEFAULT 0,
  payload_json JSON NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, audit_id),
  KEY idx_retention_audit_class (board_id, event_class, at_ms),
  KEY idx_retention_audit_immutable (board_id, immutable, at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
