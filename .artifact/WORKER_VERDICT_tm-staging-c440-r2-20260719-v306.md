# WORKER_VERDICT — TM-VERIFY-STAGING-C440-R2

| Field | Value |
|---|---|
| **TASK_ID** | `TM-VERIFY-STAGING-C440-R2` |
| **SLUG** | `tm-staging-c440-r2-20260719-v306` |
| **ROLE** | Independent Grok LIVE STAGING VERIFIER R2 only (not operator / author / integrator) |
| **MODEL** | grok-4.5 high |
| **UTC_DATE** | `2026-07-19` |
| **TARGET_SHA** | `c44060b28dfe0c0b0be70cbdbf5f5fd143357155` |
| **STACK** | Task Manager staging only (`127.0.0.1:33211` / `cairn_tm_v3_staging`) |
| **MUTATION** | **NONE** product/source/Git/index/config/service/deploy/schema. Ephemeral `sessions` row for pre-existing e2e admin was seeded for browser probes and **deleted** after. No production. No MFS product/rebuild. |
| **EVIDENCE** | Nonsecret under `/tmp/tm-verify-staging-c440-r2-20260719-v306/` + this verdict path only |
| **OVERALL** | **FAIL** |

---

## 0. Executive verdict

Independent live re-bind of staging against exact

`c44060b28dfe0c0b0be70cbdbf5f5fd143357155`

**does not meet every required gate**. Runtime/deploy/P3D/data-ledger/security/API pins largely **PASS**. Canon Alur browser completeness (official functional harness, dark token fidelity, node sheet content + related-nav S2, edge-canvas ink) **FAIL or incomplete**.

**Do not emit** `TASK_MANAGER_STAGING_VERIFIED: c44060b28dfe0c0b0be70cbdbf5f5fd143357155`.

### Exact blockers (release-blocking)

| ID | Gate | Measured | Severity |
|---|---|---|---|
| **B-TOKENS-DARK** | Exact dark canon colors / static fidelity `tokens_sample` | Live Alur `--bg=#fafafa` light scheme; expected `#0d1017` / panel `#12161e` / tx `#e8edf3`. Static harness **26/27** with sole FAIL `tokens_sample`. | **BLOCKER** |
| **B-FUNC-OOM** | Live `canon-flow-functional.mjs --run` complete B\*/S\* | Progress: **B0/B1/B2 PASS** (652 nodes; 5 UI projects). Crash: `RangeError: getImageData … Out of memory` on `canvas.flow-edges` **28880×19284** (~2.23 GiB). Harness exit 2; no complete status JSON. | **BLOCKER** |
| **B-SHEET-S2** | Node sheet content + Navigasi terkait replace+center+highlight (S2) | After Fit (`Muat`) + force click, sheet **opens** but body is empty shell (`title=Detail`, no Navigasi terkait / related `data-goto`, no feature copy). S2 not proven. | **BLOCKER** |
| **B-MCP-SMOKE-REAL** | `staging-agent-smoke.mjs --real` dual-principal | With ROOT+AGENT+`STAGING_AGENT_ID=agent-synth-stg-smoke` + live pin bind: **FAIL** `PUBLISH_FAIL` — `entityExpectedRev` required on `publish_dispatch_plan`. Non-mutating MCP subset still OK. | **BLOCKER** (full MCP harness) |

### Non-blocking residuals (recorded, not sole cause)

| ID | Note |
|---|---|
| R-CANVAS-SIZE | Edge canvas bitmap unbounded → official edge-ink / B6 path unsafe without product canvas change |
| R-DPR2-HARNESS | Viewports 390/1440/2560 PASS at DPR1; DPR2 context not fully re-run after sheet timeout (partial) |
| R-AGENT-SMOKE-MUTATE | Full `--real` smoke performs control-plane writes; verifier limited mutating surface; fail closed on missing entity rev rather than force write |

---

## 1. Authority bind (required a305 + R3)

