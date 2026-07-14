/**
 * Production release package — pure fail-closed gates (no network, no secrets printed).
 * Used by deploy/production/scripts/* and selftests / unit tests.
 *
 * Evidence source: WORKER_RESULT_investigate-final-production-502-r3.md
 *   host path /home/gian.devx/cairn-taskmanager, PM2 preview :3210, nginx → 127.0.0.1:3210
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

/** Full 40-char lowercase hex git SHA. */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/

/** PM2 app name + listen contract from production dump. */
export const PROD_CONTRACT = Object.freeze({
  appName: 'cairn-taskmanager',
  appPathDefault: '/home/gian.devx/cairn-taskmanager',
  listenHost: '127.0.0.1',
  listenPort: 3210,
  nginxUpstream: 'http://127.0.0.1:3210',
  pm2StartArgs: ['run', 'preview', '--', '--port', '3210', '--host', '127.0.0.1'],
  systemdUnit: 'pm2-gian.devx.service',
  publicHost: 'task-manager.mfsdev.net',
  envKeysRequired: Object.freeze([
    'CAIRN_DB_HOST',
    'CAIRN_DB_PORT',
    'CAIRN_DB_USER',
    'CAIRN_DB_PASSWORD',
    'CAIRN_DB_NAME',
    'CAIRN_WRITE_TOKEN',
    'CAIRN_ALLOW_REMOTE_DB',
  ]),
  approvalEnvKeys: Object.freeze([
    'APPROVED_FULL_SHA',
    'PRODUCTION_APPROVAL_ID',
    'BACKUP_RECEIPT',
  ]),
})

/**
 * Canonical APPROVED_FULL_SHA: full 40-char **lowercase** hex only.
 * Uppercase / mixed-case 40-hex is rejected (no silent lowercasing) so bash
 * assert_full_sha_var and node gates stay consistent.
 *
 * @param {string | undefined | null} sha
 * @returns {{ ok: true, sha: string } | { ok: false, code: string, message: string }}
 */
export function assertFullSha(sha) {
  const raw = typeof sha === 'string' ? sha.trim() : ''
  if (!raw) {
    return { ok: false, code: 'MISSING_APPROVED_FULL_SHA', message: 'APPROVED_FULL_SHA is required (40-char lowercase hex)' }
  }
  if (FULL_SHA_RE.test(raw)) {
    return { ok: true, sha: raw }
  }
  if (/^[0-9a-fA-F]{40}$/.test(raw)) {
    return {
      ok: false,
      code: 'INVALID_APPROVED_FULL_SHA',
      message:
        'APPROVED_FULL_SHA must be canonical lowercase 40-char hex git SHA (uppercase/mixed rejected)',
    }
  }
  return {
    ok: false,
    code: 'INVALID_APPROVED_FULL_SHA',
    message: `APPROVED_FULL_SHA must be full 40-char lowercase hex git SHA, got length=${raw.length}`,
  }
}

/**
 * Fail closed when any of APPROVED_FULL_SHA, PRODUCTION_APPROVAL_ID, BACKUP_RECEIPT absent.
 * Does not read backup file contents (path presence is separate).
 *
 * @param {Record<string, string | undefined>} env
 */
export function requireApprovalBundle(env = {}) {
  const missing = []
  for (const k of PROD_CONTRACT.approvalEnvKeys) {
    const v = env[k]
    if (v === undefined || v === null || String(v).trim() === '') missing.push(k)
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'MISSING_APPROVAL_BUNDLE',
      message: `fail closed: missing required approval env: ${missing.join(', ')}`,
      missing,
    }
  }
  const sha = assertFullSha(env.APPROVED_FULL_SHA)
  if (!sha.ok) return sha

  const approvalId = String(env.PRODUCTION_APPROVAL_ID).trim()
  if (approvalId.length < 4) {
    return {
      ok: false,
      code: 'INVALID_PRODUCTION_APPROVAL_ID',
      message: 'PRODUCTION_APPROVAL_ID must be non-empty (≥4 chars)',
    }
  }

  const receipt = String(env.BACKUP_RECEIPT).trim()
  if (receipt.length < 1) {
    return {
      ok: false,
      code: 'MISSING_BACKUP_RECEIPT',
      message: 'BACKUP_RECEIPT path/id required',
    }
  }

  return {
    ok: true,
    approvedFullSha: sha.sha,
    productionApprovalId: approvalId,
    backupReceipt: receipt,
  }
}

