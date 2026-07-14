#!/usr/bin/env bash
# Production build/install at approved SHA. Fail closed without approval bundle.
# Does NOT start PM2 or touch nginx. Prefer running on production checkout path.
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
    echo "WARN: building SOURCE_ROOT (dry-run or ALLOW_SOURCE_ROOT_BUILD=1); not production path"
    APP_ROOT="${SOURCE_ROOT}"
  else
    die "package.json missing at PROD_APP_PATH=${PROD_APP_PATH} (set ALLOW_SOURCE_ROOT_BUILD=1 only for dry package tests)"
  fi
fi

cd "${APP_ROOT}"

echo "==> git fetch/checkout APPROVED_FULL_SHA (preserves .env)"
if [[ -d .git ]]; then
  if maybe_dry_run "git-checkout"; then
    echo "DRY_RUN_CMD: git fetch origin && git checkout ${APPROVED_FULL_SHA}"
  else
    git fetch origin
    git checkout "${APPROVED_FULL_SHA}"
    HEAD_NOW="$(git rev-parse HEAD)"
    [[ "${HEAD_NOW}" == "${APPROVED_FULL_SHA}" ]] || die "checkout failed: HEAD=${HEAD_NOW}"
  fi
else
  die "not a git checkout at ${APP_ROOT}"
fi

echo "==> install dependencies (frozen lockfile preferred)"
if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
  run_or_dry "pnpm-install" pnpm install --frozen-lockfile
elif [[ -f package-lock.json ]]; then
  run_or_dry "npm-ci" npm ci
else
  die "no pnpm-lock.yaml/package-lock.json or pnpm missing"
fi

echo "==> build (dist/client + dist/server)"
if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
  run_or_dry "pnpm-build" pnpm build
else
  run_or_dry "npm-build" npm run build
fi

echo "BUILD_INSTALL_OK sha=${APPROVED_FULL_SHA} root=${APP_ROOT}"
