#!/usr/bin/env bash
# Read-only production preflight. NEVER mutates process, nginx, DB, or git.
#
# Validates (when available on this host):
#   - approval bundle (APPROVED_FULL_SHA, PRODUCTION_APPROVAL_ID, BACKUP_RECEIPT)
#   - host/path/branch/upstream vs approved SHA
#   - nginx site upstream → 127.0.0.1:3210
#   - env keys present (names only, never values)
#   - DB TCP connectivity (no auth query)
#   - backup authority (receipt file non-empty, optional max age)
#
# Usage:
#   APPROVED_FULL_SHA=... PRODUCTION_APPROVAL_ID=... BACKUP_RECEIPT=/path/to/receipt \
#     ./deploy/production/scripts/preflight.sh
#
# Optional env:
#   PROD_APP_PATH, PROD_NGINX_SITE, PROD_ENV_FILE, BACKUP_MAX_AGE_HOURS,
#   PROD_PATH_STRICT=1, PROD_HOST_STRICT=1, EXPECTED_HOSTNAME
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target
require_cmd node
require_cmd git

echo "==> approval bundle (fail closed)"
require_approval_bundle >/dev/null
assert_full_sha_var APPROVED_FULL_SHA

echo "==> backup authority"
GATES_JS="${GATES_JS}" node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const { assertBackupAuthority } = await import(pathToFileURL(process.env.GATES_JS).href);
const r = assertBackupAuthority({
  receiptPath: process.env.BACKUP_RECEIPT,
  maxAgeHours: process.env.BACKUP_MAX_AGE_HOURS ? Number(process.env.BACKUP_MAX_AGE_HOURS) : undefined,
});
console.log(JSON.stringify(r));
if (!r.ok) process.exit(2);
"

echo "==> working tree / path / SHA (read-only)"
APP_ROOT="${PROD_APP_PATH}"
if [[ ! -d "${APP_ROOT}/.git" ]]; then
  # Fall back to package source root for laptop selftest (not production host).
  if [[ -d "${SOURCE_ROOT}/.git" ]]; then
    echo "WARN: PROD_APP_PATH has no .git; using SOURCE_ROOT for git readback (not production host)"
    APP_ROOT="${SOURCE_ROOT}"
  else
    die "no git repo at PROD_APP_PATH=${PROD_APP_PATH}"
  fi
fi

HEAD_SHA="$(git -C "${APP_ROOT}" rev-parse HEAD)"
BRANCH="$(git -C "${APP_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo DETACHED)"
UPSTREAM="$(git -C "${APP_ROOT}" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo NONE)"
# dirty: ignore untracked .env.bak* only
DIRTY=0
if git -C "${APP_ROOT}" status --porcelain | grep -vE '^\?\? \.env\.bak' | grep -q .; then
  DIRTY=1
fi
HOSTNAME_NOW="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"

echo "GIT_HEAD=${HEAD_SHA}"
echo "GIT_BRANCH=${BRANCH}"
echo "GIT_UPSTREAM=${UPSTREAM}"
echo "GIT_DIRTY=${DIRTY}"
echo "HOSTNAME=${HOSTNAME_NOW}"
echo "APP_ROOT=${APP_ROOT}"

if [[ "${HEAD_SHA}" != "${APPROVED_FULL_SHA}" ]]; then
  echo "PREFLIGHT_NOTE: HEAD !== APPROVED_FULL_SHA (checkout step required before pm2 start)"
  echo "HEAD=${HEAD_SHA}"
  echo "APPROVED=${APPROVED_FULL_SHA}"
  if [[ "${PREFLIGHT_REQUIRE_HEAD_MATCH:-0}" == "1" ]]; then
    die "PREFLIGHT_REQUIRE_HEAD_MATCH=1 and HEAD !== APPROVED_FULL_SHA"
  fi
fi

echo "==> env keys (names only)"
ENV_FILE="${PROD_ENV_FILE:-${APP_ROOT}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  ENV_KEYS_RC=0
  env_keys_only "${ENV_FILE}"
  if [[ "${ENV_KEYS_RC}" -ne 0 ]]; then
    if [[ "${PREFLIGHT_REQUIRE_ENV_KEYS:-1}" == "1" && "${APP_ROOT}" == "${PROD_APP_PATH_DEFAULT}" ]]; then
      die "required env keys missing (PREFLIGHT_REQUIRE_ENV_KEYS=1 on production path)"
    fi
    echo "WARN: env key check incomplete (rc=${ENV_KEYS_RC}); production host must have full CAIRN_* set"
  fi