/**
 * Parse .env-like text and return key names only (never values).
 * @param {string} text
 * @returns {string[]}
 */
export function listEnvKeysOnly(text) {
  const keys = []
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    if (key) keys.push(key)
  }
  return keys
}

/**
 * Assert required CAIRN_* keys present; never returns values.
 * @param {string[]} presentKeys
 * @param {string[]} [required]
 */
export function assertEnvKeysPresent(
  presentKeys,
  required = [...PROD_CONTRACT.envKeysRequired],
) {
  const set = new Set(presentKeys)
  const missing = required.filter((k) => !set.has(k))
  if (missing.length) {
    return {
      ok: false,
      code: 'MISSING_ENV_KEYS',
      message: `env missing required keys (values not shown): ${missing.join(', ')}`,
      missing,
      present: presentKeys.filter((k) => required.includes(k)),
    }
  }
  return {
    ok: true,
    present: required.slice(),
    code: 'ENV_KEYS_OK',
  }
}

/**
 * Detect nginx upstream target from site conf text.
 * @param {string} confText
 */
export function parseNginxUpstream(confText) {
  const text = String(confText)
  // proxy_pass http://127.0.0.1:3210;  or with trailing path
  const m = text.match(/proxy_pass\s+(https?:\/\/[^\s;]+)/i)
  if (!m) {
    return { ok: false, code: 'NGINX_UPSTREAM_NOT_FOUND', message: 'no proxy_pass found in site conf' }
  }
  const upstream = m[1].replace(/\/$/, '')
  const expected = PROD_CONTRACT.nginxUpstream
  const ok = upstream === expected || upstream === `${expected}/`
  return {
    ok,
    code: ok ? 'NGINX_UPSTREAM_OK' : 'NGINX_UPSTREAM_MISMATCH',
    upstream,
    expected,
    message: ok
      ? `nginx upstream matches ${expected}`
      : `nginx upstream ${upstream} !== expected ${expected}`,
  }
}

/**
 * Host/path/branch/upstream SHA preflight classification (pure inputs).
 * @param {{
 *   hostname?: string
 *   expectedHostname?: string
 *   appPath: string
 *   expectedAppPath?: string
 *   headSha?: string
 *   approvedFullSha: string
 *   branch?: string
 *   upstreamBranch?: string
 *   dirty?: boolean
 *   skipHostMatch?: boolean
 * }} input
 */
export function preflightGitHostPath(input) {
  const errors = []
  const expectedPath = input.expectedAppPath || PROD_CONTRACT.appPathDefault
  if (input.appPath !== expectedPath && !input.skipHostMatch) {
    // Allow local package selftest / laptop checkout: only warn when PROD_PATH_STRICT=1
    if (input.strictPath) {
      errors.push({
        code: 'APP_PATH_MISMATCH',
        message: `appPath ${input.appPath} !== ${expectedPath}`,
      })
    }
  }
  if (input.expectedHostname && input.hostname && input.hostname !== input.expectedHostname) {
    if (input.strictHost) {
      errors.push({
        code: 'HOSTNAME_MISMATCH',
        message: `hostname ${input.hostname} !== ${input.expectedHostname}`,
      })
    }
  }
  const approved = assertFullSha(input.approvedFullSha)
  if (!approved.ok) errors.push(approved)

  if (input.headSha) {
    const head = assertFullSha(input.headSha)
    if (!head.ok) {
      errors.push(head)
    } else if (approved.ok && head.sha !== approved.sha) {
      errors.push({
        code: 'HEAD_NOT_APPROVED_SHA',
        message: `HEAD ${head.sha} !== APPROVED_FULL_SHA ${approved.sha} (checkout required before start)`,
      })
    }
  }

  if (input.dirty === true && input.allowDirty !== true) {
    errors.push({
      code: 'DIRTY_TREE',
      message: 'working tree dirty; refuse production start (only .env bak untracked may be allowlisted separately)',
    })
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? 'PREFLIGHT_GIT_HOST_PATH_OK' : 'PREFLIGHT_GIT_HOST_PATH_FAIL',
    errors,
    approvedFullSha: approved.ok ? approved.sha : undefined,
    branch: input.branch,
    upstreamBranch: input.upstreamBranch,
  }
}

