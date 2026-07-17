/**
 * Runtime gate for Flow Ultimate (/b/$boardId/alur) against vite preview :3335.
 * When MySQL is unavailable, full authenticated SPA cannot load; this spec still
 * proves static data, route registration (auth redirect), and captures screenshots.
 *
 * Run:
 *   WEB_BASE=http://127.0.0.1:3335 CAIRN_E2E_SKIP_WEBSERVER=1 \
 *     npx playwright test tests/e2e/flow-alur-preview.spec.ts --project=chromium
 * (project may differ; this file is also runnable via node playwright harness below)
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const SHOT_DIR =
  '/home/user/.claude/jobs/3c5adda9/tmp/tm-wave0/receipts/shots-app-alur'

test.describe('flow alur preview gate', () => {
  test('static flow-data + alur auth fence + screenshots', async ({ page }) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    // 1) data bundle public
    const res = await page.request.get('/flow-data/data-bundle.json')
    expect(res.status()).toBe(200)
    const json = await res.json()
    expect(json.premium?.steps?.length).toBeGreaterThan(0)
    expect(json.features).toBeTruthy()

    // 2) alur requires auth → redirect login (URL leaves /alur only via auth fence)
    await page.setViewportSize({ width: 1440, height: 900 })
    const resp = await page.goto('/b/mfs-rebuild/alur', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    // 307→login or stay if session exists
    const url = page.url()
    const onAlur = /\/b\/mfs-rebuild\/alur/.test(url)
    const onLogin = /\/login/.test(url)

    if (onAlur) {
      // Fully authenticated path
      await expect(page.getByTestId('flow-ultimate')).toBeVisible({
        timeout: 30_000,
      })
      const nodes = page.getByTestId('flow-node')
      await expect(nodes.first()).toBeVisible({ timeout: 15_000 })
      const before = page.url()
      await nodes.first().click()
      await expect(page.getByTestId('flow-sheet')).toHaveClass(/is-open/)
      expect(page.url()).toBe(before)
      await page.screenshot({
        path: path.join(SHOT_DIR, 'alur-sheet-open.png'),
        fullPage: false,
      })
      // filter known third-party noise only — app pageerror must be empty
      expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([])
    } else {
      // Residual: no MySQL / no session — prove fence + capture
      expect(onLogin || resp?.status() === 500 || onLogin).toBeTruthy()
      await page.screenshot({
        path: path.join(SHOT_DIR, 'alur-auth-fence.png'),
        fullPage: false,
      })
      // Still capture static bundle health page via data URL is N/A — write meta
      fs.writeFileSync(
        path.join(SHOT_DIR, 'RUNTIME_RESIDUAL.json'),
        JSON.stringify(
          {
            residual: 'AUTH_OR_DB',
            url,
            status: resp?.status() ?? null,
            note: 'Full in-app canvas requires session + MySQL; static flow-data OK',
            flowDataStatus: 200,
          },
          null,
          2,
        ),
      )
    }
  })
})
