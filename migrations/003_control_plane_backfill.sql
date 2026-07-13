-- 003_control_plane_backfill.sql
-- Classification: FORWARD_FIX_ONLY (data transform; re-run is idempotent via WHERE guards)
-- Source-grounded backfill: missing proof remains UNCLASSIFIED; NEVER set PRODUCT.
-- No production-derived fixture content.

-- Seed board_revisions for boards that already exist (start at 1)
INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id)
SELECT b.id, 1, 1, NULL, NULL
FROM boards b
WHERE NOT EXISTS (
  SELECT 1 FROM board_revisions br WHERE br.board_id = b.id
);

-- Backfill task classification defaults only where still null-ish / default path.
-- MySQL: columns already DEFAULT 'UNCLASSIFIED' from expand; force any empty string to UNCLASSIFIED.
UPDATE tasks
SET task_class = 'UNCLASSIFIED'
WHERE task_class IS NULL OR task_class = '';

UPDATE tasks
SET disposition = 'UNCLASSIFIED'
WHERE disposition IS NULL OR disposition = '';

-- Monotonic entity rev: existing `rev` column (legacy optimistic lock) seeds entity_rev when still 1/default
UPDATE tasks
SET entity_rev = GREATEST(COALESCE(entity_rev, 1), COALESCE(rev, 0) + 1)
WHERE entity_rev IS NULL OR entity_rev < 1 OR (rev IS NOT NULL AND entity_rev < (rev + 1));

-- created_at for cursor: prefer updated parse when available; else leave NULL (cursor rejects incomplete rows)
-- Do not invent timestamps from production fixtures; only normalize empty to NULL.
UPDATE tasks
SET created_at = NULL
WHERE created_at IS NOT NULL AND created_at = '0000-00-00 00:00:00.000';

-- Mirror classification into control_plane_classification without promoting class
INSERT INTO control_plane_classification (
  board_id, task_id, task_class, disposition,
  classification_receipt_id, classification_receipt_hash,
  proof_source, board_rev, entity_rev
)
SELECT
  t.board_id,
  t.id,
  COALESCE(NULLIF(t.task_class, ''), 'UNCLASSIFIED'),
  COALESCE(NULLIF(t.disposition, ''), 'UNCLASSIFIED'),
  t.classification_receipt_id,
  t.classification_receipt_hash,
  CASE
    WHEN t.classification_receipt_hash IS NULL OR t.classification_receipt_hash = '' THEN 'MISSING_PROOF'
    ELSE 'EXISTING_RECEIPT'
  END,
  t.board_rev,
  COALESCE(t.entity_rev, 1)
FROM tasks t
WHERE NOT EXISTS (
  SELECT 1 FROM control_plane_classification c
  WHERE c.board_id = t.board_id AND c.task_id = t.id
);

-- Reject path is application-side (migrations runner backfill contract):
-- duplicate joins / conflicting ownership / cycles / stale data must fail dry-run.
-- SQL here never silently repairs those cases.
