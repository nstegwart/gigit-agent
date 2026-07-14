# Staging gate fixtures (synthetic, reversible)

**Fixture id:** `staging-gate-fixtures-v1`  
**Root:** `qa/fixtures/staging/gates/**`  
**Schema bind:** `006`  
**Board:** `mfs-rebuild`  
**ID prefix:** `synth-gate-`  
**Default mode:** pure self-test — **no staging mutation**

## Purpose

Deterministic, reversible synthetic packets that exercise the terminal-matrix gate families without production-derived data:

| Packet | ACs | What it proves |
|---|---|---|
| **classification** | AC-CLASS-01..05 | Full **3×4** PRODUCT/CONTROL_PLANE/UNCLASSIFIED × ACTIVE/HOLD/EXCLUDE/UNCLASSIFIED (incl. CONTROL_PLANE×HOLD, UNCLASSIFIED×UNCLASSIFIED); stale + missing receipts → once-only BLOCKED:DATA_INTEGRITY repair; valid HOLD/EXCLUDE outside tracked |
| **distinct** | AC-COUNT-01/02 | Valid import OK; duplicate FC / node / dependency / task id → typed reject |
| **lifecycle** | AC-LIFE-03/04 | One valid **MAPPING** evidence; negatives bound to engine: skip, stale board/lifecycle/entity rev, self-verify, fence, unregistered, hand-typed, missing evidence fields |
| **g5** | AC-LIFE-05, AC-READY-04 | Nine domains; honest NOT_STARTED / IN_PROGRESS / PASS only from programmatic receipts; hand-typed PASS fails closed |
| **capacity** | AC-CAP-01..03, ACCOUNT-07 | zero/stale, BELOW_FLOOR, majority OPEN, fail-safe (LIMIT/BAN/filler/CPU) |
| **priority** | AC-PRIORITY-01/02 | no-frontier, zero capacity, majority, non-majority fail-safe |
| **reconciler** | AC-OPS-05, BUCKET-07 | dry-run hash → apply → idempotent re-apply; maxActions 100; negatives: DRY_RUN_HASH_MISMATCH, NOT_LEADER |
| **expected/** | support | Deterministic expected outputs for classification grid, lifecycle negatives, reconciler negatives (not empty placeholder) |

## Entrypoints

```bash
# Pure contract self-test (no DB / no network)
node qa/fixtures/staging/gates/contract.mjs --self-test
node deploy/staging/scripts/seed-gates.mjs --self-test
node qa/e2e/flows/staging-gates.mjs --self-test

# Deterministic pack JSON + cleanup plan (no mutation)
node deploy/staging/scripts/seed-gates.mjs --manifest
node deploy/staging/scripts/seed-gates.mjs --cleanup

# Unit (product pure engines + fixtures)
pnpm exec vitest run tests/unit/staging-gates-contract.test.ts \
  tests/unit/staging-gates-lifecycle-reconciler.test.ts
```

## Live apply (operator only)

`seed-gates.mjs --apply` **refuses** unless:

- `CAIRN_ENV=staging`
- `CAIRN_DB_NAME=cairn_tm_v3_staging`
- `CAIRN_STAGING_SEED_APPROVED=1`
- `CAIRN_GATES_APPLY=1`

Even with dual gates, this pack **delegates** mutation to existing seed/import APIs:

- `deploy/staging/scripts/seed-synthetic.mjs`
- `src/server/canonical-import.ts` / `canonical-snapshot.ts`

It never `DROP DATABASE` and never prints bearer/token secrets.

## Cleanup

`cleanup-rules.json` + `buildCleanupPlan()` emit a **plan-only** JSON:

1. runs `synth-gate-*`
2. stage evidence receipts
3. G5 domain evidence
4. classification rows
5. tasks
6. reconciler dry-run/apply hashes (packet-scoped)

## Reuse map

| Concern | Product API |
|---|---|
| Classification | `evaluateClassification` (`src/server/classification.ts`) |
| Distinct joins | `produceCanonicalSnapshot` / `validateCanonicalSnapshot` |
| Lifecycle | `submitStageEvidence` / `advanceTaskV3` |
| G5 | `evaluateG5` / `makePassingDomain` |
| Capacity | `evaluateCapacityPolicy` |
| Priority | `computePriorityAllocation` |
| Reconciler | `dryRunReconcile` / `applyReconcile` |

## Status grading

| Evidence | Max status |
|---|---|
| Contract self-test + unit | **LOCAL ONLY** |
| Staging MCP/API readback of seeded pack | FUNCTIONAL |
| Full ordered rail + g5Pass live + agent flow | DONE (orchestrator, not this pack alone) |

**Hard ban:** do not claim G5 PASS / g5Pass=true on staging without programmatic independent-verifier receipts emitted by a real run.

## Files

- `qa/fixtures/staging/gates/**` — manifests + packets + `contract.mjs`
- `qa/fixtures/staging/gates/expected/**` — deterministic expected outputs
- `deploy/staging/scripts/seed-gates.mjs` — seed CLI (self-test default)
- `qa/e2e/flows/staging-gates.mjs` — promoted flow (indexed in `qa/e2e/README.md`)
- `tests/unit/staging-gates*.test.ts` — engine binding (incl. lifecycle stale_lifecycle/entity/missing_fields + reconciler hash/leader negatives)
- `docs/control-center/STAGING_GATE_FIXTURES.md` — this doc
