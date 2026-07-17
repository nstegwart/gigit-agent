#!/usr/bin/env node
/**
 * TM-10 residual: LIVE axe WCAG + visual capture for public unauth surfaces.
 *
 * Produces program-emitted JSON under qa/evidence/ (not static baseline stubs).
 * No login / no storageState. Headless by default.
 *
 * Usage:
 *   WEB_BASE=https://task-manager.mfsdev.net node qa/evidence/public-axe-visual-live.mjs
 *   WEB_BASE=… node qa/evidence/public-axe-visual-live.mjs --out qa/evidence/axe-visual-live.json
 *
 * Exit 0 = ran without crash and wrote JSON (findings or clean). Exit 1 = crash / no write.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const DEFAULT_OUT = path.join(REPO_ROOT, 'qa/evidence/axe-visual-live.json')
const SHOT_DIR = path.join(REPO_ROOT, 'qa/evidence/public-live-shots')
const AXE_DIR = path.join(REPO_ROOT, 'qa/evidence/public-live-axe')

const DEFAULT_WEB_BASE = 'https://task-manager.mfsdev.net'
const DEFAULT_BOARD = 'mfs-rebuild'

/** Public S-id surfaces reachable without login (UI5 residual). */
export const PUBLIC_LIVE_SIDS = Object.freeze([
  {
    id: 'S-PUB-LOGIN-D',
    route: '/login',
    viewport: '1440x900',
    intent: 'Login shell id-ID (desktop)',
  },
  {
    id: 'S-PUB-LOGIN-M',
    route: '/login',
    viewport: '390x844',
    intent: 'Login shell id-ID (mobile)',
  },
  {
    id: 'S-PUB-FEATURES',
    route: '/public/features?boardId={board}',
    viewport: '1280x800',
    intent: 'Public features list unauth',
  },
  {
    id: 'S-PUB-FEATURE-DETAIL',
    route: '/public/features/FC-AFF-MEMBER-REFERRAL?boardId={board}',
    viewport: '1280x800',
    intent: 'Public feature detail + progress nodes unauth',
  },
])

const AXE_TAGS = Object.freeze([
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
])

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return fallback
}

function resolveWebBase() {
  return (process.env.WEB_BASE?.trim() || DEFAULT_WEB_BASE).replace(/\/$/, '')
}

function resolveBoardId() {
  return process.env.BOARD_ID?.trim() || DEFAULT_BOARD
}

function resolveFullSha() {
  const env = process.env.FULL_SHA?.trim() || process.env.GIT_SHA?.trim()
  if (env && /^[0-9a-f]{40}$/i.test(env)) return env.toLowerCase()
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : 'UNKNOWN_SHA'
  } catch {
    return 'UNKNOWN_SHA'
  }
}

