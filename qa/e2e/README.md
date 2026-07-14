# qa/e2e — promoted Web E2E harness (C3-F5 + C3-R2D)

Durable, env-parameterized browser flows for **local / staging** only.
Reuse-first: existing 21 Playwright specs live under `tests/e2e/*.spec.ts` and are **not rewritten**.
Shared TypeScript fixtures: `tests/e2e/fixtures/**`. This tree holds **promoted Node entrypoints** + manifest schema + **deterministic isolated-DB harness**.

**Status cap:** `LOCAL ONLY` until independent verifier runs full headed capture against settled product source.

## Environment

| Variable                           | Required       | Default / notes                                                                                                                                                                                                                                   |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_BASE`                         | no             | `http://127.0.0.1:3210` (owned harness overrides)                                                                                                                                                                                                 |
| `HEADED`                           | no             | `1` / `true` → headed Chromium                                                                                                                                                                                                                    |
| `CAIRN_E2E_USERNAME`               | for auth flows | Synthetic local/staging user — **never commit**                                                                                                                                                                                                   |
| `CAIRN_E2E_PASSWORD`               | for auth flows | Synthetic — **never commit**                                                                                                                                                                                                                      |
| `BOARD_ID`                         | no             | `mfs-rebuild` (deterministic harness) / `ibils` (legacy defaults)                                                                                                                                                                                 |
| `STAGING_URL`                      | no             | defaults to `WEB_BASE`; **required for** `staging-agent-smoke --real` (SSH tunnel e.g. `http://127.0.0.1:33211`)                                                                                                                                  |
| `STAGING_BEARER_TOKEN` / `STAGING_BEARER` / `CAIRN_MCP_BEARER` | real smoke | Authorized bearer for staging MCP/health — **never commit/print**. Optional `STAGING_BEARER_TOKEN_REF` = env **name** to read.                                                                                                                     |
| `EXPECTED_SHA`                     | real smoke     | 40-char release SHA; fail-closed vs `/api/healthz` `deployedSha` when set                                                                                                                                                                         |
| `FULL_SHA`                         | harness full   | **40-char Git SHA**. Harness `--full` resolves `FULL_SHA` → `GIT_SHA` → `git rev-parse HEAD` and **fail-closes** if unresolved. Piecewise/dry tools may still see `UNKNOWN_SHA` only when `require` is off. Never claim a run with `UNKNOWN_SHA`. |
| `SCHEMA_VERSION`                   | no             | `TM_UI_CONTRACT_V1`                                                                                                                                                                                                                               |
| `CAIRN_E2E_SKIP_WEBSERVER`         | no             | `1` skips Playwright auto-`preview`                                                                                                                                                                                                               |
| `PORT`                             | no             | Preview port default `3210`                                                                                                                                                                                                                       |
| `CAIRN_ISO_DB_NAME`                | no             | Unique iso DB (`cairn_tm_e2e_*`); auto-generated                                                                                                                                                                                                  |
| `CAIRN_DB_HOST/PORT/USER/PASSWORD` | seed/full      | Local MySQL admin (from env or `.env`)                                                                                                                                                                                                            |
| `CAIRN_HARNESS_PORT`               | no             | Prefer fixed loopback port for owned preview                                                                                                                                                                                                      |
| `CAIRN_HARNESS_RUN_ID`             | no             | Run id for out/ + manifest                                                                                                                                                                                                                        |
| `CAIRN_HARNESS_OUT`                | no             | Default `qa/e2e/out/runtime/<runId>`                                                                                                                                                                                                              |

Fail-closed auth: missing credentials or missing `cairn_session` cookie → hard error. No ambient sessions. No production.
Iso DB names must match `cairn_tm_e2e_|c3_|iso_|synth_*` — ambient `cairn_taskmanager` is refused.

## Playwright projects (`playwright.config.ts`)

