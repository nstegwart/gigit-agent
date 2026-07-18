# Production runbook — cairn-taskmanager (PM2 + nginx)

Operator runbook for **production only**:
`https://task-manager.mfsdev.net` on host `gian.devx@34.128.96.254`.

Companion package: `deploy/production/` (PM2 release scripts + fail-closed gates).

Staging compose under `deploy/staging/` (Docker loopback bind) is **not** valid for this host.

| Contract field | Value |
|---|---|
| App path | `/home/gian.devx/cairn-taskmanager` |
| Listen | `127.0.0.1:3210` (nginx `proxy_pass`) |
| PM2 name | `cairn-taskmanager` |
| Process | `npm run preview -- --port 3210 --host 127.0.0.1` |
| Systemd | `pm2-gian.devx.service` (resurrect on boot) |
| Public | `https://task-manager.mfsdev.net` |
| Approval | `APPROVED_FULL_SHA` (lowercase 40-hex) + `PRODUCTION_APPROVAL_ID` + `BACKUP_RECEIPT` **required** |
| Dry-run | **DEFAULT-ON** (`PRODUCTION_DRY_RUN` defaults to `1`) |
| Mutation opt-in | Real host mutation needs `PRODUCTION_DRY_RUN=0` + `PRODUCTION_MUTATION_APPROVED=1` **in addition to** approval triple |
| Liveness | Unauth loopback `GET /api/healthz` → **401\|200\|503** (not connection refused) |
| Release PASS | Auth healthz **200** + `deployedSha` === approved full SHA |

Never paste DB passwords, bearer secrets, cookies, or dump bodies into tickets/logs.

---

## 1. Owner target

```text
OWNER_TARGET: {base_url: https://task-manager.mfsdev.net, port: 3210, account: production (approval-gated), device: n/a}
```

Print the same line before any probe or release step.

---

## 2. Root cause class (502 forensic, 2026-07-14)

Proven class for prolonged public **502**:

1. Edge Cloudflare and origin nginx both return 502 when upstream is down.
2. nginx site proxies to `http://127.0.0.1:3210`.
3. Nothing listens on `:3210` when PM2 app list is empty / `pm2-gian.devx.service` is inactive.
4. Historical PM2 dump still defines `cairn-taskmanager` even when process table is empty — prefer `systemctl start pm2-gian.devx.service` or `pm2 resurrect` for recovery **after** owner approval.

This runbook recovers/releases the app process; it does not change Cloudflare.

---

## 3. Approval bundle + dry-run / mutation policy (fail closed)

Every mutating script under `deploy/production/scripts/` refuses to run unless:

| Env | Rule |
|---|---|
| `APPROVED_FULL_SHA` | **Canonical lowercase** full 40-char hex git SHA (`^[0-9a-f]{40}$`). Uppercase/mixed rejected by both `gates.mjs` and bash. |
| `PRODUCTION_APPROVAL_ID` | Owner ticket / approval identifier (≥4 chars) |
| `BACKUP_RECEIPT` | Path to non-empty dump or receipt file proving backup authority |

### Dry-run default-on + mutation opt-in

| Env | Rule |
|---|---|
| `PRODUCTION_DRY_RUN` | **Defaults to `1`** when unset. Dry-run prints intended commands after gates pass; no git/pm2/DB mutate. |
| `PRODUCTION_MUTATION_APPROVED=1` | **Required** together with `PRODUCTION_DRY_RUN=0` for real mutation. Approval triple alone is not enough. |

Laptop dry-run of `pm2-atomic.sh` / `release.sh` does **not** require the `pm2` binary (command gate runs only on the real mutation branch).

Optional for schema apply (code path ready through manifest **012**; runtime apply stays closed until independent verification + exact owner approval):

| Env | Rule |
|---|---|
| `MIGRATE_APPLY_APPROVED=1` | Explicit owner opt-in for DDL apply |
| `DB_DUMP_PATH` | Fresh dump (defaults to `BACKUP_RECEIPT`) |
| `BACKUP_MAX_AGE_HOURS` | Default 24h freshness gate |
| `MIGRATION_APPROVED_VERSION` | Exact next pending manifest NNN only (one-step; never skip; never all remaining). Product tip **012**; CP0 baseline **008**. |
| `MIGRATION_APPROVED_SHA256` | Lowercase SHA-256 of that version's SQL file |
| `MIGRATION_TARGET_HOST` / `MIGRATION_TARGET_DATABASE` | Must equal `CAIRN_DB_HOST` / `CAIRN_DB_NAME` |
| `MIGRATION_APPROVAL_BINDING` | Binding over release SHA, approval id, version, migration sha, host, db, backup sha |

### Migration entrypoint (fail closed)

