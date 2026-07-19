# WORKER_RESULT — Production Preflight Refresh R2

```
TASK_ID:     TM-PREFLIGHT-PRODUCTION-REFRESH-R2
slug:        preflight-tm-production-refresh-r2-20260719-a265
role:        READ-ONLY PRODUCTION PREFLIGHT operator only
             (not author / integrator / migration operator / deployer)
model:       grok-4.5 high
workspace:   /opt/mfs/workspace/task-manager
operated_at: 2026-07-19T04:44:31Z … 2026-07-19T04:47:30Z (UTC probe window)
environment: PRODUCTION (live edge + SSH app host + RO SQL) + staging RO context
mutation:    NONE
             - no Git mutation / checkout / pull / build / deploy
             - no DDL/DML apply / locks / migrations
             - no backup creation
             - no service/PM2/nginx/container restart or reload
             - no provider mutation
             - no MFS product/rebuild repo touch
             - credentials / tokens / DSNs / host identities beyond sanitized class NEVER printed
write_scope: this receipt only under .artifact/
prior_refresh: .artifact/WORKER_RESULT_preflight-tm-production-schema-release-r1-20260719-a241.md
verdict:     PRODUCTION_PREFLIGHT_BLOCKED
READY_FOR_011: no
```

**OWNER_TARGET (sanitized):** `{base_url: https://task-manager.mfsdev.net, port: 3210, account: production (approval-gated), device: n/a}`

**Authority boundary:** This packet is **read-only evidence refresh**. It is **not** mutation approval, backup authority, migrate-apply authority, or production publish authority.

**Source anchors (secret-safe):**
- `docs/runbook-production.md`
- `deploy/production/**` (preflight, migrate-plan/apply, release, health-readback, rollback, gates)
- Prior production preflight a241 (refreshed against live truth, not assumed)
- Staging context: a200 / a206 / a232 / a234 / a238 / a261 (context only; not production PASS)

---

## Executive verdict

| Gate | Result |
|---|---|
| Production identity proven (edge + origin + loopback + host) | **PASS (readback)** |
| Live app release SHA pinned | **PASS** → `8cde4f86868aebcb5784ba13405a6b1e1e2b81a3` |
| Live schema/migration tip pinned | **PASS** → **010** (ledger + healthz agree) |
| Ledger continuous 000–010; no gaps/duplicates | **PASS** (11 rows) |
| History hashes 000–010 vs workspace files | **PASS** 11/11 ALL_MATCH |
| Exact next pending version | **011** only (never batch-skip) |
| Ordered pending chain (repo/manifest) | **011 → 012 → 013 → 014** |
| Workspace source hashes 011–014 | **PASS** all four match locked expectations |
| Prod checkout source for 011/012 | **PRESENT** (hashes match); **013/014 MISSING** on host tree |
| 013 pre-state (CI collation still live) | **CONFIRMED** `utf8mb4_unicode_ci` on both `task_id` cols |
| 013 CI→bin precheck (dist_bin == dist_ci) | **PASS** board `mfs-rebuild` n=2499 delta=0 |
| 014 additive tables absent on production | **CONFIRMED** (both absent) |
| Fresh ≤24h backup of current tip-010 DB | **FAIL / MISSING** |
| Staging formal release acceptance for prod cutover | **FAIL** (a238 `BLOCKED/PENDING`; app pin 008 vs DB 014) |
| Owner-accepted production publish SHA bound | **FAIL** (no final accepted SHA for schema-014 app) |
| Production mutation / deploy authorized by this packet | **NO** |
| zeroBacklogProven | **false** (fail closed; do not invent from empty/missing 014 tables) |
| CP0 sync freshness | **STALE** freshnessAt `2026-07-16T14:12:46.594Z` (~**62.5 h** at probe) |
| **READY_FOR_011** | **no** |

### **VERDICT: `PRODUCTION_PREFLIGHT_BLOCKED`**

Independent production truth is current and self-consistent at **SHA `8cde4f8…` / schema `010`**. Do **not** claim readiness from workspace/future SHA `b149509…` (or any post-010 tip) or from stale backups. Exact next migration authority remains **011 only**. First mutation is blocked until a fresh tip-010 backup + separate operator approval bundle exist.

---

## 1. Redacted read-only command / exit table

