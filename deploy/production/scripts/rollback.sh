#!/usr/bin/env bash
# Production rollback helper — app prior SHA + DB forward-fix classification.
# Fail closed without approval bundle for any mutating mode.
#
# Usage:
#   ./rollback.sh --classify
#       # print DB/app rollback class only (needs SCHEMA_MOVED / HAS_DB_DUMP env)
#   ./rollback.sh --to-sha <40-char-sha>
#       # checkout prior SHA, install, build, pm2 atomic restart
#   ./rollback.sh --stop
#       # pm2 stop (returns 502 by design — traffic kill)
#   ./rollback.sh --classify-and-stop
#
# DB schema rollback is NEVER automated here. Class DB_FORWARD_FIX_ONLY when
# schema moved without restorable dump (proven gap on 502-r3 host).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

MODE=""
TO_SHA=""

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \?//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --classify) MODE=classify; shift ;;
    --to-sha) MODE=to_sha; TO_SHA="${2:-}"; shift 2 ;;
    --stop) MODE=stop; shift ;;
    --classify-and-stop) MODE=classify_stop; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

if [[ -z "${MODE}" ]]; then
  usage
fi

print_target

classify_now() {
  export PRIOR_FULL_SHA="${TO_SHA:-${PRIOR_FULL_SHA:-}}"
  export SCHEMA_MOVED="${SCHEMA_MOVED:-0}"
  export HAS_DB_DUMP="${HAS_DB_DUMP:-0}"
  export DUMP_RESTORABLE="${DUMP_RESTORABLE:-0}"
  # Infer dump presence from BACKUP_RECEIPT if set
  if [[ -n "${BACKUP_RECEIPT:-}" && -f "${BACKUP_RECEIPT}" ]]; then
    export HAS_DB_DUMP=1
  fi
  node "${GATES_JS}" classify-rollback
}

case "${MODE}" in
  classify)
    classify_now
    ;;
  classify_stop)
    classify_now
    require_approval_bundle >/dev/null
    require_mutation_opt_in
    if maybe_dry_run "pm2-stop"; then
      echo "DRY_RUN_CMD: pm2 stop ${PROD_APP_NAME}"
    else
      require_cmd pm2
      pm2 stop "${PROD_APP_NAME}" || true
      pm2 save || true
    fi
    echo "ROLLBACK_STOP_OK (edge will 502 until start)"
    ;;
  stop)
    require_approval_bundle >/dev/null
    require_mutation_opt_in
    if maybe_dry_run "pm2-stop"; then
      echo "DRY_RUN_CMD: pm2 stop ${PROD_APP_NAME}"
    else
      require_cmd pm2
      pm2 stop "${PROD_APP_NAME}" || true
      pm2 save || true
    fi
    echo "ROLLBACK_STOP_OK"
    ;;
  to_sha)
    require_approval_bundle >/dev/null
    require_mutation_opt_in
    if [[ -z "${TO_SHA}" || ! "${TO_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
      die "--to-sha requires full 40-char lowercase hex git SHA"
    fi
    export PRIOR_FULL_SHA="${TO_SHA}"
    CLASS_JSON="$(classify_now)"
    echo "ROLLBACK_CLASS_JSON=${CLASS_JSON}"
    if echo "${CLASS_JSON}" | grep -q 'DB_FORWARD_FIX_ONLY'; then
      echo "WARN: DB class is FORWARD_FIX_ONLY — app will roll back; DB schema will NOT be auto-reverted"
    fi

    APP_ROOT="${PROD_APP_PATH}"
    [[ -d "${APP_ROOT}/.git" ]] || die "no git at ${APP_ROOT}"

    # Pin approved SHA to the rollback target for nested scripts
    export APPROVED_FULL_SHA="${TO_SHA}"

    if maybe_dry_run "rollback-to-sha"; then
      echo "DRY_RUN_CMD: git checkout ${TO_SHA} && install && build && pm2-atomic"
    else
      git -C "${APP_ROOT}" fetch origin
      git -C "${APP_ROOT}" checkout "${TO_SHA}"
      (
        cd "${APP_ROOT}"
        if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
          pnpm install --frozen-lockfile
          pnpm build
        else
          npm ci
          npm run build
        fi
      )
      # restart PM2 with rolled-back tree
      PREFLIGHT_REQUIRE_HEAD_MATCH=1 \
        "${SCRIPT_DIR}/pm2-atomic.sh"
    fi
    echo "PRIOR_SHA_ROLLBACK_APPLIED sha=${TO_SHA}"
    echo "NEXT: health-readback.sh; DB restore is MANUAL if class APP_PLUS_DB_RESTORE"
    ;;
esac
