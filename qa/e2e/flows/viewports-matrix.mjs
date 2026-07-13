#!/usr/bin/env node
/**
 * Promoted flow: open a route at 1440/1024/390/360 and assert no horizontal overflow.
 * Env: WEB_BASE, HEADED, ROUTE, BOARD_ID; use --unauth for /login
 */
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import {
  printOwnerTarget,
  resolveBoardId,
  resolveHeaded,
  resolveWebBase,
} from '../lib/env.mjs'
import { VIEWPORTS, assertNoDocumentOverflow, setViewport } from '../lib/overflow.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

async function main() {
  const unauth = process.argv.includes('--unauth')
  const route =
    arg('--route', process.env.ROUTE) ||
    (unauth ? '/login' : `/b/${resolveBoardId()}/`)
  printOwnerTarget({ flow: 'viewports-matrix', route })

  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const contextOpts = { baseURL: resolveWebBase() }
  if (!unauth) {
    contextOpts.storageState = requireExistingStorageState(AUTH_STORAGE_STATE_PATH)
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  try {
    for (const [name, size] of Object.entries(VIEWPORTS)) {
      await setViewport(page, size)
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await assertNoDocumentOverflow(page)
      console.log(`OK viewport ${name} route=${route}`)
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