| # | Command class (redacted) | Exit | Result summary |
|---|---|---|---|
| 1 | Auditor `hostname` / `whoami` / date UTC | 0 | Host `mfs-rebuild-automation-01`; not prod VPS |
| 2 | Edge unauth `GET /api/healthz` | 0 | **HTTP 401** `AUTHORIZATION_REQUIRED` (liveness OK) |
| 3 | Edge auth healthz (token env-ref; never printed) + browser-class UA | 0 | **HTTP 200**; SHA/schema pin §2 |
| 4 | SSH BatchMode prod host process/git/ss/systemd/nginx/backups | 0 | Host class prod app; HEAD=`8cde4f8…`; PM2 online; `:3210` listen |
| 5 | Prod loopback unauth healthz | 0 | **HTTP 401** |
| 6 | Prod loopback auth healthz | 0 | **HTTP 200** same pin as edge |
| 7 | Prod origin `https://127.0.0.1` Host=`task-manager.mfsdev.net` auth healthz | 0 | **HTTP 200** same pin |
| 8 | Prod RO `mysql2` + `START TRANSACTION READ ONLY` + ledger/objects/collation | 0 | Tip **010**; counts; 013 CI pre-state |
| 9 | `ROLLBACK` (RO txn end) | 0 | No write |
| 10 | Workspace `sha256sum migrations/*.sql` + offline manifest | 0 | 000–014 hashes frozen; offline tip **014** |
| 11 | `git rev-parse` HEAD/origin + prod ancestry | 0 | Topology §5 |
| 12 | Backup inventory + ages + sha256 + `gzip -t` | 0 | No ≤24h tip-010 dump |
| 13 | `rollback.sh --classify` matrix (dry classify only) | 0 | Current class `APP_ONLY_PRIOR_SHA` (no schema move yet) |
| 14 | Staging docker RO tip/counts (context) | 0 | Staging tip **014**; app-flow data present; app pin **008** |
| 15 | `df -h` prod `/` | 0 | ~7.8 GiB free (capacity note only; not a receipt) |

**Secrets policy:** token/password/DB hostname values never printed. DB name `cairn_taskmanager`, `CAIRN_ENV=production`, host class REMOTE, port 3306, credential **lengths only**.

---

## 2. Actual current production release / process truth

### 2.1 App / process / edge

| Field | Live value | Proof |
|---|---|---|
| Public host | `task-manager.mfsdev.net` | edge + nginx `server_name` |
| App host hostname | `stg-fe-jkt` | SSH |
| App path | `/home/gian.devx/cairn-taskmanager` | SSH |
| Git HEAD (prod checkout) | **`8cde4f86868aebcb5784ba13405a6b1e1e2b81a3`** | `git rev-parse` + healthz |
| Subject | `fix(alur+mcp): EN strings…` | prod `git log -1` |
| Branch | detached `HEAD` | SSH (`GIT_BRANCH=HEAD`, detached=yes) |
| Upstream | **none** | detached |
| Dirty count | **45** (all `??` untracked deploy markers / backups; not release code pin) | informational |
| PM2 name | `cairn-taskmanager` | **online**; restarts=6; unstable=0; fork_mode; node **22.22.0** |
| PM2 uptime | ~**31.5 h** at probe | pm_uptime delta |
| Listen | **127.0.0.1:3210** | `ss` LISTEN; node under PM2 |
| Systemd | `pm2-gian.devx.service` | **active** + **enabled** |
| nginx upstream | `http://127.0.0.1:3210` | site file readable |
| Deploy last ts | `20260717T184404Z` | `.deploy-last-ts` |
| Dist present | yes (`dist/server/server.js`) | SSH |
| Dist rollback artifacts | multiple `dist.rollback-20260717T*` (Jul-17) | present; latest `…211133Z` |
| Latest recorded prior SHA file | `0ff82dc4477935509fcde66f8607b27c1de13e24` (`.deploy-prior-sha-20260717T200207Z`) | app prior list |
| Image | **N/A** (bare-metal PM2, not container) | — |
| Future workspace SHA on host object store | **`b149509…` / `ed4585b…` not present** (`git cat-file` fail for `ed4585b…`) | deploy-time `git fetch` required |

**Prod checkout migrations on disk (not equal to applied ledger):**

| File | On prod tree | sha256 |
|---|---|---|
| `010_product_features.sql` | present | `1b7ff33cd40ee821f22f8952f91c6ad9d890560caad6a1c25c2f4d0efa3728d7` |
| `011_feature_flow_edges.sql` | present | `8ce2567ebb65ed3971dbabef995e5e5cfbb8724eb381a91557ce90420a620568` |
| `012_ultimate_map.sql` | present | `ad6acb1631fc23287b4540ecc9326e9dc82702257fd5576d72d7e88dbcbc33db` |
| `013_classification_task_id_case_sensitive.sql` | **MISSING** | — |
| `014_cp0_sync_backlog_sources.sql` | **MISSING** | — |

