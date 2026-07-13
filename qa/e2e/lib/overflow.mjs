/**
 * Overflow / reflow probes for promoted flows.
 */
import { VIEWPORTS } from './keyboard.mjs'

export { VIEWPORTS }

/** @param {import('@playwright/test').Page} page @param {{width:number,height:number}} size */
export async function setViewport(page, size) {
  await page.setViewportSize(size)
}

/** @param {import('@playwright/test').Page} page @param {number} [slackPx] */
export async function hasDocumentHorizontalOverflow(page, slackPx = 1) {
  return page.evaluate((slack) => {
    const de = document.documentElement
    const body = document.body
    const scrollWidth = Math.max(de.scrollWidth, body?.scrollWidth ?? 0)
    return scrollWidth > de.clientWidth + slack
  }, slackPx)
}

/** @param {import('@playwright/test').Page} page */
export async function assertNoDocumentOverflow(page) {
  if (await hasDocumentHorizontalOverflow(page)) {
    throw new Error('document horizontal overflow')
  }
}