| Project            | Role                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `setup-auth`       | Login/bootstrap with process-local `CAIRN_E2E_*` → run-scoped storageState |
| `chromium`         | Authoritative 21 IBILS specs — **storageState + MCP Bearer** (depends setup-auth) |
| `harness-contract` | No-auth foundation + deterministic contract (`*.contract.harness.spec.ts`) |
| `chromium-1440`    | 1440×900 + storageState (`*.auth.harness.spec.ts`)                         |
| `chromium-1024`    | 1024×768 + storageState                                                    |
| `chromium-390`     | 390×844 + storageState                                                     |
| `chromium-360`     | 360×800 + storageState                                                     |

### Auth fixture green path (AC-IBILS-01)

Default Playwright run (no hand-exported passwords):

1. **Config load** — `ensureAuthSecretsInEnv()` pins a **run-scoped** `CAIRN_E2E_AUTH_RUN_ID` + storage/meta/secrets paths + generates process-local `CAIRN_E2E_USERNAME` / `CAIRN_E2E_PASSWORD` + `CAIRN_MCP_BEARER` + `CAIRN_BEARER_PRINCIPALS_JSON` (never committed).
2. **webServer** (`start-auth-preview.mjs`) — prepares iso DB + secrets using the same run id; preview inherits `CAIRN_DB_NAME` + bearer principals JSON.
3. **globalSetup** — reuses **this run's** meta only (`.artifact/e2e-auth-runtime-<runId>.json`); clones ambient boards into disposable `cairn_tm_e2e_authfix_*` if nothing prepared yet. Never reads a shared fixed meta path (parallel workers cannot clobber each other).
4. **setup-auth** — product `/login` first-admin bootstrap (or product-schema session seed fallback) → **run-scoped** `.artifact/e2e-auth-storage-<runId>.json` (gitignored). Not the legacy shared `qa/e2e/fixtures/storage/admin.json` (that path races concurrent suite teardowns).
5. **chromium** — `storageState` (same run-scoped path) for UI; `extraHTTPHeaders.Authorization` for `/mcp` request fixtures. Raw MCP SDK specs (`mcp-client.spec.ts`) pass the same bearer via `StreamableHTTPClientTransport` `requestInit` (never logged).
6. **globalTeardown** — DROP **only** the iso DB owned by this run's meta (`cairn_tm_e2e_authfix_*` + matching `runId`); erase **only this run's** secrets sidecar + storageState; scrub secret env keys. Never unlinks a peer invocation's storage file.

| Variable | Notes |
| --- | --- |
| `CAIRN_E2E_AUTH_RUN_ID` | Auto-generated per Playwright invocation; shared across webServer/setup/teardown |
| `CAIRN_E2E_AUTH_RUNTIME_META_PATH` | Override run-scoped meta path (default `.artifact/e2e-auth-runtime-<runId>.json`) |
| `CAIRN_E2E_AUTH_SECRETS_PATH` | Override secrets sidecar (default `.artifact/e2e-auth-secrets-<runId>.json`, mode 600) |
| `CAIRN_E2E_AUTH_STORAGE_PATH` | Override storageState path (default `.artifact/e2e-auth-storage-<runId>.json`) |
| `CAIRN_E2E_SKIP_ISO_AUTH=1` | Skip iso clone (requires pre-existing user + credentials) |
| `CAIRN_E2E_KEEP_ISO_DB=1` | Leave iso DB after teardown (debug) |
| `CAIRN_E2E_KEEP_STORAGE=1` | Keep this run's storageState after teardown |
| `CAIRN_E2E_FORCE_FRESH_SERVER=1` | Do not reuseExistingServer on preview |
| `CAIRN_MCP_BEARER` | Process-local; also used as project `extraHTTPHeaders` + MCP SDK transport |

**Gitignore (exact):** `.artifact/e2e-auth-secrets.json`, `.artifact/e2e-auth-secrets-*.json`, `.artifact/e2e-auth-runtime.json`, `.artifact/e2e-auth-runtime-*.json`, `.artifact/e2e-auth-storage-*.json`, `qa/e2e/fixtures/storage/admin.json` (legacy CLI shared path).

