#!/usr/bin/env bash
# Shared helpers for production PM2 release package.
# Source only — do not execute. Fail closed. Never print secret values.
# Evidence: WORKER_RESULT_investigate-final-production-502-r3.md
# shellcheck shell=bash

set -euo pipefail

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_DIR="$(cd "${COMMON_DIR}/.." && pwd)"
# Repo / release source root (directory that contains package.json + deploy/production).
SOURCE_ROOT="$(cd "${PROD_DIR}/../.." && pwd)"
GATES_JS="${PROD_DIR}/lib/gates.mjs"

# Production contract (from 502-r3 investigation)
PROD_APP_NAME="${PROD_APP_NAME:-cairn-taskmanager}"
PROD_APP_PATH_DEFAULT="/home/gian.devx/cairn-taskmanager"
PROD_APP_PATH="${PROD_APP_PATH:-$PROD_APP_PATH_DEFAULT}"
PROD_LISTEN_HOST="${PROD_LISTEN_HOST:-127.0.0.1}"
PROD_LISTEN_PORT="${PROD_LISTEN_PORT:-3210}"
PROD_NGINX_UPSTREAM="${PROD_NGINX_UPSTREAM:-http://127.0.0.1:3210}"
PROD_SYSTEMD_UNIT="${PROD_SYSTEMD_UNIT:-pm2-gian.devx.service}"
PROD_PUBLIC_HOST="${PROD_PUBLIC_HOST:-task-manager.mfsdev.net}"
PROD_NGINX_SITE_DEFAULT="/etc/nginx/sites-available/task-manager.mfsdev.net.conf"
PROD_NGINX_SITE="${PROD_NGINX_SITE:-$PROD_NGINX_SITE_DEFAULT}"

# Dry-run is DEFAULT-ON. Mutating steps print intent and exit 0 only after
# approval gates pass. Real mutation requires explicit opt-in:
#   PRODUCTION_DRY_RUN=0
#   PRODUCTION_MUTATION_APPROVED=1
#   + existing approval triple (APPROVED_FULL_SHA + PRODUCTION_APPROVAL_ID + BACKUP_RECEIPT)
PRODUCTION_DRY_RUN="${PRODUCTION_DRY_RUN:-1}"
PRODUCTION_MUTATION_APPROVED="${PRODUCTION_MUTATION_APPROVED:-0}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

print_target() {
  echo "OWNER_TARGET: {base_url: https://${PROD_PUBLIC_HOST}, port: ${PROD_LISTEN_PORT}, account: production (approval-gated), device: n/a}"
  echo "PROD_APP_PATH: ${PROD_APP_PATH}"
  echo "SOURCE_ROOT:   ${SOURCE_ROOT}"
  echo "PROD_APP_NAME: ${PROD_APP_NAME}"
  echo "LISTEN:        ${PROD_LISTEN_HOST}:${PROD_LISTEN_PORT}"
  echo "NGINX_UPSTREAM:${PROD_NGINX_UPSTREAM}"
  echo "SYSTEMD_UNIT:  ${PROD_SYSTEMD_UNIT}"
  echo "APPROVED_FULL_SHA: ${APPROVED_FULL_SHA:-<unset>}"
  echo "PRODUCTION_APPROVAL_ID: ${PRODUCTION_APPROVAL_ID:-<unset>}"
  echo "BACKUP_RECEIPT: ${BACKUP_RECEIPT:-<unset>}"
  echo "PRODUCTION_DRY_RUN: ${PRODUCTION_DRY_RUN}"
  echo "PRODUCTION_MUTATION_APPROVED: ${PRODUCTION_MUTATION_APPROVED}"
}

# Fail closed when operator intends real mutation without explicit opt-in.
# Dry-run path does not need this. Call after require_approval_bundle on mutators.
require_mutation_opt_in() {
  if [[ "${PRODUCTION_DRY_RUN}" == "1" ]]; then
    return 0
  fi
  if [[ "${PRODUCTION_MUTATION_APPROVED}" != "1" ]]; then
    die "mutation refuse: PRODUCTION_DRY_RUN defaults to 1; set PRODUCTION_DRY_RUN=0 and PRODUCTION_MUTATION_APPROVED=1 (plus approval triple) for real host mutation"
  fi
  echo "MUTATION_OPT_IN_OK dry_run=0 mutation_approved=1"
}

# Fail closed without APPROVED_FULL_SHA + PRODUCTION_APPROVAL_ID + BACKUP_RECEIPT.
require_approval_bundle() {
  require_cmd node
  local out
  if ! out="$(node "${GATES_JS}" require-approval 2>&1)"; then
    echo "${out}" >&2
    die "approval bundle gate failed (require APPROVED_FULL_SHA, PRODUCTION_APPROVAL_ID, BACKUP_RECEIPT)"
  fi
  # node exits 2 on fail; also parse ok field
  if echo "${out}" | grep -q '"ok":false'; then
    echo "${out}" >&2
    die "approval bundle gate failed"
  fi
  echo "APPROVAL_BUNDLE_OK"
  echo "${out}"
}