/**
 * Backup authority: receipt path must exist, be non-empty, optionally max age.
 * @param {{ receiptPath: string, maxAgeHours?: number, nowMs?: number }} input
 */
export function assertBackupAuthority(input) {
  const path = String(input.receiptPath || '').trim()
  if (!path) {
    return { ok: false, code: 'MISSING_BACKUP_RECEIPT', message: 'BACKUP_RECEIPT empty' }
  }
  if (!existsSync(path)) {
    return {
      ok: false,
      code: 'BACKUP_RECEIPT_NOT_FOUND',
      message: `BACKUP_RECEIPT path not found: ${basename(path)} (full path withheld from logs if secret dir)`,
      path,
    }
  }
  let st
  try {
    st = statSync(path)
  } catch (e) {
    return {
      ok: false,
      code: 'BACKUP_RECEIPT_UNREADABLE',
      message: e instanceof Error ? e.message : String(e),
    }
  }
  if (!st.isFile() || st.size <= 0) {
    return {
      ok: false,
      code: 'BACKUP_RECEIPT_EMPTY',
      message: 'BACKUP_RECEIPT file empty or not a regular file',
    }
  }
  const now = input.nowMs ?? Date.now()
  const ageMs = now - st.mtimeMs
  const maxH = input.maxAgeHours
  if (typeof maxH === 'number' && maxH > 0 && ageMs > maxH * 3600 * 1000) {
    return {
      ok: false,
      code: 'BACKUP_RECEIPT_STALE',
      message: `BACKUP_RECEIPT older than ${maxH}h (age_ms=${ageMs})`,
      ageMs,
    }
  }
  // Content fingerprint without printing dump body
  let fingerprint = ''
  try {
    const head = readFileSync(path).subarray(0, Math.min(st.size, 64 * 1024))
    fingerprint = createHash('sha256').update(head).digest('hex').slice(0, 16)
  } catch {
    fingerprint = 'unreadable'
  }
  return {
    ok: true,
    code: 'BACKUP_AUTHORITY_OK',
    size: st.size,
    mtimeMs: st.mtimeMs,
    fingerprint16: fingerprint,
  }
}

/**
 * DB connectivity classification from probe results (no passwords).
 * @param {{ tcpOpen?: boolean, hostClass?: string, allowRemoteDb?: boolean }} input
 */
export function classifyDbConnectivity(input) {
  if (input.tcpOpen !== true) {
    return {
      ok: false,
      code: 'DB_TCP_CLOSED',
      message: 'DB TCP probe failed (port closed or unreachable)',
    }
  }
  if (input.hostClass === 'remote_public_or_hostname' && input.allowRemoteDb !== true) {
    return {
      ok: false,
      code: 'REMOTE_DB_NOT_OPTED_IN',
      message: 'remote DB host requires CAIRN_ALLOW_REMOTE_DB=1',
    }
  }
  return { ok: true, code: 'DB_CONNECTIVITY_OK', tcpOpen: true, hostClass: input.hostClass }
}

/**
 * Migrate apply gate: needs approval bundle + explicit MIGRATE_APPLY_APPROVED=1 + fresh dump.
 * @param {Record<string, string | undefined>} env
 * @param {{ dumpPath?: string, maxAgeHours?: number, nowMs?: number }} opts
 */
