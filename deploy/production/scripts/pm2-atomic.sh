#!/usr/bin/env bash
# Atomic PM2 start/restart + save + optional systemd enable for production.
# Fail closed without approval bundle. Does not checkout/build (use build-install.sh).
#
# Dry-run is DEFAULT-ON (PRODUCTION_DRY_RUN defaults to 1). Laptop dry-run does NOT
# require the pm2 binary — command gate runs only on the real mutation branch.
# Real mutation needs: PRODUCTION_DRY_RUN=0 + PRODUCTION_MUTATION_APPROVED=1 + approval triple.
#
# Usage:
#   APPROVED_FULL_SHA=... PRODUCTION_APPROVAL_ID=... BACKUP_RECEIPT=... \
#     ./deploy/production/scripts/pm2-atomic.sh [--enable-systemd]
#
# Contract (502-r3):
#   pm2 start npm --name cairn-taskmanager --cwd <path> -- run preview -- --port 3210 --host 127.0.0.1
#   pm2 save
#   sudo systemctl enable --now pm2-gian.devx.service
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

ENABLE_SYSTEMD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-systemd) ENABLE_SYSTEMD=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

print_target
require_approval_bundle >/dev/null
assert_full_sha_var APPROVED_FULL_SHA
require_mutation_opt_in

APP_ROOT="${PROD_APP_PATH}"
if [[ ! -d "${APP_ROOT}" || ! -f "${APP_ROOT}/package.json" ]]; then
  if [[ -f "${SOURCE_ROOT}/package.json" && ( "${PRODUCTION_DRY_RUN}" == "1" || "${ALLOW_SOURCE_ROOT_BUILD:-0}" == "1" ) ]]; then
    echo "WARN: PROD_APP_PATH missing/incomplete; using SOURCE_ROOT for dry-run/package test (ALLOW_SOURCE_ROOT_BUILD=${ALLOW_SOURCE_ROOT_BUILD:-0})"
    APP_ROOT="${SOURCE_ROOT}"
  else
    die "PROD_APP_PATH missing or package.json absent: ${PROD_APP_PATH}"
  fi
fi

# Optional: refuse start if HEAD != approved (set PREFLIGHT_REQUIRE_HEAD_MATCH=1)
if [[ -d "${APP_ROOT}/.git" ]]; then
  HEAD_NOW="$(git -C "${APP_ROOT}" rev-parse HEAD)"
  if [[ "${HEAD_NOW}" != "${APPROVED_FULL_SHA}" ]]; then
    if [[ "${PREFLIGHT_REQUIRE_HEAD_MATCH:-1}" == "1" && "${PRODUCTION_DRY_RUN}" != "1" ]]; then
      die "HEAD ${HEAD_NOW} !== APPROVED_FULL_SHA ${APPROVED_FULL_SHA}"
    fi
    if [[ "${HEAD_NOW}" != "${APPROVED_FULL_SHA}" ]]; then
      echo "WARN: HEAD !== APPROVED_FULL_SHA (dry-run or PREFLIGHT_REQUIRE_HEAD_MATCH=0)"
    fi
  fi
fi

echo "==> atomic PM2 replace ${PROD_APP_NAME}"
if maybe_dry_run "pm2-atomic"; then
  echo "DRY_RUN_CMD: pm2 delete ${PROD_APP_NAME} || true"
  echo "DRY_RUN_CMD: pm2 start npm --name ${PROD_APP_NAME} --cwd ${APP_ROOT} -- run preview -- --port ${PROD_LISTEN_PORT} --host ${PROD_LISTEN_HOST}"
  echo "DRY_RUN_CMD: pm2 save"
  # pm2 binary intentionally NOT required on dry-run path (laptop package exercise)
else
  require_cmd pm2
  # delete may fail if not running — ok
  pm2 delete "${PROD_APP_NAME}" 2>/dev/null || true
  pm2 start npm \
    --name "${PROD_APP_NAME}" \
    --cwd "${APP_ROOT}" \
    -- run preview -- --port "${PROD_LISTEN_PORT}" --host "${PROD_LISTEN_HOST}"
  pm2 save
  pm2 describe "${PROD_APP_NAME}" || true
fi

if [[ "${ENABLE_SYSTEMD}" == "1" ]]; then
  echo "==> systemd enable --now ${PROD_SYSTEMD_UNIT}"
  if maybe_dry_run "systemd-enable"; then
    echo "DRY_RUN_CMD: sudo systemctl enable --now ${PROD_SYSTEMD_UNIT}"
  else
    require_cmd systemctl
    sudo systemctl enable --now "${PROD_SYSTEMD_UNIT}"
    systemctl is-enabled "${PROD_SYSTEMD_UNIT}" || true
    systemctl is-active "${PROD_SYSTEMD_UNIT}" || true
  fi
else
  echo "NOTE: skipped systemd (pass --enable-systemd to enable ${PROD_SYSTEMD_UNIT})"
fi

echo "PM2_ATOMIC_OK name=${PROD_APP_NAME} port=${PROD_LISTEN_PORT} sha=${APPROVED_FULL_SHA} dry_run=${PRODUCTION_DRY_RUN}"
echo "NEXT: ./deploy/production/scripts/health-readback.sh"
