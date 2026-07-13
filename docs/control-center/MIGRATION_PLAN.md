# Migration Plan (C0 Design Freeze)

**Document class:** DESIGN CONTRACT
**Checkpoint:** C0
**Schema version:** `TM_MIGRATION_PLAN_V1`
**Source SHA:** `3c8a855dabd68a1d8a701597da16969756ee6511`

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this document |
|---|---|
| **DESIGN CONTRACT** | Binding. Normative. |
| **Implemented / runtime proof** | **Not claimed** by C0 docs alone. |

### Explicit non-claims

- Staging gate only: `TASK_MANAGER_STAGING_VERIFIED`
- Live: `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`
- No live P0 PASS, no mass-refill unlock, no FABLE PASS
- Production / public-consumer writes excluded
- Synthetic staging default without dual approvals
- Production HTTP 502 / historical open-read MCP = G0 **observed facts**, not implementation success


## 1. Principles

- Versioned, **non-destructive**, expand-then-contract where possible.
- Never guess PRODUCT classification.
- Legacy static fields remain namespaced and **never drive readiness**.
- Preserve audit/receipts and tenant isolation.
- **No production migration** without separate owner approval.
- Staging uses **synthetic fixtures** unless dual approvals present.

## 2. Lifecycle enum identity evidence (G0)

| Artifact | Result |
|---|---|
| LIVE_LIFECYCLE_ENUM.json | 9 states match V3 rail |
| PROPOSED_LIFECYCLE_ENUM.json | Same 9 states + weights |
| LIFECYCLE_ENUM_DIFF.json | identityStates=9; blockingAmbiguity=false |
| LIFECYCLE_MAPPING_V1.json | All rows type IDENTITY |

Canonical stages: `MAPPING`, `MAPPED`, `MAP_VERIFIED`, `BUILT`, `FUNCTIONAL`, `INTEGRATED`, `STAGING_PROVEN`, `PROD_READY`, `LIVE_VERIFIED`.

### Ambiguity rule

| Mapping type | Action |
|---|---|
| IDENTITY | Preserve value; strengthen receipts/revisions later |
| RENAME | Explicit map table + dual-write period |
| SPLIT / MERGE / UNMAPPED | **Block migration** until root Decision; never ad-hoc rewrite |
| Legacy-only | Decision required |

## 3. Exact versioned sequence

| Step | Action | Stop if |
|---|---|---|
| 1 | Schema dry-run | Dry-run errors |
| 2 | Live enum diff/mapping approval | Ambiguity or missing artifacts |
| 3 | Add UNCLASSIFIED fields (`taskClass`, `disposition`, classification receipt) | Constraint fail |
| 4 | Constraints/indexes (boardRev, lifecycleRev, unique task IDs, lock keys) | Index fail |
| 5 | Backfill dry-run | Unexpected row explosion |
| 6 | Before snapshot (disposable staging DB dump) | Snapshot fail |
| 7 | Staging apply | Apply fail → restore snapshot |
| 8 | Source-grounded classification backfill | Any guessed PRODUCT |
| 9 | Duplicate-join / cycle validation | DATA_INTEGRITY hits unhandled |
| 10 | Stale reconcile dry-run/apply | dryRunHash mismatch |
| 11 | Parity (counts/hashes/revisions) | Parity fail |
| 12 | Idempotency rerun | Second apply not no-op |
| 13 | Prior-SHA rollback rehearsal | Rollback fail |
| 14 | Current-SHA restore/re-apply | Recovery fail |

Proposed migration files (C1 package; not written at C0):

- `migrations/001_control_plane_expand.sql`
- `migrations/002_control_plane_indexes.sql`
- `migrations/003_control_plane_backfill.sql`

## 4. UNCLASSIFIED / source-grounded backfill

| Case | Backfill rule |
|---|---|
| No classification proof | `taskClass=UNCLASSIFIED`, `disposition=UNCLASSIFIED` |
| HOLD/EXCLUDE with valid receipt | Preserve disposition; outside tracked buckets |
| HOLD/EXCLUDE missing/stale receipt | Tracked once as BLOCKED:DATA_INTEGRITY |
| PRODUCT membership | Only with current receipt-valid proof |

**Never** map legacy scope/phase strings to PRODUCT without proof.

## 5. Duplicate / cycle validation

Importer and migrator reject:

- Duplicate FC joins multiplying a task
- Duplicate node joins multiplying a task
- Duplicate dependency joins multiplying a task
- Conflicting primary ownership for one task ID
- Dependency cycles

## 6. Revisions

Introduce monotonic integers:

- `boardRev`
- `lifecycleRev` (and per-entity revs)

Live schema currently lacks these (G0). Backfill starts at 1 after expand; mutations require expected revs thereafter.

## 7. Provenance / synthetic fixtures

| Mode | Requirements |
|---|---|
| Production-derived staging load | `productionReadApprovalId` + `stagingLoadApprovalId` + allowlist + redactionPolicyVersion + export manifest |
| Default | Synthetic fixtures under `qa/` / `tests/` only |

Export must never include tokens, private decision text, owner comments, raw account identity, production credentials, unnecessary PII.

Staging load: idempotent, isolated, reversible, cleaned after tests.

## 8. Reconciliation during migration

After expand: reconciler dry-run classifies live/terminal/stale/orphan/requeue/manual; apply only with matching dryRunHash and current revs; preserve history.

## 9. Idempotency / parity

- Re-running migrations/backfill on same staging snapshot is safe (no double count).
- Parity proof: DISTINCT denominators, readiness fields, bucket sum, board/lifecycle revs, snapshot hash vs API/MCP/UI readback.

## 10. Migration classification

| Class | Meaning | Rollback default |
|---|---|---|
| `REVERSIBLE` | Drop additive columns/tables safely | Prefer rollback |
| `EXPAND_CONTRACT_BACKWARD_COMPATIBLE` | Dual-write/read old+new | Rollback app first, then contract |
| `FORWARD_FIX_ONLY` | Irreversible transform | Forward-fix only |

## 11. Rollback vs forward-fix criteria

**Rollback trigger:** app/API/UI failure; security regression; schema compatible with prior release; rollback does not lose accepted data.

**Forward-fix trigger:** rollback would lose/corrupt data; irreversible transform applied; prior release incompatible with safe current schema.

## 12. Actual previous-SHA rollback / current recovery rehearsal

Staging rehearsal **must** (not document-only):

1. Record current full SHA and **actual previous** full SHA.
2. Deploy current; apply migration; smoke.
3. Redeploy actual previous SHA against compatible schema or restored disposable DB snapshot.
4. Prior-SHA `/healthz` + smoke.
5. Redeploy current SHA; re-apply/forward-fix.
6. Prove data/readiness integrity.

Maps to AC-ROLL-01 / AC-ROLL-02 (C5).

## 13. Stop / forward-fix criteria (summary)

| Event | Action |
|---|---|
| Enum SPLIT/MERGE/UNMAPPED | STOP → root Decision |
| Parity mismatch | STOP → investigate; no force |
| Security regression | Rollback if REVERSIBLE; else forward-fix with freeze |
| Data loss risk on rollback | FORWARD_FIX_ONLY path |
| Dual approval missing for prod data | Use synthetic; do not copy |

## 14. Weights preserved across migration

Stage weights remain exactly: 0/10/20/45/65/75/90/100/100 for the nine stages. Migration must not reweight.
