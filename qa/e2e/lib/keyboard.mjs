/**
 * Keyboard / reflow helpers for promoted flows.
 */

/** @param {import('@playwright/test').Page} page @param {number} [maxTabs] */
export async function tabN(page, maxTabs = 1) {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab')
  }
}

/** @param {import('@playwright/test').Page} page */
export async function assertFocusVisible(page) {
  const info = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { ok: false, reason: 'no focused element' }
    const style = window.getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const outline = style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
    const ring = style.boxShadow !== 'none' || outline || el.matches(':focus-visible')
    return {
      ok: ring && rect.width > 0 && rect.height > 0,
      reason: ring ? 'ok' : `no visible ring on ${el.tagName}`,
    }
  })
  if (!info.ok) throw new Error(`assertFocusVisible: ${info.reason}`)
}

/** @param {import('@playwright/test').Page} page @param {number} [slackPx] */
export async function assertNoDocumentOverflow(page, slackPx = 1) {
  const overflow = await page.evaluate((slack) => {
    const de = document.documentElement
    const body = document.body
    const scrollWidth = Math.max(de.scrollWidth, body?.scrollWidth ?? 0)
    return scrollWidth > de.clientWidth + slack
  }, slackPx)
  if (overflow) throw new Error('document horizontal overflow detected')
}

export const VIEWPORTS = {
  '1440x900': { width: 1440, height: 900 },
  '1024x768': { width: 1024, height: 768 },
  '390x844': { width: 390, height: 844 },
  '360x800': { width: 360, height: 800 },
}
