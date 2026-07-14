#!/usr/bin/env bash
# Production migration APPLY — fail closed unless:
#   APPROVED_FULL_SHA + PRODUCTION_APPROVAL_ID + BACKUP_RECEIPT
#   MIGRATE_APPLY_APPROVED=1
#   fresh DB dump file exists (BACKUP_RECEIPT or DB_DUMP_PATH)
#   PRODUCTION_DRY_RUN=0 + PRODUCTION_MUTATION_APPROVED=1 for real apply
#   proven migrate entrypoint (package.json script or src/server/migrate-runner.mjs)
#
# NEVER run without owner approval. Prefer migrate-plan.sh first.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target

echo "==> migrate apply authority (fail closed)"
require_migrate_apply_authority >/dev/null
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

echo "==> resolve migrate apply entrypoint (fail closed if missing)"
resolve_migrate_entrypoint apply

echo "==> apply migrations"
if maybe_dry_run "migrate-apply"; then
  echo "DRY_RUN_CMD: ${MIGRATE_ENTRYPOINT_CMD}"
else
  run_migrate_entrypoint apply
fi

echo "MIGRATE_APPLY_OK approval_id=${PRODUCTION_APPROVAL_ID} sha=${APPROVED_FULL_SHA} entrypoint=${MIGRATE_ENTRYPOINT_KIND}"
echo "NOTE: if apply fails mid-way, DB class may be FORWARD_FIX_ONLY — do not invent schema rollback"