| Check | Evidence | Result |
|---|---|---|
| R3 synthesis exists | `.artifact/WORKER_VERDICT_tm-final-release-synthesis-r3-20260719-v304.md` | **PASS** |
| R3 literal | `APPROVED_FULL_SHA: c44060b28dfe0c0b0be70cbdbf5f5fd143357155` + `OVERALL: PASS` | **PASS** |
| a305 deploy result | `.artifact/WORKER_RESULT_deploy-tm-staging-c440-r2-20260719-a305.md` `RESULT: DEPLOY_OK` | **PASS** |
| a305 candidate = target | `c44060b28dfe0c0b0be70cbdbf5f5fd143357155` | **PASS** |
| Verifier ≠ operator | This session R2 verifier only; a305 operator smoke not reused as acceptance | **PASS** |

R3 explicitly left **live staging re-acceptance of c440 NOT YET PROVEN** — this packet is that live attempt; result = **FAIL** (blockers above).

---

## 2. Fresh backup / rollback / runtime SHA (read-only)

### 2.1 Runtime

| Probe | Measured | Result |
|---|---|---|
| Workspace HEAD | `c44060b28dfe0c0b0be70cbdbf5f5fd143357155` | **PASS** |
| `origin/main` | same | **PASS** |
| Staging source HEAD | same (`fix(cp0): format MySQL freshness timestamps`) | **PASS** |
| Container image | `cairn-tm-v3-app:c44060b28dfe0c0b0be70cbdbf5f5fd143357155` healthy | **PASS** |
| Image id | `sha256:4b72dce91f7b9894298b99e9b28a1d82311c89eed7cfd706f37e404f83248ba2` | **PASS** (matches a305) |
| MySQL | `cairn-tm-v3-mysql` healthy | **PASS** |
| Process pins | `RELEASE_SHA`/`CAIRN_DEPLOYED_SHA`/`CAIRN_EXPECTED_SHA`=`c44060b…`; `CAIRN_SCHEMA_VERSION=014`; `CAIRN_MIGRATION_LATEST=014`; `CAIRN_ENV=staging` | **PASS** |

### 2.2 Backup / rollback artifacts (verified present; **not** executed)

| Asset | Mode / bytes | SHA-256 | Result |
|---|---|---|---|
| `…/snapshots/pre-deploy-c440-20260719T082216Z.sql.gz` | **600** / **2076511** | `55524ab7f1cedf3a5fd3243bdd3cde264f2eabf4e12bc7ba5b332ce7506bb30c` | **PASS** (sidecar match; `gzip -t` OK) |
| `…/env-pre-deploy-c440-20260719T082216Z.env.bak` | **600** / 952 | `16476742dd2001ce8ba2f19853cdde20fa0fd467c0d5c5ac11b1106f41d5419d` | **PASS** (content not printed) |
| `…/rollback-marker-pre-c440-20260719T082216Z.txt` | **600** / 1027 | `ba50312022959ea310a1573f67388a5a81f3207f22ab7b0d1ce43dcf26c69b96` | **PASS** |
| Prior image retained | `cairn-tm-v3-app:7b9d28f113a35957468c55aa3b2ec17edf81aa25` (`941de1eda44c…`) | present | **PASS** |
| Rollback executed? | **No** — staging healthy at c440; rollback artifacts only | | **PASS** (do-not-rollback-healthy) |

Meta ledger-at-dump: tip **014** / `56d97d15…ceb0` / nodes 652 / edges 622 / pages 722 / nav 3547 / sync 0 / outbox 0.

---

## 3. Health / auth / schema014 / migration014

| Probe | Measured | Result |
|---|---|---|
| Unauth `GET /api/healthz` | **401** `AUTHORIZATION_REQUIRED` | **PASS** |
| Auth loopback `Origin: http://127.0.0.1:33211` | **200** | **PASS** |
| Auth localhost origin | **200** | **PASS** |
| Auth no-origin | **200** | **PASS** |
| Auth + forwarded edge headers | **200** | **PASS** |
| `deployedSha` / `release.sha` | exact `c44060b28dfe0c0b0be70cbdbf5f5fd143357155` | **PASS** |
| `release.match` | **true** | **PASS** |
| `schema.version` / `match` | **014** / **true** | **PASS** |
| Migration | `expectedLatestVersion=014`; applied **000…014** count **15**; status `IDEMPOTENT_NOOP` | **PASS** |
| `unhealthyReasons` | `[]` | **PASS** |
| deps mysql / control-plane / schema-required-tables | **up** | **PASS** |
| Pin | `boardRev=544` `lifecycleRev=3` `canonicalHash=c0797378…b05e39` | **PASS** |