Helpers: `qa/e2e/lib/auth-fixture.mjs` (+ `auth-fixture.d.mts` for TS), `qa/e2e/lib/start-auth-preview.mjs`, `tests/e2e/fixtures/mcp-auth.ts`, `tests/e2e/fixtures/global-setup.ts` / `global-teardown.ts`.

```bash
pnpm build
# optional: export CAIRN_E2E_USERNAME=… CAIRN_E2E_PASSWORD=…  (else auto-synth)
pnpm test:e2e -- --list
pnpm test:e2e -- --project=chromium   # setup-auth + storageState + MCP bearer
CAIRN_E2E_SKIP_WEBSERVER=1 pnpm test:e2e -- --project=harness-contract
pnpm test:e2e -- --project=chromium-1440   # needs setup-auth + credentials + *.auth.harness.spec.ts
```

## Deterministic control-center harness (C3-R2D)

Promoted entrypoint — **one bounded lifecycle** (seed → owned server → bootstrap login → capture → cleanup):

```bash
# 1) Self-tests only (no MySQL / browser / server) — safe under parallel product edits
node qa/e2e/flows/deterministic-control-center-harness.mjs --self-test

# 2) Seed-only isolated DB (leaves DB; for debug)
node qa/e2e/fixtures/seed/seed-isolated.mjs
# or
node qa/e2e/flows/deterministic-control-center-harness.mjs --seed-only

# 3) Full lifecycle (requires: pnpm build, local MySQL, Playwright browsers)
#    Creates unique DB, starts owned preview, bootstrap OWNER, captures matrix,
#    axe critical/serious fail-closed, drops DB + kills only owned PID.
HEADED=1 node qa/e2e/flows/deterministic-control-center-harness.mjs --full

# Optional: skip axe exit fail (still records), keep DB, or health-only
node qa/e2e/flows/deterministic-control-center-harness.mjs --no-browser
node qa/e2e/flows/deterministic-control-center-harness.mjs --skip-axe-fail --keep-db
```

### What the full harness guarantees