function parseViewport(token) {
  const m = String(token).match(/^(\d+)x(\d+)$/i)
  if (!m) throw new Error(`invalid viewport: ${token}`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

function resolveRoute(template, boardId) {
  return String(template).replaceAll('{board}', boardId)
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runPublicLive(opts = {}) {
  const webBase = opts.webBase ?? resolveWebBase()
  const boardId = opts.boardId ?? resolveBoardId()
  const fullSha = opts.fullSha ?? resolveFullSha()
  const outPath = opts.outPath ?? arg('--out', DEFAULT_OUT)
  const headed =
    process.env.HEADED === '1' ||
    process.env.HEADED === 'true' ||
    process.argv.includes('--headed')

  const ownerTarget = {
    base_url: webBase,
    port: webBase.startsWith('https') ? 443 : 80,
    account: 'n/a',
    device: headed ? 'playwright-headed' : 'playwright-headless',
  }
  console.log(`OWNER_TARGET: ${JSON.stringify(ownerTarget)}`)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(AXE_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const { chromium } = await import('@playwright/test')
  const AxeBuilder = (await import('@axe-core/playwright')).default

  const browser = await chromium.launch({ headless: !headed })
  /** @type {Array<Record<string, unknown>>} */
  const results = []
  /** @type {string[]} */
  const findings = []
  let crashed = false
  let crashError = null

  try {
    const context = await browser.newContext({
      baseURL: webBase,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()

    for (const sid of PUBLIC_LIVE_SIDS) {
      const route = resolveRoute(sid.route, boardId)
      const vp = parseViewport(sid.viewport)
      const axePath = path.join(AXE_DIR, `axe-${sid.id}.json`)
      const shotPath = path.join(SHOT_DIR, `visual-${sid.id}.png`)
      /** @type {Record<string, unknown>} */
      const row = {
        artSid: sid.id,
        route,
        viewport: sid.viewport,
        intent: sid.intent,
        finalUrl: null,
        httpOk: false,
        axe: null,
        visual: null,
        ok: false,
      }

      try {
        await page.setViewportSize(vp)
        const resp = await page.goto(route, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        })
        // Give SPA hydrate a moment (public surfaces are client-rendered).
        await page.waitForTimeout(1200)
        row.finalUrl = page.url()
        row.httpOk = Boolean(resp && resp.ok())
        if (!row.httpOk) {
          findings.push(`${sid.id}: HTTP not ok status=${resp?.status() ?? 'null'}`)
        }

        // Live axe
        const axeBuilder = new AxeBuilder({ page }).withTags([...AXE_TAGS])
        const axeResults = await axeBuilder.analyze()
        const criticalSerious = (axeResults.violations ?? []).filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        )
        const axePayload = {
          browserTestId: `axe-${sid.id}`,
          artSid: sid.id,
          url: page.url(),
          route,
          viewport: sid.viewport,
          fullSha,
          boardId,
          timestamp: new Date().toISOString(),
          live: true,
          tags: [...AXE_TAGS],
          criticalSeriousCount: criticalSerious.length,
          violationCount: (axeResults.violations ?? []).length,
          violations: (axeResults.violations ?? []).map((v) => ({
            id: v.id,
            impact: v.impact,
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: (v.nodes ?? []).slice(0, 5).map((n) => ({
              html: n.html?.slice?.(0, 200) ?? n.html,
              target: n.target,
              failureSummary: n.failureSummary?.slice?.(0, 300),
            })),
          })),
        }
        fs.writeFileSync(axePath, `${JSON.stringify(axePayload, null, 2)}\n`, 'utf8')
        row.axe = {
          path: axePath,
          criticalSeriousCount: criticalSerious.length,
          violationCount: axePayload.violationCount,
          claim: criticalSerious.length === 0 ? 'PASS' : 'FAIL',
        }
        if (criticalSerious.length > 0) {
          findings.push(
            `${sid.id}: axe critical/serious=${criticalSerious.length} ids=${criticalSerious.map((v) => v.id).join(',')}`,
          )
        }

        // Live visual capture (receipt + PNG hash — not static baseline compare)
        await page.screenshot({ path: shotPath, fullPage: false })
        const pngSha = sha256File(shotPath)
        const stat = fs.statSync(shotPath)
        row.visual = {
          path: shotPath,
          bytes: stat.size,
          sha256: pngSha,
          claim: 'LIVE_CAPTURE',
          note: 'Live screenshot receipt; not compared to static baseline',
        }

        row.ok = row.httpOk === true
        // Surface still "ok" for harness purposes if we got axe+shot even with a11y findings
        if (row.axe && row.visual) {
          row.ran = true
        }
      } catch (err) {
        row.error = String(/** @type {Error} */ (err).message ?? err)
        findings.push(`${sid.id}: ${row.error}`)
        row.ok = false
      }
      results.push(row)
    }

    await context.close()
  } catch (err) {
    crashed = true
    crashError = String(/** @type {Error} */ (err).stack || err)
  } finally {
    await browser.close().catch(() => {})
  }

  const axeFailed = results.filter(
    (r) => r.axe && /** @type {{ claim?: string }} */ (r.axe).claim === 'FAIL',
  ).length
  const ran = results.filter((r) => r.ran || r.axe).length
  const summary = {
    schemaVersion: 'TM_PUBLIC_AXE_VISUAL_LIVE_V1',
    gate: 'TM10_PUBLIC_AXE_VISUAL_LIVE',
    mode: 'live',
    live: true,
    staticBaseline: false,
    generatedAt: new Date().toISOString(),
    OWNER_TARGET: ownerTarget,
    webBase,
    boardId,
    fullSha,
    sidCount: PUBLIC_LIVE_SIDS.length,
    ran,
    axePass: results.filter(
      (r) => r.axe && /** @type {{ claim?: string }} */ (r.axe).claim === 'PASS',
    ).length,
    axeFail: axeFailed,
    visualLiveCaptures: results.filter((r) => r.visual).length,
    crashed,
    crashError,
    findings,
    results,
    // Harness green = executed without crash and wrote per-SID live JSON.
    // Axe FAIL is a real finding list, not a harness crash.
    harnessOk: !crashed && ran === PUBLIC_LIVE_SIDS.length,
    residual_gaps:
      crashed
        ? `harness crash: ${crashError}`
        : findings.length === 0
          ? 'none for public live axe/visual capture'
          : findings.join(' | '),
  }

  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  summary.outPath = outPath
  return summary
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Usage:
  WEB_BASE=https://task-manager.mfsdev.net node qa/evidence/public-axe-visual-live.mjs
  node qa/evidence/public-axe-visual-live.mjs --out qa/evidence/axe-visual-live.json
`)
    process.exit(0)
  }
  try {
    const summary = await runPublicLive()
    console.log(JSON.stringify(summary, null, 2))
    process.exit(summary.harnessOk ? 0 : 1)
  } catch (err) {
    console.error(String(/** @type {Error} */ (err).stack || err))
    process.exit(1)
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