Applied ledger tip remains **010** (files present ≠ applied). 013/014 apply requires accepted checkout that contains those exact files.

### 2.2 Authenticated health (loopback / origin / edge) — ~2026-07-19T04:45Z

| Surface | HTTP | deployedSha | schema.version | schema.match | expectedLatest | migration.status | unhealthy |
|---|---|---|---|---|---|---|---|
| Loopback `127.0.0.1:3210` | **200** | `8cde4f8…` | **010** | true | **010** | IDEMPOTENT_NOOP | `[]` |
| Origin nginx Host | **200** | same | **010** | true | **010** | IDEMPOTENT_NOOP | `[]` |
| Public edge | **200** | same | **010** | true | **010** | IDEMPOTENT_NOOP | `[]` |
| Edge unauth | **401** | — | — | — | — | — | liveness only |
| Loopback unauth | **401** | — | — | — | — | — | liveness only |

Additional healthz fields (edge/loopback agree):

| Field | Value |
|---|---|
| service | `cairn-task-manager` |
| release.match | true (self-match to **current** checkout only — **not** a new release PASS) |
| appliedVersions | `000`…`010` |
| dependencies | mysql=up, control-plane=up, schema-required-tables=up |
| boardRev / lifecycleRev | **5845** / **1** |
| canonicalSnapshotId | `blindspot-2501-20260716` |
| canonicalHash | `8ba475c604a09fc9ae0f1510835cf7260d4a46f9e459424cb0b12ab7003bbd7b` |
| sync.status | `IN_SYNC` (claimed) |
| effectiveBacklog | **null** |
| zeroBacklogProven | **false** |
| freshnessAt | `2026-07-16T14:12:46.594Z` (**stale** ~**62.5 h** vs probe) |
| checkedAt (edge) | `2026-07-19T04:45:04.178Z` |

**Classification:** Production is **live and self-consistent** at SHA `8cde4f8` / schema **010**. This is **not** a release PASS for any newer SHA (workspace HEAD `b149509…` or any post-014 candidate).

### 2.3 CP0 sync / readback (fail closed)

| Source | Observation | Verdict |
|---|---|---|
| healthz `sync.zeroBacklogProven` | **false** | fail closed |
| healthz `sync.effectiveBacklog` | **null** | not proven zero |
| healthz `sync.freshnessAt` | 2026-07-16T14:12:46.594Z (~62.5h old) | **STALE** |
| table `control_plane_sync_status` | PRESENT count **1** (sink row) | sink ≠ zero-backlog proof |
| sink row (sanitized) | status=IN_SYNC; outbox_pending=0; legacy_unreplayed=0; effective_backlog=0; board_rev=**3980** (≠ healthz boardRev 5845); freshness_at same stale stamp | **inconsistent / not authoritative for release close** |
| `control_plane_sync_outbox` / `legacy_residuals` | **ABSENT** (014 not applied) | cannot claim durable backlog sources |

**Do not** claim zero-backlog or CP0 production close from sink zeros or missing 014 tables.

---

## 3. Production DB identity / migration ledger / schema objects

### 3.1 DB identity (redacted)

| Field | Value |
|---|---|
| `CAIRN_ENV` | `production` |
| `DATABASE()` | `cairn_taskmanager` |
| MySQL version | `8.0.46-0ubuntu0.22.04.3` |
| Host class | **REMOTE** (len=13; value redacted) |
| Port | 3306 |
| `CAIRN_ALLOW_REMOTE_DB` | `1` |
| Access mode | `START TRANSACTION READ ONLY` via prod app `mysql2` + host `.env` (values never printed) |
| User / password | lengths 13 / 8 only |

### 3.2 Ledger summary

| Field | Value |
|---|---|
| Table | `schema_migrations` |
| Row count | **11** |
| Ordered versions | `000,001,002,003,004,005,006,007,008,009,010` |
| Continuous | **yes** |
| Duplicates | **none** |
| Tip version | **010** |
| Tip filename | `010_product_features.sql` |
| Tip sha256 | `1b7ff33cd40ee821f22f8952f91c6ad9d890560caad6a1c25c2f4d0efa3728d7` |
| Tip classification | REVERSIBLE |
| Tip applied_by / applied_at | `migrate-cli` / `2026-07-17T08:16:52.514Z` |
| Rows for 011/012/013/014 | **0** |

### 3.3 Ordered history + hash parity vs workspace `migrations/`

