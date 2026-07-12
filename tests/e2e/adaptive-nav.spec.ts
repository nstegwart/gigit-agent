// Adaptive-nav E2E (Batch 5 multi-board).
// Each board's data/boards.json `views` array drives which sidebar tabs render
// (AppShell.NAV + the adaptive `visible` filter). Boards without a "board" view
// redirect their bare `/b/<id>/` index to the first enabled view.
//   - ibils     views: board, agents, projects, features, map, design, decisions, log
//   - mfs-rebuild views: tasks, ops, prod, guide, projects, agents  (NO board/features/map)
// Sidebar labels: ops -> "Accounts", prod -> "Production" (see AppShell.NAV).
import { expect, test, type Locator, type Page } from '@playwright/test'

// A sidebar nav item selected by its exact `.lbl` text (stable across trailing-slash
// / href differences). Scoped to `.sidebar a.nav-item` so page-body links never match.
function navItem(page: Page, label: string): Locator {
  return page.locator('.sidebar a.nav-item', {
    has: page.locator('.lbl', { hasText: new RegExp(`^${label}$`) }),
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
    await expect(navItem(page, 'Accounts')).toHaveCount(0)
    await expect(navItem(page, 'Production')).toHaveCount(0)
  })

  test('mfs-rebuild board shows Tasks/Accounts/Production/Guide, hides Features/Map', async ({
    page,
  }) => {
    await page.goto('/b/mfs-rebuild/projects')

    await expect(page.locator('.sidebar')).toBeVisible()

    // mfs-rebuild enables tasks/ops/prod/guide -> all four tabs render.
    await expect(navItem(page, 'Tasks')).toBeVisible()
    await expect(navItem(page, 'Accounts')).toBeVisible()
    await expect(navItem(page, 'Production')).toBeVisible()
    await expect(navItem(page, 'Guide')).toBeVisible()

    // mfs-rebuild does NOT enable features/map -> those tabs absent.
    await expect(navItem(page, 'Features')).toHaveCount(0)
    await expect(navItem(page, 'Map')).toHaveCount(0)
  })
})

test.describe('adaptive board-index redirect', () => {
  test('mfs-rebuild bare index redirects to an enabled view (no Board KPI strip)', async ({
    page,
  }) => {
    await page.goto('/b/mfs-rebuild/')

    // A board without a "board" view must NOT stay on the bare index: the client
    // <Navigate replace> lands us on the first enabled view (tasks). Assert the URL
    // moved off the bare index onto a named sub-view under this board's scope.
    await expect(page).toHaveURL(/\/b\/mfs-rebuild\/(tasks|ops|prod|guide|projects|agents)(\/|$)/)
    await expect(page).not.toHaveURL(/\/b\/mfs-rebuild\/?$/)

    // The Board home body (KPI strip) must NOT be present — this board has no board view.
    await expect(page.locator('[data-testid="board-smoke"]')).toHaveCount(0)

    // Landing view is Tasks (mfs-rebuild's first enabled view) — topbar reflects it.
    await expect(page).toHaveURL(/\/b\/mfs-rebuild\/tasks(\/|$)/)
    await expect(page.locator('#page-title')).toHaveText('Tasks')
    await expect(navItem(page, 'Tasks')).toHaveClass(/active/)
  })

  test('ibils bare index stays on the Board home KPI view', async ({ page }) => {
    await page.goto('/b/ibils/')

    // ibils enables "board" -> no redirect; the Board home body (KPI strip) renders.
    await expect(page).toHaveURL(/\/b\/ibils\/?$/)
    await expect(page.locator('[data-testid="board-smoke"]')).toBeVisible()
  })
})
