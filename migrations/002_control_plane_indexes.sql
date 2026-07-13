-- 002_control_plane_indexes.sql
-- Classification: EXPAND_CONTRACT_BACKWARD_COMPATIBLE
-- Indexes/constraints for tenant/board isolation, revisions, cursor, idempotency.
-- Non-destructive: ADD INDEX / UNIQUE only; no DROP of legacy keys.

-- Tasks: classification + lifecycle filters under board isolation
ALTER TABLE tasks ADD KEY idx_tasks_class (board_id, task_class, disposition);
ALTER TABLE tasks ADD KEY idx_tasks_lifecycle_rev (board_id, lifecycle_stage, entity_rev);
ALTER TABLE tasks ADD KEY idx_tasks_cursor (board_id, created_at, id);
ALTER TABLE tasks ADD KEY idx_tasks_board_rev (board_id, board_rev);

-- Entity revisions lookup by subject hash
ALTER TABLE entity_revisions ADD KEY idx_entity_rev_hash (board_id, subject_hash);

-- Snapshots by board revision
ALTER TABLE control_plane_snapshots ADD KEY idx_snap_board_rev (board_id, board_rev);
ALTER TABLE control_plane_snapshots ADD KEY idx_snap_payload (payload_sha256);

-- Imports by snapshot / status
ALTER TABLE control_plane_imports ADD KEY idx_import_snapshot (board_id, snapshot_id);
ALTER TABLE control_plane_imports ADD KEY idx_import_created (board_id, created_at);

-- Idempotency TTL sweep + run lookup (unique scopes already in expand)
ALTER TABLE control_plane_idempotency ADD KEY idx_idem_expires (expires_at);
ALTER TABLE control_plane_idempotency ADD KEY idx_idem_board_created (board_id, created_at);

-- Evidence by entity / domain / stage
ALTER TABLE control_plane_evidence ADD KEY idx_evidence_entity (board_id, entity_type, entity_id);
ALTER TABLE control_plane_evidence ADD KEY idx_evidence_domain (board_id, domain, stage_key);
ALTER TABLE control_plane_evidence ADD KEY idx_evidence_subject (board_id, subject_hash);

-- G5 domain status
ALTER TABLE control_plane_g5 ADD KEY idx_g5_status (board_id, status);

-- Run plans by board rev / status
ALTER TABLE control_plane_run_plans ADD KEY idx_run_plan_rev (board_id, board_rev);
ALTER TABLE control_plane_run_plans ADD KEY idx_run_plan_status (board_id, status);

-- Classification ledger
ALTER TABLE control_plane_classification ADD KEY idx_class_task_class (board_id, task_class, disposition);
ALTER TABLE control_plane_classification ADD KEY idx_class_receipt (board_id, classification_receipt_id);

-- Audit preserved; ensure board isolation index exists (legacy may already have idx_board)
ALTER TABLE audit_log ADD KEY idx_audit_board_ts (board_id, ts);
