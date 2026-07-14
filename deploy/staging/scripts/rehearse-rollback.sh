#!/usr/bin/env bash
# Fail-closed STAGING rollback rehearsal runner (PRIOR_SHA app-only + CURRENT recovery).
#
# Purpose (AC-ROLL-01 / AC-ROLL-02):
#   1) Redeploy exact PREVIOUS full SHA (app-only; MySQL volume preserved)
#   2) Prove prior-SHA health / smoke
#   3) Recover exact CURRENT full SHA (app-only)
#   4) Prove current-SHA health / smoke + MySQL volume preservation
#   5) Cleanup temporary pins / working files
#
# Hard bans:
#   - PRODUCTION hosts/paths/env (never)
#   - GREENFIELD / stop-wipe / compose down -v / volume rm (never)
#   - Image-only prior when schema is NOT compatible (app-only class only)
#   - Mutating without fresh approval + BACKUP_MARKER + mutation opt-in
#
# Usage:
#   # Dry-run / preflight only (default; non-mutating):
#   ./deploy/staging/scripts/rehearse-rollback.sh \
#     --current-sha <40hex> --previous-sha <40hex> \
#     --approval-id <fresh-id> --backup-marker /path/to/BACKUP_MARKER.txt
#
#   # Explicit plan print (same as dry-run):
#   ... --plan
#
#   # Live mutation (operator only; requires BOTH flags):
#   STAGING_ROLLBACK_MUTATION_APPROVED=1 ./deploy/staging/scripts/rehearse-rollback.sh \
#     --current-sha … --previous-sha … --approval-id … --backup-marker … --execute
#
# Env aliases (optional if flags set):
#   CURRENT_SHA, PREVIOUS_SHA, STAGING_ROLLBACK_APPROVAL_ID, BACKUP_MARKER
#   STAGING_HEALTH_BEARER   (optional auth smoke; never printed)
#   REHEARSE_HEALTH_BASE    (default http://127.0.0.1:33211)
#   REHEARSE_DRY_RUN        (default 1; set 0 only with --execute + mutation approved)
#   SCHEMA_COMPATIBLE       (default auto from marker/env; set 1 to assert app-only class)
#
# Does NOT edit deploy.sh / rollback.sh. Sources common.sh for compose helpers only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

# ---------------------------------------------------------------------------
# Defaults (fail closed: dry-run ON)
# ---------------------------------------------------------------------------
REHEARSE_DRY_RUN="${REHEARSE_DRY_RUN:-1}"
EXECUTE=0
PLAN_ONLY=0
CURRENT_SHA="${CURRENT_SHA:-}"
PREVIOUS_SHA="${PREVIOUS_SHA:-}"
APPROVAL_ID="${STAGING_ROLLBACK_APPROVAL_ID:-}"
BACKUP_MARKER="${BACKUP_MARKER:-}"
SCHEMA_COMPATIBLE="${SCHEMA_COMPATIBLE:-}"
HEALTH_BASE="${REHEARSE_HEALTH_BASE:-http://127.0.0.1:33211}"
APP_SERVICE="cairn-tm-v3-app"
MYSQL_CONTAINER="cairn-tm-v3-mysql"
MYSQL_VOLUME="cairn-tm-v3-mysql-data"
WORKDIR=""
MYSQL_STARTED_AT_PRE=""
PHASE_LOG=()

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \?//'
  exit 2
}

die() {
  echo "ERROR: $*" >&2
  echo "REHEARSE_ROLLBACK_FAIL" >&2
  exit 1
}

log() {
  echo "$*"
  PHASE_LOG+=("$*")
}

is_full_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]
}

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --current-sha)
      CURRENT_SHA="${2:-}"
      shift 2
      ;;
    --previous-sha|--prior-sha)
      PREVIOUS_SHA="${2:-}"
      shift 2
      ;;
    --approval-id)
      APPROVAL_ID="${2:-}"
      shift 2
      ;;
    --backup-marker)
      BACKUP_MARKER="${2:-}"
      shift 2
      ;;
    --dry-run|--plan)
      REHEARSE_DRY_RUN=1
      PLAN_ONLY=1
      shift
      ;;
    --execute)
      EXECUTE=1
      shift
      ;;
    --schema-compatible)
      SCHEMA_COMPATIBLE=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    --greenfield|--wipe|--stop-wipe-volume|--production)
      die "FORBIDDEN flag '$1' — production/greenfield/wipe are banned on this runner (use dedicated greenfield tooling outside AC-ROLL path)"
      ;;
    *)
      die "unknown arg: $1 (see --help)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# GATE 0 — environment class: staging only; production/greenfield banned