| ver | filename | stored sha256 | vs workspace HEAD |
|---|---|---|---|
| 000 | 000_baseline_core.sql | `f009035b13b2dbb9931e8e59b5e43c31f730dc564a1f41e9ee7dc514a409ac12` | **MATCH** |
| 001 | 001_control_plane_expand.sql | `9a2853392d458afd2ea8359c15916f3b8f173e8aee9c044328ffef1e90b68d7b` | **MATCH** |
| 002 | 002_control_plane_indexes.sql | `27222d4688259d7ed6ae4de605b8dad64499c4160eabcc2411c549df3229da72` | **MATCH** |
| 003 | 003_control_plane_backfill.sql | `cca909e4c5009d9dfde515a2792c96af82593f0f70e3e2bef565feac35d15e13` | **MATCH** |
| 004 | 004_control_data_persistence.sql | `82205fde2300ecf9e8fa8c3591fabc6e2c963abc21b16a39386f595819dbbb48` | **MATCH** |
| 005 | 005_control_plane_runtime_persistence.sql | `aefc61dd34a054b6f84278cf80d2db283efd5832b5804af21ad150d28651b27c` | **MATCH** |
| 006 | 006_stage_evidence_receipts.sql | `8cf35c2652ee25ec3e8ec7fd52cf5c4991ce81ee4ec87c52e33f100a8b56d97d` | **MATCH** |
| 007 | 007_globals_table.sql | `d49f4c5767ae81f0abfc9f60982aebbcfb8fa5733c013ce8709cba7d2684f4c7` | **MATCH** |
| 008 | 008_cp0_control_plane.sql | `385ca63ed551622439a7e722a2017bc7452356c1f25035e15f6161f33fc73940` | **MATCH** |
| 009 | 009_rebuild_lineage.sql | `5af6145a49b6317cddf150f1188c0147db1ccac3187d039e9e07d1f04d39e639` | **MATCH** |
| 010 | 010_product_features.sql | `1b7ff33cd40ee821f22f8952f91c6ad9d890560caad6a1c25c2f4d0efa3728d7` | **MATCH** |

**ALL_MATCH = 11/11** applied history. No hash drift. No gaps/duplicates.

### 3.4 Required-object health (selected counts)

| Object | State | Count |
|---|---|---|
| `schema_migrations` | PRESENT | **11** |
| `product_features` | PRESENT | **45** |
| `feature_task_map` | PRESENT | **4237** |
| `app_flow_nodes` / `app_flow_edges` | **ABSENT** | null (011 not applied) |
| `app_pages` / `api_endpoints` / `page_api_calls` / `nav_edges` / `knowledge_aliases` | **ABSENT** | null (012 not applied) |
| `control_plane_classification` | PRESENT | **2499** |
| `control_plane_classification_receipts` | PRESENT | **5641** |
| `control_plane_sync_status` | PRESENT | **1** (sink; not zero-backlog proof) |
| `control_plane_sync_outbox` | **ABSENT** | null (014 not applied) |
| `control_plane_legacy_residuals` | **ABSENT** | null (014 not applied) |

**App-flow / page-nav production counts:** all future tables **ABSENT** → counts are null, not zero. Do not invent 652/622 production data from staging.

### 3.5 Migration 013 pre-apply (case-sensitive classification)

| Check | Result |
|---|---|
| `control_plane_classification.task_id` | `varchar(160)` utf8mb4 **`utf8mb4_unicode_ci`** NOT NULL |
| `control_plane_classification_receipts.task_id` | same **`utf8mb4_unicode_ci`** |
| Table collations | both tables `utf8mb4_unicode_ci` |
| PK classification | `(board_id, task_id)` present |
| Secondary classification | `idx_class_task_class`, `idx_class_receipt` retained |
| PK receipts | `(board_id, receipt_id)` |
| Secondary receipts | `idx_class_receipt_task`, `idx_class_receipt_hash` |
| board `mfs-rebuild` | n=**2499**, dist_bin=**2499**, dist_ci=**2499**, delta=**0** |
| 013 MODIFY ER_DUP_ENTRY precondition | **Satisfied under current CI PK** |
| 013 applied? | **NO** |

**Post-013 operator readback required (not done):** both columns → `utf8mb4_bin`; ledger row 013 with sha `96f6bc392d298f9ce72e86c6943f67c75776d7aad45cd2851d05abaeb414789d`; classification **FORWARD_FIX_ONLY**.

---

## 4. Pending migration source availability + locked hashes

### 4.1 Exact next migration only

| Field | Value |
|---|---|
| Current tip | **010** |
| Exact next pending | **011** only |
| Forbidden | batch-skip; `--through 014` from tip 010; multi-version single apply |