Ledger tip file hash re-bound:

| version | filename | sha256 |
|---|---|---|
| **014** | `014_cp0_sync_backlog_sources.sql` | `56d97d15e1d3047d7da6f78707ba16c11182f5c03791f5227c3d84f3c381ceb0` |

Workspace file `migrations/014_cp0_sync_backlog_sources.sql` SHA-256 **exact match**. Continuous versions **000–014** (15 rows). **PASS**.

---

## 4. App-flow 652/622 · five projects · page-nav 722/3547

| Metric | Expected | Measured | Result |
|---|---|---|---|
| `app_flow_nodes` | 652 | **652** | **PASS** |
| `app_flow_edges` | 622 | **622** | **PASS** |
| `app_pages` | 722 | **722** | **PASS** |
| `nav_edges` | 3547 | **3547** | **PASS** |
| Tables | 57 | **57** | **PASS** |
| Projects (nodes) | affiliate/backend/rn/sales/web | **36 / 167 / 333 / 13 / 103** | **PASS** |
| Projects (edges) | five only | **37 / 166 / 305 / 12 / 102** | **PASS** |
| `control_plane_sync_outbox` | 0 | **0** | **PASS** |

UI mode node counts (live browser, journey layer) differ from raw DB project rows (e.g. rn UI **353** vs DB **333**) — expected journey materialization; cross mode still shows **652** nodes. MCP `get_flow` project=rn → **333 nodes / 305 edges** matches DB.

---

## 5. P3D staging-only allowlist · prod gate off · CAS/freshness · NO_OUTBOX

| Check | Measured | Result |
|---|---|---|
| `CAIRN_CP0_SYNC_STATUS_PUBLISHER` | `1` | **PASS** |
| `CAIRN_CP0_SYNC_STATUS_PUBLISHER_BOARDS` | `mfs-rebuild` only (explicit allowlist) | **PASS** |
| `CAIRN_CP0_SYNC_STATUS_PUBLISHER_ALLOW_PRODUCTION` | **ABSENT** | **PASS** |
| Outbox writer env | **ABSENT** | **PASS** |
| Sink rows | **only** `board_id=mfs-rebuild` (count 1) | **PASS** |
| Non-allowlisted boards | no extra `control_plane_sync_status` rows | **PASS** |
| Status | `IN_SYNC`; `zeroBacklogProven=true`; outbox pending **0** | **PASS** |
| Pin stable while ticking | board_rev **544**, lifecycle_rev **3**, canonical_hash stable | **PASS** |
| Freshness / entity_rev advance (A→B ~35s) | entity_rev **24→25**; freshness `08:36:46.900Z` → `08:37:19.047Z` | **PASS** |
| Continued advance (session window) | health entityRev observed through **40** with advancing `freshnessAt` | **PASS** |
| Error storm (45m logs) | `ER_TRUNCATED_WRONG_VALUE` / `PUBLISHER_ERROR` / `SKIP_ERROR` / `Incorrect datetime` count **0** | **PASS** |
| Causal close vs a288 | MySQL datetime3 product-path CAS accepts; no ISO-truncation storm | **PASS** |

**NO_OUTBOX:** `control_plane_sync_outbox` count **0** throughout; health `currentOutbox=0`. **PASS**.

P3C→P1→P2→P3A chain is **live-supported** on staging at c440 (shared snapshot counts + publisher measures + MySQL sink CAS) under staging allowlist only.

---

## 6. Board / control-center → primary Alur (start flow)

