#!/usr/bin/env bash
# Production release orchestrator (PM2 bare-metal). Fail closed.
# Does NOT run without APPROVED_FULL_SHA + PRODUCTION_APPROVAL_ID + BACKUP_RECEIPT.
#
# Steps:
#   1. preflight (read-only)
#   2. build-install (checkout + pnpm install + build)
#   3. migrate-plan (always)
#   4. migrate-apply (only if MIGRATE_APPLY_APPROVED=1)
#   5. pm2-atomic (+ optional --enable-systemd)
#   6. health-readback
#
# This script is intentionally not auto-invoked by CI. Owner/orchestrator only.
# Dry-run is DEFAULT-ON (PRODUCTION_DRY_RUN defaults to 1). Real mutation requires:
#   PRODUCTION_DRY_RUN=0 + PRODUCTION_MUTATION_APPROVED=1 + approval triple.
#
# App-only plan (no approval bundle and no mutation):
#   release.sh --dry-run --no-migrate --expected-sha <full-sha>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

ENABLE_SYSTEMD=0
SKIP_MIGRATE_PLAN=0
NO_MIGRATE=0
EXPLICIT_DRY_RUN=0
EXPECTED_SHA_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-systemd) ENABLE_SYSTEMD=1; shift ;;
    --skip-migrate-plan) SKIP_MIGRATE_PLAN=1; shift ;;
    --no-migrate) NO_MIGRATE=1; shift ;;
    --dry-run) EXPLICIT_DRY_RUN=1; PRODUCTION_DRY_RUN=1; shift ;;
    --expected-sha) EXPECTED_SHA_ARG="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

if [[ -n "${EXPECTED_SHA_ARG}" ]]; then
  if [[ -n "${APPROVED_FULL_SHA:-}" && "${APPROVED_FULL_SHA}" != "${EXPECTED_SHA_ARG}" ]]; then
    die "--expected-sha conflicts with APPROVED_FULL_SHA"
  fi
  APPROVED_FULL_SHA="${EXPECTED_SHA_ARG}"
fi

# Explicit dry-run without the production approval triple is an honest local
# plan only. It validates the intended source SHA and prints bounded steps; it
# never calls host/PM2/DB scripts and never emits a deploy/readback PASS.
if [[ "${EXPLICIT_DRY_RUN}" == "1" && ( -z "${PRODUCTION_APPROVAL_ID:-}" || -z "${BACKUP_RECEIPT:-}" ) ]]; then
  assert_full_sha_var APPROVED_FULL_SHA
  SOURCE_HEAD="$(git -C "${SOURCE_ROOT}" rev-parse HEAD 2>/dev/null || true)"
  [[ "${SOURCE_HEAD}" == "${APPROVED_FULL_SHA}" ]] || die "plan source HEAD does not match --expected-sha"
  print_target
  echo "RELEASE_PLAN_ONLY target=production-app expected_sha=${APPROVED_FULL_SHA} no_migrate=${NO_MIGRATE}"
  echo "PLAN_STEP preflight exact-sha + approval + backup readback (not executed)"
  echo "PLAN_STEP build-install exact accepted SHA (not executed)"
  if [[ "${NO_MIGRATE}" == "1" ]]; then
    echo "PLAN_STEP schema migration prohibited by --no-migrate"
  else
    echo "PLAN_STEP migration plan only; apply remains separately authorized"
  fi
  echo "PLAN_STEP pm2 atomic + authenticated loopback/origin/edge readback (not executed)"
  echo "PLAN_STEP automatic prior-SHA rollback on failed exact readback (not executed)"
  echo "RELEASE_PLAN_DONE deployed=false health_verified=false rollback_proven=false"
  exit 0
fi

print_target
echo "==> [1/6] require approval bundle + mutation opt-in policy"
require_approval_bundle >/dev/null
assert_full_sha_var APPROVED_FULL_SHA
require_mutation_opt_in

PRIOR_FULL_SHA=""
if [[ -d "${PROD_APP_PATH}/.git" ]]; then
  PRIOR_FULL_SHA="$(git -C "${PROD_APP_PATH}" rev-parse HEAD 2>/dev/null || true)"
fi

echo "==> [2/6] preflight (read-only)"
"${SCRIPT_DIR}/preflight.sh"

