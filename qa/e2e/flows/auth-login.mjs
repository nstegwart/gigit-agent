#!/usr/bin/env node
/**
 * Promoted flow: fail-closed login → qa/e2e/fixtures/storage/admin.json
 *
 * Env:
 *   WEB_BASE (default http://127.0.0.1:3210)
 *   HEADED=1
 *   CAIRN_E2E_USERNAME / CAIRN_E2E_PASSWORD (required, synthetic)
 *
 * Does not create users. Does not access production.
 */
import { chromium } from '@playwright/test'

import { loginAndSaveStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import { printOwnerTarget, resolveHeaded, resolveWebBase } from '../lib/env.mjs'

async function main() {
  printOwnerTarget({ flow: 'auth-login' })
  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({
    baseURL: resolveWebBase(),
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  try {
    const out = await loginAndSaveStorageState(page, AUTH_STORAGE_STATE_PATH)
    console.log(`OK storageState written: ${out}`)
    process.exitCode = 0
  } catch (e) {
    console.error(String(e?.stack || e))
    process.exitCode = 1
  } finally {
    await context.close()
    await browser.close()
  }
}

main()
