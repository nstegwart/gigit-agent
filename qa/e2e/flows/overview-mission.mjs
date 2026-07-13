#!/usr/bin/env node
/**
 * Promoted flow entrypoint: board overview / mission surface (extends tests/e2e/board.spec + smoke).
 * Requires auth storageState. Does not rewrite existing Playwright specs.
 *
 * Env: WEB_BASE, HEADED, BOARD_ID, CAIRN_E2E_* (via prior auth-login)
 */
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import {
  printOwnerTarget,
  resolveBoardId,
  resolveHeaded,
  resolveWebBase,
} from '../lib/env.mjs'

async function main() {
  const board = resolveBoardId()
  printOwnerTarget({ flow: 'overview-mission', board })
  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({
    baseURL: resolveWebBase(),
    viewport: { width: 1440, height: 900 },
    storageState: requireExistingStorageState(AUTH_STORAGE_STATE_PATH),
  })
  const page = await context.newPage()
  try {
    await page.goto(`/b/${board}/`, { waitUntil: 'domcontentloaded' })
    // Reuse smoke/board surface signals — fail if login redirected.
    if (page.url().includes('/login')) {
      throw new Error('FAIL-CLOSED: redirected to /login — storageState invalid or expired')
    }
    const brand = page.locator('.brand-name')
    await brand.waitFor({ state: 'visible', timeout: 30_000 })
    const brandText = (await brand.first().textContent())?.trim()
    if (brandText !== 'Cairn') {
      throw new Error(`expected brand Cairn, got ${JSON.stringify(brandText)}`)
    }
    const smoke = page.getByTestId('board-smoke')
    if ((await smoke.count()) > 0) {
      await smoke.first().waitFor({ state: 'visible', timeout: 15_000 })
    }
    const kpi = page.locator('.kpi-num').first()
    if ((await kpi.count()) > 0) {
      await kpi.waitFor({ state: 'visible', timeout: 15_000 })
    }
    console.log(`OK overview-mission board=${board} url=${page.url()}`)
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
