/**
 * Keyboard / focus helpers (UI_CONTRACT §11 keyboard-only primary actions).
 */
import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

/** Tab until target matches, or throw after maxTabs. */
export async function tabUntil(
  page: Page,
  target: Locator,
  maxTabs = 40,
): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    const focused = await target.evaluate((el) => el === document.activeElement).catch(() => false)
    if (focused) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`tabUntil: target not focused within ${maxTabs} tabs`)
}

/** Shift+Tab reverse. */
export async function shiftTab(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Shift+Tab')
  }
}

/** Assert active element is visible and has a non-zero focus ring or outline/box-shadow. */
export async function assertFocusVisible(page: Page): Promise<void> {
  const info = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) {
      return { ok: false as const, reason: 'no focused element' }
    }
    const style = window.getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const outline = style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
    const ring =
      style.boxShadow !== 'none' ||
      outline ||
      // Tailwind / custom focus classes often use outline-offset or ring
      Boolean(el.matches(':focus-visible'))
    return {
      ok: ring && rect.width > 0 && rect.height > 0,
      reason: ring
        ? 'ok'
        : `focus without visible ring: tag=${el.tagName} class=${el.className}`,
      tag: el.tagName,
      className: String(el.className),
    }
  })
  if (!info.ok) {
    throw new Error(`assertFocusVisible failed: ${info.reason}`)
  }
}

/** Activate focused control with Enter (or Space for buttons/checkboxes). */
export async function activateWithKeyboard(page: Page, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await page.keyboard.press(key)
}

/** Expect a locator to become focused. */
export async function expectFocused(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused()
}
