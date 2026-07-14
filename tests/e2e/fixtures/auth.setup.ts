/**
 * Playwright setup project: produce fail-closed storageState for authenticated UI runs.
 * Invoked by projects that list dependencies: ['setup-auth'] (chromium + viewport projects).
 *
 * Against iso DB with zero users, /login is first-admin product bootstrap (same form fields).
 * Credentials: process-local CAIRN_E2E_* from ensureAuthSecretsInEnv / globalSetup.
 * Output: gitignored qa/e2e/fixtures/storage/admin.json
 */
import { test as setup } from '@playwright/test'

import { loadSecretsSidecar } from '../../../qa/e2e/lib/auth-fixture.mjs'
import { AUTH_STORAGE_STATE_PATH, loginAndSaveStorageState } from './auth'
import { requireE2ECredentials } from './env'

setup.setTimeout(120_000)

setup('authenticate (CAIRN_E2E_USERNAME/PASSWORD → storageState)', async ({ page }) => {
  // Align worker env with secrets written by start-auth-preview / config load.
  loadSecretsSidecar()
  requireE2ECredentials()
  await loginAndSaveStorageState(page, AUTH_STORAGE_STATE_PATH)
  // Fail-closed: storageState must exist with session cookie
  const { requireExistingStorageState } = await import('./auth')
  requireExistingStorageState(AUTH_STORAGE_STATE_PATH)
})