export function requireMigrateApplyAuthority(env = {}, opts = {}) {
  const bundle = requireApprovalBundle(env)
  if (!bundle.ok) return bundle
  if (String(env.MIGRATE_APPLY_APPROVED || '') !== '1') {
    return {
      ok: false,
      code: 'MIGRATE_APPLY_NOT_APPROVED',
      message: 'migrate apply refuse: set MIGRATE_APPLY_APPROVED=1 only after owner approval + dump',
    }
  }
  const dumpPath = opts.dumpPath || env.DB_DUMP_PATH || env.BACKUP_RECEIPT
  const backup = assertBackupAuthority({
    receiptPath: dumpPath,
    maxAgeHours: opts.maxAgeHours ?? Number(env.BACKUP_MAX_AGE_HOURS || 24),
    nowMs: opts.nowMs,
  })
  if (!backup.ok) {
    return {
      ok: false,
      code: 'MIGRATE_APPLY_NO_FRESH_DUMP',
      message: `migrate apply refuse: ${backup.message}`,
      backup,
    }
  }
  return {
    ok: true,
    code: 'MIGRATE_APPLY_AUTHORITY_OK',
    approvedFullSha: bundle.approvedFullSha,
    productionApprovalId: bundle.productionApprovalId,
    backup,
  }
}

/**
 * Rollback classification for app + DB.
 * @param {{
 *   priorFullSha?: string
 *   schemaMoved?: boolean
 *   hasDbDump?: boolean
 *   dumpRestorable?: boolean
 * }} input
 */
export function classifyRollback(input) {
  const prior = input.priorFullSha ? assertFullSha(input.priorFullSha) : null
  if (input.priorFullSha && prior && !prior.ok) {
    return { ok: false, class: 'INVALID', ...prior }
  }

  if (input.schemaMoved && !input.hasDbDump) {
    return {
      ok: true,
      class: 'DB_FORWARD_FIX_ONLY',
      code: 'DB_FORWARD_FIX_ONLY',
      message:
        'schema-moving release without proven dump: app may roll back to prior SHA; DB must forward-fix only (no schema rollback)',
      appRollback: prior?.ok ? 'PRIOR_SHA' : 'NONE',
      dbRollback: 'FORBIDDEN_FORWARD_FIX_ONLY',
    }
  }

  if (input.schemaMoved && input.hasDbDump && input.dumpRestorable) {
    return {
      ok: true,
      class: 'APP_PLUS_DB_RESTORE',
      code: 'APP_PLUS_DB_RESTORE',
      message: 'prior SHA + restore DB dump (owner-approved; not auto-run by package)',
      appRollback: 'PRIOR_SHA',
      dbRollback: 'DUMP_RESTORE_MANUAL',
    }
  }

  if (!input.schemaMoved) {
    return {
      ok: true,
      class: 'APP_ONLY_PRIOR_SHA',
      code: 'APP_ONLY_PRIOR_SHA',
      message: 'no schema move: checkout prior SHA + reinstall/build + PM2 restart is sufficient',
      appRollback: 'PRIOR_SHA',
      dbRollback: 'NONE_NEEDED',
    }
  }

  return {
    ok: true,
    class: 'DB_FORWARD_FIX_ONLY',
    code: 'DB_FORWARD_FIX_ONLY',
    message: 'schema moved but dump not restorable: forward-fix DB only',
    appRollback: prior?.ok ? 'PRIOR_SHA' : 'NONE',
    dbRollback: 'FORBIDDEN_FORWARD_FIX_ONLY',
  }
}

/**
 * Health readback classification from HTTP status codes.
 * Liveness: 401|200 proves listen. Release PASS needs 200 + deployedSha match.
 * @param {{
 *   loopbackStatus?: number | null
 *   originStatus?: number | null
 *   edgeStatus?: number | null
 *   loopbackBody?: { deployedSha?: string }
 *   approvedFullSha?: string
 * }} input
 */
