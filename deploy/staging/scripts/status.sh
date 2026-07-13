#!/usr/bin/env bash
# Idempotent status probe for the staging compose stack (no secrets printed).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target

echo "==> containers (name filter)"
if docker info >/dev/null 2>&1; then
  D=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  D=(sudo -n docker)
else
  D=(sudo docker)
fi
"${D[@]}" ps -a --filter name=cairn-tm-v3 --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true

if [[ -f "${ENV_FILE}" ]]; then
  echo "==> compose ps"
  compose ps || true
fi

echo "==> loopback listener 33211"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E ':33211\b' || echo "NO_LISTENER_33211"
else
  netstat -lntp 2>/dev/null | grep -E ':33211\b' || echo "NO_LISTENER_33211"
fi

echo "==> health probe (unauth LIVENESS — expect 401 when app is up; 503=up-but-not-ready)"
echo "NOTE: unauth 401/503 and Docker 'healthy' are NOT release PASS."
echo "RELEASE PASS requires authenticated /api/healthz HTTP 200 + SHA/schema/history/table."
set +e
HTTP_CODE=$(curl -sS -o /tmp/cairn-tm-v3-healthz.body -w '%{http_code}' \
  --connect-timeout 3 --max-time 8 \
  http://127.0.0.1:33211/api/healthz 2>/tmp/cairn-tm-v3-healthz.err)
CURL_EC=$?
set -e
if [[ ${CURL_EC} -ne 0 ]]; then
  echo "HEALTH_PROBE curl_exit=${CURL_EC} (connection failed — stack down or not bound)"
  if [[ -f /tmp/cairn-tm-v3-healthz.err ]]; then
    head -c 400 /tmp/cairn-tm-v3-healthz.err; echo
  fi
else
  echo "HEALTH_PROBE http_code=${HTTP_CODE} path=/api/healthz class=LIVENESS_ONLY"
  if [[ "${HTTP_CODE}" == "503" ]]; then
    echo "HEALTH_PROBE note=503_is_liveness_not_release_PASS"
  fi
  # Do not dump body if it might contain operational detail; length only.
  if [[ -f /tmp/cairn-tm-v3-healthz.body ]]; then
    echo "HEALTH_PROBE body_bytes=$(wc -c </tmp/cairn-tm-v3-healthz.body | tr -d ' ')"
  fi
fi

echo "STATUS_DONE"
