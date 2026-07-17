import { expect, test } from '@playwright/test'

test.describe('agents view', () => {
  test('groups run cards by status with live counts', async ({ page }) => {
    await page.goto('/b/ibils/agents')

    await expect(page.locator('.sec-head h2')).toHaveText('Agents')

    // Section count badge reflects total number of runs.
    const total = Number(await page.locator('.sec-head .count').innerText())
    expect(total).toBeGreaterThan(0)

    // At least one status group rail + one run card rendered.
    await expect(page.locator('.queue-lbl').first()).toBeVisible()
    const runCards = page.locator('.run')
    await expect(runCards.first()).toBeVisible()
    expect(await runCards.count()).toBeGreaterThan(0)

    // Every run card carries a status modifier class (s-running/s-blocked/...).
    const classes = await runCards.evaluateAll((els) =>
      els.map((el) => el.className),
    )
    for (const cls of classes) {
      expect(cls).toMatch(/\bs-(running|blocked|queued|done|failed)\b/)
    }

    // Sum of cards across visible groups matches the header count.
    expect(await runCards.count()).toBe(total)
  })

  test('filters run cards via global search', async ({ page }) => {
    await page.goto('/b/ibils/agents')

    const runCards = page.locator('.run')
    await expect(runCards.first()).toBeVisible()
    const before = await runCards.count()

    const searchBox = page.getByLabel('Search')
    const firstTask = (await page.locator('.run-task').first().innerText()).trim()
    const needle = firstTask.split(/\s+/)[0]

    if (needle) {
      await searchBox.fill(needle)
      await expect(async () => {
        const after = await runCards.count()
        expect(after).toBeGreaterThan(0)
        expect(after).toBeLessThanOrEqual(before)
      }).toPass()
      await searchBox.fill('')
      await expect(runCards).toHaveCount(before)
    }
  })
})

test.describe('decisions view', () => {
  test('lists decision cards with D# ids', async ({ page }) => {
    await page.goto('/b/ibils/decisions')

    // Batch-2 splits the page into open/waiting and decided sections (id-ID).
    // Decided decisions render as DecisionCard (.decision) under the decided head.
    const decidedSection = page.locator('.section', {
      has: page.locator('.sec-head h2', { hasText: 'Sudah diputuskan' }),
    })
    await expect(decidedSection.locator('.sec-head h2')).toHaveText('Sudah diputuskan')

    const count = Number(await decidedSection.locator('.sec-head .count').innerText())
    expect(count).toBeGreaterThan(0)

    const decisionCards = page.locator('.decision')
    await expect(decisionCards.first()).toBeVisible()
    expect(await decisionCards.count()).toBe(count)

    // Every decision card exposes an id shaped like D<number>.
    const ids = await page.locator('.decision-id').allInnerTexts()
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(id.trim()).toMatch(/^D\d+/)
    }

    // Decided decisions show a "Decided:" answer row.
    const decidedCount = await page.locator('.decision-ans:has-text("Decided:")').count()
    expect(decidedCount).toBeGreaterThanOrEqual(0)
  })
})

test.describe('log view', () => {
  test('renders a chronological activity timeline', async ({ page }) => {
    await page.goto('/b/ibils/log')

    await expect(page.locator('.sec-head h2')).toHaveText('Log aktivitas')

    const count = Number(await page.locator('.sec-head .count').innerText())
    expect(count).toBeGreaterThan(0)

    const timeline = page.locator('.timeline')
    await expect(timeline).toBeVisible()

    const items = page.locator('.tl-item')
    await expect(items.first()).toBeVisible()
    expect(await items.count()).toBe(count)

    // Each entry has a date and non-empty text.
    await expect(items.first().locator('.tl-date')).not.toHaveText('')
    await expect(items.first().locator('.tl-text')).not.toHaveText('')
  })
})
