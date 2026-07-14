/**
 * Playwright setup project: produce fail-closed storageState for authenticated UI runs.
 * Invoked by projects that list dependencies: ['setup-auth'] (chromium + viewport projects).
 *
 * Against iso DB with zero users, /login is first-admin product bootstrap (same form fields).
 * Credentials: process-local CAIRN_E2E_* from ensureAuthSecretsInEnv / globalSetup.
 * Output: run-scoped `.artifact/e2e-auth-storage-<runId>.json` (gitignored), never the
 * shared admin.json path that concurrent suite teardowns race on.
 */
import { test as setup } from '@playwright/test'

import {
  loadSecretsSidecar,
  resolveAuthStorageStatePath,
} from '../../../qa/e2e/lib/auth-fixture.mjs'
import { loginAndSaveStorageState, requireExistingStorageState } from './auth'
import { requireE2ECredentials } from './env'

setup.setTimeout(120_000)

setup('authenticate (CAIRN_E2E_USERNAME/PASSWORD → storageState)', async ({ page }) => {
  // Align worker env with secrets written by start-auth-preview / config load.
  loadSecretsSidecar()
  requireE2ECredentials()
  const storagePath = resolveAuthStorageStatePath()
  await loginAndSaveStorageState(page, storagePath)
  // Fail-closed: storageState must exist with session cookie
  requireExistingStorageState(storagePath)
})