Package enforcement: `deploy/production/scripts/migrate-apply.sh` requires exact `MIGRATION_APPROVED_VERSION` + matching `MIGRATION_APPROVED_SHA256`, refuses wrong next version, applies one step, readbacks that version only.

### 4.2 Locked file hashes (workspace source authority)

| ver | file | expected sha256 | workspace | prod checkout |
|---|---|---|---|---|
| 011 | `011_feature_flow_edges.sql` | `8ce2567ebb65ed3971dbabef995e5e5cfbb8724eb381a91557ce90420a620568` | **MATCH** | **MATCH** (present) |
| 012 | `012_ultimate_map.sql` | `ad6acb1631fc23287b4540ecc9326e9dc82702257fd5576d72d7e88dbcbc33db` | **MATCH** | **MATCH** (present) |
| 013 | `013_classification_task_id_case_sensitive.sql` | `96f6bc392d298f9ce72e86c6943f67c75776d7aad45cd2851d05abaeb414789d` | **MATCH** | **MISSING** |
| 014 | `014_cp0_sync_backlog_sources.sql` | `56d97d15e1d3047d7da6f78707ba16c11182f5c03791f5227c3d84f3c381ceb0` | **MATCH** | **MISSING** |

Workspace offline plan: manifest items **000–014** (15 files), tip **014** (plan-only; not production apply).

### 4.3 Step classifications (for future authorized operators)

| Step | Classification | DDL surface | Backup-before | Rollback class if no dump |
|---|---|---|---|---|
| 011 | REVERSIBLE additive | `app_flow_nodes`, `app_flow_edges` | tip-**010** dump ≤24h | DB_FORWARD_FIX_ONLY |
| 012 | REVERSIBLE additive | ultimate map tables (+ re-declare 011) | post-**011** dump | DB_FORWARD_FIX_ONLY |
| 013 | **FORWARD_FIX_ONLY** | `task_id` → `utf8mb4_bin` | post-**012** dump | DB_FORWARD_FIX_ONLY (never reverse after case-distinct rows) |
| 014 | REVERSIBLE additive | `control_plane_sync_outbox`, `control_plane_legacy_residuals` | post-**013** dump | DB_FORWARD_FIX_ONLY |

Empty 014 tables after create **≠** `zeroBacklogProven`.

---

## 5. Repository / pin topology (no Git mutation)

| Pin | Full SHA | Manifest tip | Notes |
|---|---|---|---|
| **Production live** | `8cde4f86868aebcb5784ba13405a6b1e1e2b81a3` | **010** (runtime expected) | Deployed + DB tip |
| **Workspace / origin/main HEAD** | `b149509ec454fe3dc9afc9a6a31cf9ec82533243` | **014** | docs staging pin 014; **not** production publish authority |
| Prod is ancestor of HEAD | **yes** | — | `git merge-base --is-ancestor` |
| Commits prod → HEAD | **28** | — | includes 011–014 + app-flow/CP0/canon gates |
| Migration 014 integrate commit | `0eda456decf1754dddc342d643d74e8216e25f00` | 014 blob on main | descendant of prod |
| Final production publish SHA | **NOT DESIGNATED** | must equal **staging-accepted** full SHA | see blockers |

**Do not claim readiness from future SHA.** Workspace dirty count is high (artifacts/tests); dirty tree is not a release pin.

---

## 6. Backup inventory (metadata only; nothing created)

### 6.1 Production host + automation copies

| Asset | Age at probe (~04:45Z) | Size | sha256 (file) | Restorable for tip-010 cutover? |
|---|---|---|---|---|
| `~/backups/pre-migration-008-…/cairn-pre-migration-008.sql.gz` | ~**89.4 h** | 9,449,247 | `6d7b0e8f164e9f58250c27ad85d0ce5480467487731c372c594da89988a00c9f` | **NO** — pre-008 archaeology (receipt: pre_schema_version=007, ledger_rows=8) |
| companion `receipt.txt` | ~89.4 h | 237 | `fd74bb4e…` | metadata only |
| `~/cairn-db-backup-20260714-111325.sql.gz` | ~**113.5 h** | 7,215,001 | `d50a12031c170d38c0d2ffcb11645edc0bc15fcd10e4bf1809a30ad807768d0e` | **NO** — Jul-14; pre tip-010 final state |
| `~/cairn-db-backup-20260714-090401.sql.gz` | ~**115.7 h** | 7,056,093 | `1c0e7c231b08f8a1bed7eb6fba9199d8f70a916ee639048ab721d6bb286c4598` | **NO** |
| blocker1-* status/tiny dumps / dist.tgz | ~109–112 h | mixed | various | **NO** for schema tip-010 |
| Automation copy pre-008 | same era | 9,449,247 | `6d7b0e8f…` (matches prod) | **NO** |