echo "==> [3/6] build-install"
"${SCRIPT_DIR}/build-install.sh"

if [[ "${NO_MIGRATE}" == "1" ]]; then
  echo "==> [4/6] migrate-plan SKIPPED (--no-migrate app-only contract)"
elif [[ "${SKIP_MIGRATE_PLAN}" != "1" ]]; then
  echo "==> [4/6] migrate-plan"
  "${SCRIPT_DIR}/migrate-plan.sh"
else
  echo "==> [4/6] migrate-plan SKIPPED"
fi

if [[ "${NO_MIGRATE}" == "1" ]]; then
  echo "==> [5a/6] migrate-apply PROHIBITED (--no-migrate app-only contract)"
elif [[ "${MIGRATE_APPLY_APPROVED:-0}" == "1" ]]; then
  echo "==> [5a/6] migrate-apply (explicit approval)"
  "${SCRIPT_DIR}/migrate-apply.sh"
else
  echo "==> [5a/6] migrate-apply SKIPPED (MIGRATE_APPLY_APPROVED!=1)"
fi

echo "==> [5b/6] pm2-atomic"
PM2_ARGS=()
if [[ "${ENABLE_SYSTEMD}" == "1" ]]; then
  PM2_ARGS+=(--enable-systemd)
fi
"${SCRIPT_DIR}/pm2-atomic.sh" "${PM2_ARGS[@]+"${PM2_ARGS[@]}"}"

echo "==> [6a/6] exact SHA/schema health-readback (sync cutover not claimed yet)"
set +e
"${SCRIPT_DIR}/health-readback.sh" \
  --require-exact \
  --expected-sha "${APPROVED_FULL_SHA}"
HR=$?
set -e
if [[ "${HR}" != "0" ]]; then
  echo "ERROR: exact authenticated health/readback exit=${HR}"
  if [[ "${MIGRATE_APPLY_APPROVED:-0}" == "1" ]]; then
    die "schema moved; automatic prior-app rollback is prohibited. Preserve evidence and forward-fix, or perform owner-approved full DB restore before concurrent writes"
  elif [[ "${PRODUCTION_DRY_RUN}" != "1" && "${PRIOR_FULL_SHA}" =~ ^[0-9a-f]{40}$ && "${PRIOR_FULL_SHA}" != "${APPROVED_FULL_SHA}" ]]; then
    echo "==> automatic prior-SHA rollback"
    if ! "${SCRIPT_DIR}/rollback-prior-sha.sh" \
      --expected-sha "${APPROVED_FULL_SHA}" \
      --prior-sha "${PRIOR_FULL_SHA}"; then
      die "exact health failed and automatic prior-SHA rollback also failed"
    fi
  fi
  die "exact health/readback failed; release not accepted"
fi

if [[ "${MIGRATION_APPROVED_VERSION:-}" == "008" && "${PRODUCTION_DRY_RUN}" != "1" ]]; then
  [[ "${CP0_CUTOVER_APPROVED:-0}" == "1" ]] || die "schema008 requires CP0_CUTOVER_APPROVED=1 for serialized classification/replay/sync cutover"
  [[ -n "${CP0_CUTOVER_RECEIPT:-}" ]] || die "schema008 requires CP0_CUTOVER_RECEIPT path"
  [[ -n "${CAIRN_ROOT_WRITE_TOKEN:-}" ]] || die "schema008 cutover requires CAIRN_ROOT_WRITE_TOKEN secret reference"
  mkdir -p "$(dirname "${CP0_CUTOVER_RECEIPT}")"
  umask 077
  echo "==> [6b/6] classification + receipt replay + sync-status cutover"
  node "${PROD_APP_PATH}/scripts/schema007-sync-replay.mjs" \
    --apply-classifications \
    --apply-runs \
    --apply-sync-status >"${CP0_CUTOVER_RECEIPT}"
fi

echo "==> [6c/6] final exact health + zero-backlog readback"
"${SCRIPT_DIR}/health-readback.sh" \
  --require-exact \
  --require-sync-zero \
  --expected-sha "${APPROVED_FULL_SHA}"

echo "RELEASE_PIPELINE_DONE sha=${APPROVED_FULL_SHA} approval_id=${PRODUCTION_APPROVAL_ID} dry_run=${PRODUCTION_DRY_RUN} exact_health=PASS sync_backlog_zero=PASS"
