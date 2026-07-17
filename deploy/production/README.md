# Production PM2 release package — cairn-taskmanager

Bare-metal **PM2 + nginx** production release tooling for
`task-manager.mfsdev.net` on `gian.devx@34.128.96.254`.

| Contract field | Value |
|---|---|
| Host path | `/home/gian.devx/cairn-taskmanager` |
| Upstream | nginx → `http://127.0.0.1:3210` |
| Process | PM2 `cairn-taskmanager` = `npm run preview -- --port 3210 --host 127.0.0.1` |
| Systemd | `pm2-gian.devx.service` (enable so resurrect survives reboot) |
| Public | `https://task-manager.mfsdev.net` |
| Approval | **Fail closed** without lowercase `APPROVED_FULL_SHA` + `PRODUCTION_APPROVAL_ID` + `BACKUP_RECEIPT` |
| Dry-run | **Default-on** (`PRODUCTION_DRY_RUN` defaults to `1`) |
| Mutation | Needs `PRODUCTION_DRY_RUN=0` + `PRODUCTION_MUTATION_APPROVED=1` **plus** approval triple |
| Staging | **Out of scope** — do not use `deploy/staging/` Docker paths for this host |

Evidence source for this package: `WORKER_RESULT_investigate-final-production-502-r3.md`.

The release entrypoint may be invoked by the authorized orchestrator after root
acceptance. Real mutation still refuses a missing approval bundle, mutation
opt-in, exact-SHA health/readback, or rollback target. No CI job invokes it.

---

## Layout

```text
deploy/production/
  README.md                 # this file
  env.production.example    # approval + key names template (no secrets)
  lib/gates.mjs             # pure fail-closed gates (node)
  scripts/
    common.sh               # shared helpers
    preflight.sh            # read-only gates
    build-install.sh        # checkout + install + build
    migrate-plan.sh         # plan only
    migrate-apply.sh        # apply only with MIGRATE_APPLY_APPROVED=1 + dump
    pm2-atomic.sh           # delete+start+save [+systemd]
    health-readback.sh      # loopback / origin / edge
    rollback.sh             # prior SHA + DB forward-fix class
    rollback-prior-sha.sh   # automatic app-only prior-SHA rollback wrapper
    release.sh              # orchestrates 1→6
  selftest/
    selftest.sh             # shell self-test (no production mutation)
    selftest.mjs            # node gate self-test
```

Operator runbook: `docs/runbook-production.md`.

---

## Required approval env

```bash
export APPROVED_FULL_SHA=<40-char-lowercase-full-git-sha>
export PRODUCTION_APPROVAL_ID=<owner-ticket-or-approval-id>
export BACKUP_RECEIPT=/absolute/path/to/non-empty-dump-or-receipt
```

Missing any → scripts exit non-zero (`MISSING_APPROVAL_BUNDLE`).
Uppercase/mixed SHA → `INVALID_APPROVED_FULL_SHA` / bash die (no silent lowercasing).

### Dry-run default + mutation opt-in

| Mode | Env |
|---|---|
| Dry-run (default) | unset or `PRODUCTION_DRY_RUN=1` — gates pass, commands printed, **no** pm2 required |
| Real mutation | `PRODUCTION_DRY_RUN=0` **and** `PRODUCTION_MUTATION_APPROVED=1` **and** approval triple |

Migrate plan/apply validate entrypoint (`package.json` `migrate:*` or `src/server/migrate-runner.mjs`) before dry-run print or apply — missing → `MIGRATE_ENTRYPOINT_MISSING`.

---

## Typical release (owner-approved)

```bash
cd /home/gian.devx/cairn-taskmanager   # production checkout
export APPROVED_FULL_SHA=$(git rev-parse HEAD)  # lowercase 40-hex
export PRODUCTION_APPROVAL_ID=...
export BACKUP_RECEIPT=/secure/path/dump-or-receipt
export PRODUCTION_DRY_RUN=0
export PRODUCTION_MUTATION_APPROVED=1
# optional schema move:
# export MIGRATE_APPLY_APPROVED=1
# export DB_DUMP_PATH=/secure/path/fresh.sql

chmod +x deploy/production/scripts/*.sh
./deploy/production/scripts/release.sh --enable-systemd
```

Dry-run (default on laptop or host; no pm2 binary required):

```bash
echo dry >/tmp/dummy-backup-receipt
APPROVED_FULL_SHA=$(git rev-parse HEAD) \
  PRODUCTION_APPROVAL_ID=dry-run-local \
  BACKUP_RECEIPT=/tmp/dummy-backup-receipt \
  PREFLIGHT_REQUIRE_HEAD_MATCH=0 \
  ./deploy/production/scripts/pm2-atomic.sh
```

Exact app-only release plan (no host, DB, service, or network mutation; does
not claim deploy/readback/rollback PASS):

```bash
./deploy/production/scripts/release.sh \
  --dry-run \
  --no-migrate \
  --expected-sha "$(git rev-parse HEAD)"

./deploy/production/scripts/rollback-prior-sha.sh \
  --dry-run \
  --expected-sha "$(git rev-parse HEAD)"
```

`--no-migrate` is the production app-only fence. It skips both migration plan
and apply; it does not grant task-manager production schema authority.

### Exact authenticated readback

Release acceptance uses all three authenticated surfaces (loopback, nginx
origin, public edge), exact `deployedSha`, release/schema match, non-blocked
migration state, and proven sync backlog zero:

```bash
# CAIRN_HEALTH_BEARER is loaded from the production secret environment; never echo it.
CAIRN_HEALTH_BEARER="$CAIRN_HEALTH_BEARER" \
  ./deploy/production/scripts/health-readback.sh \
    --require-exact \
    --require-sync-zero \
    --expected-sha "$APPROVED_FULL_SHA"
```

Liveness-only `401|200|503` is still observable in default read-only mode, but
it cannot close a release gate. A failed exact readback in real `release.sh`
automatically invokes `rollback-prior-sha.sh` when a distinct prior SHA was
captured. Failed-release and rollback output remains evidence; it is not erased.

---

## Rollback classes

| Class | When | Action |
|---|---|---|
| `APP_ONLY_PRIOR_SHA` | no schema move | `rollback.sh --to-sha <prior>` |
| `DB_FORWARD_FIX_ONLY` | schema moved, no restorable dump | app prior SHA ok; **DB not auto-reverted** |
| `APP_PLUS_DB_RESTORE` | schema moved + restorable dump | app prior SHA + **manual** dump restore |

```bash
SCHEMA_MOVED=1 HAS_DB_DUMP=0 ./deploy/production/scripts/rollback.sh --classify
```

The automatic wrapper performs app rollback plus exact health/readback of the
prior SHA. It never auto-reverts a database and its dry-run output explicitly
sets `rollback_proven=false`.

---

## Self-tests

```bash
./deploy/production/selftest/selftest.sh
node deploy/production/selftest/selftest.mjs
pnpm exec vitest run tests/unit/production-deploy-package.test.ts
```

---

## Explicit non-goals

- No Docker / compose production path (staging only).
- No automatic production deploy from CI.
- No printing of DB passwords, bearer secrets, or dump bodies.
- No `git commit` / Trello / Cloudflare mutation from these scripts.
