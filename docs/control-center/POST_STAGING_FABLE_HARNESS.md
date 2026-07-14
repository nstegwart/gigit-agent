# Post-staging FABLE harness (C5)

**Document class:** HARNESS CONTRACT (executable under `qa/evidence/`)  
**Schema:** `TM_POST_STAGING_FABLE_HARNESS_V1`  
**Orchestrator anchor:** `AGENT_TASK_ORCHESTRATOR.md` → **POST-STAGING FABLE GATE**

## Purpose

Machine-enforce the post-staging FABLE gate as fail-closed program behavior:

| Requirement | Harness behavior |
|---|---|
| Exact `claude-fable-5` | `FABLE_MODEL`; argv `--model claude-fable-5` only |
| Exact effort `xhigh` | `FABLE_EFFORT`; argv `--effort xhigh` only |
| Non-interactive JSON | `-p` / `--print` + `--output-format json` |
| Supply pack | screenshot manifest, mission Q1–Q8 → evidence, staging SHA/schema, revisions/hash, responsive states, prior review finding ledger |
| Output hash | `verifyPostStagingFableOutputHash` on **post-staging** program output |
| Unavailable | emit `BLOCKED_FABLE_UNAVAILABLE`; **never** substitute model/effort/fallback |
| Staging first | refuse invoke until staging evidence precondition PASSes (`STAGING_EVIDENCE_REQUIRED`) |

Design-input FABLE receipts under `.artifact/evidence/.../input/01-task-manager-fable5-xhigh-*.json` are **not** post-staging output. The verifier rejects those paths as substitution.

## Module

- **Code:** `qa/evidence/post-staging-fable-harness.mjs`
- **Unit tests:** `tests/unit/post-staging-fable-harness.test.ts` (LOCAL ONLY; no live FABLE)

### CLI

```bash
node qa/evidence/post-staging-fable-harness.mjs help
node qa/evidence/post-staging-fable-harness.mjs print-argv
node qa/evidence/post-staging-fable-harness.mjs check-staging --staging path/to/staging-pass.json
node qa/evidence/post-staging-fable-harness.mjs pack --supply path/to/supply.json [--ledger docs/control-center/DESIGN_DECISIONS.md] [--out bundle.json]
node qa/evidence/post-staging-fable-harness.mjs verify-output --output path/to/post-staging-fable.json --expected-sha <64hex>
node qa/evidence/post-staging-fable-harness.mjs gate --staging staging-pass.json --supply supply.json
# Execute FABLE only when staging PASS + intentional flag:
node qa/evidence/post-staging-fable-harness.mjs gate --staging staging-pass.json --supply supply.json --allow-execute --out post-staging-fable.json
```

Default `gate` without `--allow-execute` returns `READY_TO_INVOKE` (pack + argv) and **does not** spawn FABLE.

## Codes

| Code | Meaning |
|---|---|
| `STAGING_EVIDENCE_REQUIRED` | No staging PASS / missing SHA/schema; FABLE not invoked |
| `SUPPLY_PACK_INCOMPLETE` | Missing manifest/mission/ledger/states/etc. |
| `FABLE_SUBSTITUTION_FORBIDDEN` | Wrong model/effort/format or design-input path used as output |
| `FABLE_OUTPUT_HASH_MISMATCH` | Post-staging output SHA-256 mismatch |
| `BLOCKED_FABLE_UNAVAILABLE` | Binary/process/model unavailable; **no substitute** |

## Explicit non-claims

- This harness **implements** the gate machinery; it does **not** by itself emit `TASK_MANAGER_STAGING_VERIFIED` or FABLE PASS.
- Unit tests are support evidence (`LOCAL ONLY`) until a real post-staging FABLE run against real staging evidence is exercised in-session.
- FABLE remains advisory; not independent code/runtime verification.
