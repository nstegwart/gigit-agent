#!/usr/bin/env node
/**
 * Promoted flow: axe zero critical/serious on a route (AC-UI-06).
 *
 * Env: WEB_BASE, HEADED, CAIRN_E2E_* (for auth routes), ROUTE, BOARD_ID
 * Usage: node qa/e2e/flows/a11y-axe.mjs [--route /login] [--unauth]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import { assertAxeZeroCriticalSerious } from '../lib/axe.mjs'
import {
  printOwnerTarget,
  resolveBoardId,
  resolveHeaded,
  resolveWebBase,
} from '../lib/env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_AXE = path.resolve(__dirname, '../out/axe')

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
  printOwnerTarget({ flow: 'a11y-axe', route, unauth })

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
    await page.goto(route, { waitUntil: 'domcontentloaded' })
    const id = `a11y-${route.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'root'}`
    const result = await assertAxeZeroCriticalSerious(page, {
      outPath: OUT_AXE,
      browserTestId: id,
    })
    console.log(`OK axe zero critical/serious route=${route} raw=${result.rawPath ?? 'n/a'}`)
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
