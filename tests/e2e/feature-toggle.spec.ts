import { expect, test } from '@playwright/test'

// Feature detail task checklist — toggle an UNCHECKED task on, confirm it becomes
// checked (`.check.done` + rendered checkmark) and persists across a reload, then
// toggle it BACK so data/plan.json is restored to its original state.
//
// Uses a feature known to carry a mix of done/undone tasks. The row is re-located
// by its task text so the reference survives the board refetch + full page reload
// (index-independent, robust to sort/re-render).
const FEATURE_URL = '/b/ibils/features/f3-wa-export'

test('checklist task toggles to done, persists across reload, then restores', async ({
  page,
}) => {
  await page.goto(FEATURE_URL)

  // The Tasks card scopes every checklist locator (avoids the Details/meta chips).
  const tasksCard = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Tasks' }),
  })
  await expect(tasksCard).toBeVisible()

  // First task that is NOT yet done.
  const firstUnchecked = tasksCard.locator('.check:not(.done)').first()
  await expect(firstUnchecked).toBeVisible()
  const taskText = (await firstUnchecked.locator('.txt').innerText()).trim()
  expect(taskText.length).toBeGreaterThan(0)

  // Stable, text-anchored handle to the SAME row (survives reload / re-render).
  const row = tasksCard.locator('.check', { hasText: taskText })
  await expect(row).toHaveCount(1)
  await expect(row).not.toHaveClass(/done/)
  await expect(row.locator('.box svg')).toHaveCount(0) // no checkmark yet

  // --- toggle ON ------------------------------------------------------------
  await row.click()
  await expect(row).toHaveClass(/done/)
  await expect(row.locator('.box svg')).toBeVisible() // checkmark now rendered

  // persists across a full reload (server wrote data/plan.json)
  await page.reload()
  const rowAfterOn = tasksCard.locator('.check', { hasText: taskText })
  await expect(rowAfterOn).toHaveClass(/done/)
  await expect(rowAfterOn.locator('.box svg')).toBeVisible()

  // --- toggle BACK (restore original data) ----------------------------------
  await rowAfterOn.click()
  await expect(rowAfterOn).not.toHaveClass(/done/)
  await expect(rowAfterOn.locator('.box svg')).toHaveCount(0)

  // restoration persists across reload → data/plan.json is back to baseline
  await page.reload()
  const rowRestored = tasksCard.locator('.check', { hasText: taskText })
  await expect(rowRestored).not.toHaveClass(/done/)
  await expect(rowRestored.locator('.box svg')).toHaveCount(0)
})