require_migrate_apply_authority() {
  require_cmd node
  local out
  if ! out="$(node "${GATES_JS}" require-migrate-apply 2>&1)"; then
    echo "${out}" >&2
    die "migrate apply authority failed"
  fi
  if echo "${out}" | grep -q '"ok":false'; then
    echo "${out}" >&2
    die "migrate apply authority failed"
  fi
  echo "MIGRATE_APPLY_AUTHORITY_OK"
  echo "${out}"
}

# Canonical APPROVED_FULL_SHA: lowercase 40-hex only (reject uppercase/mixed).
assert_full_sha_var() {
  local name="$1"
  local val="${!name:-}"
  if [[ ! "${val}" =~ ^[0-9a-f]{40}$ ]]; then
    if [[ "${val}" =~ ^[0-9a-fA-F]{40}$ ]]; then
      die "${name} must be canonical lowercase 40-char hex git SHA (uppercase/mixed rejected; got len=${#val})"
    fi
    die "${name} must be full 40-char lowercase hex git SHA (got len=${#val})"
  fi
}

# Resolve migrate plan/apply entrypoint and fail closed if none exists.
# Sets globals: MIGRATE_ENTRYPOINT_KIND (pnpm|npm|node-runner), MIGRATE_ENTRYPOINT_CMD (printable).
# Does NOT run the command. mode = plan | apply
resolve_migrate_entrypoint() {
  local mode="$1"
  local script_key="migrate:${mode}"
  MIGRATE_ENTRYPOINT_KIND=""
  MIGRATE_ENTRYPOINT_CMD=""
  if [[ ! -f package.json ]]; then
    die "MIGRATE_ENTRYPOINT_MISSING: package.json not found in $(pwd) (mode=${mode})"
  fi
  if grep -q "\"${script_key}\"" package.json 2>/dev/null; then
    if command -v pnpm >/dev/null 2>&1; then
      MIGRATE_ENTRYPOINT_KIND="pnpm"
      MIGRATE_ENTRYPOINT_CMD="pnpm ${script_key}"
    else
      MIGRATE_ENTRYPOINT_KIND="npm"
      MIGRATE_ENTRYPOINT_CMD="npm run ${script_key}"
    fi
    echo "MIGRATE_ENTRYPOINT_OK kind=${MIGRATE_ENTRYPOINT_KIND} cmd=${MIGRATE_ENTRYPOINT_CMD}"
    return 0
  fi
  if [[ -f src/server/migrate-runner.mjs ]]; then
    MIGRATE_ENTRYPOINT_KIND="node-runner"
    MIGRATE_ENTRYPOINT_CMD="node src/server/migrate-runner.mjs ${mode}"
    echo "MIGRATE_ENTRYPOINT_OK kind=${MIGRATE_ENTRYPOINT_KIND} cmd=${MIGRATE_ENTRYPOINT_CMD}"
    return 0
  fi
  die "MIGRATE_ENTRYPOINT_MISSING: no package.json \"${script_key}\" script and no src/server/migrate-runner.mjs at $(pwd)"
}

run_migrate_entrypoint() {
  local mode="$1"
  resolve_migrate_entrypoint "${mode}"
  case "${MIGRATE_ENTRYPOINT_KIND}" in
    pnpm) pnpm "migrate:${mode}" ;;
    npm) npm run "migrate:${mode}" ;;
    node-runner) node src/server/migrate-runner.mjs "${mode}" ;;
    *) die "MIGRATE_ENTRYPOINT_INTERNAL: unknown kind=${MIGRATE_ENTRYPOINT_KIND}" ;;
  esac
}

# List keys in a dotenv file without printing values.
# Prints JSON always. Sets global ENV_KEYS_RC (0=ok, 2=missing). Always returns 0
# so set -e callers can branch on ENV_KEYS_RC without aborting.
env_keys_only() {
  local file="$1"
  [[ -f "${file}" ]] || die "env file not found: ${file}"
  set +e
  node "${GATES_JS}" env-keys "${file}"
  ENV_KEYS_RC=$?
  set -e
  return 0
}

maybe_dry_run() {
  local step="$1"
  if [[ "${PRODUCTION_DRY_RUN}" == "1" ]]; then
    echo "DRY_RUN: would execute step=${step}"
    return 0
  fi
  return 1
}

run_or_dry() {
  local step="$1"
  shift
  if maybe_dry_run "${step}"; then
    echo "DRY_RUN_CMD: $*"
    return 0
  fi
  "$@"
}