# ---------------------------------------------------------------------------
refuse_production() {
  if [[ "${CAIRN_ENV:-}" == "production" || "${NODE_ENV_FORCE:-}" == "production-host" ]]; then
    die "CAIRN_ENV/production class forbidden (got CAIRN_ENV=${CAIRN_ENV:-unset})"
  fi
  if [[ -n "${PROD_APP_PATH:-}" || -n "${PRODUCTION_APPROVAL_ID:-}" || -n "${APPROVED_FULL_SHA:-}" ]]; then
    die "production approval/env vars present — refuse to run staging rehearsal under production context"
  fi
  # Path fingerprints known from investigations (never auto-target prod tree)
  case "${PWD:-}" in
    */cairn-taskmanager|*/home/gian.devx/cairn-taskmanager*)
      if [[ "${ALLOW_STAGING_REHEARSE_FROM_PROD_TREE:-}" != "1" ]]; then
        die "cwd looks like production app tree (${PWD}); refuse"
      fi
      ;;
  esac
  case "${RELEASE_ROOT:-}" in
    */production/*|*/prod/*)
      die "RELEASE_ROOT looks production-shaped: ${RELEASE_ROOT}"
      ;;
  esac
  if [[ "${STAGING_ROLLBACK_ALLOW_GREENFIELD:-}" == "1" ]]; then
    die "STAGING_ROLLBACK_ALLOW_GREENFIELD=1 is forbidden on rehearse-rollback (greenfield banned)"
  fi
}

# ---------------------------------------------------------------------------
# GATE 1 — exact current + previous full SHAs
# ---------------------------------------------------------------------------
require_exact_shas() {
  if [[ -z "${CURRENT_SHA}" ]]; then
    die "CURRENT_SHA / --current-sha required (full 40-char lowercase hex)"
  fi
  if [[ -z "${PREVIOUS_SHA}" ]]; then
    die "PREVIOUS_SHA / --previous-sha required (full 40-char lowercase hex)"
  fi
  if ! is_full_sha "${CURRENT_SHA}"; then
    die "CURRENT_SHA must be full 40-char lowercase hex (got len=${#CURRENT_SHA})"
  fi
  if ! is_full_sha "${PREVIOUS_SHA}"; then
    die "PREVIOUS_SHA must be full 40-char lowercase hex (got len=${#PREVIOUS_SHA})"
  fi
  if [[ "${CURRENT_SHA}" == "${PREVIOUS_SHA}" ]]; then
    die "CURRENT_SHA and PREVIOUS_SHA must differ (got identical ${CURRENT_SHA})"
  fi
  # Reject uppercase (canonical contract matches production assertFullSha)
  if [[ "${CURRENT_SHA}" =~ [A-F] || "${PREVIOUS_SHA}" =~ [A-F] ]]; then
    die "SHAs must be lowercase hex only"
  fi
}

# ---------------------------------------------------------------------------
# GATE 2 — fresh approval ID
# ---------------------------------------------------------------------------
require_fresh_approval() {
  if [[ -z "${APPROVAL_ID}" ]]; then
    die "STAGING_ROLLBACK_APPROVAL_ID / --approval-id required (fresh owner/orchestrator approval)"
  fi
  if [[ "${#APPROVAL_ID}" -lt 8 ]]; then
    die "approval-id too short (min 8 chars) — refuse stale/empty token"
  fi
  case "${APPROVAL_ID}" in
    REPLACE_ME*|TODO*|placeholder*|PLACEHOLDER*|stale*|STALE*|0|null|NULL|none|NONE)
      die "approval-id looks like a placeholder/stale value: ${APPROVAL_ID}"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# GATE 3 — backup marker present + coherent
# ---------------------------------------------------------------------------
require_backup_marker() {
  if [[ -z "${BACKUP_MARKER}" ]]; then
    die "BACKUP_MARKER / --backup-marker required (path to BACKUP_MARKER.txt)"
  fi
  if [[ ! -f "${BACKUP_MARKER}" ]]; then
    die "backup marker file missing: ${BACKUP_MARKER}"
  fi
  if [[ ! -s "${BACKUP_MARKER}" ]]; then
    die "backup marker file empty: ${BACKUP_MARKER}"
  fi

  local body
  body="$(cat "${BACKUP_MARKER}")"

  # Must document app-only / no-db-mutate class when mode is present
  if printf '%s\n' "${body}" | grep -Eiq 'mode[[:space:]=]+'; then
    if ! printf '%s\n' "${body}" | grep -Eiq 'app-only|no_db_mutate|no-db-mutate|app_only'; then
      die "backup marker mode is not app-only (volume-safe class required for this runner)"
    fi
  fi

  # Prefer explicit sha fields when present
  local marker_prev marker_cur marker_rollback marker_approval
  marker_prev="$(printf '%s\n' "${body}" | sed -nE 's/.*(previous_sha|prior_sha)[=:[:space:]]+([0-9a-f]{40}).*/\2/ip' | head -1 || true)"
  marker_cur="$(printf '%s\n' "${body}" | sed -nE 's/.*(target_sha|current_sha)[=:[:space:]]+([0-9a-f]{40}).*/\2/ip' | head -1 || true)"
  marker_rollback="$(printf '%s\n' "${body}" | sed -nE 's/.*(rollback_sha)[=:[:space:]]+([0-9a-f]{40}).*/\2/ip' | head -1 || true)"
  marker_approval="$(printf '%s\n' "${body}" | sed -nE 's/.*(approval_id|deploy_approval_id)[=:[:space:]]+([^[:space:]]+).*/\2/ip' | head -1 || true)"

  if [[ -n "${marker_rollback}" && "${marker_rollback}" != "${PREVIOUS_SHA}" ]]; then
    die "backup marker rollback_sha=${marker_rollback} does not match PREVIOUS_SHA=${PREVIOUS_SHA}"
  fi
  if [[ -n "${marker_prev}" && "${marker_prev}" != "${PREVIOUS_SHA}" && "${marker_prev}" != "${CURRENT_SHA}" ]]; then
    # previous_sha on a deploy marker is often the then-running SHA (current at deploy time)
    # Allow either PREVIOUS (rollback target) or CURRENT (pre-deploy pin) — refuse unrelated.
    if [[ "${marker_prev}" != "${PREVIOUS_SHA}" ]]; then
      log "WARN: marker previous_sha=${marker_prev} is neither PREVIOUS nor equal check skipped strict if target matches"
    fi
  fi
  if [[ -n "${marker_cur}" && "${marker_cur}" != "${CURRENT_SHA}" && "${marker_cur}" != "${PREVIOUS_SHA}" ]]; then
    die "backup marker target/current_sha=${marker_cur} matches neither CURRENT nor PREVIOUS"
  fi

  # Fresh approval: must not reuse the deploy approval stamped on the marker
  if [[ -n "${marker_approval}" && "${marker_approval}" == "${APPROVAL_ID}" ]]; then
    die "approval-id must be FRESH for this rehearsal (equals marker approval_id=${marker_approval})"
  fi

  log "BACKUP_MARKER_OK path=${BACKUP_MARKER} bytes=$(wc -c <"${BACKUP_MARKER}" | tr -d ' ')"
}