1. **Unique isolated synthetic DB** — never ambient `cairn_taskmanager`; no production-derived data
2. **Seed** — board revision + lifecycle revision + authority pin + **computed taskHash** (`sha256(sorted task ids)`), PRODUCT+ACTIVE receipts on all but one deliberate UNCLASSIFIED row, DONE/ONGOING/NEXT/QUEUED/BLOCKED/RECON/STALE overlays, rich DecisionV3 (`teks`/question/options), priority membership, feature open/fail/expired branches, feature context fields, stage evidence
3. **Authorized control-plane bootstrap (C3-R5H)** — per-run synthetic `ROOT_ORCHESTRATOR` bearer (Node crypto, memory-only) injected as child-only `CAIRN_BEARER_PRINCIPALS_JSON`; real `/mcp` `publish_dispatch_plan` + `get_next` readback + `sync_accounts` with pin parity fail-closed. Never uses `CAIRN_WRITE_TOKEN` for elevation; bearer never written to receipts/logs. Bootstrap failure → non-zero exit (no residual-continue).
4. **Bootstrap/login deterministic** — zero users → first OWNER; before each protected capture: final URL, OWNER shell, board ID, no login/setup form
5. **Owned server lifecycle** — start → health wait → capture → stop in `finally`; no cross-command daemon
6. **Viewports** — 1440×900, 1024×768, 390×844, 360×800 + authenticated 200% core; viewport-only PNG + full-page companion; accurate manifest dims
7. **Fresh manifest** — cleared/versioned each run; pins **PRESENT** for valid fixture (not `MISSING`); runId/serverTestId/capturedAt/SHA/schema/a11y/mission
8. **Axe** — fail on critical/serious (unless `--skip-axe-fail`)
9. **Guards** — reject login capture, blank/tiny PNG, wrong viewport dims, stale artifact, route skip
10. **Cleanup** — kill only owned process; DROP only unique DB; prove port free + DB absent
11. **Credentials (C3-C9)** — mode-600 under `qa/e2e/out/runtime/<runId>/auth/` **only while the owned browser runs**. Full harness **never** writes canonical `qa/e2e/fixtures/storage/admin.json`. In `finally` (success + thrown failure): erase `username.txt` / `password.txt` / `storageState.json` and remove the empty auth directory. Cleanup summary is booleans/counts only — never credentials/cookies/bearer. Never place auth material under `.artifact/evidence`.
12. **C3-R3H fail-close probes** (each verdict recorded in `probes/verdicts.json` + summary; any fail → exit 1):
    - **Public redaction** — seed unique canaries in private decision/comment/account credential fields; `GET /api/public-snapshot?boardId=` must be 200 and free of canaries + forbidden keys (`password`/`token`/… as JSON keys). Legitimate schema text like checklist `"Password reset"` does **not** fail.
    - **Sticky Decision (C3-C9/C10)** — target `overview-decision-card` / `overview-decision-pill`; product uses a **sticky chrome shelf** (`overview-sticky-chrome`: app summary + collapsed pill) with mission body in `overview-mission-scroll` so content never geometrically sits under the pill. Harness prefers that mission scrollport when it owns overflow, else `#view`/`.content` (**never** `window.scrollTo` as the content scroller; require `windowScrollY ≤ 1`); pre/post screenshots (390×844 dims checked); assert pill count/severity/Expand; **full containment** (left/right/top/bottom inside both browser viewport and `#view` visible rect, epsilon ≤1px; `intersectionRatio ≥ 0.999`); app summary must stay visible; measure **all** visible mission candidates (priority/global/buckets/ONGOING/lower); fail if overlaps app bar or covers any visible meaningful content by >8px; **multi-sample** post-collapse scrollTops so a single gap cannot false-pass.
    - **Raw STALE** — navigate literal `/b/<board>/work?stale=1` (no router serialize); auth Work shell + `data-stale-overlay=1` / switch active; no error boundary/console error.
    - **Touch** — any visible in-scope control &lt; 44×44 fails run; report `data-testid`/selectors.
    - **ONGOING zero-click** — assert Overview fields for seeded `task-ongoing-1` (not query-string alone).
    - **Session denial / focus / reduced-motion / console+network / overflow** — each has a named verdict.
13. **Network honesty (C3-C6 / R4-P4)** — only APP-class request failures fail `consoleNetwork`. Narrow allowlist: same-origin `net::ERR_ABORTED` on `/_serverFn/<hex≥16>` (TanStack Start SPA abort during route matrix). Never allowlisted: generic aborts, `/api/*`, `/mcp*`, `/health*`, public-snapshot, document/navigation, cross-origin, non-abort net errors, HTTP ≥400.
14. **SHA + capture counts** — summary `fullSha` is always a program-resolved 40-char hex; `planned === captured + skipped + error` (default mfs-rebuild planned **53**). Zoom-200 core rows count as captured.

### Capture matrix

| Surface                                                                                                                    | Viewports    | Notes                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------- |
| Overview, Work, Priority, Decisions, Evidence (core)                                                                       | all 4 + 200% | mission Q1–Q8 where mapped                    |
| Work DONE/ONGOING/NEXT/QUEUED/BLOCKED/RECON/STALE                                                                          | 1440 + 390   | ONGOING zero-click deep link; raw `?stale=1`  |
| Projects, Features, Agents, Ops, legacy log/tasks                                                                          | 1440 + 390   | secondary                                     |
| Session denial / public redaction canaries / sticky Decision / raw STALE / ONGOING fields / focus / reduced motion / touch | probes       | fail-closed verdicts; bare context for denial |

## Staging agent MCP smoke (synthetic fixture + remote tunnel)

Reusable **agent-operable** MCP lifecycle against SSH-tunneled staging (or contract self-test without a server).

**Fixtures (synthetic only):** `qa/fixtures/staging/**` — `MANIFEST.json`, pin, dispatch/accounts/agent seeds, cleanup rules, pure `contract.mjs`.

