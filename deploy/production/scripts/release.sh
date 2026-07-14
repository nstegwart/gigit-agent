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
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

ENABLE_SYSTEMD=0
SKIP_MIGRATE_PLAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-systemd) ENABLE_SYSTEMD=1; shift ;;
    --skip-migrate-plan) SKIP_MIGRATE_PLAN=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

print_target
echo "==> [1/6] require approval bundle + mutation opt-in policy"
require_approval_bundle >/dev/null
assert_full_sha_var APPROVED_FULL_SHA
require_mutation_opt_in

echo "==> [2/6] preflight (read-only)"
"${SCRIPT_DIR}/preflight.sh"

echo "==> [3/6] build-install"
"${SCRIPT_DIR}/build-install.sh"

if [[ "${SKIP_MIGRATE_PLAN}" != "1" ]]; then
  echo "==> [4/6] migrate-plan"
  "${SCRIPT_DIR}/migrate-plan.sh"
else
  echo "==> [4/6] migrate-plan SKIPPED"
fi

if [[ "${MIGRATE_APPLY_APPROVED:-0}" == "1" ]]; then
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

echo "==> [6/6] health-readback"
set +e
"${SCRIPT_DIR}/health-readback.sh"
HR=$?
set -e
if [[ "${HR}" != "0" ]]; then
  echo "WARN: health-readback exit=${HR} (liveness may still be recovering)"
  if [[ "${RELEASE_REQUIRE_HEALTH:-1}" == "1" && "${PRODUCTION_DRY_RUN}" != "1" ]]; then
    die "health-readback failed and RELEASE_REQUIRE_HEALTH=1"
  fi
fi

echo "RELEASE_PIPELINE_DONE sha=${APPROVED_FULL_SHA} approval_id=${PRODUCTION_APPROVAL_ID} dry_run=${PRODUCTION_DRY_RUN}"