**Mode:** all inventoried DB dumps are **logical gzip SQL** (mysqldump-class). No proven provider snapshot receipt for current tip-010.

**`gzip -t`:** pre-008 OK (prod + automation); both Jul-14 dumps OK. Integrity of **stale** dumps only.

### 6.2 Fresh tip-010 backup?

| Required | Status |
|---|---|
| Fresh mysqldump (or provider snapshot + receipt) of **live prod DB at schema 010** | **MISSING** |
| `BACKUP_RECEIPT` non-empty, age **≤24h** (`BACKUP_MAX_AGE_HOURS` default 24) | **MISSING** |
| `dumpRestorable=true` for `APP_PLUS_DB_RESTORE` | **NOT established** |
| Cloud SQL automated backup authority | **UNCERTAINTY** (not proven from auditor) |

### 6.3 Concrete blocker for **first mutation**

> **BLOCKER-BACKUP-TIP010:** No production backup exists that is both (a) captured from the **current tip-010** live database and (b) within the fail-closed **≤24h** freshness gate. All inventoried dumps are **pre-008 or Jul-14** and would rewind past migrations 008–010 if restored.  
> **First mutation action required (by authorized operator, not this role):** create fresh logical dump of `cairn_taskmanager` at schema **010**, write receipt (sha256, size, created_at, tip version, `gzip -t`), set `BACKUP_RECEIPT`, then proceed one-step **011** only under full approval bundle.

Capacity note (not a receipt): prod `/` ~**7.8 GiB** free / **60%** used — adequate for ~9–90MB-class dumps at operation time.

---

## 7. Rollback assets / current release artifact availability

### 7.1 App rollback assets (present)

| Asset | Status |
|---|---|
| `.deploy-prior-sha-*` (Jul-17 series) | Present; latest file content `0ff82dc4477935509fcde66f8607b27c1de13e24` |
| `dist.rollback-20260717T*` | Present (multiple; latest `…211133Z`) |
| Current `dist/server/server.js` | Present (live process) |
| PM2 dump / systemd unit | Process resurrect path exists (runbook) |
| `rollback.sh` / `rollback-prior-sha.sh` | Package present; fail-closed without approval for mutate modes |

### 7.2 Classify matrix (`rollback.sh --classify` dry)

| Condition | Class |
|---|---|
| **Current live (no schema move)** | **`APP_ONLY_PRIOR_SHA`** |
| Schema moved, no proven dump | `DB_FORWARD_FIX_ONLY` |
| Schema moved + dump + dumpRestorable | `APP_PLUS_DB_RESTORE` (manual restore; package does not auto-restore) |

### 7.3 Rollback prerequisites before any schema step

| Prerequisite | Status |
|---|---|
| Fresh tip-010 dump ≤24h + receipt + `gzip -t` + sha256 | **MISSING** → any 011+ step starts **DB_FORWARD_FIX_ONLY** until fixed |
| App prior-SHA / dist.rollback path | **Present** for app-only revert of current release |
| Future accepted SHA on prod object store | **Absent** until `git fetch` of accepted full SHA |
| Prod tree 013/014 SQL files | **Missing** until accepted checkout |
| 013 reverse policy | Never reverse to `unicode_ci` after case-distinct rows |

---

## 8. Staging context (RO; not production PASS)

| Item | Staging (live probe ~04:47Z) | Production (live probe) |
|---|---|---|
| DB tip | **014** (15 ledger rows; continuous 000–014) | **010** (11 rows) |
| 011–014 ledger hashes | match locked expectations (incl. 014 `56d97d15…ceb0`) | n/a (absent) |
| `task_id` collation | **`utf8mb4_bin`** | **`utf8mb4_unicode_ci`** |
| app_flow_nodes / edges | **652 / 622** | **ABSENT** |
| app_pages / api_endpoints | **722 / 5891** | **ABSENT** |
| page_api_calls / nav_edges / knowledge_aliases | **2622 / 3547 / 327** | **ABSENT** |
| product_features | 45 | 45 |
| control_plane_sync_outbox / legacy_residuals | present, count **0** | **ABSENT** |
| App pin / env | SHA `7b9d28f…`; `CAIRN_SCHEMA_VERSION=008`; `CAIRN_MIGRATION_LATEST=008` | `8cde4f8…` schema **010** self-match **OK** |
| Staging auth healthz | **401** invalid bearer (app/token pin drift; unauth 401 only) | edge/loopback/origin auth **200** |
| Staging release acceptance | a238 **BLOCKED/PENDING** (still open for formal cutover) | — |
| MySQL | `8.4.10` (container) | `8.0.46` (remote) |

