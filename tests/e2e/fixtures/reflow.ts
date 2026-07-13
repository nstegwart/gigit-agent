/**
 * Reflow / overflow helpers (UI_CONTRACT §11 — table→card ≤768, no page overflow).
 */
import type { Page } from '@playwright/test'

export const TABLE_TO_CARD_BREAKPOINT_PX = 768

export type ViewportSize = { width: number; height: number }

export const HARNESS_VIEWPORTS: Record<string, ViewportSize> = {
  'chromium-1440': { width: 1440, height: 900 },
  'chromium-1024': { width: 1024, height: 768 },
  'chromium-390': { width: 390, height: 844 },
  'chromium-360': { width: 360, height: 800 },
}

export async function setHarnessViewport(
  page: Page,
  size: ViewportSize,
): Promise<void> {
  await page.setViewportSize(size)
}

/**
 * Measure horizontal overflow of the document root.
 * Returns true when scrollWidth exceeds clientWidth beyond slack.
 */
export async function hasDocumentHorizontalOverflow(
  page: Page,
  slackPx = 1,
): Promise<boolean> {
  return page.evaluate((slack) => {
    const de = document.documentElement
    const body = document.body
    const scrollWidth = Math.max(de.scrollWidth, body?.scrollWidth ?? 0)
    return scrollWidth > de.clientWidth + slack
  }, slackPx)
}

export async function assertNoDocumentOverflow(page: Page, slackPx = 1): Promise<void> {
  const overflow = await hasDocumentHorizontalOverflow(page, slackPx)
  if (overflow) {
    const m = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }))
    throw new Error(
      `document horizontal overflow: clientWidth=${m.clientWidth} scrollWidth=${m.scrollWidth} viewport=${m.viewport.w}x${m.viewport.h}`,
    )
  }
}

/**
 * At width ≤768, assert no wide table forces page overflow (table→card expectation).
 * Does not assert specific card markup — only overflow contract for foundation stage.
 */
export async function assertNarrowReflowNoOverflow(
  page: Page,
  width = TABLE_TO_CARD_BREAKPOINT_PX,
  height = 900,
): Promise<void> {
  await page.setViewportSize({ width, height })
  await assertNoDocumentOverflow(page)
}

/**
 * Sample min touch-target size for interactive elements matching selector.
 * Returns offenders smaller than minPx on both axes (excluding zero-size hidden).
 */
export async function findSmallTouchTargets(
  page: Page,
  selector = 'a, button, [role="button"], input, select, textarea',
  minPx = 44,
): Promise<Array<{ tag: string; w: number; h: number; text: string }>> {
  return page.evaluate(
    ({ sel, min }) => {
      const out: Array<{ tag: string; w: number; h: number; text: string }> = []
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const style = window.getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') continue
        if (r.width < min || r.height < min) {
          out.push({
            tag: el.tagName.toLowerCase(),
            w: Math.round(r.width),
            h: Math.round(r.height),
            text: (el.textContent || '').trim().slice(0, 40),
          })
        }
      }
      return out
    },
    { sel: selector, min: minPx },
  )
}
