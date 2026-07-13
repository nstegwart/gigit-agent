# Staging Compose package — cairn-taskmanager-v3 (TM-P0)

Isolated **app + MySQL** Docker Compose source for the staging release root.

| Contract field | Value |
|---|---|
| Release root | `/opt/mfs/staging/cairn-taskmanager-v3` |
| Source checkout | `/opt/mfs/staging/cairn-taskmanager-v3/source` |
| Host bind | `127.0.0.1:33211` → container `3210` |
| Database name | `cairn_tm_v3_staging` |
| DB container | `cairn-tm-v3-mysql` |
| App image | `cairn-tm-v3-app:<FULL_SHA>` |
| Data mode | **synthetic fixtures only** |
| Health | `GET /api/healthz` (auth required; unauth → **401** means process is up) |
| TLS | none (private loopback only) |

This package is **staging-only**. It does not define or reference a production deploy path.

---

## Layout

```text
deploy/staging/
  Dockerfile              # app image (preview on :3210)
  docker-compose.yml      # app + mysql, loopback 33211
  env.staging.example     # template (tracked)
  .env                    # secrets + RELEASE_SHA (UNTRACKED; create on host)
  README.md               # this runbook
  scripts/
    common.sh
    deploy.sh             # build + up (idempotent)
    stop.sh               # down, keep volume
    status.sh             # ps + :33211 + health probe
    rollback.sh           # greenfield vs prior-SHA
```

---

## Prerequisites (staging VPS)

- Docker + Compose (host evidence historically: Docker 29.x, Compose 5.x)
- `sudo` for Docker when the deploy user is not in the `docker` group
- Source tree checked out at `RELEASE_ROOT/source` at the release SHA
- Untracked secrets file `deploy/staging/.env` (copy from `env.staging.example`)

---

## One-time setup

```bash
export RELEASE_ROOT=/opt/mfs/staging/cairn-taskmanager-v3
sudo mkdir -p "$RELEASE_ROOT"/{source,releases,snapshots,logs}
# Place or rsync this repo into $RELEASE_ROOT/source at the pinned full SHA.
cd "$RELEASE_ROOT/source"

cp deploy/staging/env.staging.example deploy/staging/.env
# Edit deploy/staging/.env:
#   RELEASE_SHA=<40-char full git SHA>
#   MYSQL_ROOT_PASSWORD, CAIRN_DB_*, CAIRN_WRITE_TOKEN, CAIRN_CSRF_SECRET
# All values must be staging-only throwaways. Synthetic data only.
```

`deploy/staging/.env` is gitignored by the root `.env` pattern and must never be committed.

---

## Idempotent commands (sudo Docker Compose)

All scripts auto-select `docker` or `sudo docker` when the daemon requires elevation.

### Deploy (build + up)

```bash
cd /opt/mfs/staging/cairn-taskmanager-v3/source
chmod +x deploy/staging/scripts/*.sh
./deploy/staging/scripts/deploy.sh
```

Equivalent manual form:

```bash
cd /opt/mfs/staging/cairn-taskmanager-v3/source
export COMPOSE="sudo docker compose -f deploy/staging/docker-compose.yml --env-file deploy/staging/.env"
$COMPOSE config --quiet          # validate; does not print secret values with --quiet
$COMPOSE build --pull
$COMPOSE up -d --remove-orphans
$COMPOSE ps
```

Re-running deploy rebuilds/recreates as needed; it is safe to repeat.

### Status

```bash
./deploy/staging/scripts/status.sh
# or:
$COMPOSE ps
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:33211/api/healthz
# expect: 401 while stack is healthy but unauthenticated
```

Authenticated health (after synthetic token is set):

```bash
curl -sS -H "Authorization: Bearer $STAGING_TOKEN" http://127.0.0.1:33211/api/healthz
# Gate: schemaVersion/status, deployedSha == RELEASE_SHA, mysql dependency up
```

### Stop (keep MySQL volume)

```bash
./deploy/staging/scripts/stop.sh
# or:
$COMPOSE down --remove-orphans
```

### Rollback

#### GREENFIELD rollback (`NO_PRIOR_STAGING_SHA`)