Staging proves the **migration chain and data load pattern** are achievable in non-prod. Staging does **not** authorize production apply/deploy.

---

## 9. Gate / blocker matrix → why **BLOCKED** / READY_FOR_011 **no**

| ID | Blocker | Severity | Evidence |
|---|---|---|---|
| **B1** | **Fresh ≤24h tip-010 production backup missing** | **HARD — first mutation / READY_FOR_011** | Only pre-008 (~89h) + Jul-14 (~113h+) dumps; all fail age+tip gates |
| **B2** | **Staging release acceptance incomplete** | **HARD — prod publish** | a238 `BLOCKED/PENDING`; app pin 008 vs DB 014; auth health not 200 schema-014 |
| **B3** | **No owner-accepted production `APPROVED_FULL_SHA`** for schema-014-compatible app | **HARD — deploy** | HEAD `b149509…` is tip, not closed release acceptance; must bind to **staging-accepted** exact SHA |
| **B4** | Schema pending chain **011–014** not applied in production | **HARD — tip app pin** | Ledger tip 010; 011/012/014 objects absent; 013 still CI |
| **B5** | This packet is **read-only** — no mutation approval | **PROCESS** | Role boundary; dry-run default-on; need separate operator packets |
| **B6** | Cannot batch migrations — exact next is **011 only** | **PROCESS** | `migrate-apply.sh` one-step enforcement |
| **B7** | **013 FORWARD_FIX_ONLY** + live 2499-row CI overlay | **OPS** | Requires dedicated backup + bin readback; no unsafe reverse |
| **B8** | zeroBacklogProven=false + stale freshness + sink/healthz rev drift | **HARD for `--require-sync-zero` close** | healthz + sync_status RO |
| **B9** | Future SHA object **not on prod host** | **OPS deploy** | `git cat-file ed4585b…` failed; fetch required for any newer publish |
| **B10** | Prod tree lacks 013/014 SQL files until accepted checkout | **OPS** | ls migrations on host |
| **B11** | Cloud SQL backup authority unproven | **UNCERTAINTY** | Auditor project cannot assert provider snapshots |

**Not blockers for this readback:** edge/origin/loopback auth 200; ledger readable continuous; hash parity 000–010; nginx upstream; systemd enabled; PM2 online; locked 011–014 workspace hashes; 013 dist precheck PASS.

### READY_FOR_011

```
READY_FOR_011: no
```

**Reason (single gate):** no fresh ≤24h restorable backup of live tip-**010** production DB. All other 011 preconditions (ledger tip 010, continuous history, file hash available on workspace and prod tree) are met but fail-closed backup authority blocks first mutation.

---

## 10. Exact **future** safe sequence (only after staging release acceptance + owner approval)

**Do not execute from this receipt.** Preconditions before step 0:

1. Staging formal release acceptance for the **exact** app SHA + schema **014** + app-flow data gates (clear a238-class blockers).
2. Owner designates `APPROVED_FULL_SHA=<accepted full 40-hex>` identical to staging-accepted publish pin.
3. Independent production operator packets with mutation opt-in (not this preflight).

### Ordered production sequence

| Phase | Action | Proof required |
|---|---|---|
| **0** | Fresh backup at schema **010** | dump + receipt ≤24h; `gzip -t`; sha256; tip@dump=010; `BACKUP_RECEIPT` |
| **1** | Apply **011** one-step + independent readback | ledger tip 011 exact sha `8ce2567e…0568`; tables `app_flow_nodes/edges` exist |
| **2** | Fresh backup post-011 | receipt age gate |
| **3** | Apply **012** one-step + independent readback | tip 012 exact sha `ad6acb16…33db`; ultimate tables exist |
| **4** | Fresh backup post-012 | receipt |
| **5** | Apply **013** + **binary-collation proof** | tip 013 exact sha `96f6bc39…789d`; both `task_id` = `utf8mb4_bin`; dist precheck retained |
| **6** | Fresh backup post-013 | receipt |
| **7** | Apply **014** + independent readback | tip 014 exact sha `56d97d15…ceb0`; outbox+residuals exist; counts 0 ≠ zero backlog |
| **8** | App-flow / page-nav / CP0 **data load** (explicit; not schema-only) | regenerate/verify production candidates; staging reference 652/622 etc. is **not** auto-copied; load via sanctioned loaders only |
| **9** | Deploy **exact staging-accepted SHA** | `APPROVED_FULL_SHA` + `PRODUCTION_APPROVAL_ID` + `BACKUP_RECEIPT` + `PRODUCTION_DRY_RUN=0` + `PRODUCTION_MUTATION_APPROVED=1`; build-install + pm2-atomic |
| **10** | Loopback + origin + edge **authenticated** health | HTTP 200; `deployedSha === APPROVED_FULL_SHA`; schema.version **014** match; unhealthy=[] |
| **11** | Browser / MCP / security / performance / rollback proof | residual gates per runbook; classify rollback with restorable dump; prior-SHA app path proven |