**Library:** `qa/e2e/lib/staging-agent-smoke.mjs` (reuses `control-plane-bootstrap.mjs` MCP JSON-RPC + redaction).

**Flow:**

```bash
# Contract / self-test (no server, no credentials)
node qa/e2e/flows/staging-agent-smoke.mjs --self-test
# alias
node qa/e2e/flows/staging-agent-smoke.mjs --contract

# Real remote (tunnel must serve STAGING_URL; bearer via env ref only)
export STAGING_URL=http://127.0.0.1:33211
export BOARD_ID=mfs-rebuild
export EXPECTED_SHA=<40-char release sha>   # fail-closed vs healthz
export STAGING_ROOT_BEARER_TOKEN='…'        # never commit/print
export STAGING_AGENT_BEARER_TOKEN='…'       # dual-principal required
export STAGING_AGENT_ID='…'
# Full live-pin CAS authority (preferred for --real when fixture pin ≠ live board):
export STAGING_BIND_LIVE_PIN=1              # alias: STAGING_BIND_LIVE_BOARD_REV=1
node qa/e2e/flows/staging-agent-smoke.mjs --real
```

**Real sequence (fail-closed):** unauth `/api/healthz` → 401; auth healthz SHA/schema; unauth sensitive MCP deny; `tools/list`; when `STAGING_BIND_LIVE_PIN=1` (or legacy `STAGING_BIND_LIVE_BOARD_REV=1`) bind complete live pin (`canonicalSnapshotId`/`canonicalHash`/`boardRev`/`lifecycleRev`) from authenticated probe as working CAS authority before pin parity/mutation (incomplete → `INCOMPLETE_LIVE_PIN`; never invents `taskHash`); else fixture pin parity fail-closed (`PIN_PARITY_MISMATCH`). Then `publish_dispatch_plan` → `get_next` → `sync_accounts` → `register_run` → `heartbeat_run`; readback `list_tasks` / `get_rollup` / `list_audit` / `get_task_lifecycle`; unique `synth-stg-smoke-*` ids + cleanup/reconcile rules. One bounded `STALE_REVISION` recovery. Pin/revision/hash mismatch → non-zero exit.

**Playwright contract:** `tests/e2e/fixtures/staging-agent-smoke.contract.harness.spec.ts` (`harness-contract` project).

## Flow index

