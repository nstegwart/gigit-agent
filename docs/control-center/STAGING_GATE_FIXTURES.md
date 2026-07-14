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

# Apply adapter pure self-test / plan (no mutation)
node qa/fixtures/staging/gates/apply-adapter.mjs --self-test
node deploy/staging/scripts/seed-gates.mjs --apply-adapter-self-test
node qa/e2e/flows/staging-gates-apply.mjs --self-test
node qa/e2e/flows/staging-gates-apply.mjs --plan

# Deterministic pack JSON + cleanup plan (no mutation)
node deploy/staging/scripts/seed-gates.mjs --manifest
node deploy/staging/scripts/seed-gates.mjs --cleanup

# Unit (product pure engines + fixtures + apply adapter)
pnpm exec vitest run tests/unit/staging-gates-contract.test.ts \
  tests/unit/staging-gates-lifecycle-reconciler.test.ts \
  tests/unit/staging-gates-apply-adapter.test.ts
```

## Live apply (operator only)

**Default is always non-mutating.** `seed-gates.mjs --apply` / `staging-gates-apply.mjs --apply` refuse unless:

| Env | Value |
|---|---|
| `CAIRN_ENV` | `staging` |
| `CAIRN_DB_NAME` | `cairn_tm_v3_staging` |
| `CAIRN_STAGING_SEED_APPROVED` | `1` |
| `CAIRN_GATES_APPLY` | `1` |
| `CAIRN_GATES_BIND_LIVE_PIN` | `1` |

With those gates set, **default remains plan-only** (`mode: apply-plan`, `stagingMutation: false`): pure step plan from `qa/fixtures/staging/gates/apply-adapter.mjs`.

### Execute (authenticated product MCP only)

Additionally require:

- `CAIRN_GATES_EXECUTE=1`
- `STAGING_URL` (e.g. tunnel `http://127.0.0.1:33211`)
- `STAGING_ROOT_BEARER_TOKEN` + `STAGING_AGENT_BEARER_TOKEN` + `STAGING_AGENT_ID`
- Optional `EXPECTED_SHA` (fail-closed vs healthz `deployedSha`)

```bash
export CAIRN_ENV=staging CAIRN_DB_NAME=cairn_tm_v3_staging
export CAIRN_STAGING_SEED_APPROVED=1 CAIRN_GATES_APPLY=1 CAIRN_GATES_BIND_LIVE_PIN=1
export CAIRN_GATES_EXECUTE=1
export STAGING_URL=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild
# bearers via env — never commit/print
node deploy/staging/scripts/seed-gates.mjs --apply
# or
node qa/e2e/flows/staging-gates-apply.mjs --apply
```

### Apply rails (acceptance)

1. **Live pin rebind + healthz pin-shape fail-closed** — probe `/api/healthz` and validate pin shape (`boardRev:number`, `lifecycleRev:number`, `deployedSha|release.sha`) **before any mutation**. Incomplete shape → `HEALTHZ_PIN_SHAPE_INVALID` (no plan/execute side effects). Re-read pin before **each** mutation. If healthz omits `canonicalHash`, fill via `get_overview` then require non-empty subject hash for CAS (`validateLivePinForMutation`). Fixture `pin.json` `boardRev=7` is self-test only — never live CAS.
2. **Definition** — `replace_board_snapshot` **dryRun** first; apply only if **additive `synth-gate-` prefix proof** shows all existing non-prefix tasks/projects/features unchanged.
3. **Lifecycle (MCP schema-exact)** — `register_run` **must** send required `targetGate` (plus `runId`/`taskId`/`agentId`/`model`) → `submit_stage_evidence` (server hash; `byRunId` = registered run) → `advance_task` **must** send required `byRunId` bound to that registered author run + server `receiptId+receiptHash` only. Never hand-insert schema006 receipts. Unit tests assert domain keys against `src/server/board-mcp.ts` so drift fails the suite.
4. **Unique idempotency keys** — `gates-apply:${sha}:${packHash}:${step}:${salt}` per step.
5. **Reconciler** — dry-run hash → apply bind; wrong-hash / not-leader as expected rejects.
6. **G5** — **fail closed**. No public MCP write for domain PASS; `get_g5` read only. Never fabricate PASS.
7. **Cleanup** — prefix-scoped only; before/after/audit readback must preserve non-prefix content. Never `DROP DATABASE`.

### Hard ban (bypass)

| Path | Why banned for gate apply |
|---|---|
| `deploy/staging/scripts/seed-synthetic.mjs` | Board-scoped raw SQL wipe; resets rev; not planImport/lifecycle rails |
| Raw SQL into `control_plane_stage_evidence_receipts` | Fabricates non-programmatic receipts |
| Fixture receipt hashes as PASS proof | Not source-grounded |
| Claiming G5 PASS without independent verifier runs | False-DONE |

## Cleanup

`cleanup-rules.json` + `buildCleanupPlan()` / adapter `buildPrefixCleanupPlan()` emit a **plan-only** JSON:

1. READBACK_BEFORE
2. runs `synth-gate-*`
3. stage evidence receipts
4. G5 domain evidence
5. classification rows
6. tasks
7. reconciler dry-run/apply hashes (packet-scoped)
8. READBACK_AFTER + AUDIT_NON_PREFIX_PRESERVED

## Reuse map

| Concern | Product API |
|---|---|
| Classification | `evaluateClassification` (`src/server/classification.ts`) |
| Distinct joins | `produceCanonicalSnapshot` / `validateCanonicalSnapshot` / MCP `replace_board_snapshot` |
| Lifecycle | MCP `register_run` + `submit_stage_evidence` + `advance_task` |
| G5 | MCP `get_g5` read-only / pure `evaluateG5` (write unsupported) |
| Capacity | MCP `sync_accounts` / pure `evaluateCapacityPolicy` |
| Priority | `computePriorityAllocation` |
| Reconciler | MCP `reconcile_dry_run` / `reconcile_apply` |
| Apply adapter | `qa/fixtures/staging/gates/apply-adapter.mjs` (pure transforms) |
| Apply driver | `qa/e2e/flows/staging-gates-apply.mjs` |

## Status grading

| Evidence | Max status |
|---|---|
| Contract / apply-adapter self-test + unit | **LOCAL ONLY** |
| Staging MCP/API readback of seeded pack (EXECUTE path) | FUNCTIONAL |
| Full ordered rail + g5Pass live + agent flow | DONE only with programmatic G5 write surface + independent verifier (currently residual) |

**Hard ban:** do not claim G5 PASS / g5Pass=true on staging without programmatic independent-verifier receipts emitted by a real run. Unsupported G5 write must remain explicit (`G5_WRITE_UNSUPPORTED`) — never fabricate PASS.

## Files

- `qa/fixtures/staging/gates/**` — manifests + packets + `contract.mjs`
- `qa/fixtures/staging/gates/apply-adapter.mjs` — pure apply transforms + additive proof + fail-closed G5
- `qa/fixtures/staging/gates/expected/**` — deterministic expected outputs
- `deploy/staging/scripts/seed-gates.mjs` — seed CLI (self-test default; `--apply` plan / execute delegate)
- `qa/e2e/flows/staging-gates.mjs` — promoted pack contract flow
- `qa/e2e/flows/staging-gates-apply.mjs` — promoted apply driver (MCP only)
- `tests/unit/staging-gates*.test.ts` — engine + apply-adapter binding
- `docs/control-center/STAGING_GATE_FIXTURES.md` — this doc
