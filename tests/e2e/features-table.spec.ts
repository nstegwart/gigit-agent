import { expect, test } from '@playwright/test'

// Covers the /features route (`FeaturesTable`, ported 1:1 from the prototype's
// `vFeatures(m)`): a large sortable table, project filter chips (`.filters
// .fbtn`), and the topbar global search (`input[aria-label="Search"]`) which
// narrows rows by name/id/track/kelompok. Read-only — no checklist tasks are
// toggled, so `data/plan.json` is never mutated by this spec.

test.describe('Features table (/features)', () => {
  test('renders a large, real feature list', async ({ page }) => {
    await page.goto('/b/ibils/features')

    const table = page.locator('table.ftable')
    await expect(table).toBeVisible()

    const rows = table.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    const total = await rows.count()
    expect(total).toBeGreaterThanOrEqual(40)

    // "All features" header count badge mirrors the unfiltered row count.
    await expect(page.locator('.sec-head .count')).toHaveText(String(total))

    // Each row carries the expected shape: name + id, a phase badge, a
    // progress bar — spot-check the first row rather than every row.
    const firstRow = rows.first()
    await expect(firstRow.locator('.t-name')).toBeVisible()
    await expect(firstRow.locator('.t-id')).toBeVisible()
    await expect(firstRow.locator('.phase')).toBeVisible()
  })

  test('a project filter chip narrows rows to that project', async ({ page }) => {
    await page.goto('/b/ibils/features')

    const table = page.locator('table.ftable')
    const rows = table.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    const totalCount = await rows.count()

    // Chip order mirrors `m.projects`: index 0 is the "All projects" reset
    // chip, so the first real per-project chip is index 1.
    const projectChips = page.locator('.filters button.fbtn')
    const allProjectsChip = projectChips.first()
    await expect(allProjectsChip).toHaveText('All projects')

    const projectChip = projectChips.nth(1)
    const projectName = (await projectChip.textContent())?.trim()
    expect(projectName?.length ?? 0).toBeGreaterThan(0)

    await projectChip.click()
    await expect(projectChip).toHaveClass(/\bon\b/)

    await expect(rows.first()).toBeVisible()
    const filteredCount = await rows.count()
    expect(filteredCount).toBeGreaterThan(0)
    expect(filteredCount).toBeLessThan(totalCount)

    // Header count badge reflects the filtered row count too.
    await expect(page.locator('.sec-head .count')).toHaveText(String(filteredCount))

    // Every visible row's Project column shows the selected project.
    const projectCells = table.locator('tbody tr td:nth-child(3)')
    const cellCount = await projectCells.count()
    for (let i = 0; i < cellCount; i++) {
      await expect(projectCells.nth(i)).toContainText(projectName!)
    }

    // Resetting to "All projects" restores the full row count.
    await allProjectsChip.click()
    await expect(rows.first()).toBeVisible()
    await expect(rows).toHaveCount(totalCount)
  })

  test('typing in the topbar search filters rows', async ({ page }) => {
    await page.goto('/b/ibils/features')

    const table = page.locator('table.ftable')
    const rows = table.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    const totalCount = await rows.count()

    // Use a real feature id straight off the table as the query — unique by
    // construction, so it deterministically narrows the result set to rows
    // that actually contain it, without hardcoding fixture data.
    const targetId = (await rows.first().locator('.t-id').textContent())?.trim()
    expect(targetId?.length ?? 0).toBeGreaterThan(0)

    const search = page.getByRole('textbox', { name: 'Search' })
    await search.fill(targetId!)

    await expect(rows.first()).toBeVisible()
    const filteredCount = await rows.count()
    expect(filteredCount).toBeGreaterThan(0)
    expect(filteredCount).toBeLessThan(totalCount)

    for (let i = 0; i < filteredCount; i++) {
      await expect(rows.nth(i)).toContainText(new RegExp(escapeRegExp(targetId!), 'i'))
    }

    // Clearing the query restores the full, unfiltered row count.
    await search.fill('')
    await expect(rows.first()).toBeVisible()
    await expect(rows).toHaveCount(totalCount)
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
