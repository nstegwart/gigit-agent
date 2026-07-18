# Staging runbook — cairn-taskmanager-v3 (TM-P0)

Operator runbook for **staging only** (`127.0.0.1:33211` / `cairn_tm_v3_staging`).
Companion to `deploy/staging/README.md` (compose package) and in-code
`STAGING_RUNBOOKS` (`src/server/observability.ts` / observability-integration).

| Contract field | Value |
|---|---|
| Health (liveness) | Unauth `GET /api/healthz` → **401** (or 503 while unhealthy) |
| Release PASS | Auth `GET /api/healthz` → **200** + `deployedSha` / schema pin **012** (product latest; CP0 baseline **008**) / migrations / required tables |
| Public surface | `GET /api/public-snapshot?boardId=<allowlisted>` — redacted pin only |
| MCP | `POST /mcp` — unauth public tool surface only; sensitive tools need bearer |
| Data mode | **Synthetic fixtures only** unless dual-approval production-derived gate passes |
| Observability | Redacted structured logs + memory metrics on `/mcp`, `/api/healthz`, `/api/public-snapshot` (`x-request-id`) |

Never paste bearer secrets, `CAIRN_BEARER_PRINCIPALS_JSON`, cookies, or DB passwords into tickets/logs.

---

## 1. Owner target

```text
OWNER_TARGET: {base_url: http://127.0.0.1:33211, port: 33211, account: staging ROOT bearer (env ref), device: n/a}
```

Override with `WEB_BASE` / `STAGING_URL` when tunneled. Print the same line before any probe.

---

## 2. Preflight

```bash
cd /opt/mfs/staging/cairn-taskmanager-v3/source   # or local checkout
./deploy/staging/scripts/status.sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:33211/api/healthz
# expect 401 (listen) — not connection refused
```

Release SHA check (authorized):

```bash
# STAGING_BEARER_TOKEN from host .env — never echo
curl -sS -H "Authorization: Bearer $STAGING_BEARER_TOKEN" \
  http://127.0.0.1:33211/api/healthz | jq '{status,deployedSha,schema,migration,boardRev,lifecycleRev}'
```

Fail closed when `deployedSha` ≠ intended full SHA or schema/migration not READY.

---

## 3. Alert → runbook map (AC-OPS-03)

| AlertId | RunbookId | First actions |
|---|---|---|
| `UNHEALTHY_RELEASE_SCHEMA_MISMATCH` | `rb-release-schema-mismatch` | Compare healthz SHA/schema to release pin; do not promote; redeploy or migrate |
| `PUBLIC_FRESHNESS_STALE` | `rb-public-freshness-stale` | Check materializer; inspect `snapshot_freshness_ms`; fail closed public until republish |
| `REPEATED_IMPORT_RECONCILE_FAILURE` | `rb-import-reconcile-failure` | Inspect import/reconcile metrics; verify pins; halt auto-apply |
| `LIVE_MCP_UNAUTHORIZED_EXPOSURE` | `rb-mcp-unauthorized` | Confirm unauth tools/list is public-only; rotate tokens if leak |
| `ACCOUNT_SYNC_STALE` | `rb-account-sync-stale` | usableCapacity=0; re-run authorized `sync_accounts` |
| `CLAIM_LOCK_ANOMALY` | `rb-claim-lock-anomaly` | Inspect claim_lock_conflict; fencing tokens; authorized release only |
| `ERROR_LATENCY_BUDGET_BREACH` | `rb-latency-budget` | api_latency_ms / api_error_rate; healthz deps; throttle public load |

In-process evaluation: `createObservabilityIntegration().evaluateAlerts(...)`.
Product request path: shared integration on MCP / healthz / public-snapshot (requestId, latency, result, board/lifecycle rev when known). **No payload secrets.**

---

## 4. Security probes (promoted)

```bash
WEB_BASE=http://127.0.0.1:33211 node qa/e2e/flows/security-probes.mjs
# Optional: BOARD_ID=mfs-rebuild STAGING_BEARER_TOKEN=… (auth healthz only; never print)
```

Checks (fail-closed report, no fabricated PASS):

1. Unauth `/api/healthz` → 401
2. Unauth `/` → redirect login
3. Public snapshot 200 + redaction (no secret keys)
4. ETag / If-None-Match → 304
5. Burst rate limit → some 429 + Retry-After
6. MCP tools/list unauth → public-only
7. MCP sensitive tools/call unauth → 401

