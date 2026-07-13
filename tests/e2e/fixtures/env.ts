/**
 * Environment helpers for the C3-F5 Playwright / qa/e2e harness.
 * Never embed credentials. Fail closed when required auth env is missing.
 */

export const DEFAULT_WEB_BASE = 'http://127.0.0.1:3210'
export const DEFAULT_PORT = 3210

/** Resolved browser base URL (WEB_BASE wins; else local preview default). */
export function resolveWebBase(): string {
  const raw = process.env.WEB_BASE?.trim()
  if (raw) return raw.replace(/\/$/, '')
  return DEFAULT_WEB_BASE
}

/** HEADED=1|true enables headed browser. */
export function resolveHeaded(): boolean {
  const v = process.env.HEADED?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export type E2ECredentials = {
  username: string
  password: string
}

/**
 * Synthetic local/staging credentials only.
 * Fail-closed: missing either var throws (never ambient empty session).
 */
export function requireE2ECredentials(): E2ECredentials {
  const username = process.env.CAIRN_E2E_USERNAME?.trim() ?? ''
  const password = process.env.CAIRN_E2E_PASSWORD ?? ''
  if (!username || !password) {
    throw new Error(
      [
        'FAIL-CLOSED auth: CAIRN_E2E_USERNAME and CAIRN_E2E_PASSWORD are required.',
        'Set synthetic local/staging credentials in the environment.',
        'Never embed passwords in repo files or ambient browser sessions.',
      ].join(' '),
    )
  }
  return { username, password }
}

/** Soft probe — true only when both env vars are non-empty. */
export function hasE2ECredentials(): boolean {
  const username = process.env.CAIRN_E2E_USERNAME?.trim() ?? ''
  const password = process.env.CAIRN_E2E_PASSWORD ?? ''
  return Boolean(username && password)
}

export function resolveBoardId(defaultId = 'ibils'): string {
  return process.env.BOARD_ID?.trim() || defaultId
}

export function resolveStagingUrl(): string {
  const raw = process.env.STAGING_URL?.trim()
  if (raw) return raw.replace(/\/$/, '')
  return resolveWebBase()
}

export function resolveFullSha(): string {
  return process.env.FULL_SHA?.trim() || process.env.GIT_SHA?.trim() || 'UNKNOWN_SHA'
}

export function resolveSchemaVersion(): string {
  return process.env.SCHEMA_VERSION?.trim() || 'TM_UI_CONTRACT_V1'
}
