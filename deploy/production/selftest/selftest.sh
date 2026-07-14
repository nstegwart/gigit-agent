#!/usr/bin/env bash
# Shell self-test for production package. Never touches production host/process.
# Runs on laptop workspace only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROD="${ROOT}/deploy/production"
SCRIPTS="${PROD}/scripts"
cd "${ROOT}"

echo "SELFTEST_ROOT=${ROOT}"
fail=0

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS ${name}"
  else
    echo "FAIL ${name}" >&2
    fail=$((fail + 1))
  fi
}

# --- layout ---
for f in \
  lib/gates.mjs \
  scripts/common.sh \
  scripts/preflight.sh \
  scripts/build-install.sh \
  scripts/migrate-plan.sh \
  scripts/migrate-apply.sh \
  scripts/pm2-atomic.sh \
  scripts/health-readback.sh \
  scripts/rollback.sh \
  scripts/release.sh \
  env.production.example \
  README.md \
  selftest/selftest.mjs
do
  check "exists ${f}" test -f "${PROD}/${f}"
done

for f in preflight.sh build-install.sh migrate-plan.sh migrate-apply.sh pm2-atomic.sh health-readback.sh rollback.sh release.sh; do
  check "executable ${f}" test -x "${SCRIPTS}/${f}"
done

# --- node gates ---
check "node selftest" node "${PROD}/selftest/selftest.mjs"

# --- fail closed without approval ---
set +e
out="$(env -u APPROVED_FULL_SHA -u PRODUCTION_APPROVAL_ID -u BACKUP_RECEIPT \
  bash "${SCRIPTS}/preflight.sh" 2>&1)"
rc=$?
set -e
check "preflight fails closed without bundle" test "${rc}" -ne 0
if printf '%s\n' "${out}" | grep -Eqi 'APPROVED_FULL_SHA|approval|MISSING'; then
  echo "PASS preflight error mentions approval or missing"
else
  echo "FAIL preflight error mentions approval or missing" >&2
  printf '%s\n' "${out}" | tail -10 >&2
  fail=$((fail + 1))
fi

# --- dry-run preflight with dummy receipt (may WARN on nginx/env) ---
RECEIPT="$(mktemp)"
echo "selftest-backup-receipt $(date -u +%Y%m%dT%H%M%SZ)" >"${RECEIPT}"
SHA="$(git rev-parse HEAD)"
set +e
out2="$(
  APPROVED_FULL_SHA="${SHA}" \
  PRODUCTION_APPROVAL_ID="selftest-local" \
  BACKUP_RECEIPT="${RECEIPT}" \
  PRODUCTION_DRY_RUN=1 \
  PREFLIGHT_REQUIRE_HEAD_MATCH=0 \
  PREFLIGHT_REQUIRE_DB_TCP=0 \
  bash "${SCRIPTS}/preflight.sh" 2>&1
)"
rc2=$?
set -e
# On laptop, preflight should reach PREFLIGHT_OK if git readable
if echo "${out2}" | grep -q 'PREFLIGHT_OK'; then
  echo "PASS preflight dry with approval"
else
  # Still accept non-zero only if approval passed and later env/nginx warn caused die
  if echo "${out2}" | grep -q 'APPROVAL_BUNDLE_OK\|approval bundle'; then
    echo "PASS preflight approval gate reached (host-specific later checks may warn)"
    echo "${out2}" | tail -20
  else
    echo "FAIL preflight dry with approval" >&2
    echo "${out2}" | tail -40 >&2
    fail=$((fail + 1))
  fi
fi

# --- migrate-apply refuses without MIGRATE_APPLY_APPROVED ---
set +e
out3="$(
  APPROVED_FULL_SHA="${SHA}" \
  PRODUCTION_APPROVAL_ID="selftest-local" \
  BACKUP_RECEIPT="${RECEIPT}" \
  bash "${SCRIPTS}/migrate-apply.sh" 2>&1
)"
rc3=$?
set -e
check "migrate-apply fail without MIGRATE_APPLY_APPROVED" test "${rc3}" -ne 0

# --- rollback classify ---
set +e
out4="$(SCHEMA_MOVED=1 HAS_DB_DUMP=0 bash "${SCRIPTS}/rollback.sh" --classify 2>&1)"
rc4=$?
set -e
check "rollback classify exit 0" test "${rc4}" -eq 0
if printf '%s\n' "${out4}" | grep -q 'DB_FORWARD_FIX_ONLY'; then
  echo "PASS rollback class FORWARD_FIX"
else
  echo "FAIL rollback class FORWARD_FIX" >&2
  printf '%s\n' "${out4}" | tail -5 >&2
  fail=$((fail + 1))