| Flow                      | Path                                             | Auth                 | Purpose                                                              |
| ------------------------- | ------------------------------------------------ | -------------------- | -------------------------------------------------------------------- |
| **Deterministic harness** | `flows/deterministic-control-center-harness.mjs` | bootstrap synth      | Full isolated lifecycle (C3-R2D)                                     |
| **Staging agent MCP smoke** | `flows/staging-agent-smoke.mjs`                | bearer env ref       | Real staging MCP lifecycle + `--self-test` contract                  |
| **Staging gate fixtures** | `flows/staging-gates.mjs`                        | n/a (self-test)      | Pure gate pack contract: classification 3×4, distinct, lifecycle±, G5, capacity/priority, reconciler; dual-gate refuse; cleanup plan-only |
| **Staging gate apply**    | `flows/staging-gates-apply.mjs`                  | dual bearer env refs | Safe apply adapter driver: plan-only default; EXECUTE uses MCP `replace_board_snapshot` + lifecycle receipts; G5 fail-closed; never seed-synthetic |
| Staging fixtures          | `qa/fixtures/staging/**`                         | n/a                  | Synthetic MANIFEST/pin/seeds/cleanup (no prod data)                  |
| Staging gate packets      | `qa/fixtures/staging/gates/**`                   | n/a                  | Reversible gate packets + `apply-adapter.mjs` + `expected/*`         |
| Isolated seed             | `fixtures/seed/seed-isolated.mjs`                | n/a                  | Unique MySQL + pins                                                  |
| Fixture contract (pure)   | `fixtures/seed/control-center-fixture.mjs`       | n/a                  | Overlays/receipts/taskHash/scenarios                                 |
| Control-plane bootstrap   | `lib/control-plane-bootstrap.mjs`                | MCP + synthetic ROOT | Authorized dispatch + account-sync; pin fail-close; bearer redaction |
| Staging agent smoke lib   | `lib/staging-agent-smoke.mjs`                    | MCP + token ref      | Health SHA/schema, unauth deny, register/heartbeat lifecycle         |
| Auth login → storageState | `flows/auth-login.mjs`                           | env creds            | Write `fixtures/storage/admin.json`                                  |
| Overview / mission        | `flows/overview-mission.mjs`                     | storageState         | Board shell                                                          |
| Control center IA         | `flows/control-center.mjs`                       | storageState         | Overview/Work/Priority/Evidence                                      |
| Viewports matrix          | `flows/viewports-matrix.mjs`                     | storage / `--unauth` | AC-UI-04 overflow @ 4 sizes                                          |
| Zoom 200%                 | `flows/zoom-200.mjs`                             | storage / `--unauth` | AC-UI-05                                                             |
| Axe a11y                  | `flows/a11y-axe.mjs`                             | storage / `--unauth` | AC-UI-06 zero critical/serious                                       |
| Keyboard nav              | `flows/keyboard-nav.mjs`                         | optional `--auth`    | Focus ring after Tab                                                 |
| Screenshot manifest       | `flows/screenshot-manifest-capture.mjs`          | dry-run default      | §13 schema + collector                                               |
| Public snapshot           | `flows/public-snapshot.mjs`                      | none                 | `/api/public-snapshot` HTTP probe                                    |
| **Public consumer conformance** | `flows/public-consumer-conformance.mjs`    | none (fixture default; LIVE optional) | MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1 offline fixtures + optional LIVE ETag/304/429 probes. **EXCLUDED:** real consumer publish/mutation (`writeAuthority`, `/opt/mfs/workspace/CONTRACT`, `/var/www/contract`, nginx, deploy) |
| **Security probes**       | `flows/security-probes.mjs`                      | none (optional bearer) | Unauth healthz/MCP/public + rate-limit + redaction (AC-AUTH/PUBLIC) |
| **Perf budgets**          | `flows/perf-budgets.mjs`                         | none                 | Scale-1000 + p95; identical public/filter path budget-aligned; rate-limit-aware sampling; TUNNEL/HARNESS/APP class; opt-in `--load-10m` (AC-PERF-01). Docs: `docs/control-center/PERFORMANCE.md` |
| Scale-1000 fixture        | `qa/fixtures/staging/scale-1000/generate.mjs`    | n/a                  | Deterministic 1000 tasks / 200 runs / 20 accounts / 100 decisions    |

### Example commands (piecewise)

