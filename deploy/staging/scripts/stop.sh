#!/usr/bin/env bash
# Idempotent stop: compose down, keep MySQL volume (data retained for debug/rollback).
# Use rollback.sh --greenfield for full volume wipe on first-ever stack.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

print_target
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "WARN: ${ENV_FILE} missing — attempting stop with empty env may fail variable interpolation."
  echo "If compose refuses, create .env from env.staging.example with the same RELEASE_SHA used at deploy."
fi

if [[ -f "${ENV_FILE}" ]]; then
  compose down --remove-orphans
else
  # Best-effort stop by project/container names when env file is gone.
  docker stop cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || \
    sudo docker stop cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || true
  docker rm cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || \
    sudo docker rm cairn-tm-v3-app cairn-tm-v3-mysql 2>/dev/null || true
fi

echo "STOP_OK volumes retained (cairn-tm-v3-mysql-data). Network may remain if other consumers exist."
