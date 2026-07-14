/**
 * Node self-test for production release gates (no network, no host mutation).
 * Exit 0 = all assertions passed.
 */
import {
  assertBackupAuthority,
  assertEnvKeysPresent,
  assertFullSha,
  classifyDbConnectivity,
  classifyHealthReadback,
  classifyRollback,
  listEnvKeysOnly,
  parseNginxUpstream,
  preflightGitHostPath,
  PROD_CONTRACT,
  requireApprovalBundle,
  requireMigrateApplyAuthority,
} from '../lib/gates.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`)
  }
}

// --- SHA (canonical lowercase only) ---
check('assertFullSha empty', !assertFullSha('').ok)
check('assertFullSha short', !assertFullSha('abc').ok)
const goodSha = 'a'.repeat(40)
check('assertFullSha good', assertFullSha(goodSha).ok && assertFullSha(goodSha).sha === goodSha)
const upperSha = 'A'.repeat(40)
check(
  'assertFullSha rejects uppercase',
  !assertFullSha(upperSha).ok && assertFullSha(upperSha).code === 'INVALID_APPROVED_FULL_SHA',
)
const mixedSha = 'AbCdEf0123456789AbCdEf0123456789AbCdEf01'
check('assertFullSha rejects mixed case', !assertFullSha(mixedSha).ok)
// No silent lowercasing: goodSha input must remain as-is
check('assertFullSha no silent lowercasing of upper', assertFullSha(upperSha).ok !== true)

// --- approval bundle fail closed ---
check(
  'requireApprovalBundle missing all',
  !requireApprovalBundle({}).ok &&
    requireApprovalBundle({}).code === 'MISSING_APPROVAL_BUNDLE',
)
check(
  'requireApprovalBundle missing backup',
  !requireApprovalBundle({
    APPROVED_FULL_SHA: goodSha,
    PRODUCTION_APPROVAL_ID: 'ticket-1',
  }).ok,
)
const dir = mkdtempSync(join(tmpdir(), 'prod-gate-'))
const receipt = join(dir, 'backup.receipt')
writeFileSync(receipt, 'mysqldump-placeholder-not-secret\n')
check(
  'requireApprovalBundle ok',
  requireApprovalBundle({
    APPROVED_FULL_SHA: goodSha,
    PRODUCTION_APPROVAL_ID: 'ticket-99',
    BACKUP_RECEIPT: receipt,
  }).ok,
)

// --- backup authority ---
check('assertBackupAuthority missing file', !assertBackupAuthority({ receiptPath: join(dir, 'nope') }).ok)
check('assertBackupAuthority ok', assertBackupAuthority({ receiptPath: receipt }).ok)
check(
  'assertBackupAuthority stale',
  !assertBackupAuthority({ receiptPath: receipt, maxAgeHours: 0.0000001, nowMs: Date.now() + 3600e3 }).ok,
)

// --- env keys only ---
const envText = `# comment\nCAIRN_DB_HOST=secret-host\nCAIRN_DB_PORT=3306\nCAIRN_DB_USER=u\nCAIRN_DB_PASSWORD=p\nCAIRN_DB_NAME=n\nCAIRN_WRITE_TOKEN=t\nCAIRN_ALLOW_REMOTE_DB=1\n`
const keys = listEnvKeysOnly(envText)
check('listEnvKeysOnly no values', keys.includes('CAIRN_DB_HOST') && !keys.some((k) => k.includes('secret')))
check('assertEnvKeysPresent ok', assertEnvKeysPresent(keys).ok)
check(
  'assertEnvKeysPresent missing',
  !assertEnvKeysPresent(['CAIRN_DB_HOST']).ok,
)

// --- nginx ---
const confOk = 'server { location / { proxy_pass http://127.0.0.1:3210; } }'
const confBad = 'server { location / { proxy_pass http://127.0.0.1:3000; } }'
check('parseNginxUpstream ok', parseNginxUpstream(confOk).ok)
check('parseNginxUpstream mismatch', !parseNginxUpstream(confBad).ok)
check('nginx expected constant', PROD_CONTRACT.nginxUpstream === 'http://127.0.0.1:3210')

// --- git/host preflight ---
const pf = preflightGitHostPath({
  appPath: '/home/gian.devx/cairn-taskmanager',
  approvedFullSha: goodSha,
  headSha: goodSha,
  dirty: false,
})
check('preflightGitHostPath match', pf.ok)
const pf2 = preflightGitHostPath({
  appPath: '/tmp/other',
  approvedFullSha: goodSha,
  headSha: 'b'.repeat(40),
  dirty: false,
})
check('preflightGitHostPath head mismatch', !pf2.ok)

// --- DB ---
check(
  'classifyDbConnectivity open',
  classifyDbConnectivity({ tcpOpen: true, hostClass: 'remote_public_or_hostname', allowRemoteDb: true }).ok,
)
check(
  'classifyDbConnectivity remote refuse',
  !classifyDbConnectivity({ tcpOpen: true, hostClass: 'remote_public_or_hostname', allowRemoteDb: false }).ok,
)

// --- migrate apply ---
check(
  'requireMigrateApplyAuthority no flag',
  !requireMigrateApplyAuthority({
    APPROVED_FULL_SHA: goodSha,
    PRODUCTION_APPROVAL_ID: 'ticket-apply',
    BACKUP_RECEIPT: receipt,
  }).ok,
)
check(
  'requireMigrateApplyAuthority ok',
  requireMigrateApplyAuthority(
    {
      APPROVED_FULL_SHA: goodSha,
      PRODUCTION_APPROVAL_ID: 'ticket-apply',
      BACKUP_RECEIPT: receipt,
      MIGRATE_APPLY_APPROVED: '1',
    },
    { maxAgeHours: 24 },
  ).ok,
)

// --- rollback classes ---
check(
  'rollback APP_ONLY',
  classifyRollback({ priorFullSha: goodSha, schemaMoved: false }).class === 'APP_ONLY_PRIOR_SHA',
)
check(
  'rollback FORWARD_FIX',
  classifyRollback({ priorFullSha: goodSha, schemaMoved: true, hasDbDump: false }).class ===
    'DB_FORWARD_FIX_ONLY',
)
check(
  'rollback APP_PLUS_DB',
  classifyRollback({
    priorFullSha: goodSha,
    schemaMoved: true,
    hasDbDump: true,
    dumpRestorable: true,
  }).class === 'APP_PLUS_DB_RESTORE',
)

// --- health ---
check(
  'health liveness 401',
  classifyHealthReadback({ loopbackStatus: 401 }).liveness === true &&
    classifyHealthReadback({ loopbackStatus: 401 }).releasePass === false,
)
check(
  'health release pass',
  classifyHealthReadback({
    loopbackStatus: 200,
    loopbackBody: { deployedSha: goodSha },
    approvedFullSha: goodSha,
  }).releasePass === true,
)
check(
  'health refused',
  classifyHealthReadback({ loopbackStatus: null }).ok === false,
)

rmSync(dir, { recursive: true, force: true })

if (failed) {
  console.error(`SELFTEST_FAIL count=${failed}`)
  process.exit(1)
}
console.log('SELFTEST_OK node gates')
process.exit(0)
