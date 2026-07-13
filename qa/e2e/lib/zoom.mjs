/**
 * 200% zoom + overflow helpers for promoted flows.
 */

/** @param {import('@playwright/test').Page} page @param {number} [level] */
export async function setPageZoom(page, level = 2) {
  await page.evaluate((z) => {
    document.documentElement.style.zoom = String(z)
  }, level)
}

/** @param {import('@playwright/test').Page} page */
export async function resetPageZoom(page) {
  await page.evaluate(() => {
    document.documentElement.style.zoom = ''
  })
}

/** @param {import('@playwright/test').Page} page @param {number} [slackPx] */
export async function assertNoHorizontalOverflow(page, slackPx = 1) {
  const metrics = await page.evaluate(() => {
    const de = document.documentElement
    const body = document.body
    return {
      clientWidth: de.clientWidth,
      scrollWidth: Math.max(de.scrollWidth, body?.scrollWidth ?? 0),
      innerWidth: window.innerWidth,
    }
  })
  if (metrics.scrollWidth > metrics.clientWidth + slackPx) {
    throw new Error(
      `horizontal overflow: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`,
    )
  }
  return metrics
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<unknown>} fn
 */
export async function withZoom200(page, fn) {
  await setPageZoom(page, 2)
  try {
    return await fn()
  } finally {
    await resetPageZoom(page)
  }
}
