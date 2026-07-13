/**
 * Foundation harness self-check (config/type layer).
 * Does not require a running server or credentials.
 * Matched only by project harness-contract (testMatch *.contract.harness.spec.ts).
 */
import { expect, test } from '@playwright/test'

import {
  HARNESS_VIEWPORTS,
  MANIFEST_STATES,
  ScreenshotManifestCollector,
  buildManifestRow,
  validateManifestRow,
  hasE2ECredentials,
  resolveWebBase,
} from './index'

test.describe('C3-F5 harness contract (no server)', () => {
  test('WEB_BASE resolves to http(s) URL', () => {
    const base = resolveWebBase()
    expect(base).toMatch(/^https?:\/\//)
  })

  test('viewport table has 1440/1024/390/360', () => {
    expect(HARNESS_VIEWPORTS['chromium-1440']).toEqual({ width: 1440, height: 900 })
    expect(HARNESS_VIEWPORTS['chromium-1024']).toEqual({ width: 1024, height: 768 })
    expect(HARNESS_VIEWPORTS['chromium-390']).toEqual({ width: 390, height: 844 })
    expect(HARNESS_VIEWPORTS['chromium-360']).toEqual({ width: 360, height: 800 })
  })

  test('screenshot-manifest row validates; pins default MISSING (no fabrication)', () => {
    const row = buildManifestRow({
      route: '/b/ibils/',
      state: 'populated',
      viewport: '1440x900',
      browserTestId: 'contract-row-1',
      accessibilityResult: 'qa/e2e/out/axe/placeholder.json',
      missionQuestionLink: 'Q1',
    })
    expect(row.pinFields).toBe('MISSING')
    expect(row.boardRev).toBe('MISSING')
    expect(row.lifecycleRev).toBe('MISSING')
    expect(row.canonicalSnapshotId).toBe('MISSING')
    expect(validateManifestRow(row)).toEqual([])
    expect(MANIFEST_STATES).toContain('populated')

    const c = new ScreenshotManifestCollector({ runId: 'contract' })
    c.clear()
    c.add({
      route: '/login',
      state: 'populated',
      zoom: '200%',
      browserTestId: 'contract-row-2',
      accessibilityResult: 'none',
      missionQuestionLink: null,
    })
    expect(c.rows).toHaveLength(1)

    const present = buildManifestRow({
      route: '/b/mfs-rebuild/',
      state: 'populated',
      viewport: '1440x900',
      browserTestId: 'contract-row-present',
      accessibilityResult: 'none',
      missionQuestionLink: 'Q1',
      pins: {
        canonicalSnapshotId: 'synth-c3-r2d-snap-001',
        canonicalHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab',
        boardRev: '7',
        lifecycleRev: '3',
      },
    })
    expect(present.pinFields).toBe('PRESENT')
  })

  test('credentials presence is env-only (never embedded)', () => {
    // Soft probe only — must not throw when unset.
    expect(typeof hasE2ECredentials()).toBe('boolean')
  })
})
