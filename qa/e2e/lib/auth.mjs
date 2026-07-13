/**
 * Fail-closed login → storageState writer for promoted flows.
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

export function ensureAuthStorageDir() {
  fs.mkdirSync(path.dirname(AUTH_STORAGE_STATE_PATH), { recursive: true })
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} [outPath]
 */
export async function loginAndSaveStorageState(page, outPath = AUTH_STORAGE_STATE_PATH) {
  const { username, password } = requireE2ECredentials()
  ensureAuthStorageDir()
  const base = resolveWebBase()

  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('.auth-card').waitFor({ state: 'visible', timeout: 30_000 })

  await page.locator('input[autocomplete="username"]').fill(username)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button.auth-submit').click()

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
