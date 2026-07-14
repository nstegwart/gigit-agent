# Control Center — Performance budgets (AC-PERF-01)

Programmatic harness: `qa/e2e/flows/perf-budgets.mjs`.

This document locks **what** is measured, **where** the budget applies, and **how**
failures are classified. It exists to stop false `class: APP` fails on tunnel
paths that hit the same public-snapshot handler twice under different budgets.

## Stated product budgets (distinct)

| Surface | Budget | When it applies |
|--------|--------|-----------------|
| **On-host / API public snapshot p95** | **≤ 500 ms** (`PERF_P95_MS`) | **Warmed** `GET /api/public-snapshot` (default: **1 cold sample discarded** per series) on an **on-host** proof boundary, or when a **server latency header** is present and preferred |
| **UI filter feedback** | **≤ 200 ms** (`PERF_UI_FILTER_P95_MS`) | **True UI filter surface only** — set `PERF_UI_FILTER_URL` or run `perf-ui-overview-lcp.mjs --live --filter`. Not the default identical public probe |
| Sustained load | 20 req/s × 10 min | Opt-in `--load-10m` only |
| LCP / Overview-ready | ≤ 2.5 s | `qa/e2e/flows/perf-ui-overview-lcp.mjs` (self-test pure; `--live` Playwright) |
| Runner visible / material publish / public | ≤30s / ≤30s / ≤60s | `qa/e2e/flows/perf-freshness-sla.mjs` (**server-clock** lag; `--self-test` / `--live-ro`) |
| Public payload bound | ≤200 tasks / ≤512 KiB | Fail-closed `PAYLOAD_UNBOUNDED` in `perf-budgets.mjs` (MCP `MAX_PAGE_SIZE` parity) |
| Scale fixture | 1000 tasks / 200 runs / 20 accounts / 100 decisions | `qa/fixtures/staging/scale-1000` |

These two latency budgets are **not interchangeable**. UI filter feedback ≤200 is
a product UX budget after data is available. The public-snapshot HTTP probe is an
API budget (≤500 on-host).

## Default harness probes

```bash
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
  node qa/e2e/flows/perf-budgets.mjs
```

| Probe | URL shape | Handler work | Default p95 budget |
|-------|-----------|--------------|--------------------|
| `publicSnapshot` | `/api/public-snapshot?boardId=…` | full public materialization | ≤500 |
| `filterProbe` | same + `&view=filter&bucket=ONGOING` | **identical** (query keys unread by server) | **aligned to public** (≤500) unless overridden |

Investigation (`WORKER_RESULT_investigate-final-filter-perf.md`) proved:

- `view` / `bucket` are **not** read by `handlePublicSnapshotGet`
- public vs filter bodies/etags are byte-identical when both return 200
- on-host both paths are ~13–20 ms p95
- tunnel client wall-clock can exceed 200 ms even without 429 inflation

Therefore the default filter probe **must not** use the UI ≤200 budget. Doing so
produced false `FAIL` + false `class: APP` on SSH tunnels.

### Overriding filter probe budget

```bash
# Force a custom probe budget (even on identical path)
PERF_FILTER_P95_MS=200 WEB_BASE=… node qa/e2e/flows/perf-budgets.mjs

# True UI filter feedback (distinct ≤200 test)
PERF_UI_FILTER_URL=/control-center?view=filter&bucket=ONGOING \
  WEB_BASE=… node qa/e2e/flows/perf-budgets.mjs
```

When `PERF_UI_FILTER_URL` is set, the harness gates **UI filter feedback ≤200**
as a separate pass flag (`passes.uiFilterFeedback`).

## Proof boundary and root class

| `PERF_PROOF_BOUNDARY` | Meaning |
|----------------------|---------|
| `on-host` | Client runs on the same host as the app (or you assert server loopback). Budget fail → **APP** |
| `tunnel` (default for loopback `WEB_BASE`) | SSH local-forward / client≠host. Client wall-clock fail → **TUNNEL**, not APP |
| `client` | Other off-host client path |
| `remote` | Non-loopback URL; budget fail treated as **APP** unless only HARNESS signals |

