/**
 * 200% zoom helper (UI_CONTRACT §11 / AC-UI-05).
 * Prefer CSS zoom on documentElement; CDP Page.setPageScaleFactor as fallback.
 */
import type { Page } from '@playwright/test'

export type ZoomLevel = 1 | 1.5 | 2

/** Apply browser-like zoom. Default 200% for core-flow checks. */
export async function setPageZoom(page: Page, level: ZoomLevel = 2): Promise<void> {
  await page.evaluate((z) => {
    const root = document.documentElement
    // CSS zoom is widely supported in Chromium (Playwright default).
    ;(root.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(z)
  }, level)
}

export async function resetPageZoom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement
    ;(root.style as CSSStyleDeclaration & { zoom?: string }).zoom = ''
  })
}

/**
 * Assert document does not create accidental horizontal overflow at current zoom.
 * Allows 1px subpixel slack.
 */
export async function assertNoHorizontalOverflow(page: Page, slackPx = 1): Promise<void> {
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
      `horizontal overflow at zoom: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} innerWidth=${metrics.innerWidth}`,
    )
  }
}

/** Run body under 200% zoom, always restore. */
export async function withZoom200<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await setPageZoom(page, 2)
  try {
    return await fn()
  } finally {
    await resetPageZoom(page)
  }
}
