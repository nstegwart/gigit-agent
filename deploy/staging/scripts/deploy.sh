#!/usr/bin/env bash
# Idempotent staging deploy: build SHA-tagged image + up app/MySQL.
# Safe to re-run; does not touch production hosts or paths.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target
require_env_file

echo "==> compose config (quiet; no secret dump)"
compose config --quiet

echo "==> build image cairn-tm-v3-app:${RELEASE_SHA}"
compose build --pull

echo "==> up (detached, recreate if needed)"
compose up -d --remove-orphans

echo "==> status"
compose ps
echo "DEPLOY_OK release_sha=${RELEASE_SHA} bind=127.0.0.1:33211->3210 db=cairn_tm_v3_staging container=cairn-tm-v3-mysql"
echo "NOTE: compose 'healthy' is LIVENESS only (unauth healthz 401|200|503). 503 is NOT release PASS."
echo "RELEASE acceptance: authenticated GET /api/healthz → HTTP 200 with deployedSha/schemaVersion/migration history + required tables."
echo "Next: wait for container healthy (listen), then auth probe http://127.0.0.1:33211/api/healthz (unauth expect 401)."
