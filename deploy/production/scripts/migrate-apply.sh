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

echo "==> verify exact migration artifact + sole pending item"
[[ "${MIGRATION_APPROVED_VERSION:-}" == "008" ]] || die "this cutover accepts MIGRATION_APPROVED_VERSION=008 only"
MIGRATION_FILE="migrations/${MIGRATION_APPROVED_VERSION}_cp0_control_plane.sql"
[[ -f "${MIGRATION_FILE}" ]] || die "approved migration file missing: ${MIGRATION_FILE}"
OBSERVED_MIGRATION_SHA="$(sha256sum "${MIGRATION_FILE}" | awk '{print $1}')"
[[ "${OBSERVED_MIGRATION_SHA}" == "${MIGRATION_APPROVED_SHA256:-}" ]] || die "approved migration sha256 mismatch"
PLAN_JSON="$(node src/server/migrate-runner.mjs plan --json)"
PLAN_JSON="${PLAN_JSON}" \
MIGRATION_APPROVED_VERSION="${MIGRATION_APPROVED_VERSION}" \
MIGRATION_APPROVED_SHA256="${MIGRATION_APPROVED_SHA256}" \
node --input-type=module -e '
const body = JSON.parse(process.env.PLAN_JSON || "{}")
const plan = body.plan || {}
const pending = (plan.items || []).filter((item) => item.action === "APPLY")
const expectedVersion = process.env.MIGRATION_APPROVED_VERSION
const expectedSha = process.env.MIGRATION_APPROVED_SHA256
if (plan.status !== "READY" || pending.length !== 1 || pending[0]?.version !== expectedVersion || pending[0]?.expectedSha256 !== expectedSha) {
  console.error("ERROR: migration plan is not exactly the approved sole pending artifact")
  process.exit(2)
}
'

echo "==> apply migrations"
if maybe_dry_run "migrate-apply"; then
  echo "DRY_RUN_CMD: ${MIGRATE_ENTRYPOINT_CMD}"
else
  run_migrate_entrypoint apply
fi

if [[ "${PRODUCTION_DRY_RUN}" != "1" ]]; then
  echo "==> exact migration history readback"
  STATUS_JSON="$(node src/server/migrate-runner.mjs status --json)"
  STATUS_JSON="${STATUS_JSON}" \
  MIGRATION_APPROVED_VERSION="${MIGRATION_APPROVED_VERSION}" \
  MIGRATION_APPROVED_SHA256="${MIGRATION_APPROVED_SHA256}" \
  node --input-type=module -e '
const body = JSON.parse(process.env.STATUS_JSON || "{}")
const plan = body.plan || {}
const schema = body.schema || {}
const version = process.env.MIGRATION_APPROVED_VERSION
const sha = process.env.MIGRATION_APPROVED_SHA256
const item = (plan.items || []).find((candidate) => candidate.version === version)
if (plan.status !== "IDEMPOTENT_NOOP" || schema.schemaVersion !== version || item?.action !== "SKIP_ALREADY_APPLIED" || item?.expectedSha256 !== sha) {
  console.error("ERROR: exact migration history readback failed")
  process.exit(2)
}
'
fi

echo "MIGRATE_APPLY_OK approval_id=${PRODUCTION_APPROVAL_ID} release_sha=${APPROVED_FULL_SHA} migration_version=${MIGRATION_APPROVED_VERSION} migration_sha256=${MIGRATION_APPROVED_SHA256} target_host=${MIGRATION_TARGET_HOST} target_database=${MIGRATION_TARGET_DATABASE} entrypoint=${MIGRATE_ENTRYPOINT_KIND}"
echo "NOTE: if apply fails mid-way, DB class may be FORWARD_FIX_ONLY — do not invent schema rollback"
