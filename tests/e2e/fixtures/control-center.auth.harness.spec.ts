/**
 * C3-W1 / C3-R2D authenticated multi-viewport harness for control-center IA.
 * Matched by chromium-1440/1024/390/360 (requires setup-auth storageState).
 *
 * Runtime is honestly blocked when CAIRN_E2E_* credentials / storageState are
 * unavailable — this file must remain listable and fail-closed (no ambient prod).
 * Full lifecycle + isolated seed: qa/e2e/flows/deterministic-control-center-harness.mjs
 */
import { expect, test } from '@playwright/test'

import {
  assertAuthenticatedOwnerShell,
  assertAxeZeroCriticalSerious,
  assertFocusVisible,
  assertNoDocumentOverflow,
  assertNoHorizontalOverflow,
  assertNotLoginCapture,
  buildManifestRow,
  hasE2ECredentials,
  resolveWebBase,
  setPageZoom,
  validateManifestRow,
} from './index'

const BOARD = process.env.BOARD_ID?.trim() || 'mfs-rebuild'

const PRIMARY_PATHS = [
  `/b/${BOARD}/`,
  `/b/${BOARD}/work`,
  `/b/${BOARD}/priority`,
  `/b/${BOARD}/evidence`,
] as const

test.describe('C3-W1 control-center auth harness', () => {
  test.beforeEach(() => {
    if (!hasE2ECredentials()) {
      test.skip(
        true,
        'FAIL-CLOSED harness: CAIRN_E2E_USERNAME/PASSWORD unset — listable but runtime-blocked',
      )
    }
  })

  test('OWNER_TARGET + navigate Overview/Work/Priority/Evidence', async ({ page }, testInfo) => {
    // eslint-disable-next-line no-console
    console.log(
      `OWNER_TARGET: {base_url: ${resolveWebBase()}, port: derived, account: CAIRN_E2E_USERNAME, device: ${testInfo.project.name}}`,
    )

    for (const path of PRIMARY_PATHS) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      const auth = await assertAuthenticatedOwnerShell(page, { boardId: BOARD })
      assertNotLoginCapture({ url: auth.url, filename: path })
      await expect(page.locator('.sidebar a.nav-item .lbl', { hasText: 'Overview' })).toBeVisible()
      await expect(page.locator('.sidebar a.nav-item .lbl', { hasText: 'Work' })).toBeVisible()
      await expect(page.locator('.sidebar a.nav-item .lbl', { hasText: 'Priority' })).toBeVisible()
      await expect(
        page.locator('.sidebar a.nav-item .lbl', { hasText: 'Evidence / Audit' }),
      ).toBeVisible()
    }
  })

  test('mission landmarks + no horizontal overflow @ viewport', async ({ page }) => {
    await page.goto(`/b/${BOARD}/`, { waitUntil: 'domcontentloaded' })
    await assertAuthenticatedOwnerShell(page, { boardId: BOARD })
    await expect(page.locator('[data-testid="control-center-overview"]')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('[data-testid="control-center-overview"]')).toHaveAttribute(
      'data-surface-state',
      /.+/,
    )
    await assertNoDocumentOverflow(page)
  })

  test('200% zoom reflow on Overview', async ({ page }) => {
    await page.goto(`/b/${BOARD}/`, { waitUntil: 'domcontentloaded' })
    await assertAuthenticatedOwnerShell(page, { boardId: BOARD })
    await setPageZoom(page, 2)
    await assertNoHorizontalOverflow(page)
  })

  test('keyboard focus after Tab', async ({ page }) => {
    await page.goto(`/b/${BOARD}/`, { waitUntil: 'domcontentloaded' })
    await assertAuthenticatedOwnerShell(page, { boardId: BOARD })
    await page.keyboard.press('Tab')
    await assertFocusVisible(page)
  })

  test('axe zero critical/serious on Overview', async ({ page }) => {
    await page.goto(`/b/${BOARD}/`, { waitUntil: 'domcontentloaded' })
    await assertAuthenticatedOwnerShell(page, { boardId: BOARD })
    await assertAxeZeroCriticalSerious(page)
  })

  test('screenshot-manifest capture hooks (pins PRESENT when seeded)', async ({}, testInfo) => {
    const seededPins = process.env.CAIRN_HARNESS_PINS_JSON
      ? (JSON.parse(process.env.CAIRN_HARNESS_PINS_JSON) as {
          canonicalSnapshotId: string
          canonicalHash: string
          boardRev: string
          lifecycleRev: string
        })
      : undefined
    const row = buildManifestRow({
      route: `/b/${BOARD}/`,
      state: 'populated',
      viewport: `${testInfo.project.use?.viewport?.width ?? 0}x${testInfo.project.use?.viewport?.height ?? 0}`,
      browserTestId: `cc-w1-${testInfo.project.name}`,
      accessibilityResult: 'qa/e2e/out/axe/placeholder.json',
      missionQuestionLink: 'Q1',
      pins: seededPins,
    })
    expect(validateManifestRow(row)).toEqual([])
    // Valid isolated seed → PRESENT; without seed env pins stay MISSING (honest).
    if (seededPins) {
      expect(row.pinFields).toBe('PRESENT')
    } else {
      expect(row.pinFields).toBe('MISSING')
    }
  })
})