fi

# --- gates CLI require-approval ---
set +e
out5="$(node "${PROD}/lib/gates.mjs" require-approval 2>&1)"
rc5=$?
set -e
check "gates CLI fail without env" test "${rc5}" -ne 0

# --- dry-run default + pm2-atomic without pm2 binary ---
# PRODUCTION_DRY_RUN defaults to 1; require_cmd pm2 must NOT run on dry-run path.
set +e
out6="$(
  APPROVED_FULL_SHA="${SHA}" \
  PRODUCTION_APPROVAL_ID="selftest-local" \
  BACKUP_RECEIPT="${RECEIPT}" \
  PREFLIGHT_REQUIRE_HEAD_MATCH=0 \
  bash "${SCRIPTS}/pm2-atomic.sh" 2>&1
)"
rc6=$?
set -e
check "pm2-atomic dry-run exit 0 without pm2" test "${rc6}" -eq 0
if printf '%s\n' "${out6}" | grep -q 'PM2_ATOMIC_OK'; then
  echo "PASS pm2-atomic dry-run PM2_ATOMIC_OK"
else
  echo "FAIL pm2-atomic dry-run PM2_ATOMIC_OK" >&2
  printf '%s\n' "${out6}" | tail -20 >&2
  fail=$((fail + 1))
fi
if printf '%s\n' "${out6}" | grep -qi 'missing required command: pm2'; then
  echo "FAIL pm2-atomic dry-run still requires pm2" >&2
  fail=$((fail + 1))
else
  echo "PASS pm2-atomic dry-run does not require pm2 binary"
fi

# --- mutation opt-in: DRY_RUN=0 without PRODUCTION_MUTATION_APPROVED fails ---
set +e
out7="$(
  APPROVED_FULL_SHA="${SHA}" \
  PRODUCTION_APPROVAL_ID="selftest-local" \
  BACKUP_RECEIPT="${RECEIPT}" \
  PRODUCTION_DRY_RUN=0 \
  PRODUCTION_MUTATION_APPROVED=0 \
  bash "${SCRIPTS}/pm2-atomic.sh" 2>&1
)"
rc7=$?
set -e
check "mutation refuse without PRODUCTION_MUTATION_APPROVED" test "${rc7}" -ne 0
if printf '%s\n' "${out7}" | grep -Eqi 'mutation refuse|PRODUCTION_MUTATION_APPROVED'; then
  echo "PASS mutation refuse message"
else
  echo "FAIL mutation refuse message" >&2
  printf '%s\n' "${out7}" | tail -10 >&2
  fail=$((fail + 1))
fi

# --- uppercase SHA rejected by bash assert_full_sha_var after node would also reject ---
UPPER_SHA="$(printf '%s' "${SHA}" | tr 'a-f' 'A-F')"
set +e
out8="$(
  APPROVED_FULL_SHA="${UPPER_SHA}" \
  PRODUCTION_APPROVAL_ID="selftest-local" \
  BACKUP_RECEIPT="${RECEIPT}" \
  bash "${SCRIPTS}/pm2-atomic.sh" 2>&1
)"
rc8=$?
set -e
check "uppercase SHA rejected" test "${rc8}" -ne 0

# --- migrate-plan dry-run validates real entrypoint (this repo has migrate:plan) ---
set +e
out9="$(
  APPROVED_FULL_SHA="${SHA}" \
  PRODUCTION_APPROVAL_ID="selftest-local" \
  BACKUP_RECEIPT="${RECEIPT}" \
  bash "${SCRIPTS}/migrate-plan.sh" 2>&1
)"
rc9=$?
set -e
check "migrate-plan dry-run exit 0" test "${rc9}" -eq 0
if printf '%s\n' "${out9}" | grep -q 'MIGRATE_ENTRYPOINT_OK'; then
  echo "PASS migrate entrypoint validated"
else
  echo "FAIL migrate entrypoint validated" >&2
  printf '%s\n' "${out9}" | tail -15 >&2
  fail=$((fail + 1))
fi

# --- common.sh default PRODUCTION_DRY_RUN=1 ---
if grep -q 'PRODUCTION_DRY_RUN="${PRODUCTION_DRY_RUN:-1}"' "${SCRIPTS}/common.sh"; then
  echo "PASS dry-run default-on in common.sh"
else
  echo "FAIL dry-run default-on in common.sh" >&2
  fail=$((fail + 1))
fi

rm -f "${RECEIPT}"

if [[ "${fail}" -ne 0 ]]; then
  echo "SELFTEST_FAIL count=${fail}"
  exit 1
fi
echo "SELFTEST_OK shell production package"
exit 0
