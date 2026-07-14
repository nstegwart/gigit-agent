/**
 * Dedicated unit tests for qa/e2e/flows/capture-control-center-manifest.mjs
 * LOCAL ONLY — pure self-test / plan contract. No browser, no staging capture.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/capture-control-center-manifest.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

describe('capture-control-center-manifest runner', () => {
  it('exports required viewport order 1440/1024/390/360 and 200% zoom token', async () => {
    const m = await loadFlow()
    expect(m.REQUIRED_VIEWPORTS).toEqual([
      '1440x900',
      '1024x768',
      '390x844',
      '360x800',
    ])
    expect(m.REQUIRED_ZOOM).toBe('200%')
    expect(m.VISUAL_CLAIMS.PASS).toBe('PASS')
    expect(m.VISUAL_CLAIMS.PENDING_CAPTURE).toBe('PENDING_CAPTURE')
  })

  it('refuses pin requirePresent when env/pins incomplete (no fabrication)', async () => {
    const m = await loadFlow()
    expect(() =>
      m.resolveRunPins({ requirePresent: true, env: {}, pins: {} }),
    ).toThrow(/CANONICAL_SNAPSHOT_ID/)
    const present = m.resolveRunPins({
      requirePresent: true,
      env: {},
      pins: {
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'hash-1',
        boardRev: '2',
        lifecycleRev: '1',
      },
    })
    expect(present.pinFields).toBe('PRESENT')
    expect(present.present).toBe(true)
  })

  it('blocks visual PASS without on-disk screenshot and baseline', async () => {
    const m = await loadFlow()
    expect(() =>
      m.buildVisualDiffMetadata({ claim: m.VISUAL_CLAIMS.PASS, screenshotPath: null }),
    ).toThrow(/without an on-disk screenshotPath/)

    expect(() =>
      m.buildVisualDiffMetadata({
        claim: m.VISUAL_CLAIMS.PASS,
        screenshotPath: '/no/shot.png',
        baselinePath: '/no/base.png',
        fsExists: () => false,
      }),
    ).toThrow(/without an on-disk screenshotPath/)

    const ok = m.buildVisualDiffMetadata({
      claim: m.VISUAL_CLAIMS.PASS,
      screenshotPath: '/mock/shot.png',
      baselinePath: '/mock/base.png',
      fsExists: () => true,
    })
    expect(ok.claim).toBe('PASS')
    expect(ok.shippableVisual).toBe(true)

    expect(() =>
      m.assertNoVisualPassWithoutScreenshot(
        { visualDiff: 'PASS: fake', screenshotPath: null },
        { fsExists: () => false },
      ),
    ).toThrow(/screenshot missing/)
  })

  it('plans exact 53 rows with stagingUrl, fullSha, schema, pins, a11y, visualDiff, missions', async () => {
    const m = await loadFlow()
    const fixturePins = {
      canonicalSnapshotId: 'synth-unit-snap',
      canonicalHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      boardRev: '9',
      lifecycleRev: '4',
    }
    const planned = m.buildPlannedManifestRows({
      boardId: 'mfs-rebuild',
      stagingUrl: 'https://staging.example.test',
      fullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
      schemaVersion: 'TM_UI_CONTRACT_V1',
      pins: fixturePins,
      requirePinsPresent: true,
      runId: 'unit-plan-run',
      env: {},
    })

    expect(planned.plannedCount).toBe(53)
    expect(planned.rows).toHaveLength(53)
    expect(planned.contract.planned).toBe(53)
    expect(planned.viewports).toEqual(m.REQUIRED_VIEWPORTS)
    expect(planned.pins.pinFields).toBe('PRESENT')

    const collector = m.materializePlanCollector(planned)
    expect(collector.rows).toHaveLength(53)

    for (const row of collector.rows) {
      expect(row.stagingUrl).toBe('https://staging.example.test')
      expect(row.fullSha).toBe('b9c86c2d1ef6c26d4436d4ffd434642421f847bd')
      expect(row.schemaVersion).toBe('TM_UI_CONTRACT_V1')
      expect(row.canonicalSnapshotId).toBe('synth-unit-snap')
      expect(row.canonicalHash).toMatch(/^a{64}$/)
      expect(row.boardRev).toBe('9')
      expect(row.lifecycleRev).toBe('4')
      expect(row.pinFields).toBe('PRESENT')
      expect(row.accessibilityResult).toBeTruthy()
      expect(row.visualDiff).toMatch(/NOT_CLAIMED|PENDING/)
      expect(row.route).toMatch(/^\/b\/mfs-rebuild\//)
      expect(row.state).toBeTruthy()
      expect(row.viewport || row.zoom).toBeTruthy()
      // plan-only: never attach screenshot proof
      expect(row.screenshotPath).toBeFalsy()
    }

    const zoom = collector.rows.filter((r: { zoom?: string }) => r.zoom === '200%')
    expect(zoom).toHaveLength(5)

    const vps = new Set(
      collector.rows
        .filter((r: { viewport?: string }) => r.viewport)
        .map((r: { viewport?: string }) => r.viewport),
    )
    for (const vp of m.REQUIRED_VIEWPORTS) {
      expect(vps.has(vp)).toBe(true)
    }

    const missions = new Set(
      collector.rows
        .map((r: { missionQuestionLink: string | null }) => r.missionQuestionLink)
        .filter(Boolean),
    )
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']) {
      expect(missions.has(q)).toBe(true)
    }

    const verdict = m.validateCaptureManifest({
      planned,
      capturedIds: [],
      skippedIds: collector.rows.map((r: { browserTestId: string }) => r.browserTestId),
      errorIds: [],
      rows: collector.rows,
      requirePinsPresent: true,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.missions).toHaveLength(8)
    expect(verdict.zoomRowCount).toBe(5)
  })

  it('selfTest() returns ok with residual_gaps noting no live capture', async () => {
    const m = await loadFlow()
    const r = m.selfTest()
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('self-test')
    expect(r.flow).toBe('capture-control-center-manifest')
    expect(r.checks.plannedExact53).toBe(true)
    expect(r.checks.visualPassBlockedNoShot).toBe(true)
    expect(r.checks.allPinsPresent).toBe(true)
    expect(r.NOT_SHIPPABLE).toMatch(/no visual proof/)
    expect(r.residual_gaps).toMatch(/live --capture not exercised|none for pure contract/)
  })
})
