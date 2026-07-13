#!/usr/bin/env node
/**
 * Promoted flow: keyboard Tab/Enter probe on login (unauth) or shell (auth).
 * Env: WEB_BASE, HEADED, CAIRN_E2E_* for --auth
 */
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import { assertFocusVisible, tabN } from '../lib/keyboard.mjs'
import { printOwnerTarget, resolveHeaded, resolveWebBase } from '../lib/env.mjs'

async function main() {
  const useAuth = process.argv.includes('--auth')
  printOwnerTarget({ flow: 'keyboard-nav', auth: useAuth })
  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const contextOpts = {
    baseURL: resolveWebBase(),
    viewport: { width: 1440, height: 900 },
  }
  if (useAuth) {
    contextOpts.storageState = requireExistingStorageState(AUTH_STORAGE_STATE_PATH)
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  try {
    await page.goto(useAuth ? '/' : '/login', { waitUntil: 'domcontentloaded' })
    await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {})
    await tabN(page, 3)
    await assertFocusVisible(page)
    console.log('OK keyboard focus ring after Tab×3')
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
