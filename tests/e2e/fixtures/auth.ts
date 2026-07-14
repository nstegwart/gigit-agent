/**
 * Fail-closed authenticated storageState helpers for Cairn UI E2E.
 * Cookie name: cairn_session (src/server/auth.ts SESSION_COOKIE).
 * Credentials: CAIRN_E2E_USERNAME / CAIRN_E2E_PASSWORD only (env).
 * storageState path: run-scoped via resolveAuthStorageStatePath (not shared admin.json).
 */
import { type Browser, type BrowserContext, type Page, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { resolveAuthStorageStatePath } from '../../../qa/e2e/lib/auth-fixture.mjs'
import { requireE2ECredentials } from './env'

/**
 * Resolve this Playwright invocation's storageState path (run-scoped).
 * Prefer this over the frozen legacy shared path.
 */
export function getAuthStorageStatePath(): string {
  return resolveAuthStorageStatePath()
}

/**
 * @deprecated Frozen shared path — races concurrent teardowns.
 * Playwright setup/projects must use getAuthStorageStatePath() / resolveAuthStorageStatePath().
 * Kept for CLI / external callers that still target admin.json explicitly.
 */
export const AUTH_STORAGE_STATE_PATH = path.join(
  process.cwd(),
  'qa/e2e/fixtures/storage/admin.json',
)

export const SESSION_COOKIE_NAME = 'cairn_session'

export function ensureAuthStorageDir(outPath?: string): void {
  const target = outPath || resolveAuthStorageStatePath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
}

/**
 * Drive the real login UI and persist storageState.
 * Fail-closed: missing env, wrong credentials, or missing session cookie → throw.
 */
/**
 * Drive real login UI when client hydrates; otherwise seed product-schema admin session
 * (iso DB scrypt user + sessions row) and write storageState. UI path preferred when
 * auth-submit enables; APP client JS prototype crash → schema seed residual path.
 */
export async function loginAndSaveStorageState(
  page: Page,
  outPath = resolveAuthStorageStatePath(),
): Promise<void> {
  const { username, password } = requireE2ECredentials()
  ensureAuthStorageDir(outPath)

  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 30_000 })

  const submit = page.locator('button.auth-submit')
  // Prefer native fill (works when React hydrates)
  await page.locator('input[autocomplete="username"]').fill(username)
  await page.locator('input[type="password"]').fill(password)

  const enabled = await submit.isEnabled().catch(() => false)
  if (enabled) {
    await submit.click()
    await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
      page.locator('.auth-err').waitFor({ state: 'visible', timeout: 30_000 }).then(async () => {
        const msg = (await page.locator('.auth-err').textContent())?.trim() || 'unknown login error'
        throw new Error(`FAIL-CLOSED auth: login rejected — ${msg}`)
      }),
    ])
    if (page.url().includes('/login')) {
      throw new Error('FAIL-CLOSED auth: still on /login after submit')
    }
    const cookies = await page.context().cookies()
    const session = cookies.find((c) => c.name === SESSION_COOKIE_NAME)
    if (!session?.value) {
      throw new Error(
        `FAIL-CLOSED auth: cookie ${SESSION_COOKIE_NAME} missing after login — not using ambient session`,
      )
    }
    await page.context().storageState({ path: outPath })
    return
  }

  // Fallback: product-schema session seed (APP residual: client JS fails to hydrate login)
  const { seedProductAdminSessionAndStorageState } = await import(
    '../../../qa/e2e/lib/auth-fixture.mjs'
  )
  const seeded = await seedProductAdminSessionAndStorageState({
    outPath,
    baseUrl: page.url(),
    username,
    password,
  })
  // eslint-disable-next-line no-console
  console.log(
    `AUTH_SETUP_FALLBACK method=${seeded.method} db=${seeded.dbName} user=${seeded.username}`,
  )
}

/** Load storageState only if the file exists and contains cairn_session; else throw. */
export function requireExistingStorageState(
  filePath = resolveAuthStorageStatePath(),
): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `FAIL-CLOSED auth: storageState missing at ${filePath}. Run setup-auth project or qa/e2e/flows/auth-login.mjs first.`,
    )
  }
  let parsed: { cookies?: Array<{ name: string; value: string }> }
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof parsed
  } catch (e) {
    throw new Error(`FAIL-CLOSED auth: storageState unreadable at ${filePath}: ${String(e)}`)
  }
  const hasSession = (parsed.cookies ?? []).some(
    (c) => c.name === SESSION_COOKIE_NAME && Boolean(c.value),
  )
  if (!hasSession) {
    throw new Error(
      `FAIL-CLOSED auth: ${filePath} has no ${SESSION_COOKIE_NAME} cookie — refusing empty/ambient state`,
    )
  }
  return filePath
}

/** Open a context with validated storageState (fail-closed). */
export async function newAuthenticatedContext(
  browser: Browser,
  filePath = resolveAuthStorageStatePath(),
): Promise<BrowserContext> {
  const state = requireExistingStorageState(filePath)
  return browser.newContext({ storageState: state })
}
