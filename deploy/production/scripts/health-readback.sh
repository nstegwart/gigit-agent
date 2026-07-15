#!/usr/bin/env bash
# Production health / readback probes. Read-only HTTP. Never restarts.
#
# Liveness: loopback HTTP 401|200|503 proves listen.
# Release PASS: HTTP 200 + deployedSha === APPROVED_FULL_SHA (needs auth token if endpoint is authed).
#
# Usage:
#   APPROVED_FULL_SHA=... [CAIRN_HEALTH_TOKEN=...] ./deploy/production/scripts/health-readback.sh
#   ./deploy/production/scripts/health-readback.sh --require-exact --require-sync-zero \
#     --expected-sha <40-char-lowercase-sha>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

REQUIRE_EXACT=0
REQUIRE_SYNC_ZERO=0
EXPECTED_SHA_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-exact) REQUIRE_EXACT=1; shift ;;
    --require-sync-zero) REQUIRE_SYNC_ZERO=1; shift ;;
    --expected-sha) EXPECTED_SHA_ARG="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown arg: $1" ;;
  esac
done

if [[ -n "${EXPECTED_SHA_ARG}" ]]; then
  if [[ -n "${APPROVED_FULL_SHA:-}" && "${APPROVED_FULL_SHA}" != "${EXPECTED_SHA_ARG}" ]]; then
    die "--expected-sha conflicts with APPROVED_FULL_SHA"
  fi
  APPROVED_FULL_SHA="${EXPECTED_SHA_ARG}"
fi
if [[ "${REQUIRE_EXACT}" == "1" ]]; then
  assert_full_sha_var APPROVED_FULL_SHA
  [[ -n "${CAIRN_HEALTH_TOKEN:-${CAIRN_HEALTH_BEARER:-}}" ]] || die "exact readback requires CAIRN_HEALTH_TOKEN env reference"
fi

print_target
require_cmd curl
require_cmd node

# Approval SHA optional for pure liveness; required for release-pass claim
APPROVED_FULL_SHA="${APPROVED_FULL_SHA:-}"

LOOP_URL="http://${PROD_LISTEN_HOST}:${PROD_LISTEN_PORT}/api/healthz"
ORIGIN_URL="https://127.0.0.1/api/healthz"
EDGE_URL="https://${PROD_PUBLIC_HOST}/api/healthz"

AUTH_ARGS=()
HEALTH_TOKEN="${CAIRN_HEALTH_TOKEN:-${CAIRN_HEALTH_BEARER:-}}"
if [[ -n "${HEALTH_TOKEN}" ]]; then
  # Production read/write contract uses X-Cairn-Token. Keep the legacy env-name
  # fallback above only so an existing secret reference does not need rotation.
  AUTH_ARGS=(-H "X-Cairn-Token: ${HEALTH_TOKEN}")
fi

probe() {
  local label="$1"
  local url="$2"
  shift 2
  local code body_file
  body_file="$(mktemp)"
  code="$(curl -sk -o "${body_file}" -w '%{http_code}' --connect-timeout 5 --max-time 15 "$@" "${url}" 2>/dev/null || echo "000")"
  echo "${label}_HTTP=${code}" >&2
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
" "${body_file}" "${label}" >&2
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
export LOOP_BODY_FILE ORIGIN_BODY_FILE EDGE_BODY_FILE REQUIRE_EXACT REQUIRE_SYNC_ZERO
GATES_JS="${GATES_JS}" node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { classifyHealthReadback } = await import(pathToFileURL(process.env.GATES_JS).href);
const read = (name) => {
  try { return JSON.parse(readFileSync(process.env[name], 'utf8')); }
  catch { return {}; }
};
const body = read('LOOP_BODY_FILE');
const originBody = read('ORIGIN_BODY_FILE');
const edgeBody = read('EDGE_BODY_FILE');
const loop = Number(process.env.LOOP_CODE);
const r = classifyHealthReadback({
  loopbackStatus: Number.isFinite(loop) ? loop : null,
  originStatus: Number(process.env.ORIGIN_CODE) || null,
  edgeStatus: Number(process.env.EDGE_CODE) || null,
  loopbackBody: body,
  approvedFullSha: process.env.APPROVED_FULL_SHA || undefined,
});
console.log('HEALTH_CLASS=' + JSON.stringify(r));
if (process.env.REQUIRE_EXACT !== '1') process.exit(r.liveness ? 0 : 2);
const expected = process.env.APPROVED_FULL_SHA;
const bodies = [body, originBody, edgeBody];
const statusExact = [process.env.LOOP_CODE, process.env.ORIGIN_CODE, process.env.EDGE_CODE]
  .every((code) => Number(code) === 200);
const bodyExact = bodies.every((item) =>
  item?.deployedSha === expected &&
  item?.release?.match === true &&
  item?.schema?.match === true &&
  !['BLOCKED', 'CHECKSUM_MISMATCH', 'UNKNOWN'].includes(item?.migration?.status)
);
const syncZero = bodies.every((item) =>
  item?.sync?.status === 'IN_SYNC' &&
  item?.sync?.effectiveBacklog === 0 &&
  item?.sync?.zeroBacklogProven === true
);
const exact = r.releasePass && statusExact && bodyExact &&
  (process.env.REQUIRE_SYNC_ZERO !== '1' || syncZero);
console.log('HEALTH_EXACT=' + JSON.stringify({
  ok: exact,
  statusExact,
  bodyExact,
  syncZero: process.env.REQUIRE_SYNC_ZERO === '1' ? syncZero : null,
  expectedSha: expected,
}));
process.exit(exact ? 0 : 2);
"

# cleanup temp bodies (codes only were adjacent)
rm -f "${LOOP_BODY_FILE}" "${LOOP_BODY_FILE}.code" \
  "${ORIGIN_BODY_FILE}" "${ORIGIN_BODY_FILE}.code" \
  "${EDGE_BODY_FILE}" "${EDGE_BODY_FILE}.code" 2>/dev/null || true

echo "HEALTH_READBACK_DONE"