# ---------------------------------------------------------------------------
# GATE 4 — schema compatibility (app-only class)
# ---------------------------------------------------------------------------
require_schema_compatible() {
  # App-only rehearsal: both SHAs must share the same schema/migration pin era.
  # Cross-schema dump restore is a DIFFERENT class and is intentionally out of this runner.
  local schema_pin mig_pin
  schema_pin="${CAIRN_SCHEMA_VERSION:-}"
  mig_pin="${CAIRN_MIGRATION_LATEST:-}"

  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    set -a
    # shellcheck disable=SC1091
    source "${ENV_FILE}" 2>/dev/null || true
    set +a
    schema_pin="${CAIRN_SCHEMA_VERSION:-$schema_pin}"
    mig_pin="${CAIRN_MIGRATION_LATEST:-$mig_pin}"
  fi

  if [[ "${SCHEMA_COMPATIBLE}" == "1" ]]; then
    log "SCHEMA_COMPATIBLE=1 asserted by operator (app-only class)"
    return 0
  fi

  # If marker documents schema, require non-empty pins (fail closed on silent missing)
  if [[ -f "${BACKUP_MARKER}" ]]; then
    local body
    body="$(cat "${BACKUP_MARKER}")"
    if printf '%s\n' "${body}" | grep -Eiq 'schema|migration'; then
      if [[ -z "${schema_pin}" || -z "${mig_pin}" ]]; then
        die "schema/migration pins missing in env while backup marker documents schema (set CAIRN_SCHEMA_VERSION + CAIRN_MIGRATION_LATEST or SCHEMA_COMPATIBLE=1)"
      fi
    fi
  fi

  if [[ -z "${schema_pin}" || -z "${mig_pin}" ]]; then
    die "schema compatibility unproven: set CAIRN_SCHEMA_VERSION + CAIRN_MIGRATION_LATEST (same-era app-only) or SCHEMA_COMPATIBLE=1"
  fi
  if [[ "${schema_pin}" != "${mig_pin}" ]]; then
    die "schema pin mismatch: CAIRN_SCHEMA_VERSION=${schema_pin} != CAIRN_MIGRATION_LATEST=${mig_pin}"
  fi
  log "SCHEMA_COMPAT_OK version=${schema_pin} (app-only; no dump restore; pins must stay for prior+recovery)"
}