`migrate-plan.sh` / `migrate-apply.sh` **validate** the entrypoint exists before dry-run print or real run:

1. `package.json` script `migrate:plan` / `migrate:apply` (pnpm preferred, else npm), or
2. `src/server/migrate-runner.mjs` on disk

If neither is present → exit non-zero (`MIGRATE_ENTRYPOINT_MISSING`). Scripts never print an unproven fallback command as if it were valid.

Missing approval / missing mutation opt-in / missing entrypoint → exit non-zero. Do **not** bypass.

---

## 4. Read-only preflight

```bash
cd /home/gian.devx/cairn-taskmanager
export APPROVED_FULL_SHA=<full-sha>
export PRODUCTION_APPROVAL_ID=<approval-id>
export BACKUP_RECEIPT=/secure/path/to/receipt-or-dump

./deploy/production/scripts/preflight.sh
```

Checks (when host files readable):

- Approval bundle + backup receipt non-empty (optional max age)
- Git HEAD / branch / upstream vs approved SHA (checkout note if mismatch)
- `.env` **key names only** (never values): `CAIRN_DB_*`, `CAIRN_WRITE_TOKEN`, `CAIRN_ALLOW_REMOTE_DB`
- nginx site upstream equals `http://127.0.0.1:3210`
- DB TCP open (no SELECT); remote host requires `CAIRN_ALLOW_REMOTE_DB=1`
- Listener / PM2 snapshot (informational)

---

## 5. Release pipeline

```bash
# Owner-approved full release (mutates git checkout, dist, PM2, optional migrate/systemd)
export APPROVED_FULL_SHA=$(git rev-parse HEAD)   # must be lowercase 40-hex
export PRODUCTION_APPROVAL_ID=...
export BACKUP_RECEIPT=...
# Explicit mutation opt-in (dry-run is default-on without these):
export PRODUCTION_DRY_RUN=0
export PRODUCTION_MUTATION_APPROVED=1
# If schema must move on this release:
# export MIGRATE_APPLY_APPROVED=1

./deploy/production/scripts/release.sh --enable-systemd
```

Equivalent staged steps:

```bash
./deploy/production/scripts/preflight.sh
./deploy/production/scripts/build-install.sh      # fetch + checkout SHA + pnpm install + build + asset assert
./deploy/production/scripts/migrate-plan.sh       # always plan first (validates entrypoint)
# ./deploy/production/scripts/migrate-apply.sh    # only with MIGRATE_APPLY_APPROVED=1 + fresh dump
./deploy/production/scripts/pm2-atomic.sh --enable-systemd
./deploy/production/scripts/health-readback.sh
```

### Dry-run (default; gates only — no pm2 required on laptop)

```bash
# PRODUCTION_DRY_RUN defaults to 1 when unset
echo "selftest" >/tmp/dummy-receipt
APPROVED_FULL_SHA=$(git rev-parse HEAD) \
  PRODUCTION_APPROVAL_ID=dry-run \
  BACKUP_RECEIPT=/tmp/dummy-receipt \
  PREFLIGHT_REQUIRE_HEAD_MATCH=0 \
  ./deploy/production/scripts/pm2-atomic.sh
# → PM2_ATOMIC_OK ... dry_run=1  (no pm2 binary needed)

# Full release dry-run on laptop package checkout:
APPROVED_FULL_SHA=$(git rev-parse HEAD) \
  PRODUCTION_APPROVAL_ID=dry-run \
  BACKUP_RECEIPT=/tmp/dummy-receipt \
  PREFLIGHT_REQUIRE_HEAD_MATCH=0 \
  PREFLIGHT_REQUIRE_DB_TCP=0 \
  ./deploy/production/scripts/release.sh
```

---

## 6. Immediate 502 recovery (approval-gated)

When preflight shows `LISTEN_3210=NO` and PM2 empty but dump exists:

```bash
export APPROVED_FULL_SHA=<currently-approved-or-HEAD-sha>
export PRODUCTION_APPROVAL_ID=<incident-id>
export BACKUP_RECEIPT=<existing-or-fresh-receipt>

# Prefer systemd resurrect of saved dump:
sudo systemctl start pm2-gian.devx.service
# or: pm2 resurrect

ss -lntp | grep 3210
./deploy/production/scripts/health-readback.sh
```

If resurrect fails (empty dump / stale vite error):

```bash
./deploy/production/scripts/build-install.sh
./deploy/production/scripts/pm2-atomic.sh --enable-systemd
./deploy/production/scripts/health-readback.sh
```

Nginx reload only if site file changed: `sudo nginx -t && sudo systemctl reload nginx`.

---

## 7. Health / readback