**Production app publication must bind to exact accepted SHA and current backup/rollback proof.** Self-match at old SHA `8cde4f8` is not a new release PASS.

### Apply gate bundle (informational; not set here)

- `APPROVED_FULL_SHA`, `PRODUCTION_APPROVAL_ID`, `BACKUP_RECEIPT` (≤24h)
- `MIGRATE_APPLY_APPROVED=1`
- `PRODUCTION_DRY_RUN=0` + `PRODUCTION_MUTATION_APPROVED=1`
- `MIGRATION_APPROVED_VERSION` = exact next NNN only
- `MIGRATION_APPROVED_SHA256` = lowercase 64-hex of that SQL
- `MIGRATION_TARGET_HOST` / `MIGRATION_TARGET_DATABASE` bind to prod `CAIRN_DB_*`
- `MIGRATION_APPROVAL_BINDING` over release SHA, approval id, version, migration sha, host, db, backup sha

---

## 11. Diff vs prior production preflight a241

| Item | a241 (~03:34Z) | this a265 (~04:45Z) |
|---|---|---|
| Prod SHA | `8cde4f8…` | **unchanged** |
| Schema tip | 010 | **unchanged** |
| Ledger hashes | ALL_MATCH | **reconfirmed ALL_MATCH** |
| Health surfaces | loop/origin/edge 200 | **reconfirmed** |
| Fresh tip-010 backup | MISSING | **still MISSING** (ages +~1.1h) |
| CP0 freshness age | ~2.5d+ | **~62.5 h** (same stamp; still stale) |
| Workspace HEAD | `ed4585b…` | **`b149509…`** (+docs staging pin 014 + later canon commits; still not prod publish pin) |
| Commits prod→HEAD | 23 | **28** |
| Staging tip | 014 + 652/622 | **reconfirmed** live RO (652/622/722/5891/…) |
| Staging app pin | 008 / 7b9d28f | **reconfirmed** env 008 + SHA `7b9d28f…` |
| Staging release | a238 BLOCKED/PENDING | **still open** (no formal PASS found) |
| READY_FOR_011 | (implicit blocked) | **explicit `no`** |
| Verdict | PRODUCTION_PREFLIGHT_BLOCKED | **PRODUCTION_PREFLIGHT_BLOCKED** (refreshed) |

---

## 12. Final status line

```
TASK_ID: TM-PREFLIGHT-PRODUCTION-REFRESH-R2
VERDICT: PRODUCTION_PREFLIGHT_BLOCKED
READY_FOR_011: no
PRIMARY_BLOCKERS:
  1) No fresh ≤24h production backup at schema tip 010 (first mutation blocked → READY_FOR_011=no)
  2) Staging release acceptance not complete (app pin/schema/data/release SHA gates open)
  3) No owner-accepted production APPROVED_FULL_SHA bound for schema-014 publish
  4) Production schema still tip 010 with pending 011→012→013→014 (one-step only)
  5) CP0 zeroBacklogProven=false + stale freshness (~62.5h) — fail closed
  6) This packet is read-only evidence — not mutation/deploy approval
PROD_SHA: 8cde4f86868aebcb5784ba13405a6b1e1e2b81a3
PROD_SCHEMA_TIP: 010
NEXT_PENDING: 011
PENDING_CHAIN: 011→012→013→014
PENDING_HASHES:
  011=8ce2567ebb65ed3971dbabef995e5e5cfbb8724eb381a91557ce90420a620568
  012=ad6acb1631fc23287b4540ecc9326e9dc82702257fd5576d72d7e88dbcbc33db
  013=96f6bc392d298f9ce72e86c6943f67c75776d7aad45cd2851d05abaeb414789d
  014=56d97d15e1d3047d7da6f78707ba16c11182f5c03791f5227c3d84f3c381ceb0
WORKSPACE_HEAD: b149509ec454fe3dc9afc9a6a31cf9ec82533243
SAFE_SEQUENCE: fresh_backup → one_migration → independent_readback → fresh_backup (through 014) → data_load → exact_staging_accepted_SHA_deploy → live_verification
MUTATION: NONE
```

WORKER_RESULT_END
