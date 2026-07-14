/**
 * Fail-closed login → storageState writer for promoted flows.
 * Zero-user iso DBs: same form is product first-admin bootstrap.
 * Prefer process-local CAIRN_E2E_* from auth-fixture ensureAuthSecretsInEnv.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { requireE2ECredentials, resolveWebBase } from './env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const AUTH_STORAGE_STATE_PATH = path.resolve(
  __dirname,
  '../fixtures/storage/admin.json',
)
export const SESSION_COOKIE_NAME = 'cairn_session'

/** Re-export MCP header helper for flows that share auth surface. */
export { mcpAuthHeaders, ensureAuthSecretsInEnv } from './auth-fixture.mjs'

export function ensureAuthStorageDir() {
  fs.mkdirSync(path.dirname(AUTH_STORAGE_STATE_PATH), { recursive: true })
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} [outPath]
 */
/** Fill controlled React inputs so canSubmit enables. */
async function fillReactInput(page, selector, value) {
  const loc = page.locator(selector)
  await loc.waitFor({ state: 'visible', timeout: 30_000 })
  await loc.click()
  await loc.evaluate((el, v) => {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    desc?.set?.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

export async function loginAndSaveStorageState(page, outPath = AUTH_STORAGE_STATE_PATH) {
  const { username, password } = requireE2ECredentials()
  ensureAuthStorageDir()
  const base = resolveWebBase()

  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('.auth-card').waitFor({ state: 'visible', timeout: 30_000 })

  await fillReactInput(page, 'input[autocomplete="username"]', username)
  await fillReactInput(page, 'input[type="password"]', password)
  const submit = page.locator('button.auth-submit')
  await submit.waitFor({ state: 'visible', timeout: 15_000 })
  // Fail closed if still disabled after React fill
  const disabled = await submit.isDisabled()
  if (disabled) {
    throw new Error(
      'FAIL-CLOSED auth: auth-submit still disabled after fill (React state not updated or validation failed)',
    )
  }
  await submit.click()

  await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page
      .locator('.auth-err')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(async () => {
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
      `FAIL-CLOSED auth: cookie ${SESSION_COOKIE_NAME} missing after login — refusing ambient session`,
    )
  }

  await page.context().storageState({ path: outPath })
  return outPath
}

export function requireExistingStorageState(filePath = AUTH_STORAGE_STATE_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `FAIL-CLOSED auth: storageState missing at ${filePath}. Run qa/e2e/flows/auth-login.mjs first.`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    throw new Error(`FAIL-CLOSED auth: storageState unreadable at ${filePath}: ${String(e)}`)
  }
  const hasSession = (parsed.cookies ?? []).some(
    (c) => c.name === SESSION_COOKIE_NAME && Boolean(c.value),
  )
  if (!hasSession) {
    throw new Error(
      `FAIL-CLOSED auth: ${filePath} has no ${SESSION_COOKIE_NAME} cookie — refusing empty state`,
    )
  }
  return filePath
}