```bash
# Liveness (expect 401 unauth or 200 with bearer — not 000/connection refused)
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/api/healthz

# Origin via local nginx Host header
curl -sk -o /dev/null -w '%{http_code}\n' \
  -H 'Host: task-manager.mfsdev.net' https://127.0.0.1/api/healthz

# Public edge
curl -sk -o /dev/null -w '%{http_code}\n' https://task-manager.mfsdev.net/api/healthz

# Script form (classifies liveness vs release PASS)
APPROVED_FULL_SHA=... CAIRN_HEALTH_BEARER=... \
  ./deploy/production/scripts/health-readback.sh
```

| Result | Meaning |
|---|---|
| Loopback connection refused | App down — not Cloudflare-only |
| 401 on loopback | Listen OK (liveness) |
| 200 + matching `deployedSha` | Release PASS |
| Edge 502 + origin 502 + loopback refused | Same class as 2026-07-14 forensic |

---

## 8. Rollback

```bash
# Classify first (no mutation)
SCHEMA_MOVED=0 ./deploy/production/scripts/rollback.sh --classify
SCHEMA_MOVED=1 HAS_DB_DUMP=0 ./deploy/production/scripts/rollback.sh --classify
# → DB_FORWARD_FIX_ONLY when schema moved without dump

# App prior SHA (requires approval bundle)
export APPROVED_FULL_SHA=<current-or-incident-approval>
export PRODUCTION_APPROVAL_ID=...
export BACKUP_RECEIPT=...
./deploy/production/scripts/rollback.sh --to-sha <PRIOR_FULL_40_SHA>

# Traffic kill (returns 502 by design)
./deploy/production/scripts/rollback.sh --stop
```

| Class | App | DB |
|---|---|---|
| `APP_ONLY_PRIOR_SHA` | checkout prior + build + PM2 | none |
| `DB_FORWARD_FIX_ONLY` | prior SHA allowed | **no auto schema rollback** — forward-fix only |
| `APP_PLUS_DB_RESTORE` | prior SHA | **manual** dump restore (not automated) |

Config-only: restore `.env` from known-good backup (host may have `.env.bak.*` — inspect offline; do not log secrets).

Staging `deploy/staging/scripts/rollback.sh` GREENFIELD/PRIOR_SHA applies to **Docker staging only**.

---

## 9. DB / backup honesty

As of the 2026-07-14 production forensic:

- DB TCP to remote MySQL was open; live schema revision was **not** read without credentials.
- **No app MySQL dump** was found under home/opt/srv on the app host (`/var/backups` was OS apt only).
- Therefore: **do not assume** a restorable dump exists. Create and verify `BACKUP_RECEIPT` **before** any schema-moving release.
- `migrate-apply.sh` refuses without `MIGRATE_APPLY_APPROVED=1` and a fresh non-empty dump/receipt.

---

## 10. Self-tests (package integrity)

```bash
./deploy/production/selftest/selftest.sh
node deploy/production/selftest/selftest.mjs
pnpm exec vitest run tests/unit/production-deploy-package.test.ts
pnpm exec vitest run tests/unit/build-asset-coherence.test.ts
```

These validate fail-closed gates and script presence. They are **not** production deploy proof.

---

## 10b. Build asset coherence (SSR ↔ client)

**Root class:** SSR output may reference absolute `/assets/<file>` URLs that the
browser loads from the client static tree. If `dist/server` embeds
`/assets/styles-A.css` while only `styles-B.css` exists under `dist/client/assets`,
login/HTML CSS 404s (see investigate-final-login-assets-r2).

| Gate | Where |
|---|---|
| `pnpm build` | `vite build && node scripts/assert-build-assets.mjs --write-manifest` |
| `build-install.sh` | runs package build, then re-asserts + records `clientManifestHash` before PM2 |
| Manifest | `dist/asset-coherence-manifest.json` (names+sizes hash; not a hash-disable bypass) |

```bash
# On approved production checkout after build-install:
node scripts/assert-build-assets.mjs --write-manifest
# Expect: ASSET_COHERENCE OK
# Fail closed: MISSING_PUBLIC_ASSET /assets/styles-….css → rebuild clean; never copy stale hashes
```

Forbidden “fixes”: copying an old `styles-*.css` into `dist/client/assets`,
disabling Vite content hashes, or promoting a release when assert failed.

---

## 11. Residual / forbidden

- Do not deploy production from this runbook without owner approval IDs.
- Do not use staging Docker release root (`/opt/mfs/staging/...`) on this host.
- Do not commit host `.env` or print secret values.
- Do not claim `DONE` production recovery without loopback listen + health classification in-session.
- Cloudflare SSL mode / external Cloud SQL backups may exist outside this host — treat as UNCERTAINTY until proven.