---

## 5. Performance budgets (AC-PERF-01)

Scale fixture (deterministic, synthetic-only):

```bash
node qa/fixtures/staging/scale-1000/generate.mjs
# → qa/fixtures/staging/scale-1000/{manifest.json,tasks.jsonl,...}
# counts: 1000 tasks / 200 runs / 20 accounts / 100 decisions
```

Budget harness:

```bash
# Default: count + p95 against WEB_BASE (no 10m load)
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
  node qa/e2e/flows/perf-budgets.mjs

# Long load opt-in (exact command supported):
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
  PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 \
  node qa/e2e/flows/perf-budgets.mjs --load-10m
```

Budgets (defaults; override via env):

| Metric | Default budget |
|---|---|
| Public snapshot p95 | ≤ 500 ms (`PERF_P95_MS`) |
| Filter / list-style probe p95 | ≤ 200 ms (`PERF_FILTER_P95_MS`) |
| Sustained load | 20 req/s × 10 m (opt-in only) |
| LCP | ≤ 2.5 s when browser probe enabled (`PERF_LCP_MS`) |

---

## 6. Synthetic seed + provenance

```bash
# Compose one-shot (staging env fail-closed)
sudo docker compose -f deploy/staging/docker-compose.yml --env-file deploy/staging/.env \
  run --rm -e CAIRN_STAGING_SEED_APPROVED=1 cairn-tm-v3-app \
  node deploy/staging/scripts/seed-synthetic.mjs
```

Gate:

- `seed-policy.json` must have `productionDerived: false` / synthetic path
- Script calls `qa/fixtures/staging/provenance-gate.mjs` (SYNTHETIC allow; PRODUCTION_DERIVED refuses without dual approval + allowlist + purpose/expiry)
- Never `DROP DATABASE`; board-scoped upsert only

---

## 7. Deploy / rollback (pointer)

Full compose lifecycle lives in `deploy/staging/README.md`:

- `./deploy/staging/scripts/deploy.sh`
- `./deploy/staging/scripts/deploy.sh --no-cache` (clean rebuild for **same** `RELEASE_SHA`)
- `./deploy/staging/scripts/stop.sh`
- `./deploy/staging/scripts/rollback.sh`

This file is the **ops alert + probe** runbook; README is the **compose deploy** runbook.

---

## 7b. Build asset coherence (SSR ↔ client)

**Root class (login CSS 404):** SSR `dist/server` can embed absolute browser URLs
`/assets/styles-<hash>.css` (and other preloads) that must exist under
`dist/client/assets`. A client/server hash split serves HTML that 404s CSS while
client JS still loads. Do **not** mask by copying a stale hashed file or
disabling content hashes.

| Gate | Where |
|---|---|
| `pnpm build` | chains `node scripts/assert-build-assets.mjs --write-manifest` |
| Staging image | `deploy/staging/Dockerfile` build stage runs the same `pnpm build` (assert fails the image build) |
| Deploy | `./deploy/staging/scripts/deploy.sh --no-cache` forces clean image rebuild for the pinned SHA |

Local / host check after a clean build:

```bash
rm -rf dist
pnpm build
# → ASSET_COHERENCE OK + dist/asset-coherence-manifest.json (clientManifestHash)
pnpm run assert-build-assets
node -e 'const m=require("./dist/asset-coherence-manifest.json"); console.log(m.clientManifestHash, m.clientAssetCount, m.ok)'
```

Same-SHA clean rebuild (staging image):

```bash
# RELEASE_SHA already set in deploy/staging/.env to the intended full SHA
./deploy/staging/scripts/deploy.sh --no-cache
# equivalent: NO_CACHE=1 ./deploy/staging/scripts/deploy.sh
```

Unit self-tests (no deploy):

```bash
pnpm exec vitest run tests/unit/build-asset-coherence.test.ts
```

---

## 8. Residual / honesty

- Rate limit is process-local (multi-instance not shared).
- Metrics/logs default to memory (+ optional console JSON via `CAIRN_OBS_CONSOLE=1`); no external APM required for staging PASS.
- Authenticated multi-role matrix and browser CSRF e2e remain separate suites.
- Production host is out of scope for this runbook.
