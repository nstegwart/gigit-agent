#!/usr/bin/env node
/**
 * Promoted flow: 200% zoom overflow check on core routes (AC-UI-05).
 * Env: WEB_BASE, HEADED, BOARD_ID; --unauth for /login only
 */
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import {
  printOwnerTarget,
  resolveBoardId,
  resolveHeaded,
  resolveWebBase,
} from '../lib/env.mjs'
import { assertNoHorizontalOverflow, withZoom200 } from '../lib/zoom.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

async function main() {
  const unauth = process.argv.includes('--unauth')
  const board = resolveBoardId()
  const routes = unauth
    ? ['/login']
    : [arg('--route', null), `/b/${board}/`, `/b/${board}/agents`].filter(Boolean)

  printOwnerTarget({ flow: 'zoom-200', routes })
  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const contextOpts = {
    baseURL: resolveWebBase(),
    viewport: { width: 1440, height: 900 },
  }
  if (!unauth) {
    contextOpts.storageState = requireExistingStorageState(AUTH_STORAGE_STATE_PATH)
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  try {
    for (const route of routes) {
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await withZoom200(page, async () => {
        await assertNoHorizontalOverflow(page)
      })
      console.log(`OK zoom-200 route=${route}`)
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
