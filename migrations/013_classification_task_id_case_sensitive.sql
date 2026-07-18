-- 013_classification_task_id_case_sensitive.sql
-- Classification: FORWARD_FIX_ONLY
-- Schema version step: TM_CLASSIFICATION_TASK_ID_CASE_SENSITIVE
--
-- Root cause (CLASS_TASK_ID_COLLATION_CI):
--   control_plane_classification uses PRIMARY KEY (board_id, task_id) with
--   task_id under utf8mb4_unicode_ci. Case-distinct canonical definition IDs
--   (e.g. T-AFFILIATE-ASSET-LIBRARY-PUBLISHING vs
--   T-AFFILIATE-asset-library-publishing) collapse to one PK slot. Complete-set
--   classification sync then cannot materialize all definition IDs; UPSERT
--   ON DUPLICATE KEY UPDATE overwrites receipt_json without rewriting PK task_id,
--   producing MISSING_RECORD + RECEIPT_TASK_MISMATCH pairs.
--
-- Fix:
--   Make live classification task identity case-sensitive/binary via utf8mb4_bin
--   on task_id for the overlay ledger and the receipt archive task_id column.
--   Does NOT rewrite canonical definition IDs, classification values, receipt
--   payloads, board_rev / entity_rev CAS, or complete-set sync semantics.
--   Does NOT ad-hoc repair collapsed overlay rows (post-schema complete-set
--   sync remains the repair path).
--
-- Related objects inspected (no FK on task_id; no other unique that collapses
-- live overlay identity beyond the composite PK):
--   - control_plane_classification: PK (board_id, task_id) — primary fix target
--   - control_plane_classification: KEY idx_class_task_class / idx_class_receipt
--     (do not include task_id; unchanged)
--   - control_plane_classification_receipts: PK (board_id, receipt_id) already
--     allows both casings; KEY idx_class_receipt_task (board_id, task_id) is
--     secondary lookup only — still MODIFY task_id so joins/lookups are exact
--
-- Precondition (fail-closed, ~2499-row production overlay is safe):
--   For each board_id, stored task_id values must have
--   COUNT(DISTINCT task_id COLLATE utf8mb4_bin) =
--   COUNT(DISTINCT task_id COLLATE utf8mb4_unicode_ci).
--   Under the current CI PK, binary-distinct CI-colliding pairs cannot coexist
--   as separate rows, so MODIFY rebuilds cleanly. If a hand-edited DB violates
--   this, InnoDB raises ER_DUP_ENTRY on PK rebuild — do not force-apply or
--   delete rows here.
--
-- Idempotency: re-running MODIFY to the same utf8mb4_bin definition succeeds
--   (no-op metadata rewrite). Compatible with runner duplicate-column tolerance
--   for other expands; this file uses MODIFY only (no ADD COLUMN).
--
-- Rollback: FORWARD_FIX_ONLY. Reversing to unicode_ci re-collapses identity and
--   is unsafe once case-distinct rows exist. No down migration is registered.

ALTER TABLE control_plane_classification
  MODIFY COLUMN task_id VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

ALTER TABLE control_plane_classification_receipts
  MODIFY COLUMN task_id VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