```bash
export WEB_BASE=http://127.0.0.1:3210
export HEADED=0

# Auth storage (server must be up; synthetic user must already exist)
export CAIRN_E2E_USERNAME=e2e-admin
export CAIRN_E2E_PASSWORD='…synthetic…'
node qa/e2e/flows/auth-login.mjs

# Mission / control-center
export BOARD_ID=mfs-rebuild
node qa/e2e/flows/control-center.mjs
node qa/e2e/flows/viewports-matrix.mjs
node qa/e2e/flows/zoom-200.mjs
node qa/e2e/flows/a11y-axe.mjs --route /login --unauth

# Manifest dry-run
node qa/e2e/flows/screenshot-manifest-capture.mjs --dry-run

# Public consumer sync conformance (fixture default; no network)
# Boundary: contract + fixtures only — never mutates consumer paths.
# Prerequisites: qa/fixtures/public-consumer-sync/** + docs/control-center/public-consumer-sync/**
# EXCLUDED: real consumer publish (`writeAuthority` EXCLUDED; no /opt/mfs/workspace/CONTRACT,
# /var/www/contract, nginx, or deploy from this flow).
node qa/e2e/flows/public-consumer-conformance.mjs
# Optional LIVE read-only probes (still EXCLUDED consumer publish):
# WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild node qa/e2e/flows/public-consumer-conformance.mjs --live
# CONFORMANCE_MODE=both LIVE_RATE_LIMIT=1 …   # opt-in 429 burst on shared staging

# Security + perf (staging/local target)
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild node qa/e2e/flows/security-probes.mjs
# Perf: default filterProbe is identical public-snapshot path → budget aligns to
# public p95≤500 (not UI filter ≤200). Loopback WEB_BASE defaults proofBoundary=tunnel.
# True UI filter feedback ≤200 only with PERF_UI_FILTER_URL. On-host APP proof:
# PERF_PROOF_BOUNDARY=on-host. See docs/control-center/PERFORMANCE.md.
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild node qa/e2e/flows/perf-budgets.mjs
# Long load opt-in (exact):
# WEB_BASE=… PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 node qa/e2e/flows/perf-budgets.mjs --load-10m
node qa/fixtures/staging/scale-1000/generate.mjs
node qa/e2e/flows/security-probes.mjs --self-test
node qa/e2e/flows/perf-budgets.mjs --self-test
# Unit: tests/unit/perf-budgets.test.ts

# Staging gate fixture pack (pure self-test; no staging mutation)
node qa/e2e/flows/staging-gates.mjs --self-test
node qa/e2e/flows/staging-gates.mjs --cleanup   # plan-only JSON
node deploy/staging/scripts/seed-gates.mjs --self-test
node qa/e2e/flows/staging-gates-apply.mjs --self-test
node qa/e2e/flows/staging-gates-apply.mjs --plan
# Apply: dual gates + CAIRN_GATES_BIND_LIVE_PIN=1 → plan-only by default
# Execute: + CAIRN_GATES_EXECUTE=1 + STAGING_URL + dual bearers (MCP only; never seed-synthetic)
# Docs: docs/control-center/STAGING_GATE_FIXTURES.md
```

## Layout

```text
qa/e2e/
  README.md
  lib/                      env, auth, auth-assert, capture-guard, axe, zoom, keyboard,
                            overflow, screenshot-manifest, db-iso, server-lifecycle, routes-matrix,
                            probe-fail-close (C3-R3H pure evaluators),
                            control-plane-bootstrap (MCP dispatch + account-sync),
                            staging-agent-smoke (remote staging MCP lifecycle)
  fixtures/
    storage/                generated storageState (gitignored JSON)
    seed/                   isolated seed + pure fixture contract
  flows/                    promoted entrypoints (incl. staging-agent-smoke)
  manifests/                screenshot-manifest.schema.json + latest collector output
  out/screenshots|axe|runtime/   capture artifacts (local, gitignored)

qa/fixtures/staging/        synthetic staging MANIFEST + pin + seeds + contract.mjs
```

## TypeScript fixtures (Playwright import surface)

```ts
import {
  loginAndSaveStorageState,
  assertAuthenticatedOwnerShell,
  assertNotLoginCapture,
  assertAxeZeroCriticalSerious,
  withZoom200,
  assertNoDocumentOverflow,
  ScreenshotManifestCollector,
} from './fixtures'
```

Path: `tests/e2e/fixtures/`
Contract specs: `*.contract.harness.spec.ts`
Auth multi-viewport: `*.auth.harness.spec.ts`

## Blockers / honesty

1. **Full headed capture** against moving product source during parallel C3 edits is deferred to independent verifier.
2. **Synthetic user** for piecewise flows must exist OR use full harness bootstrap.
3. **Credentials** only via env / runtime mode-600 files — never embedded.
4. **Existing 21 specs** still direct `page.goto` without storageState; adopt fixtures incrementally.
5. No production access; no ambient cookie reuse; no ambient DB.

## Related

- `docs/control-center/UI_CONTRACT.md` §11 viewports/zoom/a11y, §13 screenshot manifest
- `playwright.config.ts`
- Prior: `WORKER_RESULT_C3-F5-E2E-AUTH-A11Y-HARNESS.md`, `WORKER_RESULT_C3-V1-VISUAL-CURRENT-STATE.md`