else
  echo "WARN: no env file at ${ENV_FILE}; skip key presence check (still require approval bundle)"
fi

echo "==> nginx upstream (read-only)"
if [[ -r "${PROD_NGINX_SITE}" ]]; then
  node "${GATES_JS}" parse-nginx "${PROD_NGINX_SITE}"
else
  echo "WARN: nginx site not readable at ${PROD_NGINX_SITE} (expected on production host only)"
  echo "EXPECTED_UPSTREAM=${PROD_NGINX_UPSTREAM}"
fi

echo "==> DB TCP connectivity (no credentials printed)"
DB_HOST=""
DB_PORT="3306"
ALLOW_REMOTE="0"
if [[ -f "${ENV_FILE}" ]]; then
  # Extract host/port/allow without echoing password lines
  DB_HOST="$(grep -E '^CAIRN_DB_HOST=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  DB_PORT="$(grep -E '^CAIRN_DB_PORT=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r' || echo 3306)"
  ALLOW_REMOTE="$(grep -E '^CAIRN_ALLOW_REMOTE_DB=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r' || echo 0)"
fi
if [[ -n "${DB_HOST}" ]]; then
  TCP_OPEN=0
  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 3 "${DB_HOST}" "${DB_PORT}" >/dev/null 2>&1; then
      TCP_OPEN=1
    fi
  elif command -v timeout >/dev/null 2>&1; then
    if timeout 3 bash -c "echo >/dev/tcp/${DB_HOST}/${DB_PORT}" 2>/dev/null; then
      TCP_OPEN=1
    fi
  else
    echo "WARN: no nc/timeout for DB TCP probe"
  fi
  HOST_CLASS="unknown"
  if [[ "${DB_HOST}" == "127.0.0.1" || "${DB_HOST}" == "localhost" || "${DB_HOST}" == "::1" ]]; then
    HOST_CLASS="LOCAL"
  else
    HOST_CLASS="remote_public_or_hostname"
  fi
  echo "DB_HOST_CLASS=${HOST_CLASS} DB_PORT=${DB_PORT} DB_TCP_OPEN=${TCP_OPEN} ALLOW_REMOTE_SET=$([[ "${ALLOW_REMOTE}" == "1" ]] && echo 1 || echo 0)"
  # Do not print DB_HOST value if it could be sensitive hostname — print length only
  echo "DB_HOST_LEN=${#DB_HOST}"
  if [[ "${TCP_OPEN}" != "1" && "${PREFLIGHT_REQUIRE_DB_TCP:-0}" == "1" ]]; then
    die "DB TCP closed and PREFLIGHT_REQUIRE_DB_TCP=1"
  fi
  if [[ "${HOST_CLASS}" == "remote_public_or_hostname" && "${ALLOW_REMOTE}" != "1" ]]; then
    die "remote DB host without CAIRN_ALLOW_REMOTE_DB=1"
  fi
else
  echo "WARN: CAIRN_DB_HOST not found; skip DB TCP"
fi

echo "==> listener / pm2 snapshot (read-only)"
if command -v ss >/dev/null 2>&1; then
  if ss -lntp 2>/dev/null | grep -q ":${PROD_LISTEN_PORT} "; then
    echo "LISTEN_${PROD_LISTEN_PORT}=YES"
  else
    echo "LISTEN_${PROD_LISTEN_PORT}=NO"
  fi
else
  echo "LISTEN_PROBE=ss_unavailable"
fi
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | node -e "
let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
  try {
    const arr=JSON.parse(d||'[]');
    const names=arr.map(x=>x.name);
    console.log('PM2_APPS='+JSON.stringify(names));
    console.log('PM2_HAS_CAIRN='+(names.includes('cairn-taskmanager')?'1':'0'));
  } catch(e) { console.log('PM2_APPS_PARSE_FAIL'); }
});
" || echo "PM2_JLIST_FAIL"
else
  echo "PM2=not_in_path"
fi

echo "PREFLIGHT_OK (read-only; no mutations performed)"
echo "NEXT: release.sh or build-install.sh → migrate-plan → pm2-atomic → health-readback"
echo "NOTE: migrate-apply requires MIGRATE_APPLY_APPROVED=1 + fresh dump"