Use when this is the **first** staging stack (no prior release SHA image / no previous healthy deploy).
There is **no prior image to restore**. Class = `GREENFIELD_ROLLBACK`.

```bash
./deploy/staging/scripts/rollback.sh --greenfield
# → compose down -v (containers + volume + project network)
# Optional orchestrator-approved path wipe:
#   sudo rm -rf /opt/mfs/staging/cairn-taskmanager-v3
```

#### PRIOR_SHA rollback (after at least one successful prior deploy)

```bash
./deploy/staging/scripts/rollback.sh --to-sha <40-char-previous-full-sha>
# pins RELEASE_SHA in .env and `compose up` that image tag
```

#### Stop variants

```bash
./deploy/staging/scripts/rollback.sh --stop-keep-volume
./deploy/staging/scripts/rollback.sh --stop-wipe-volume
```

| Class | When | Action |
|---|---|---|
| `GREENFIELD_ROLLBACK` | No prior staging SHA | `down -v` (+ optional release-root remove) |
| `PRIOR_SHA_ROLLBACK` | Prior image exists | retag/up previous `cairn-tm-v3-app:<sha>` |
| `STOP_KEEP_VOLUME` | Debug pause | `down` keep `cairn-tm-v3-mysql-data` |
| `STOP_WIPE_VOLUME` | Disposable reset | `down -v` |

---

## Local compose config validation (no secret output)

From a laptop checkout (does **not** require a live staging host):

```bash
cd /path/to/gigit-project-orchestration
cp deploy/staging/env.staging.example deploy/staging/.env
# Use dummy non-production values for local config parse only:
#   RELEASE_SHA=<any 40 hex>, passwords=local-dummy-*, tokens=local-dummy-*

docker compose -f deploy/staging/docker-compose.yml --env-file deploy/staging/.env config --quiet
echo "compose_config_exit=$?"
# Optional structural check without dumping env values:
docker compose -f deploy/staging/docker-compose.yml --env-file deploy/staging/.env config \
  --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); print("services",sorted(c.get("services",{}))); print("ports",c["services"]["cairn-tm-v3-app"]["ports"]); print("db_name",c["services"]["cairn-tm-v3-mysql"]["environment"].get("MYSQL_DATABASE"))'
# Remove the temporary .env after validation if you do not need it:
# rm deploy/staging/.env
```

Expected structural facts:

- services: `cairn-tm-v3-app`, `cairn-tm-v3-mysql`
- published port: `127.0.0.1:33211:3210`
- MySQL database: `cairn_tm_v3_staging`
- container name: `cairn-tm-v3-mysql`

---

## App env identity (forced by compose)

| Variable | Value |
|---|---|
| `CAIRN_DB_HOST` | `cairn-tm-v3-mysql` |
| `CAIRN_DB_NAME` | `cairn_tm_v3_staging` |
| `CAIRN_STAGING_DB_HOSTS` | `cairn-tm-v3-mysql` (required so host class = STAGING) |
| `CAIRN_ALLOW_REMOTE_DB` | `1` (Docker DNS is non-loopback) |
| `CAIRN_DEPLOYED_SHA` / `CAIRN_EXPECTED_SHA` | `$RELEASE_SHA` |
| `CAIRN_ENV` | `staging` |
| bind | `127.0.0.1:33211` only |

**Trap:** without `CAIRN_STAGING_DB_HOSTS=cairn-tm-v3-mysql`, `classifyDbHost` treats the service DNS as `UNKNOWN_REMOTE` and migration apply is blocked.

---

## Out of scope for this package (follow-on)

- Synthetic fixture seed under `qa/fixtures/staging/**`
- Migration apply CLI against the live MySQL executor
- SSH tunnel from a laptop (`ssh -N -L 33211:127.0.0.1:33211 …`)
- Production deploy / production credentials / production data export

---

## Isolation checklist

- [ ] No host publish of MySQL ports
- [ ] App published only on `127.0.0.1:33211`
- [ ] Volume name `cairn-tm-v3-mysql-data` (stack-scoped)
- [ ] Network name `cairn-tm-v3-net`
- [ ] Image tag equals full release SHA
- [ ] Secrets only in untracked `deploy/staging/.env`
- [ ] Database name is `cairn_tm_v3_staging`
- [ ] Data provenance: synthetic only
