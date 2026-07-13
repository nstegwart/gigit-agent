#!/usr/bin/env node
/**
 * Promoted flow: screenshot + manifest row collector (UI_CONTRACT §13).
 * Foundation stage: writes real screenshots only when --capture is set and server is up.
 * Pin fields default MISSING — never fabricates boardRev/lifecycleRev/canonical*.
 *
 * Env: WEB_BASE, STAGING_URL, FULL_SHA, BOARD_ID, HEADED
 * Usage:
 *   node qa/e2e/flows/screenshot-manifest-capture.mjs --dry-run
 *   node qa/e2e/flows/screenshot-manifest-capture.mjs --capture --route /login --unauth --state populated --viewport 1440x900
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import { runAxe } from '../lib/axe.mjs'
import {
  printOwnerTarget,
  resolveBoardId,
  resolveFullSha,
  resolveHeaded,
  resolveSchemaVersion,
  resolveStagingUrl,
  resolveWebBase,
} from '../lib/env.mjs'
import {
  ScreenshotManifestCollector,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCHEMA_PATH,
  PIN_MISSING,
} from '../lib/screenshot-manifest.mjs'
import { VIEWPORTS } from '../lib/overflow.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_SHOTS = path.resolve(__dirname, '../out/screenshots')
const OUT_AXE = path.resolve(__dirname, '../out/axe')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function dryRunCoreRows() {
  const board = resolveBoardId()
  const collector = new ScreenshotManifestCollector()
  const cores = [
    { route: '/login', state: 'populated', viewport: '1440x900', mission: null, unauth: true },
    { route: `/b/${board}/`, state: 'populated', viewport: '1440x900', mission: 'Q1' },
    { route: `/b/${board}/`, state: 'populated', zoom: '200%', mission: 'Q2' },
    { route: `/b/${board}/agents`, state: 'populated', viewport: '390x844', mission: 'Q2' },
    { route: `/b/${board}/decisions`, state: 'needs-human', viewport: '1440x900', mission: 'Q6' },
  ]
  for (const c of cores) {
    const id = `dry-${c.route.replace(/[^\w]+/g, '_')}-${c.viewport || c.zoom}`
    collector.add({
      route: c.route,
      state: c.state,
      viewport: c.viewport,
      zoom: c.zoom,
      browserTestId: id,
      accessibilityResult: `${OUT_AXE}/${id}.json`,
      missionQuestionLink: c.mission,
      // pins intentionally omitted → MISSING
    })
  }
  const out = collector.write(DEFAULT_MANIFEST_PATH)
  const missingPins = collector.rows.filter((r) => r.pinFields === 'MISSING').length
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        manifest: out,
        schema: DEFAULT_SCHEMA_PATH,
        rows: collector.rows.length,
        pinFieldsMissing: missingPins,
        schemaVersion: resolveSchemaVersion(),
        fullSha: resolveFullSha(),
        stagingUrl: resolveStagingUrl(),
        note: 'No screenshots written; pins MISSING by design (no fabrication)',
      },
      null,
      2,
    ),
  )
}

async function captureOne() {
  const unauth = process.argv.includes('--unauth')
  const route = arg('--route', unauth ? '/login' : `/b/${resolveBoardId()}/`)
  const state = arg('--state', 'populated')
  const viewportName = arg('--viewport', '1440x900')
  const zoom = arg('--zoom', null)
  const mission = arg('--mission', null)
  const size = VIEWPORTS[viewportName] || VIEWPORTS['1440x900']

  printOwnerTarget({ flow: 'screenshot-manifest-capture', route, capture: true })
  const headed = resolveHeaded()
  const browser = await chromium.launch({ headless: !headed })
  const contextOpts = {
    baseURL: resolveWebBase(),
    viewport: size,
  }
  if (!unauth) {
    contextOpts.storageState = requireExistingStorageState(AUTH_STORAGE_STATE_PATH)
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  const browserTestId = `cap-${route.replace(/[^\w]+/g, '_')}-${viewportName || zoom || 'vp'}`
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' })
    if (zoom === '200%' || zoom === '2') {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '2'
      })
    }
    fs.mkdirSync(OUT_SHOTS, { recursive: true })
    const shotPath = path.join(OUT_SHOTS, `${browserTestId}.png`)
    await page.screenshot({ path: shotPath, fullPage: true })
    const axe = await runAxe(page, { outPath: OUT_AXE, browserTestId })
    const collector = new ScreenshotManifestCollector()
    // Load existing rows if present
    if (fs.existsSync(DEFAULT_MANIFEST_PATH)) {
      try {
        const prev = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8'))
        for (const r of prev.rows ?? []) collector.rows.push(r)
      } catch {
        /* start fresh */
      }
    }
    collector.add({
      route,
      state,
      viewport: zoom ? undefined : viewportName,
      zoom: zoom || undefined,
      browserTestId,
      accessibilityResult: axe.rawPath || `${OUT_AXE}/${browserTestId}.json`,
      missionQuestionLink: mission,
      screenshotPath: shotPath,
    })
    const out = collector.write(DEFAULT_MANIFEST_PATH)
    console.log(
      JSON.stringify(
        {
          mode: 'capture',
          manifest: out,
          screenshotPath: shotPath,
          axe: axe.rawPath,
          axeOk: axe.ok,
          pinFields: PIN_MISSING,
          note: 'boardRev/lifecycleRev/canonical* left MISSING until UI/MCP pin bridge lands',
        },
        null,
        2,
      ),
    )
    process.exitCode = axe.ok ? 0 : 1
  } catch (e) {
    console.error(String(e?.stack || e))
    process.exitCode = 1
  } finally {
    await context.close()
    await browser.close()
  }
}

async function main() {
  printOwnerTarget({ flow: 'screenshot-manifest-capture' })
  if (process.argv.includes('--capture')) {
    await captureOne()
  } else {
    dryRunCoreRows()
    process.exitCode = 0
  }
}

main()
