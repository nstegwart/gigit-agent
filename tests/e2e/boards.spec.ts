// E2E for the multi-board surface added in the multi-board migration:
//   - the site root `/` is now the BOARDS HOME (a list of boards + a create form),
//   - `/b/<id>/` is a board's own scope (sidebar chrome + all sections),
//   - the sidebar `.switcher-btn` opens a `.switcher-menu` to hop between boards.
//
// The "create a board" test MUTATES the data dir (writes data/boards/<slug> +
// data/boards.json). The Verify phase restores data (git checkout + git clean),
// so this spec performs no manual cleanup. A per-run unique slug keeps the create
// test idempotent across Playwright retries (a retried attempt gets a fresh slug
// instead of colliding with the board the first attempt already wrote).
import { expect, test } from '@playwright/test'

// Mirror of slugify() in src/routes/index.tsx.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

test.describe('boards home', () => {
  test('lists the seeded "Ibils Roadmap" board and opens it on click', async ({ page }) => {
    await page.goto('/')

    // Boards home renders bare (no sidebar) with the board grid.
    await expect(page.locator('.home-title')).toHaveText('Boards')
    await expect(page.locator('.sidebar')).toHaveCount(0)

    // The seeded board shows up as a card by its display name.
    const ibilsCard = page.locator('.board-card', { hasText: 'Ibils Roadmap' })
    await expect(ibilsCard).toBeVisible()
    await expect(ibilsCard.locator('.board-name')).toHaveText('Ibils Roadmap')

    // Clicking the card enters that board's scope.
    await ibilsCard.click()
    await expect(page).toHaveURL(/\/b\/ibils(\/|$)/)
    // Board scope adds the sidebar chrome.
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.brand-name')).toHaveText('Cairn')
  })

  test('creates a new board and enters its scope', async ({ page }) => {
    await page.goto('/')

    // Unique name -> unique slug so retries never collide on an already-created board.
    const name = `E2E Board ${Date.now()}`
    const slug = slugify(name)

    // The create form is collapsed until "New board" is clicked.
    await expect(page.locator('.home input.field')).toHaveCount(0)
    await page.getByRole('button', { name: 'New board' }).click()

    const input = page.locator('.home input.field')
    await expect(input).toBeVisible()
    await input.fill(name)

    // Live URL hint reflects the derived slug.
    await expect(page.locator('.home code', { hasText: `/b/${slug}` })).toBeVisible()

    const create = page.getByRole('button', { name: 'Create' })
    await expect(create).toBeEnabled()
    await create.click()

    // Lands in the freshly-created board's scope, fully rendered.
    await expect(page).toHaveURL(new RegExp(`/b/${slug}(/|$)`))
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.brand-name')).toHaveText('Cairn')

    // The switcher reflects the current board's name.
    await expect(page.locator('.switcher-name')).toHaveText(name)
  })
})

test.describe('board switcher', () => {
  test('sidebar switcher opens a menu listing boards', async ({ page }) => {
    await page.goto('/b/ibils/')

    const btn = page.locator('.switcher-btn')
    await expect(btn).toBeVisible()
    // Shows the current board's name.
    await expect(btn.locator('.switcher-name')).toHaveText('Ibils Roadmap')

    // Menu is closed until the button is clicked.
    await expect(page.locator('.switcher-menu')).toHaveCount(0)
    await btn.click()

    const menu = page.locator('.switcher-menu')
    await expect(menu).toBeVisible()

    // Menu lists board entries, including the current one (marked active).
    const items = menu.locator('.switcher-item')
    expect(await items.count()).toBeGreaterThanOrEqual(1)
    await expect(menu.locator('.switcher-item', { hasText: 'Ibils Roadmap' })).toBeVisible()
    await expect(menu.locator('.switcher-item.active')).toContainText('Ibils Roadmap')
  })
})
