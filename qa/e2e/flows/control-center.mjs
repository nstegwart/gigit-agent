#!/usr/bin/env node
/**
 * Promoted flow: mfs-rebuild control-center IA (Overview/Work/Priority/Evidence).
 * Env-parameterized only — no embedded account.
 *
 * Env: WEB_BASE, HEADED, BOARD_ID (default mfs-rebuild), CAIRN_E2E_* via prior auth-login
 */
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import {
  printOwnerTarget,
  resolveBoardId,
  resolveHeaded,
  resolveWebBase,
} from '../lib/env.mjs'

const ROUTES = (board) => [
  { path: `/b/${board}/`, label: 'Overview' },
  { path: `/b/${board}/work`, label: 'Work' },
  { path: `/b/${board}/priority`, label: 'Priority' },
  { path: `/b/${board}/evidence`, label: 'Evidence' },
]

async function main() {
  const board = resolveBoardId('mfs-rebuild')
  printOwnerTarget({ flow: 'control-center', board })
  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({
    baseURL: resolveWebBase(),
    viewport: { width: 1440, height: 900 },
    storageState: requireExistingStorageState(AUTH_STORAGE_STATE_PATH),
  })
  const page = await context.newPage()
  try {
    for (const r of ROUTES(board)) {
      await page.goto(r.path, { waitUntil: 'domcontentloaded' })
      if (page.url().includes('/login')) {
        throw new Error(`FAIL-CLOSED: redirected to /login on ${r.path}`)
      }
      const brand = page.locator('.brand-name')
      await brand.waitFor({ state: 'visible', timeout: 30_000 })
      const overviewNav = page.locator('.sidebar a.nav-item .lbl', { hasText: 'Overview' })
      await overviewNav.waitFor({ state: 'visible', timeout: 15_000 })
      console.log(`OK control-center ${r.label} url=${page.url()}`)
    }
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
