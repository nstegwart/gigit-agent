#!/usr/bin/env node
/** Emit a timestamped, secret-redacted environment authority table. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isStrictIsoTimestamp } from './validate-resolved-target.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT_DEFAULT = resolve(__dirname, '../..')
export const SCHEMA_VERSION = 'TM_ENVIRONMENT_AUTHORITY_TABLE_V1'
export const REQUIRED_ENVIRONMENTS = Object.freeze([
  'local',
  'staging',
  'production',
])
export const SECRET_KEY_RE =
  /token|secret|password|authorization|api[_-]?key|credential|cookie|private[_-]?key/i

export const DEFAULT_ENVIRONMENTS = Object.freeze([
  {
    id: 'local',
    hostClass: 'LOCAL',
    baseUrl: 'http://127.0.0.1:3000',
    tlsStatus: 'HTTP_LOOPBACK_NO_TLS',
    deployMechanism: 'LOCAL_DEV_PROCESS',
    gateClosed: 'CHECKPOINT_TESTS_ONLY',
    databaseClass: 'LOCAL_EPHEMERAL',
    dataClass: 'SYNTHETIC_OR_DEVELOPER_LOCAL',
    appWriteAuthority: 'LOCAL_ONLY',
    schemaWriteAuthority: 'LOCAL_ONLY',
    boardSyncAuthority: 'LOCAL_BOARD_SYNC_FORBIDDEN',
  },
  {
    id: 'staging',
    hostClass: 'STAGING',
    baseUrl: 'http://127.0.0.1:33211',
    tlsStatus: 'HTTP_LOOPBACK_DOCKER_ISOLATED',
    deployMechanism: 'DOCKER_COMPOSE_STAGING',
    gateClosed: 'TASK_MANAGER_STAGING_VERIFIED_ONLY',
    databaseClass: 'STAGING_ISOLATED',
    dataClass: 'SYNTHETIC_DEFAULT',
    appWriteAuthority: 'EXECUTION_OPEN_GATED',
    schemaWriteAuthority: 'STAGING_ONLY',
    boardSyncAuthority: 'STAGING_BOARD_SYNC_FORBIDDEN',
  },
  {
    id: 'production',
    hostClass: 'PRODUCTION',
    baseUrl: 'https://task-manager.mfsdev.net',
    tlsStatus: 'HTTPS_BASELINE_VALIDATE_CERT_LIVE',
    deployMechanism: 'RESOLVED_TARGET_OWNER_APPROVED',
    gateClosed: 'AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK',
    databaseClass: 'PRODUCTION',
    dataClass: 'PRODUCTION',
    appWriteAuthority: 'APP_ONLY_AFTER_EXACT_SHA_GATES',
    schemaWriteAuthority: 'OWNER_APPROVAL_REQUIRED',
    boardSyncAuthority: 'REMOTE_BOARD_TOKEN_GATED',
  },
])

/** Additional known surfaces recorded for AC-ENV-01 (not authority-collapse axes). */
export const DEFAULT_KNOWN_SURFACES = Object.freeze([
  {
    id: 'production_mcp',
    hostClass: 'PRODUCTION',
    baseUrl: 'https://task-manager.mfsdev.net/mcp',
    tlsStatus: 'HTTPS_BASELINE_VALIDATE_CERT_LIVE',
    deployMechanism: 'SAME_AUTHORITATIVE_PRODUCTION_RELEASE',
    gateClosed: 'AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK',
    appWriteAuthority: 'READ_ONLY_SECURITY_PROBE',
  },
  {
    id: 'public_consumer',
    hostClass: 'UNKNOWN_REMOTE',
    baseUrl: 'http://34.50.66.172/',
    tlsStatus: 'HTTP_NO_TLS_RECHECK_AND_RECORD',
    deployMechanism: 'RESOLVED_TARGET_PUBLIC_CONSUMER_BIND',
    gateClosed: 'LIVE_P0_PARTICIPANT_WRITE_EXCLUDED',
    appWriteAuthority: 'EXCLUDED_UNLESS_EXACT_PATH_GRANTED',
  },
])

export const ENVIRONMENT_REQUIRED_ROW_FIELDS = Object.freeze([
  'baseUrl',
  'tlsStatus',
  'deployMechanism',
  'gateClosed',
  'databaseClass',
  'dataClass',
  'appWriteAuthority',
  'schemaWriteAuthority',
  'boardSyncAuthority',
])

export const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /\bBasic\s+[A-Za-z0-9+/=]{8,}\b/i,
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{16,})\b/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/i,
])

export function redactString(value) {
  if (/\bBearer\s+[A-Za-z0-9._~+/-]+/i.test(value)) return '[REDACTED]'
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return '[REDACTED]'
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]+:[^/@\s]+@/i.test(value)) {
    value = value.replace(/:\/\/[^/@:\s]+:[^/@\s]+@/, '://[REDACTED]@')
  }
  return value.replace(
    /([?&](?:access_token|token|api[_-]?key|secret|password|credential)=)[^&#\s]+/gi,
    '$1[REDACTED]',
  )
}

