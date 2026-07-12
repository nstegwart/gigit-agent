// E2E for the Batch-5 adaptive Tasks view on the "mfs-rebuild" board.
//   - /b/mfs-rebuild/tasks renders a `.ftable` table of first-class WorkTask
//     rows (>= 40 of them), one `.ftable tbody tr` per task.
//   - Clicking a row enters /b/mfs-rebuild/tasks/T-... and the detail shows the
//     task title (<h1>) plus the CheckpointList card.
//   - A checkpoint row toggles UNCHECKED -> CHECKED, persists across a full reload
//     (the server writes data/boards/mfs-rebuild/tasks.json), then is toggled BACK
//     so the data file is restored to its original state.
//
// The Verify phase also restores the data dir (git checkout + git clean), but this
// spec still restores manually so it is idempotent across retries and leaves no
// residue on its own.
import { expect, test } from '@playwright/test'

const TASKS_URL = '/b/mfs-rebuild/tasks'

test('tasks grid lists >= 40 cards and a card opens its detail with a CheckpointList', async ({
  page,
}) => {
  await page.goto(TASKS_URL)

  // Section header + the adaptive tasks grid.
  await expect(page.getByRole('heading', { level: 2, name: 'Tasks', exact: true })).toBeVisible()

  const cards = page.locator('.ftable tbody tr')
  expect(await cards.count()).toBeGreaterThanOrEqual(40)

  // Grab the first card's title + href before navigating (text-anchored so the
  // assertion survives the client-side transition + re-render).
  const firstCard = cards.first()
  await expect(firstCard).toBeVisible()
  const title = (await firstCard.locator('.t-name').innerText()).trim()
  expect(title.length).toBeGreaterThan(0)

  await firstCard.click()

  // Landed on a task detail route for that board.
  await expect(page).toHaveURL(/\/b\/mfs-rebuild\/tasks\/T-/)

  // Detail hero shows the same title, and the CheckpointList card is present.
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Checkpoints', exact: true })).toBeVisible()
})

test('checkpoint toggles to done, persists across reload, then restores', async ({ page }) => {
  // Open the tasks list and step into the first task whose detail exposes an
  // as-yet-unchecked checkpoint — robust to task ordering / data drift.
  await page.goto(TASKS_URL)
  const cards = page.locator('.ftable tbody tr')
  const total = await cards.count()
  expect(total).toBeGreaterThanOrEqual(40)

  // Scope every checkpoint locator to the CheckpointList card so the meta chips
  // elsewhere on the page can never satisfy them.
  const cpCard = () =>
    page.locator('.card', { has: page.getByRole('heading', { name: 'Checkpoints', exact: true }) })

  let found = false
  for (let i = 0; i < total && !found; i++) {
    await cards.nth(i).click()
    await expect(cpCard()).toBeVisible()
    if ((await cpCard().locator('.checkpoint:not(.done)').count()) > 0) {
      found = true
      break
    }
    await page.goBack()
    await expect(cards).toHaveCount(total)
  }
  expect(found, 'a task with at least one unchecked checkpoint').toBe(true)

  // First not-yet-done checkpoint on this detail page.
  const firstUnchecked = cpCard().locator('.checkpoint:not(.done)').first()
  await expect(firstUnchecked).toBeVisible()
  const label = (await firstUnchecked.locator('.cp-label').innerText()).trim()
  expect(label.length).toBeGreaterThan(0)

  // Stable, text-anchored handle to the SAME row (survives mutation + reload).
  const row = () =>
    cpCard().locator('.checkpoint', { has: page.getByText(label, { exact: true }) })
  await expect(row()).toHaveCount(1)
  await expect(row()).not.toHaveClass(/done/)
  await expect(row().locator('.box svg')).toHaveCount(0) // no checkmark yet

  // --- toggle ON ------------------------------------------------------------
  await row().click()
  await expect(row()).toHaveClass(/\bdone\b/)
  await expect(row().locator('.box svg')).toBeVisible() // checkmark rendered

  // persists across a full reload (server wrote tasks.json)
  await page.reload()
  await expect(row()).toHaveClass(/\bdone\b/)
  await expect(row().locator('.box svg')).toBeVisible()

  // --- toggle BACK (restore original data) ----------------------------------
  await row().click()
  await expect(row()).not.toHaveClass(/done/)
  await expect(row().locator('.box svg')).toHaveCount(0)

  // restoration persists across reload → tasks.json is back to baseline
  await page.reload()
  await expect(row()).not.toHaveClass(/done/)
  await expect(row().locator('.box svg')).toHaveCount(0)
})
