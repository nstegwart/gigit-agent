#!/usr/bin/env bash
# Production migration APPLY — fail closed unless:
#   APPROVED_FULL_SHA + PRODUCTION_APPROVAL_ID + BACKUP_RECEIPT
#   MIGRATE_APPLY_APPROVED=1
#   fresh DB dump file exists (BACKUP_RECEIPT or DB_DUMP_PATH)
#   PRODUCTION_DRY_RUN=0 + PRODUCTION_MUTATION_APPROVED=1 for real apply
#   proven migrate entrypoint (package.json script or src/server/migrate-runner.mjs)
#   exact MIGRATION_APPROVED_VERSION (manifest NNN) + SHA256 + DB/dump binding
#
# ONE-STEP ONLY: authorizes/applies the exact next pending migration matching the
# approved version. Never applies all remaining migrations. Never skips versions.
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

echo "==> verify exact migration artifact + next pending item (one-step)"
[[ -n "${MIGRATION_APPROVED_VERSION:-}" ]] || die "MIGRATION_APPROVED_VERSION required (exact manifest NNN)"
[[ "${MIGRATION_APPROVED_VERSION}" =~ ^[0-9]{3}$ ]] || die "MIGRATION_APPROVED_VERSION must be zero-padded NNN"
[[ -n "${MIGRATION_APPROVED_SHA256:-}" ]] || die "MIGRATION_APPROVED_SHA256 required"
[[ "${MIGRATION_APPROVED_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die "MIGRATION_APPROVED_SHA256 must be lowercase 64-hex"

# Resolve the single on-disk SQL for the approved version (filename from manifest, not hard-coded).
shopt -s nullglob
MIGRATION_CANDIDATES=(migrations/"${MIGRATION_APPROVED_VERSION}"_*.sql)
shopt -u nullglob
[[ ${#MIGRATION_CANDIDATES[@]} -eq 1 ]] || die "expected exactly one migrations/${MIGRATION_APPROVED_VERSION}_*.sql (found ${#MIGRATION_CANDIDATES[@]})"
MIGRATION_FILE="${MIGRATION_CANDIDATES[0]}"
[[ -f "${MIGRATION_FILE}" ]] || die "approved migration file missing: ${MIGRATION_FILE}"
OBSERVED_MIGRATION_SHA="$(sha256sum "${MIGRATION_FILE}" | awk '{print $1}')"
[[ "${OBSERVED_MIGRATION_SHA}" == "${MIGRATION_APPROVED_SHA256}" ]] || die "approved migration sha256 mismatch for ${MIGRATION_FILE}"

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
// One-step: first pending APPLY must be the exact approved artifact (may have later pendings).
// Refuse empty pending, wrong next version (skip), or sha mismatch. Never require sole-pending.
if (plan.status !== "READY" || pending.length < 1 || pending[0]?.version !== expectedVersion || pending[0]?.expectedSha256 !== expectedSha) {
  console.error("ERROR: migration plan next pending is not the exact approved one-step artifact")
  console.error(JSON.stringify({
    status: plan.status,
    nextPending: pending[0] ? { version: pending[0].version, expectedSha256: pending[0].expectedSha256 } : null,
    approved: { version: expectedVersion, expectedSha256: expectedSha },
    pendingCount: pending.length,
  }))
  process.exit(2)
}
'

echo "==> apply one approved next migration (through=${MIGRATION_APPROVED_VERSION})"
# Production runner enforces one-step via MIGRATION_APPROVED_VERSION + ProductionMigrationAuthority
# (throughVersion = approved). CLI also accepts explicit --through when using node-runner.
if maybe_dry_run "migrate-apply"; then
  echo "DRY_RUN_CMD: ${MIGRATE_ENTRYPOINT_CMD}  # one-step through=${MIGRATION_APPROVED_VERSION}"
else
  case "${MIGRATE_ENTRYPOINT_KIND}" in
    pnpm)
      # pnpm forwards script args without a bare end-of-options separator.
      # A separator between the script name and --through is forwarded into
      # migrate-cli argv and fails parse with "Unknown flag: --" before apply.
      # npm still needs its run-script separator; node-runner takes flags directly.
      pnpm migrate:apply --through "${MIGRATION_APPROVED_VERSION}" --lifecycle-mapping g0
      ;;
    npm)
      npm run migrate:apply -- --through "${MIGRATION_APPROVED_VERSION}" --lifecycle-mapping g0
      ;;
    node-runner)
      node src/server/migrate-runner.mjs apply --through "${MIGRATION_APPROVED_VERSION}" --lifecycle-mapping g0
      ;;
    *)
      die "MIGRATE_ENTRYPOINT_INTERNAL: unknown kind=${MIGRATE_ENTRYPOINT_KIND}"
      ;;
  esac
fi

if [[ "${PRODUCTION_DRY_RUN}" != "1" ]]; then
  echo "==> exact migration history readback (approved version applied; later pendings may remain)"
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
const applied = schema.appliedVersions || []
// One-step readback: approved version must be SKIP_ALREADY_APPLIED with matching sha.
// Do NOT require IDEMPOTENT_NOOP (later manifest versions may still be pending).
if (item?.action !== "SKIP_ALREADY_APPLIED" || item?.expectedSha256 !== sha || !applied.includes(version)) {
  console.error("ERROR: exact migration history readback failed for approved one-step version")
  console.error(JSON.stringify({
    itemAction: item?.action,
    itemSha: item?.expectedSha256,
    schemaVersion: schema.schemaVersion,
    applied,
    planStatus: plan.status,
  }))
  process.exit(2)
}
'
fi

echo "MIGRATE_APPLY_OK approval_id=${PRODUCTION_APPROVAL_ID} release_sha=${APPROVED_FULL_SHA} migration_version=${MIGRATION_APPROVED_VERSION} migration_sha256=${MIGRATION_APPROVED_SHA256} target_host=${MIGRATION_TARGET_HOST} target_database=${MIGRATION_TARGET_DATABASE} entrypoint=${MIGRATE_ENTRYPOINT_KIND} one_step=1"
echo "NOTE: if apply fails mid-way, DB class may be FORWARD_FIX_ONLY — do not invent schema rollback"