export function containsCredentialShape(value) {
  if (Array.isArray(value))
    return value.some((item) => containsCredentialShape(item))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, child]) =>
        (SECRET_KEY_RE.test(key) && child !== '[REDACTED]') ||
        containsCredentialShape(child),
    )
  }
  if (typeof value !== 'string' || value === '[REDACTED]') return false
  const withoutMarkers = value.replaceAll('[REDACTED]', '')
  return (
    /\bBearer\s+[A-Za-z0-9._~+/-]+/i.test(withoutMarkers) ||
    /^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]+:[^/@\s]+@/i.test(withoutMarkers) ||
    /[?&](?:access_token|token|api[_-]?key|secret|password|credential)=[^&#\s]+/i.test(
      withoutMarkers,
    ) ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(withoutMarkers))
  )
}

export function redactSecrets(value, key = '') {
  if (SECRET_KEY_RE.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSecrets(child, childKey),
      ]),
    )
  }
  return typeof value === 'string' ? redactString(value) : value
}

export function classifyHost(host) {
  const value = String(host ?? '')
    .trim()
    .toLowerCase()
  if (
    !value ||
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '::1'
  )
    return 'LOCAL'
  if (value === 'cairn-tm-v3-mysql' || value === 'tm-v3-staging')
    return 'STAGING'
  if (
    value === 'task-manager.mfsdev.net' ||
    value.includes('production') ||
    value.includes('prod')
  ) {
    return 'PRODUCTION'
  }
  return 'UNKNOWN_REMOTE'
}

/**
 * @param {{
 *   observedAt?: string,
 *   environments?: Array<object>,
 *   knownSurfaces?: Array<object>,
 *   metadata?: object,
 * }} [opts]
 */
export function captureEnvironmentTable(opts = {}) {
  const observedAt = opts.observedAt ?? new Date().toISOString()
  const environments = redactSecrets(opts.environments ?? DEFAULT_ENVIRONMENTS)
  const knownSurfaces = redactSecrets(
    opts.knownSurfaces ?? DEFAULT_KNOWN_SURFACES,
  )
  const metadata = redactSecrets(opts.metadata ?? {})
  const errors = []
  if (!isStrictIsoTimestamp(observedAt)) errors.push('OBSERVED_AT_INVALID')
  const ids = environments.map((row) => row.id)
  for (const required of REQUIRED_ENVIRONMENTS) {
    if (ids.filter((id) => id === required).length !== 1)
      errors.push(`ENVIRONMENT_${required.toUpperCase()}_COUNT_INVALID`)
  }
  const expectedClasses = {
    local: 'LOCAL',
    staging: 'STAGING',
    production: 'PRODUCTION',
  }
  for (const row of environments) {
    if (expectedClasses[row.id] && row.hostClass !== expectedClasses[row.id]) {
      errors.push(
        `ENVIRONMENT_${String(row.id).toUpperCase()}_HOST_CLASS_INVALID`,
      )
    }
    const missing = ENVIRONMENT_REQUIRED_ROW_FIELDS.filter(
      (field) => !row[field],
    )
    if (missing.length) {
      errors.push(`ENVIRONMENT_${String(row.id).toUpperCase()}_FIELDS_MISSING`)
    }
  }
  for (const field of [
    'databaseClass',
    'dataClass',
    'appWriteAuthority',
    'schemaWriteAuthority',
    'boardSyncAuthority',
  ]) {
    const values = new Set(environments.map((row) => row[field]))
    if (values.size !== REQUIRED_ENVIRONMENTS.length) {
      errors.push('ENVIRONMENT_AUTHORITY_COLLAPSE')
    }
  }
  for (const surface of knownSurfaces) {
    if (!surface?.id || !surface?.baseUrl || !surface?.hostClass) {
      errors.push('KNOWN_SURFACE_FIELDS_MISSING')
    }
  }
  const credentialLeak = containsCredentialShape({
    environments,
    knownSurfaces,
    metadata,
  })
  if (credentialLeak) errors.push('SECRET_REDACTION_FAILED')
  return {
    schemaVersion: SCHEMA_VERSION,
    observedAt,
    environments,
    knownSurfaces,
    metadata,
    classCoverage: Object.fromEntries(
      environments.map((row) => [row.id, row.hostClass]),
    ),
    urlCoverage: Object.fromEntries(
      [...environments, ...knownSurfaces]
        .filter((row) => row?.id && row?.baseUrl)
        .map((row) => [row.id, row.baseUrl]),
    ),
    secretsRedacted: !credentialLeak,
    nonMutating: true,
    errors: [...new Set(errors)],
    verdict: errors.length ? 'FAIL' : 'PASS',
  }
}

export function main(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node qa/evidence/capture-environment-table.mjs [--metadata-json PATH] [--observed-at ISO]\n',
    )
    return 0
  }
  let metadata = {}
  const metadataPath = valueAfter('--metadata-json')
  if (metadataPath)
    metadata = JSON.parse(readFileSync(resolve(metadataPath), 'utf8'))
  const report = captureEnvironmentTable({
    observedAt: valueAfter('--observed-at'),
    metadata,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.verdict === 'PASS' ? 0 : 1
}

const isDirect =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirect) process.exitCode = main()
