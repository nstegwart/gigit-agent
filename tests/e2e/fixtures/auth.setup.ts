/**
 * Playwright setup project: produce fail-closed storageState for authenticated UI runs.
 * Invoked only by projects that list dependencies: ['setup-auth'].
 * Existing 21 specs under tests/e2e/*.spec.ts are NOT forced through this setup.
 */
import { test as setup } from '@playwright/test'

import { AUTH_STORAGE_STATE_PATH, loginAndSaveStorageState } from './auth'

setup('authenticate (CAIRN_E2E_USERNAME/PASSWORD → storageState)', async ({ page }) => {
  await loginAndSaveStorageState(page, AUTH_STORAGE_STATE_PATH)
})
