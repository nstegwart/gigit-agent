/**
 * Environment helpers for the C3-F5 Playwright / qa/e2e harness.
 * Never embed credentials. Fail closed when required auth env is missing.
 *
 * IBILS auth fixture (AC-IBILS-01): process-local CAIRN_E2E_* + CAIRN_MCP_BEARER are
 * materialised by ensureAuthSecretsInEnv (playwright.config) + start-auth-preview iso clone.
 */
import {
  loadSecretsSidecar,
  resolveAuthSecretsSidecarPath,
} from '../../../qa/e2e/lib/auth-fixture.mjs'

export const DEFAULT_WEB_BASE = 'http://127.0.0.1:3210'
export const DEFAULT_PORT = 3210

/** Load process-local run-scoped secrets sidecar into env (workers share via file, mode 600). */
function loadSecretsSidecarIntoEnv(): void {
  try {
    loadSecretsSidecar()
  } catch {
    /* ignore corrupt sidecar — require* will fail closed */
  }
  // Ensure path env is pinned even when sidecar missing (fail-closed callers still see path).
  void resolveAuthSecretsSidecarPath()
}

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
  loadSecretsSidecarIntoEnv()
  const username = process.env.CAIRN_E2E_USERNAME?.trim() ?? ''
  const password = process.env.CAIRN_E2E_PASSWORD ?? ''
  if (!username || !password) {
    throw new Error(
      [
        'FAIL-CLOSED auth: CAIRN_E2E_USERNAME and CAIRN_E2E_PASSWORD are required.',
        'Playwright start-auth-preview / ensureAuthSecretsInEnv should inject process-local synthetics.',
        'Never embed passwords in repo files or ambient browser sessions.',
      ].join(' '),
    )
  }
  return { username, password }
}

/** Soft probe — true only when both env vars are non-empty. */
export function hasE2ECredentials(): boolean {
  loadSecretsSidecarIntoEnv()
  const username = process.env.CAIRN_E2E_USERNAME?.trim() ?? ''
  const password = process.env.CAIRN_E2E_PASSWORD ?? ''
  return Boolean(username && password)
}

/** Soft probe — true when MCP bearer fixture is present for extraHTTPHeaders. */
export function hasMcpBearer(): boolean {
  loadSecretsSidecarIntoEnv()
  return Boolean(process.env.CAIRN_MCP_BEARER?.trim())
}

/**
 * Fail-closed MCP bearer for request fixtures.
 * Prefer project-level extraHTTPHeaders; this is for explicit callers.
 */
export function requireMcpBearer(): string {
  loadSecretsSidecarIntoEnv()
  const bearer = process.env.CAIRN_MCP_BEARER?.trim() ?? ''
  if (!bearer) {
    throw new Error(
      'FAIL-CLOSED mcp-auth: CAIRN_MCP_BEARER required (process-local synthetic from ensureAuthSecretsInEnv).',
    )
  }
  return bearer
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
