#!/usr/bin/env bash
# Automatic app-only rollback wrapper used when exact release readback fails.
# Dry-run is read-only and never claims rollback proof.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

DRY_RUN_FLAG=0
EXPECTED_SHA=""
PRIOR_SHA="${PRIOR_FULL_SHA:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN_FLAG=1; PRODUCTION_DRY_RUN=1; shift ;;
    --expected-sha) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --prior-sha) PRIOR_SHA="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

APPROVED_FULL_SHA="${EXPECTED_SHA}"
assert_full_sha_var APPROVED_FULL_SHA

if [[ -z "${PRIOR_SHA}" ]]; then
  if [[ -d "${PROD_APP_PATH}/.git" ]]; then
    CANDIDATE="$(git -C "${PROD_APP_PATH}" rev-parse HEAD 2>/dev/null || true)"
    if [[ "${CANDIDATE}" != "${EXPECTED_SHA}" ]]; then PRIOR_SHA="${CANDIDATE}"; fi
  fi
fi
if [[ -z "${PRIOR_SHA}" && "${DRY_RUN_FLAG}" == "1" ]]; then
  PRIOR_SHA="$(git -C "${SOURCE_ROOT}" rev-parse "${EXPECTED_SHA}^" 2>/dev/null || true)"
fi
if [[ ! "${PRIOR_SHA}" =~ ^[0-9a-f]{40}$ || "${PRIOR_SHA}" == "${EXPECTED_SHA}" ]]; then
  die "distinct prior SHA could not be resolved"
fi

print_target
echo "ROLLBACK_TARGET expected_failed_sha=${EXPECTED_SHA} prior_sha=${PRIOR_SHA}"

if [[ "${DRY_RUN_FLAG}" == "1" ]]; then
  echo "DRY_RUN_CMD: rollback.sh --to-sha ${PRIOR_SHA}"
  echo "DRY_RUN_CMD: health-readback.sh --require-exact --require-sync-zero --expected-sha ${PRIOR_SHA}"
  echo "ROLLBACK_PLAN_DONE applied=false health_verified=false rollback_proven=false"
  exit 0
fi

require_approval_bundle >/dev/null
require_mutation_opt_in
export PRIOR_FULL_SHA="${PRIOR_SHA}"
"${SCRIPT_DIR}/rollback.sh" --to-sha "${PRIOR_SHA}"
APPROVED_FULL_SHA="${PRIOR_SHA}" \
  "${SCRIPT_DIR}/health-readback.sh" \
    --require-exact \
    --require-sync-zero \
    --expected-sha "${PRIOR_SHA}"
echo "ROLLBACK_PRIOR_SHA_OK prior_sha=${PRIOR_SHA} exact_health=PASS sync_backlog_zero=PASS"