| Check | Measured | Result |
|---|---|---|
| Unauth `/` | redirect toward login (security soft-closed residual noted in harness) | **PASS** fail-closed |
| Auth board → Alur | Live nav to `/b/mfs-rebuild/alur` | **PASS** |
| One-screen anatomy | `.flow-top` / modes / stage / world / edges canvas / nodes / zoom / sheet present; legacy maze selectors absent | **PASS** |
| Six modes | Lintas Proyek, React Native, Web Member, Panel Sales, Afiliasi, Backend | **PASS** |
| Default cross | Lintas Proyek selected; `data-mode=cross` | **PASS** |
| Mode switches nodes>0 | rn 353 · web-member 131 · panel-sales 42 · affiliate 37 · backend 208 | **PASS** |
| Pan ~300px | world transform tx **-4327→-4627** | **PASS** |
| Drag node ≥120px | dx≈120, dy≈40 | **PASS** |
| `cairn-flow-pos-v1` | localStorage present after interaction | **PASS** |
| Indonesian chrome | Alur / Lintas Proyek visible; aria-label samples Indonesian (`About, Sebagian`) | **PASS** |
| Tech IDs hidden | no FEAT-/PROD_READY/rebuild path leaks in visible body text | **PASS** |
| Viewports 390 / 1440 / 2560 | stage visible; modes visible; no horizontal blowout | **PASS** |
| S1 layer/graph | `data-mode=cross`, `data-layer=app_flow`, nodes `af:…` journey ids; inv: count 0 in sample | **PASS** (probe) |
| Zoom UI | `+` / `−` / `Muat` (Fit) | **PASS** present |

---

## 7. Harness matrix (exact target SHA)

| Harness | Mode | Result | Notes |
|---|---|---|---|
| `canon-flow-functional.mjs --self-test` | offline | **PASS** `HARNESS_READY` | S1/S2/S3 fixtures + hard-fail registry |
| `canon-flow-functional.mjs --run` | live | **FAIL / incomplete** | B0–B2 PASS then OOM on canvas digest (**B-FUNC-OOM**) |
| Live browser probe (jobtmp) | live | **28/32** probe checks | Fails: empty sheet content path, dark tokens, canvas bound, related-nav |
| Fit+click sheet follow-up | live | sheet **open** but empty Detail shell | **B-SHEET-S2** |
| `canon-flow-static-fidelity.mjs --run` | live | **FAIL** 26/27 | sole `tokens_sample` (**B-TOKENS-DARK**) |
| `canon-flow-static-fidelity` / visual / perf `--self-test` | offline | **PASS** HARNESS_READY | |
| `security-probes.mjs` | live | **PASS** 15/15 `ok:true` | unauth healthz, public redaction, etag 304, rate limit, MCP public-only, sensitive 401, wrong bearer 401, etc. |
| `perf-budgets.mjs` | live | **PASS** `class:OK` | public + filter p95 within budget; 10m load not opted-in (residual) |
| `staging-agent-smoke.mjs --real` | live | **FAIL** | **B-MCP-SMOKE-REAL** |
| MCP tools/list (ROOT) | live | **PASS** 87 tools | |
| MCP unauth tools/list | live | **PASS** public-only `get_public_snapshot` | |
| MCP unauth `list_tasks` | live | **PASS** 401 / `AUTHORIZATION_REQUIRED` | |
| MCP `get_sync_status` | live | **PASS** IN_SYNC, outbox 0, pin 544/3 | |
| MCP `get_flow` rn | live | **PASS** 333/305 | |
| Public snapshot | live | **PASS** 200; pin matches; no secret-like keys | |
| a11y axe live | partial | **NOT COMPLETE** | node outside viewport aborted click path; no critical/serious receipt this session |

Official functional note: harness hardcodes `functionalPass: false` and terminal status **LOCAL_ONLY** even when checks green (data-honesty policy). Completeness still required for independent acceptance; OOM prevented a full green check set.

---

## 8. Security negatives (fail closed)