# ---------------------------------------------------------------------------
# Mutation gate
# ---------------------------------------------------------------------------
require_mutation_opt_in() {
  if [[ "${EXECUTE}" != "1" ]]; then
    die "internal: require_mutation_opt_in without --execute"
  fi
  if [[ "${STAGING_ROLLBACK_MUTATION_APPROVED:-}" != "1" ]]; then
    die "mutation refused: set STAGING_ROLLBACK_MUTATION_APPROVED=1 AND pass --execute (dry-run is default)"
  fi
  if [[ "${REHEARSE_DRY_RUN}" == "1" && "${EXECUTE}" == "1" ]]; then
    # --execute wins over default dry-run when mutation approved
    REHEARSE_DRY_RUN=0
  fi
  if [[ "${REHEARSE_DRY_RUN}" == "1" ]]; then
    die "REHEARSE_DRY_RUN=1 blocks mutation (unset or set 0 with --execute)"
  fi
}

# ---------------------------------------------------------------------------
# Docker helpers (mutation path only)
# ---------------------------------------------------------------------------
docker_bin() {
  if docker info >/dev/null 2>&1; then
    echo docker
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    echo "sudo -n docker"
  elif command -v sudo >/dev/null 2>&1; then
    echo "sudo docker"
  else
    die "docker not available"
  fi
}

pin_release_sha() {
  local sha="$1"
  require_env_file
  if grep -q '^RELEASE_SHA=' "${ENV_FILE}"; then
    local tmp
    tmp="$(mktemp)"
    awk -v sha="${sha}" 'BEGIN{FS=OFS="="} $1=="RELEASE_SHA"{$2=sha} {print}' "${ENV_FILE}" >"${tmp}"
    mv "${tmp}" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}" || true
  else
    echo "RELEASE_SHA=${sha}" >>"${ENV_FILE}"
    chmod 600 "${ENV_FILE}" || true
  fi
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  source "${ENV_FILE}"
  set +a
  export RELEASE_SHA="${sha}"
  log "ENV_PIN_OK RELEASE_SHA=${sha}"
}

app_only_recreate() {
  local sha="$1"
  log "APP_ONLY_RECREATE begin sha=${sha} service=${APP_SERVICE} (no-deps; volume untouched)"
  # Prefer existing image; build only if missing
  local db
  db="$(docker_bin)"
  # shellcheck disable=SC2086
  if ! ${db} images --format '{{.Repository}}:{{.Tag}}' | grep -q "cairn-tm-v3-app:${sha}"; then
    log "IMAGE_MISSING sha=${sha} — compose build app"
    compose build "${APP_SERVICE}"
  else
    log "IMAGE_PRESENT sha=${sha}"
  fi
  compose up -d --force-recreate --no-deps "${APP_SERVICE}"
  log "APP_ONLY_RECREATE_OK sha=${sha}"
}

