// E2E for the multi-board surface after ART control-center default:
//   - bare `/` redirects authenticated users to the selected mfs-rebuild Overview
//     (DEFAULT_CONTROL_CENTER_BOARD_ID), not the board picker,
//   - board picker + create form live at `/?boards=1` (bare home chrome, no sidebar),
//   - `/b/<id>/` is a board's own scope (sidebar chrome + all sections),
//   - the sidebar `.switcher-btn` opens a `.switcher-menu` to hop between boards.
//
// The "create a board" test MUTATES the data dir (writes data/boards/<slug> +
// data/boards.json). The Verify phase restores data (git checkout + git clean),
// so this spec performs no manual cleanup. A per-run unique slug keeps the create
// test idempotent across Playwright retries (a retried attempt gets a fresh slug
// instead of colliding with the board the first attempt already wrote).
//
// CSRF / create failures must surface as hard test failures. Do not soft-assert
// success, catch mutation errors, or treat a stuck picker as a pass — a failed
// create (including CSRF_TOKEN_UNAVAILABLE / missing CAIRN_CSRF_SECRET under
// production-like preview) must remain red and visible in the report.
import { expect, test } from '@playwright/test'

// Mirror of slugify() in src/routes/index.tsx.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

test.describe('root redirect', () => {
  test('bare / redirects to selected mfs Overview', async ({ page }) => {
    await page.goto('/')

    // ART default: control-center overview for mfs-rebuild (not Boards home).
    await expect(page).toHaveURL(/\/b\/mfs-rebuild(\/|$|\?)/)
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.switcher-name')).toHaveText('Myfitsociety Rebuild')
    // Bilingual page title is allowed (EN · id-ID); assert Overview is present.
    await expect(page.locator('#page-title')).toContainText('Overview')
    await expect(page.locator('[data-testid="control-center-overview"]')).toBeVisible({
      timeout: 30_000,
    })
    // Boards picker chrome must NOT be the root default.
    await expect(page.locator('.home-title')).toHaveCount(0)
  })
})

test.describe('boards home', () => {
  test('lists the seeded "Ibils Roadmap" board and opens it on click', async ({ page }) => {
    // Explicit board picker — bare `/` no longer renders this surface.
    await page.goto('/?boards=1')

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
    await page.goto('/?boards=1')

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

    // Capture the create mutation response so CSRF/server failures stay in the
    // failure message instead of collapsing into a generic navigation timeout.
    const createPost = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        (res.url().includes('_serverFn') || res.url().includes('createBoard')),
      { timeout: 20_000 },
    )

    await create.click()

    // Hard success bar: must leave the picker and enter the new board scope.
    // Do not soft-pass if still on /?boards=1 — that hides real create failures.
    try {
      await expect(page).toHaveURL(new RegExp(`/b/${slug}(/|$)`), { timeout: 20_000 })
    } catch (navErr) {
      let postDetail = 'no POST captured'
      try {
        const res = await createPost
        const body = (await res.text()).slice(0, 800)
        postDetail = `status=${res.status()} body=${body}`
      } catch (postErr) {
        postDetail = `POST wait failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`
      }
      const stillOnPicker = /[?&]boards=1(?:&|$)/.test(new URL(page.url()).search) || page.url().endsWith('/?boards=1')
      throw new Error(
        [
          `Board create did not navigate to /b/${slug}.`,
          `stillOnPicker=${stillOnPicker}`,
          `finalUrl=${page.url()}`,
          postDetail,
          'CSRF/create failures must remain visible (no soft-pass).',
          `navError=${navErr instanceof Error ? navErr.message : String(navErr)}`,
        ].join(' '),
      )
    }

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
