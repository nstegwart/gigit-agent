#!/usr/bin/env bash
# Idempotent staging deploy: build SHA-tagged image + up app/MySQL.
# Safe to re-run; does not touch production hosts or paths.
#
# Usage:
#   ./deploy/staging/scripts/deploy.sh
#   ./deploy/staging/scripts/deploy.sh --no-cache   # clean rebuild same RELEASE_SHA
#   NO_CACHE=1 ./deploy/staging/scripts/deploy.sh
#
# Asset coherence: image build runs `pnpm build` which chains
# scripts/assert-build-assets.mjs (SSR /assets/* must exist on dist/client).
# Prefer --no-cache when fixing SSR↔client hash split for an already-tagged SHA
# instead of copying stale hashed files or disabling content hashes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

NO_CACHE="${NO_CACHE:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg: $1 (supported: --no-cache)" >&2
      exit 1
      ;;
  esac
done

print_target
require_env_file

echo "==> compose config (quiet; no secret dump)"
compose config --quiet

BUILD_ARGS=(--pull)
if [[ "${NO_CACHE}" == "1" ]]; then
  BUILD_ARGS+=(--no-cache)
  echo "==> build image cairn-tm-v3-app:${RELEASE_SHA} (NO_CACHE=1 clean rebuild)"
else
  echo "==> build image cairn-tm-v3-app:${RELEASE_SHA}"
fi
compose build "${BUILD_ARGS[@]}"

echo "==> up (detached, recreate if needed)"
compose up -d --remove-orphans --force-recreate

echo "==> status"
compose ps

# Best-effort: record image-side coherence marker for operators (no secret dump).
# The authoritative fail-closed gate already ran inside Dockerfile `pnpm build`.
if command -v docker >/dev/null 2>&1 || command -v sudo >/dev/null 2>&1; then
  echo "==> asset coherence note (image build asserted; host dist optional)"
  if [[ -f "${SOURCE_ROOT}/scripts/assert-build-assets.mjs" && -d "${SOURCE_ROOT}/dist/client/assets" ]]; then
    (
      cd "${SOURCE_ROOT}"
      node scripts/assert-build-assets.mjs --write-manifest || true
    )
    if [[ -f "${SOURCE_ROOT}/dist/asset-coherence-manifest.json" ]]; then
      node -e '
        const m=require(process.argv[1]);
        console.log("ASSET_COHERENCE_MANIFEST host_ok="+m.ok+" clientManifestHash="+String(m.clientManifestHash||"").slice(0,16)+"… assets="+m.clientAssetCount);
      ' "${SOURCE_ROOT}/dist/asset-coherence-manifest.json" || true
    fi
  else
    echo "NOTE: host dist/ not present — image-layer pnpm build + assert is SSOT for this deploy"
  fi
fi

echo "DEPLOY_OK release_sha=${RELEASE_SHA} bind=127.0.0.1:33211->3210 db=cairn_tm_v3_staging container=cairn-tm-v3-mysql no_cache=${NO_CACHE}"
echo "NOTE: compose 'healthy' is LIVENESS only (unauth healthz 401|200|503). 503 is NOT release PASS."
echo "RELEASE acceptance: authenticated GET /api/healthz → HTTP 200 with deployedSha/schemaVersion/migration history + required tables."
echo "Next: wait for container healthy (listen), then auth probe http://127.0.0.1:33211/api/healthz (unauth expect 401)."
