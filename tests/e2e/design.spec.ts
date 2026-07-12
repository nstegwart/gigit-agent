import { expect, test } from '@playwright/test'

test.describe('design view', () => {
  test('shows design docs links', async ({ page }) => {
    await page.goto('/b/ibils/design')

    await expect(page.locator('.sec-head h2', { hasText: 'Design docs' })).toBeVisible()

    const docLinks = page.locator('.link-list a')
    await expect(docLinks.first()).toBeVisible()
    expect(await docLinks.count()).toBeGreaterThan(0)

    // Known seed docs from plan.json.
    await expect(page.locator('.link-list a', { hasText: 'Master Plan' })).toBeVisible()
    await expect(page.locator('.link-list a', { hasText: 'Journey' })).toBeVisible()
  })

  test('renders per-project architecture component cards with stack chips', async ({ page }) => {
    await page.goto('/b/ibils/design')

    const archCards = page.locator('.arch-card')
    await expect(archCards.first()).toBeVisible()
    expect(await archCards.count()).toBeGreaterThan(0)

    // At least one project shows React Native / Rust / Next.js stack text
    // (Personal project's komponen: App mobile / Backend / Admin / Landing).
    const cardText = await archCards.allInnerTexts()
    const joined = cardText.join(' \n ')
    expect(joined).toMatch(/React Native/)
    expect(joined).toMatch(/Rust/)
    expect(joined).toMatch(/Next\.js/)
  })

  test('each project card links to its detail page', async ({ page }) => {
    await page.goto('/b/ibils/design')

    const projectLinks = page.locator('.design-proj-name')
    await expect(projectLinks.first()).toBeVisible()
    expect(await projectLinks.count()).toBeGreaterThan(0)

    const href = await projectLinks.first().getAttribute('href')
    expect(href).toMatch(/^\/b\/ibils\/projects\//)

    await projectLinks.first().click()
    await expect(page).toHaveURL(/\/b\/ibils\/projects\/[^/]+$/)
  })
})