| ID | Result |
|---|---|
| AC-AUTH-healthz-unauth | **PASS** |
| AC-AUTH-root-login-redirect | **PASS** (softClosed residual documented by harness) |
| AC-PUBLIC-snapshot-redacted | **PASS** |
| AC-PUBLIC-etag-304 | **PASS** |
| AC-AUTH-rate-limit-burst | **PASS** |
| AC-AUTH-mcp-tools-list-public-only | **PASS** |
| AC-AUTH-mcp-list_tasks-unauth-401 | **PASS** |
| AC-OPS-healthz-auth | **PASS** |
| Wrong bearer / wrong cairn token healthz+MCP | **PASS** |
| Cookie-only MCP sensitive | **PASS** |
| Malformed MCP JSON | **PASS** |
| Session get unauth | **PASS** |
| Wrong HTTP method tools/call | **PASS** fail-closed |

**Security pack: PASS.**

---

## 9. What is proven vs not

### Proven on live staging at c440

- Deploy authority a305 + source approval R3 for exact SHA  
- Runtime/image/source SHA exact match; schema/migration **014**; health green  
- App-flow + page-nav counts + five-project DB fingerprints + ledger tip hash  
- P3D staging allowlist, production second gate off, CAS freshness advance, NO_OUTBOX, no datetime error storm  
- Security negative pack  
- Public/API health/MCP read surfaces  
- Alur primary shell, six modes, cross five, pan/drag/zoom chrome, Indonesian labels, responsive 390/1440/2560, S1 journey-prefixed nodes  
- Rollback assets intact; **no rollback performed**

### Not proven (blockers)

- Dark canon **exact colors** on live Alur surface  
- Full official functional S1/S2/S3 browser gate (OOM + incomplete)  
- Node sheet **content** + related-row semantic navigation (S2)  
- Full dual-principal staging agent smoke (`entityExpectedRev` on publish)

---

## 10. Final status

```text
TASK_ID: TM-VERIFY-STAGING-C440-R2
ROLE: independent-live-staging-verifier-r2
MODEL: grok-4.5 high
TARGET_SHA: c44060b28dfe0c0b0be70cbdbf5f5fd143357155
APPROVAL_R3: WORKER_VERDICT_tm-final-release-synthesis-r3-20260719-v304.md PASS
DEPLOY_A305: WORKER_RESULT_deploy-tm-staging-c440-r2-20260719-a305.md DEPLOY_OK
RUNTIME_SHA: c44060b28dfe0c0b0be70cbdbf5f5fd143357155
SCHEMA_MIGRATION: 014 / 014 IDEMPOTENT_NOOP
UNAUTH_HEALTH: 401
AUTH_HEALTH: 200 release.match=true schema014
APP_FLOW: 652/622
PAGE_NAV: 722/3547
LEDGER_TIP: 014 sha256 56d97d15e1d3047d7da6f78707ba16c11182f5c03791f5227c3d84f3c381ceb0
P3D: allowlist mfs-rebuild; prod gate ABSENT; CAS freshness advances; outbox 0; error storm 0
SECURITY: 15/15 PASS
PERF_BUDGETS: OK
FUNCTIONAL_SELFTEST: PASS
FUNCTIONAL_LIVE: FAIL/incomplete (canvas OOM)
STATIC_LIVE: FAIL tokens_sample (light vs dark canon)
SHEET_S2: FAIL empty Detail shell / no Navigasi terkait
MCP_SMOKE_REAL: FAIL entityExpectedRev
ROLLBACK: artifacts verified; not executed
OVERALL: FAIL
```

**Blocked token (not emitted):**

`TASK_MANAGER_STAGING_VERIFIED: c44060b28dfe0c0b0be70cbdbf5f5fd143357155`

**Exact blocker line for controller:**

`BLOCKER: B-TOKENS-DARK + B-FUNC-OOM + B-SHEET-S2 + B-MCP-SMOKE-REAL — live staging at c440 does not clear full Alur/functional/MCP acceptance despite P3D/runtime/data PASS.`

Evidence root (nonsecret): `/tmp/tm-verify-staging-c440-r2-20260719-v306/`.

WORKER_VERDICT_END
