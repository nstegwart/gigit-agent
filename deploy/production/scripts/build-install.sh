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

echo "==> build (dist/client + dist/server + asset coherence assert)"
# package.json "build" chains scripts/assert-build-assets.mjs --write-manifest.
# Fail closed on SSR public /assets/* missing from dist/client (styles hash split class).
# Do not "fix" by copying stale hashed files or disabling content hashes.
if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
  run_or_dry "pnpm-build" pnpm build
else
  run_or_dry "npm-build" npm run build
fi

if [[ "${PRODUCTION_DRY_RUN}" != "1" ]]; then
  if [[ -f scripts/assert-build-assets.mjs ]]; then
    echo "==> re-assert build assets (explicit gate before PM2 start)"
    node scripts/assert-build-assets.mjs --write-manifest
    if [[ -f dist/asset-coherence-manifest.json ]]; then
      node -e '
        const m=JSON.parse(require("fs").readFileSync("dist/asset-coherence-manifest.json","utf8"));
        console.log("ASSET_COHERENCE_MANIFEST ok="+m.ok+" clientManifestHash="+String(m.clientManifestHash||"").slice(0,16)+"… assets="+m.clientAssetCount);
        if (!m.ok) process.exit(1);
      '
    fi
  else
    die "scripts/assert-build-assets.mjs missing after build — cannot prove SSR↔client asset coherence"
  fi
else
  echo "DRY_RUN_CMD: node scripts/assert-build-assets.mjs --write-manifest"
fi

echo "BUILD_INSTALL_OK sha=${APPROVED_FULL_SHA} root=${APP_ROOT}"