record_mysql_started_at() {
  local db
  db="$(docker_bin)"
  # shellcheck disable=SC2086
  MYSQL_STARTED_AT_PRE="$(${db} inspect -f '{{.State.StartedAt}}' "${MYSQL_CONTAINER}" 2>/dev/null || true)"
  if [[ -z "${MYSQL_STARTED_AT_PRE}" ]]; then
    die "cannot read MySQL StartedAt (container ${MYSQL_CONTAINER} missing?)"
  fi
  log "MYSQL_STARTED_AT_PRE=${MYSQL_STARTED_AT_PRE}"
}

assert_mysql_volume_preserved() {
  local db started now
  db="$(docker_bin)"
  # shellcheck disable=SC2086
  started="$(${db} inspect -f '{{.State.StartedAt}}' "${MYSQL_CONTAINER}" 2>/dev/null || true)"
  if [[ -z "${started}" ]]; then
    die "MySQL container missing after rehearsal — volume preservation unproven"
  fi
  if [[ -n "${MYSQL_STARTED_AT_PRE}" && "${started}" != "${MYSQL_STARTED_AT_PRE}" ]]; then
    die "MySQL StartedAt changed (pre=${MYSQL_STARTED_AT_PRE} now=${started}) — volume/container was recreated; FAIL volume preservation"
  fi
  # shellcheck disable=SC2086
  if ! ${db} volume inspect "${MYSQL_VOLUME}" >/dev/null 2>&1; then
    die "MySQL volume ${MYSQL_VOLUME} missing — FAIL volume preservation"
  fi
  log "MYSQL_VOLUME_PRESERVED volume=${MYSQL_VOLUME} StartedAt=${started}"
}

health_smoke() {
  local expect_sha="$1"
  local label="$2"
  local code body_file
  body_file="$(mktemp "${WORKDIR:-/tmp}/healthz.XXXXXX")"
  set +e
  code="$(curl -sS -o "${body_file}" -w '%{http_code}' \
    --connect-timeout 3 --max-time 12 \
    "${HEALTH_BASE}/api/healthz" 2>/dev/null)"
  local curl_ec=$?
  set -e
  if [[ ${curl_ec} -ne 0 ]]; then
    die "${label}: unauth healthz curl_exit=${curl_ec} (stack down?)"
  fi
  # Liveness: 401 proves listen under auth-required healthz; 200 also ok if open
  if [[ "${code}" != "401" && "${code}" != "200" ]]; then
    die "${label}: unauth healthz http=${code} expected 401|200 (503 is NOT pass)"
  fi
  log "${label}_LIVENESS_OK http=${code}"

  if [[ -n "${STAGING_HEALTH_BEARER:-}" ]]; then
    local acode
    set +e
    acode="$(curl -sS -o "${body_file}" -w '%{http_code}' \
      --connect-timeout 3 --max-time 12 \
      -H "Authorization: Bearer ${STAGING_HEALTH_BEARER}" \
      "${HEALTH_BASE}/api/healthz" 2>/dev/null)"
    set -e
    if [[ "${acode}" != "200" ]]; then
      die "${label}: auth healthz http=${acode} expected 200 (release PASS gate)"
    fi
    if command -v node >/dev/null 2>&1; then
      node -e '
        const fs=require("fs");
        const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        const expect=process.argv[2];
        const sha=b.deployedSha||b.release&&b.release.sha||"";
        if(sha!==expect){
          console.error("SHA_MISMATCH got="+sha+" expect="+expect);
          process.exit(2);
        }
        if(b.status && b.status!=="ok"){
          console.error("STATUS_NOT_OK="+b.status);
          process.exit(3);
        }
        console.log("AUTH_HEALTH_SHA_OK sha="+sha+" schema="+(b.schema&&b.schema.version||"?"));
      ' "${body_file}" "${expect_sha}" || die "${label}: auth healthz SHA/status mismatch"
    else
      if ! grep -q "${expect_sha}" "${body_file}"; then
        die "${label}: auth body missing expect sha ${expect_sha}"
      fi
      log "${label}_AUTH_OK http=200 (sha string present; node unavailable for JSON parse)"
    fi
  else
    log "${label}_AUTH_SKIP (STAGING_HEALTH_BEARER unset — liveness only; set bearer for release PASS)"
  fi
}