export function classifyHealthReadback(input) {
  const loop = input.loopbackStatus
  if (loop === null || loop === undefined) {
    return {
      ok: false,
      code: 'LOOPBACK_NO_RESPONSE',
      liveness: false,
      releasePass: false,
      message: 'no loopback /api/healthz response (connection refused class)',
    }
  }
  const listenOk = loop === 401 || loop === 200 || loop === 503
  if (!listenOk) {
    return {
      ok: false,
      code: 'LOOPBACK_BAD_STATUS',
      liveness: false,
      releasePass: false,
      loopbackStatus: loop,
      message: `loopback status ${loop} not in 401|200|503`,
    }
  }
  const bodySha = input.loopbackBody?.deployedSha
  const approved = input.approvedFullSha ? assertFullSha(input.approvedFullSha) : null
  const shaMatch =
    approved?.ok &&
    typeof bodySha === 'string' &&
    bodySha.toLowerCase() === approved.sha
  const releasePass = loop === 200 && Boolean(shaMatch)
  return {
    ok: listenOk,
    code: releasePass ? 'HEALTH_RELEASE_PASS' : listenOk ? 'HEALTH_LIVENESS_OK' : 'HEALTH_FAIL',
    liveness: listenOk,
    releasePass,
    loopbackStatus: loop,
    originStatus: input.originStatus ?? null,
    edgeStatus: input.edgeStatus ?? null,
    deployedSha: bodySha,
    approvedFullSha: approved?.ok ? approved.sha : undefined,
    message: releasePass
      ? 'authenticated/authorized healthz 200 + deployedSha match'
      : 'liveness only — release PASS needs HTTP 200 + deployedSha === APPROVED_FULL_SHA',
  }
}

/** CLI for shell selftest / script reuse */
export function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'help'
  if (cmd === 'require-approval') {
    const r = requireApprovalBundle(process.env)
    console.log(JSON.stringify(r))
    process.exitCode = r.ok ? 0 : 2
    return
  }
  if (cmd === 'require-migrate-apply') {
    const r = requireMigrateApplyAuthority(process.env)
    console.log(JSON.stringify(r))
    process.exitCode = r.ok ? 0 : 2
    return
  }
  if (cmd === 'parse-nginx') {
    const file = argv[1]
    if (!file || !existsSync(file)) {
      console.log(JSON.stringify({ ok: false, code: 'NO_FILE' }))
      process.exitCode = 2
      return
    }
    const r = parseNginxUpstream(readFileSync(file, 'utf8'))
    console.log(JSON.stringify(r))
    process.exitCode = r.ok ? 0 : 2
    return
  }
  if (cmd === 'env-keys') {
    const file = argv[1]
    if (!file || !existsSync(file)) {
      console.log(JSON.stringify({ ok: false, code: 'NO_FILE' }))
      process.exitCode = 2
      return
    }
    const keys = listEnvKeysOnly(readFileSync(file, 'utf8'))
    const r = assertEnvKeysPresent(keys)
    console.log(JSON.stringify({ keys, check: r }))
    process.exitCode = r.ok ? 0 : 2
    return
  }
  if (cmd === 'classify-rollback') {
    const r = classifyRollback({
      priorFullSha: process.env.PRIOR_FULL_SHA,
      schemaMoved: process.env.SCHEMA_MOVED === '1',
      hasDbDump: process.env.HAS_DB_DUMP === '1',
      dumpRestorable: process.env.DUMP_RESTORABLE === '1',
    })
    console.log(JSON.stringify(r))
    process.exitCode = r.ok ? 0 : 2
    return
  }
  console.log(
    JSON.stringify({
      ok: true,
      commands: [
        'require-approval',
        'require-migrate-apply',
        'parse-nginx <file>',
        'env-keys <file>',
        'classify-rollback',
      ],
    }),
  )
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('/gates.mjs') || process.argv[1].endsWith('\\gates.mjs'))

if (isMain) {
  main()
}