Auto-default: if `WEB_BASE` host is `127.0.0.1` / `localhost` / `::1` → `tunnel`.

### Classes

| Class | When |
|-------|------|
| `OK` | All applicable budgets pass |
| `STACK` | Transport / uncaught error |
| `HARNESS` | Rate-limit (429) pollution, or sample plan below policy with fails |
| `TUNNEL` | Budget fail on tunnel/client wall-clock without server latency proof |
| `APP` | Budget fail with `on-host` boundary **or** safe server-latency samples |
| `APP_OR_STACK` | Zero successful samples |

**Never** label APP solely because a tunnel client p95 > 200 on the identical
public-snapshot path.

## Server latency preference

If the response includes a safe server-timing / latency header, the harness
prefers it for budget math:

- `Server-Timing: app;dur=…` (or `handler` / `total` / `server`)
- `x-server-latency-ms` / `x-backend-latency-ms` / `x-app-latency-ms`
- `x-response-time: …ms`

The product public-snapshot route currently records `latencyMs` in observability
only (not always as a response header). When headers are absent, the harness
uses **client wall-clock** and classifies tunnel fails as **TUNNEL**.

## Rate-limit-aware sampling

`PUBLIC_SNAPSHOT_RATE_LIMIT_V1`: burst **20**, sustained **60/min**.

Default multi-series sampling is capped so public + filter do not self-trip:

- `sampleN` ≤ `burst/2` (default cap **10** when two series)
- `gapMs` auto ≥ **1000 ms** (token refill floor) unless `PERF_SAMPLE_GAP_MS` is set
- series cool-down between public and filter series
- **Warm discard (default):** one cold GET per series is issued and **excluded** from APP p95 (`PERF_WARM_DISCARD=0` to disable)
- Warm requests count toward rate plan `totalRequests`
- **429 samples are classified separately**; they do **not** enter APP p95
- **429 retries are not folded into APP latency** (`retries429 > 0` excluded)

Override carefully:

```bash
PERF_SAMPLE_N=8 PERF_SAMPLE_GAP_MS=2000 WEB_BASE=… node qa/e2e/flows/perf-budgets.mjs
```

## Public payload fail-closed

Public snapshot materializes full `tasks[]` / `runs[]` without pageSize. The harness
inspects one response body and fail-closes with `PAYLOAD_UNBOUNDED` when:

- `taskCount > PERF_PAYLOAD_MAX_TASKS` (default **200**, MCP `MAX_PAGE_SIZE` parity), or
- `bodyBytes > PERF_PAYLOAD_MAX_BYTES` (default **512 KiB**)

This is a **harness warning gate**, not a product fix. Product still returns O(n)
payloads; at scale-1000 the bound is expected to trip until pagination exists.

## Overview-ready / LCP + UI filter

```bash
# Pure self-test (no browser)
node qa/e2e/flows/perf-ui-overview-lcp.mjs --self-test

# Live bounded Playwright (requires WEB_BASE + storageState for auth surfaces)
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
  node qa/e2e/flows/perf-ui-overview-lcp.mjs --live

# + filter feedback (Work bucket deep-link or PERF_UI_FILTER_URL)
WEB_BASE=… PERF_UI_FILTER_URL=/b/mfs-rebuild/work?bucket=ONGOING \
  node qa/e2e/flows/perf-ui-overview-lcp.mjs --live --filter
```

Ready metric: `[data-testid="control-center-overview"]:not([data-surface-state="loading"])`
within **≤ 2.5 s**. LCP is secondary when the marker is present.

### UI filter feedback metric (in-surface after data)

Product budget **≤ 200 ms** is **in-surface feedback after data is available**, not cold
navigation:

