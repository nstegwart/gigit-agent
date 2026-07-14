#!/usr/bin/env bash
# Production migration PLAN only (read-only plan). Never applies DDL.
# Requires approval bundle so ops only plan against an approved release intent.
# Validates migrate entrypoint exists BEFORE dry-run print or real run (fail closed).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target
require_approval_bundle >/dev/null
assert_full_sha_var APPROVED_FULL_SHA
require_mutation_opt_in

APP_ROOT="${PROD_APP_PATH}"
if [[ ! -f "${APP_ROOT}/package.json" ]]; then
  if [[ -f "${SOURCE_ROOT}/package.json" && ( "${PRODUCTION_DRY_RUN}" == "1" || "${ALLOW_SOURCE_ROOT_BUILD:-0}" == "1" ) ]]; then
    APP_ROOT="${SOURCE_ROOT}"
  else
    die "package.json missing at ${PROD_APP_PATH}"
  fi
fi
cd "${APP_ROOT}"

echo "==> resolve migrate plan entrypoint (fail closed if missing)"
resolve_migrate_entrypoint plan

echo "==> migrate plan (no apply)"
if maybe_dry_run "migrate-plan"; then
  echo "DRY_RUN_CMD: ${MIGRATE_ENTRYPOINT_CMD}"
else
  run_migrate_entrypoint plan
fi

echo "MIGRATE_PLAN_OK (no schema changes applied) entrypoint=${MIGRATE_ENTRYPOINT_KIND}"
echo "To apply: MIGRATE_APPLY_APPROVED=1 + fresh DB dump → migrate-apply.sh"
