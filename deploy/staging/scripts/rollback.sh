#!/usr/bin/env bash
# Staging rollback helper with explicit GREENFIELD vs PRIOR_SHA classification.
#
# Usage:
#   ./rollback.sh --greenfield           # no prior staging SHA / first stack only
#   ./rollback.sh --to-sha <full-sha>    # redeploy previous image tag (requires prior image)
#   ./rollback.sh --stop-keep-volume     # stop containers, keep MySQL volume
#   ./rollback.sh --stop-wipe-volume     # stop + remove MySQL volume (destructive)
#
# Greenfield rule (NO_PRIOR_STAGING_SHA):
#   If this is the first staging deploy (no previous RELEASE_SHA image / no prior
#   healthy stack), the only valid rollback is GREENFIELD_TEARDOWN:
#     compose down -v + remove project network/volume + optional release-root cleanup.
#   There is no prior image to restore. Document class=GREENFIELD_ROLLBACK.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

MODE=""
TO_SHA=""

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \?//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --greenfield) MODE=greenfield; shift ;;
    --to-sha) MODE=to_sha; TO_SHA="${2:-}"; shift 2 ;;
    --stop-keep-volume) MODE=stop_keep; shift ;;
    --stop-wipe-volume) MODE=stop_wipe; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

if [[ -z "${MODE}" ]]; then
  usage
fi

print_target

case "${MODE}" in
  greenfield)
    echo "ROLLBACK_CLASS=GREENFIELD_ROLLBACK"
    echo "REASON=NO_PRIOR_STAGING_SHA (or explicit greenfield teardown requested)"
    if [[ -f "${ENV_FILE}" ]]; then
      require_env_file || true
      compose down -v --remove-orphans || true
    else
      echo "WARN: no env file; stopping containers by name"
      docker stop cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || \
        sudo docker stop cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || true
      docker rm cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || \
        sudo docker rm cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || true
      docker volume rm cairn-tm-v3-mysql-data 2>/dev/null || \
        sudo docker volume rm cairn-tm-v3-mysql-data 2>/dev/null || true
      docker network rm cairn-tm-v3-net 2>/dev/null || \
        sudo docker network rm cairn-tm-v3-net 2>/dev/null || true
    fi
    echo "GREENFIELD_TEARDOWN_OK (containers/volume/network removed when present)"
    echo "Optional: sudo rm -rf ${RELEASE_ROOT}  # only if never reused and orchestrator approves"
    ;;
  to_sha)
    if [[ -z "${TO_SHA}" || ! "${TO_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
      echo "ERROR: --to-sha requires full 40-char lowercase/hex git SHA" >&2
      exit 1
    fi
    require_env_file
    echo "ROLLBACK_CLASS=PRIOR_SHA_ROLLBACK"
    echo "TARGET_SHA=${TO_SHA}"
    # Pin env to prior SHA for compose image tag resolution.
    if grep -q '^RELEASE_SHA=' "${ENV_FILE}"; then
      # In-place pin without printing secrets.
      tmp="$(mktemp)"
      awk -v sha="${TO_SHA}" 'BEGIN{FS=OFS="="} $1=="RELEASE_SHA"{$2=sha} {print}' "${ENV_FILE}" >"${tmp}"
      mv "${tmp}" "${ENV_FILE}"
    else
      echo "RELEASE_SHA=${TO_SHA}" >>"${ENV_FILE}"
    fi
    # shellcheck disable=SC1090
    set -a; source "${ENV_FILE}"; set +a
    export RELEASE_SHA="${TO_SHA}"
    if ! compose images 2>/dev/null | grep -q "cairn-tm-v3-app"; then
      echo "WARN: prior image may be missing; will attempt pull/build for ${TO_SHA}"
    fi
    compose up -d --remove-orphans
    compose ps
    echo "PRIOR_SHA_ROLLBACK_APPLIED sha=${TO_SHA}"
    echo "Re-check: curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:33211/api/healthz  # expect 401 unauth"
    ;;
  stop_keep)
    echo "ROLLBACK_CLASS=STOP_KEEP_VOLUME"
    require_env_file
    compose down --remove-orphans
    echo "STOP_KEEP_VOLUME_OK"
    ;;
  stop_wipe)
    echo "ROLLBACK_CLASS=STOP_WIPE_VOLUME"
    require_env_file
    compose down -v --remove-orphans
    echo "STOP_WIPE_VOLUME_OK"
    ;;
esac
