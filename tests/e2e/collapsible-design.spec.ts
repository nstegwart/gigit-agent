import { expect, test } from '@playwright/test'

test('project groups collapse: In progress open, Parked closed; design links present', async ({ page }) => {
  await page.goto('/b/ibils/projects/ibils-business')

  const inProgress = page.locator('.collapsible-head', { hasText: 'In progress' })
  const parked = page.locator('.collapsible-head', { hasText: 'Parked for later' })
  await expect(inProgress).toHaveAttribute('aria-expanded', 'true')
  await expect(parked).toHaveAttribute('aria-expanded', 'false')

  // expanding Parked reveals its feature rows
  await parked.click()
  await expect(parked).toHaveAttribute('aria-expanded', 'true')

  // system-design foundation links (Katalog Komponen / Semua Halaman / Design Foundation)
  await expect(page.locator('.ds-link').first()).toBeVisible()
  await expect(page.locator('.ds-link', { hasText: 'Katalog Komponen' })).toHaveCount(1)
})