1. Load Work base (`/b/{board}/work`) and wait for data-ready surface.
2. Start timer; click target bucket tab (`data-testid=work-tab-{BUCKET}`).
3. Stop timer when feedback / selected tab is visible.
4. Sample is tagged `metricKind: in_surface_after_data`.

**Fail closed:**

- `metricKind` of `navigation_wall` / `page_goto` / cold load → never PASS (even if ms ≤ 200)
- Work data not ready, or filter control unavailable after data → no sample; FAIL when applicable
- Do **not** substitute `page.goto` wall time for the ≤200 claim

## Timed freshness (server-clock)

Lag is always `visibleAt(server) − eventAt(server)`. Client wall-clock is support-only.

**Out-of-order / negative lag (hard rule):** if `visibleAt < eventAt`, `lagMs` is negative
(e.g. **-15000**). That is **always FAIL** (`error: out_of_order_negative_lag`). Negative
lag must never pass because it is ≤ SLA numerically.

```bash
# Pure timelines + public snapshot field evaluator + handling scenarios
node qa/e2e/flows/perf-freshness-sla.mjs --self-test

# Single RO public-snapshot GET (no register/load)
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
  node qa/e2e/flows/perf-freshness-sla.mjs --live-ro
```

Budgets: runner **≤30 s**, material **≤30 s**, public publication lag / ageMs **≤60 s**.
`stale:true` with age within product threshold is **forceStale** (domain blockers), not
an age-SLA fail by itself. `--live-mutate` is disabled by default (shared staging safety).

### Handling scenarios (pure evaluators)

| Scenario | Evaluator | Contract |
|----------|-----------|----------|
| **reconnect** | `evaluateReconnectRecovery` | order: event ≤ disconnect ≤ reconnect ≤ reVisible; lag = reVisible − reconnect ≤ SLA |
| **duplicate** | `evaluateDuplicateDelivery` | multi-delivery same event → normalize earliest valid visibleAt ≥ eventAt; discard OOO samples |
| **out-of-order** | `serverClockLagMs` / `evaluateTimedSla` | negative lag always FAIL |
| **manual refresh** | `evaluateManualRefresh` | refreshRequestedAt → refreshVisibleAt server lag; staleBefore expected, not auto-fail |
| **stale snapshot** | `evaluatePublicFreshnessFromSnapshot` | forceStale orthogonal to age SLA |

## Commands

```bash
# Self-test (no network)
node qa/e2e/flows/perf-budgets.mjs --self-test
node qa/e2e/flows/perf-ui-overview-lcp.mjs --self-test
node qa/e2e/flows/perf-freshness-sla.mjs --self-test

# Scale fixture only
node qa/e2e/flows/perf-budgets.mjs --scale-only

# On-host APP proof (run ON the staging host, or assert loopback there)
PERF_PROOF_BOUNDARY=on-host WEB_BASE=http://127.0.0.1:33211 \
  BOARD_ID=mfs-rebuild node qa/e2e/flows/perf-budgets.mjs

# Tunnel verify (class stays TUNNEL on client-wall fail)
PERF_PROOF_BOUNDARY=tunnel WEB_BASE=http://127.0.0.1:33211 \
  BOARD_ID=mfs-rebuild node qa/e2e/flows/perf-budgets.mjs

# Long load opt-in
WEB_BASE=… PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 \
  node qa/e2e/flows/perf-budgets.mjs --load-10m
```

## Unit tests

```bash
pnpm exec vitest run tests/unit/perf-budgets.test.ts \
  tests/unit/perf-ui-overview-lcp.test.ts \
  tests/unit/perf-freshness-sla.test.ts
# or
npm test -- tests/unit/perf-budgets.test.ts
```

## Residual product notes (not harness)

- Every public GET still reloads full aggregation before materialize/ETag (APP residual for load, not filter-specific).
- Optional aggregation short-TTL cache is product work, not required for on-host ≤500.
- Do not invent a filter materialization path for `view=filter` unless product needs it.
- Public snapshot O(n) full-board payload remains a product residual; harness only fail-closes the warning.
