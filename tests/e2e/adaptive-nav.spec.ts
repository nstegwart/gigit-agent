// Adaptive-nav E2E (Batch 5 multi-board + control-center IA for mfs-rebuild).
//
// Classic boards (ibils): data/boards.json `views` array drives which sidebar tabs
// render (AppShell.NAV + the adaptive `visible` filter). Boards without a "board"
// view redirect their bare `/b/<id>/` index to the first enabled view.
//   - ibils views: board, agents, projects, features, map, design, decisions, log
//
// Control-center boards (mfs-rebuild): UI_CONTRACT §2 nine primary IA — always shown
// via AppShell.CONTROL_CENTER_NAV (views filter bypassed). Bare index stays Overview
// (no adaptive redirect to tasks). Labels (exact English `.lbl` order):
//   Overview, Work, Priority, Projects, Features / Flows, Agents / Runs,
//   Ops / Accounts, Decisions, Evidence / Audit
// Sidebar ops label is "Ops / Accounts" (not legacy "Accounts"); there is no "Tasks" tab.
import { expect, test, type Locator, type Page } from '@playwright/test'

/** Exact English labels for control-center boards (AppShell.CONTROL_CENTER_NAV_LABELS). */
const CONTROL_CENTER_NAV_LABELS = [
  'Overview',
  'Work',
  'Priority',
  'Projects',
  'Features / Flows',
  'Agents / Runs',
  'Ops / Accounts',
  'Decisions',
  'Evidence / Audit',
] as const

// A sidebar nav item selected by its exact `.lbl` text (stable across trailing-slash
// / href differences). Scoped to `.sidebar a.nav-item` so page-body links never match.
function navItem(page: Page, label: string): Locator {
  return page.locator('.sidebar a.nav-item', {
    has: page.locator('.lbl', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  })
}

test.describe('adaptive sidebar nav', () => {
  test('ibils board shows Features, hides Accounts/Production', async ({ page }) => {
    await page.goto('/b/ibils/')

    // Sidebar chrome present.
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.brand-name')).toHaveText('Cairn')

    // ibils enables `features` -> the Features tab renders.
    await expect(navItem(page, 'Features')).toBeVisible()

    // ibils does NOT enable ops/prod -> Accounts/Production tabs absent entirely.
    // (CC boards use "Ops / Accounts"; classic label remains "Accounts".)
    await expect(navItem(page, 'Accounts')).toHaveCount(0)
    await expect(navItem(page, 'Production')).toHaveCount(0)
  })

  test('mfs-rebuild board shows nine control-center IA (Overview, Ops / Accounts, Features / Flows)', async ({
    page,
  }) => {
    await page.goto('/b/mfs-rebuild/projects')

    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('[data-control-center="true"]').first()).toBeVisible()

    // All nine primary IA destinations present (UI_CONTRACT §2).
    for (const label of CONTROL_CENTER_NAV_LABELS) {
      await expect(navItem(page, label)).toBeVisible()
    }

    // Spot-check named contract labels from the task text.
    await expect(navItem(page, 'Overview')).toBeVisible()
    await expect(navItem(page, 'Ops / Accounts')).toBeVisible()
    await expect(navItem(page, 'Features / Flows')).toBeVisible()

    // Legacy Batch-5 adaptive labels must NOT drive the CC sidebar.
    await expect(navItem(page, 'Tasks')).toHaveCount(0)
    await expect(navItem(page, 'Accounts')).toHaveCount(0)
    await expect(navItem(page, 'Map')).toHaveCount(0)
    // Classic "Features" alone is not a CC label (CC uses "Features / Flows").
    await expect(navItem(page, 'Features')).toHaveCount(0)
  })
})

test.describe('adaptive board-index redirect', () => {
  test('mfs-rebuild bare index stays on Overview (no Tasks redirect)', async ({ page }) => {
    await page.goto('/b/mfs-rebuild/')

    // Control-center boards render Overview at bare index — no adaptive Navigate
    // to tasks/ops. URL must remain the board root (optional trailing slash).
    await expect(page).toHaveURL(/\/b\/mfs-rebuild\/?$/)

    // Overview chrome: active nav + bilingual page title (SECTION_TITLE + id-ID).
    await expect(navItem(page, 'Overview')).toHaveClass(/active/)
    await expect(page.locator('#page-title')).toHaveText(/Overview/)

    // Surface assertion: control-center shell + overview route (not board KPI strip).
    await expect(page.locator('.app--control-center, [data-control-center="true"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="board-smoke"]')).toHaveCount(0)
  })

  test('ibils bare index stays on the Board home KPI view', async ({ page }) => {
    await page.goto('/b/ibils/')

    // ibils enables "board" -> no redirect; the Board home body (KPI strip) renders.
    await expect(page).toHaveURL(/\/b\/ibils\/?$/)
    await expect(page.locator('[data-testid="board-smoke"]')).toBeVisible()
  })
})
