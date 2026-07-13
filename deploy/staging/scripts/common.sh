#!/usr/bin/env bash
# Shared helpers for staging compose ops (idempotent). Source only — do not execute.
# shellcheck shell=bash

set -euo pipefail

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING_DIR="$(cd "${COMMON_DIR}/.." && pwd)"
# Repo / release source root (directory that contains package.json + deploy/staging).
SOURCE_ROOT="$(cd "${STAGING_DIR}/../.." && pwd)"
COMPOSE_FILE="${STAGING_DIR}/docker-compose.yml"
ENV_FILE="${STAGING_DIR}/.env"

RELEASE_ROOT_DEFAULT="/opt/mfs/staging/cairn-taskmanager-v3"
RELEASE_ROOT="${RELEASE_ROOT:-$RELEASE_ROOT_DEFAULT}"

compose() {
  # Prefer sudo docker when the user cannot talk to the daemon (staging VPS pattern).
  local docker_bin=(docker)
  if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
      docker_bin=(sudo -n docker)
    elif command -v sudo >/dev/null 2>&1; then
      docker_bin=(sudo docker)
    fi
  fi
  (
    cd "${SOURCE_ROOT}"
    "${docker_bin[@]}" compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
  )
}

require_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "ERROR: missing secrets file ${ENV_FILE}" >&2
    echo "Copy: cp ${STAGING_DIR}/env.staging.example ${ENV_FILE}" >&2
    echo "Then set RELEASE_SHA + passwords + tokens (staging-only)." >&2
    return 1
  fi
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  source "${ENV_FILE}"
  set +a
  if [[ -z "${RELEASE_SHA:-}" || "${RELEASE_SHA}" == "0000000000000000000000000000000000000000" ]]; then
    echo "ERROR: RELEASE_SHA must be set to the full git SHA of this release in ${ENV_FILE}" >&2
    return 1
  fi
  if [[ "${MYSQL_ROOT_PASSWORD:-}" == REPLACE_ME* || -z "${MYSQL_ROOT_PASSWORD:-}" ]]; then
    echo "ERROR: MYSQL_ROOT_PASSWORD still placeholder or empty in ${ENV_FILE}" >&2
    return 1
  fi
}

print_target() {
  echo "OWNER_TARGET: {base_url: http://127.0.0.1:33211/, port: 33211, account: synthetic-staging-only, device: n/a}"
  echo "RELEASE_ROOT: ${RELEASE_ROOT}"
  echo "SOURCE_ROOT:  ${SOURCE_ROOT}"
  echo "COMPOSE_FILE: ${COMPOSE_FILE}"
  echo "ENV_FILE:     ${ENV_FILE}"
  echo "RELEASE_SHA:  ${RELEASE_SHA:-<unset>}"
}
