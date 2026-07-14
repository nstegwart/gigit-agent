#!/usr/bin/env bash
# Production health / readback probes. Read-only HTTP. Never restarts.
#
# Liveness: loopback HTTP 401|200|503 proves listen.
# Release PASS: HTTP 200 + deployedSha === APPROVED_FULL_SHA (needs auth token if endpoint is authed).
#
# Usage:
#   APPROVED_FULL_SHA=... [CAIRN_HEALTH_BEARER=...] ./deploy/production/scripts/health-readback.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target
require_cmd curl
require_cmd node

# Approval SHA optional for pure liveness; required for release-pass claim
APPROVED_FULL_SHA="${APPROVED_FULL_SHA:-}"

LOOP_URL="http://${PROD_LISTEN_HOST}:${PROD_LISTEN_PORT}/api/healthz"
ORIGIN_URL="https://127.0.0.1/api/healthz"
EDGE_URL="https://${PROD_PUBLIC_HOST}/api/healthz"

AUTH_ARGS=()
if [[ -n "${CAIRN_HEALTH_BEARER:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${CAIRN_HEALTH_BEARER}")
fi

probe() {
  local label="$1"
  local url="$2"
  shift 2
  local code body_file
  body_file="$(mktemp)"
  code="$(curl -sk -o "${body_file}" -w '%{http_code}' --connect-timeout 5 --max-time 15 "$@" "${url}" 2>/dev/null || echo "000")"
  echo "${label}_HTTP=${code}"
  # never dump full body if it might contain secrets — print sha fields only via node
  if [[ -s "${body_file}" ]]; then
    node -e "
const fs=require('fs');
const t=fs.readFileSync(process.argv[1],'utf8');
try {
  const j=JSON.parse(t);
  const pick={status:j.status,deployedSha:j.deployedSha,schemaVersion:j.schemaVersion||j.schema,migration:j.migration};
  console.log(process.argv[2]+'_BODY='+JSON.stringify(pick));
} catch {
  console.log(process.argv[2]+'_BODY_LEN='+t.length);
}
" "${body_file}" "${label}"
  fi
  # export for classification via files
  echo "${code}" >"${body_file}.code"
  echo "${body_file}"
}

echo "==> loopback ${LOOP_URL}"
LOOP_BODY_FILE="$(probe LOOPBACK "${LOOP_URL}" "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}")"
LOOP_CODE="$(cat "${LOOP_BODY_FILE}.code" 2>/dev/null || echo 000)"

echo "==> origin Host header (local nginx)"
ORIGIN_BODY_FILE="$(probe ORIGIN "${ORIGIN_URL}" -H "Host: ${PROD_PUBLIC_HOST}" "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}")"
ORIGIN_CODE="$(cat "${ORIGIN_BODY_FILE}.code" 2>/dev/null || echo 000)"

echo "==> public edge"
EDGE_BODY_FILE="$(probe EDGE "${EDGE_URL}" "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}")"
EDGE_CODE="$(cat "${EDGE_BODY_FILE}.code" 2>/dev/null || echo 000)"

# Classify with gates.mjs
export LOOP_CODE ORIGIN_CODE EDGE_CODE APPROVED_FULL_SHA
export LOOP_BODY_FILE
GATES_JS="${GATES_JS}" node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { classifyHealthReadback } = await import(pathToFileURL(process.env.GATES_JS).href);
let body = {};
try {
  const t = readFileSync(process.env.LOOP_BODY_FILE, 'utf8');
  body = JSON.parse(t);
} catch { /* unauth may be non-json */ }
const loop = Number(process.env.LOOP_CODE);
const r = classifyHealthReadback({
  loopbackStatus: Number.isFinite(loop) ? loop : null,
  originStatus: Number(process.env.ORIGIN_CODE) || null,
  edgeStatus: Number(process.env.EDGE_CODE) || null,
  loopbackBody: body,
  approvedFullSha: process.env.APPROVED_FULL_SHA || undefined,
});
console.log('HEALTH_CLASS=' + JSON.stringify(r));
process.exit(r.liveness ? 0 : 2);
"

# cleanup temp bodies (codes only were adjacent)
rm -f "${LOOP_BODY_FILE}" "${LOOP_BODY_FILE}.code" \
  "${ORIGIN_BODY_FILE}" "${ORIGIN_BODY_FILE}.code" \
  "${EDGE_BODY_FILE}" "${EDGE_BODY_FILE}.code" 2>/dev/null || true

echo "HEALTH_READBACK_DONE"
