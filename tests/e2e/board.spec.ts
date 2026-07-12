// E2E for the Board (home) view — ported from prototype `vBoard(m)`.
// Verifies the KPI strip, the "Agents at work" run cards (agent name + model chip
// + effort chip + task line), and the "Work queue" Now/Next rails.
// Read-only: these tests never mutate data/plan.json, so nothing to restore.
import { expect, test } from '@playwright/test'

test.describe('Board (home) view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/b/ibils/')
  })

  test('KPI strip shows numeric tiles', async ({ page }) => {
    const kpis = page.locator('.kpis .kpi')
    await expect(kpis.first()).toBeVisible()
    // At least the five seeded KPIs (agents/in-progress/queue/blocked/projects).
    expect(await kpis.count()).toBeGreaterThanOrEqual(5)

    // Every KPI carries a number and a label.
    const nums = page.locator('.kpi .kpi-num')
    const count = await nums.count()
    expect(count).toBeGreaterThanOrEqual(5)
    for (let i = 0; i < count; i++) {
      await expect(nums.nth(i)).toHaveText(/^\d+$/)
    }
    await expect(page.locator('.kpi .kpi-lbl').first()).not.toBeEmpty()
  })

  test('"Agents at work" section renders run cards', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Agents at work' }),
    })
    await expect(section.getByRole('heading', { name: 'Agents at work' })).toBeVisible()
    await expect(section.locator('.live')).toContainText('live')

    const runs = section.locator('.runs-grid .run')
    await expect(runs.first()).toBeVisible()
    expect(await runs.count()).toBeGreaterThanOrEqual(1)
  })

  test('a run card exposes agent name, model chip, effort chip and task line', async ({ page }) => {
    const card = page.locator('.runs-grid .run').first()
    await expect(card).toBeVisible()

    // Agent name is present and non-empty.
    await expect(card.locator('.run-name')).toBeVisible()
    await expect(card.locator('.run-name')).not.toBeEmpty()

    // Model chip (monospace) — real seed data uses grok-4.5 / claude-opus-4-8 etc.
    const modelChip = card.locator('.chip-model')
    await expect(modelChip).toBeVisible()
    await expect(modelChip).toHaveText(/\S/)

    // Effort chip renders as "effort <level>".
    const effortChip = card.locator('.chip-effort')
    await expect(effortChip).toBeVisible()
    await expect(effortChip).toHaveText(/effort\s+\S+/)

    // Task line.
    await expect(card.locator('.run-task')).toBeVisible()
    await expect(card.locator('.run-task')).not.toBeEmpty()
  })

  test('at least one known model chip (grok / claude) appears across run cards', async ({
    page,
  }) => {
    const knownModel = page
      .locator('.runs-grid .run .chip-model')
      .filter({ hasText: /grok-|claude-/ })
    await expect(knownModel.first()).toBeVisible()
  })

  test('"Work queue" shows Now and Next rails', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Work queue' }),
    })
    await expect(section.getByRole('heading', { name: 'Work queue' })).toBeVisible()

    // "Now" rail label is always rendered.
    await expect(page.locator('.queue-lbl.ql-now')).toHaveText('Now')

    // "Now" grid holds queue cards (or an explicit empty state).
    const nowGrid = section.locator('.qgrid').first()
    await expect(nowGrid).toBeVisible()
    const nowCards = nowGrid.locator('.qcard')
    if (await nowCards.count()) {
      await expect(nowCards.first()).toBeVisible()
    } else {
      await expect(nowGrid.locator('.empty')).toBeVisible()
    }

    // "Next" rail is present when there is upcoming work.
    const nextLbl = page.locator('.queue-lbl.ql-next')
    if (await nextLbl.count()) {
      await expect(nextLbl.first()).toHaveText('Next')
    }
  })

  test('a queue card shows its feature name, task count and progress bar', async ({ page }) => {
    const qcard = page.locator('.qcard').first()
    await expect(qcard).toBeVisible()
    await expect(qcard.locator('.qcard-name')).not.toBeEmpty()
    await expect(qcard.locator('.chip', { hasText: /tasks$/ })).toBeVisible()
    // ProgressBar renders a .bar track.
    await expect(qcard.locator('.bar')).toBeVisible()
  })
})
