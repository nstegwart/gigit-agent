import { expect, test } from '@playwright/test'

test('theme button toggles documentElement data-theme between dark and light', async ({ page }) => {
  await page.goto('/b/ibils/')

  const html = page.locator('html')
  const themeBtn = page.locator('#theme-btn')
  await expect(themeBtn).toBeVisible()

  // Whatever the resolved theme is on load, the toggle must flip it and the
  // attribute must always end up as either 'dark' or 'light' (never absent
  // once the user has explicitly toggled it).
  await themeBtn.click()
  const first = await html.getAttribute('data-theme')
  expect(['dark', 'light']).toContain(first)

  await themeBtn.click()
  await expect(html).not.toHaveAttribute('data-theme', first as string)
  const second = await html.getAttribute('data-theme')
  expect(['dark', 'light']).toContain(second)
  expect(second).not.toBe(first)

  // Toggle a third time to confirm it flips back to the first value.
  await themeBtn.click()
  await expect(html).toHaveAttribute('data-theme', first as string)
})