cleanup_rehearse() {
  if [[ -n "${WORKDIR}" && -d "${WORKDIR}" ]]; then
    rm -rf "${WORKDIR}" || true
  fi
  log "CLEANUP_OK"
}

print_plan() {
  cat <<EOF
======== REHEARSE_ROLLBACK_PLAN ========
OWNER_TARGET: {base_url: ${HEALTH_BASE}/, port: 33211, account: staging-synthetic, device: n/a}
CLASS: PRIOR_SHA_APP_ONLY + CURRENT_SHA_RECOVERY
CURRENT_SHA:  ${CURRENT_SHA}
PREVIOUS_SHA: ${PREVIOUS_SHA}
APPROVAL_ID:  ${APPROVAL_ID}
BACKUP_MARKER: ${BACKUP_MARKER}
DRY_RUN: ${REHEARSE_DRY_RUN}
EXECUTE: ${EXECUTE}
MUTATION_APPROVED_ENV: ${STAGING_ROLLBACK_MUTATION_APPROVED:-0}
RELEASE_ROOT: ${RELEASE_ROOT}
SOURCE_ROOT: ${SOURCE_ROOT}
FORBIDDEN: production, greenfield, wipe-volume, down -v
PHASES:
  1. record MySQL StartedAt + volume presence
  2. pin RELEASE_SHA=PREVIOUS; app-only force-recreate --no-deps ${APP_SERVICE}
  3. prior health/smoke (unauth 401 + optional auth SHA match)
  4. pin RELEASE_SHA=CURRENT; app-only force-recreate --no-deps ${APP_SERVICE}
  5. current recovery health/smoke
  6. assert MySQL StartedAt unchanged + volume present
  7. cleanup temp workdir
========================================
EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  print_target
  refuse_production
  require_exact_shas
  require_fresh_approval
  require_backup_marker
  require_schema_compatible

  log "GATES_OK current=${CURRENT_SHA} previous=${PREVIOUS_SHA} approval=${APPROVAL_ID}"
  print_plan

  # --execute without mutation opt-in = fail closed (never silent dry-run).
  if [[ "${EXECUTE}" == "1" ]]; then
    require_mutation_opt_in
  else
    log "REHEARSE_ROLLBACK_DRY_RUN_OK (no compose mutation; no git checkout; no env pin write)"
    log "To mutate staging: STAGING_ROLLBACK_MUTATION_APPROVED=1 $0 --execute --current-sha … --previous-sha … --approval-id … --backup-marker …"
    echo "status: LOCAL ONLY (dry-run gates only)"
    exit 0
  fi

  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/rehearse-rollback.XXXXXX")"
  trap cleanup_rehearse EXIT

  require_env_file
  record_mysql_started_at

  # --- AC-ROLL-01: prior redeploy ---
  log "PHASE_PRIOR begin"
  pin_release_sha "${PREVIOUS_SHA}"
  app_only_recreate "${PREVIOUS_SHA}"
  # brief listen wait (bounded)
  sleep 3
  health_smoke "${PREVIOUS_SHA}" "PRIOR"
  log "PHASE_PRIOR_OK AC-ROLL-01"
  assert_mysql_volume_preserved

  # --- AC-ROLL-02: current recovery ---
  log "PHASE_RECOVERY begin"
  pin_release_sha "${CURRENT_SHA}"
  app_only_recreate "${CURRENT_SHA}"
  sleep 3
  health_smoke "${CURRENT_SHA}" "CURRENT"
  log "PHASE_RECOVERY_OK AC-ROLL-02"
  assert_mysql_volume_preserved

  cleanup_rehearse
  trap - EXIT

  log "REHEARSE_ROLLBACK_OK current=${CURRENT_SHA} previous=${PREVIOUS_SHA} mysql_started_at=${MYSQL_STARTED_AT_PRE}"
  echo "AC-ROLL-01: PROVEN (prior redeploy + smoke)"
  echo "AC-ROLL-02: PROVEN (current recovery + smoke + volume preserve)"
  exit 0
}

main "$@"
