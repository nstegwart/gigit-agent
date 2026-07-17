/**
 * Dedicated unit tests for qa/e2e/flows/capture-control-center-manifest.mjs
 * plus TM-10 axe / visual-regression S01–S24 harness self-tests.
 * LOCAL ONLY — pure self-test / plan contract. No browser, no staging capture.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ART_SID_IDS,
  MAX_DIFF_PIXEL_RATIO,
  artSidAxePath,
  artSidBaselinePaths,
  baselineDirForFullSha,
  buildManifestRow,
} from '../e2e/fixtures/screenshot-manifest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/capture-control-center-manifest.mjs')
const AXE_FLOW = join(ROOT, 'qa/e2e/flows/axe-control-center.mjs')
const VISUAL_FLOW = join(ROOT, 'qa/e2e/flows/visual-regression-sids.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

async function loadAxeFlow() {
  return import(pathToFileURL(AXE_FLOW).href)
}

async function loadVisualFlow() {
  return import(pathToFileURL(VISUAL_FLOW).href)
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

  it('buildVisualDiffMetadata defaults maxDiffPixelRatio to 0.002', async () => {
    const m = await loadFlow()
    const ok = m.buildVisualDiffMetadata({
      claim: m.VISUAL_CLAIMS.PASS,
      screenshotPath: '/mock/shot.png',
      baselinePath: '/mock/base.png',
      fsExists: () => true,
    })
    expect(ok.maxDiffPixelRatio).toBe(0.002)
    expect(ok.maxDiffPixelRatio).toBe(MAX_DIFF_PIXEL_RATIO)
  })
})

describe('TM-10 axe-control-center harness', () => {
  it('selfTest() plans 24 SIDs and blocks a11y PASS without axe JSON', async () => {
    const m = await loadAxeFlow()
    const r = m.selfTest()
    expect(r.ok).toBe(true)
    expect(r.flow).toBe('axe-control-center')
    expect(r.checks.sidCount24).toBe(true)
    expect(r.checks.plannedCount24).toBe(true)
    expect(r.checks.tagsIncludeWcag22aa).toBe(true)
    expect(r.checks.passBlockedNoFile).toBe(true)
    expect(r.checks.failOnCriticalSerious).toBe(true)
    expect(r.checks.shaBoundReceipt).toBe(true)
    expect(r.NOT_SHIPPABLE).toMatch(/no live axe proof/)
  })

  it('planAxeMatrix emits axe-Sxx.json paths under out/axe', async () => {
    const m = await loadAxeFlow()
    const planned = m.planAxeMatrix({
      boardId: 'mfs-rebuild',
      fullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
    })
    expect(planned.plannedCount).toBe(24)
    expect(planned.rows).toHaveLength(24)
    expect(planned.tags).toContain('wcag22aa')
    for (const row of planned.rows) {
      expect(row.artSid).toMatch(/^S\d{2}$/)
      expect(row.axePath).toContain('axe-S')
      expect(row.claim).toBe(m.A11Y_CLAIMS.PENDING_RUN)
    }
  })
})

describe('TM-10 visual-regression-sids harness', () => {
  it('selfTest() enforces 24 SIDs, maxDiff 0.002, SHA-bound baselines', async () => {
    const m = await loadVisualFlow()
    const r = m.selfTest()
    expect(r.ok).toBe(true)
    expect(r.flow).toBe('visual-regression-sids')
    expect(r.checks.sidCount24).toBe(true)
    expect(r.checks.maxDiffExact).toBe(true)
    expect(r.checks.allHaveShaBoundBaseline).toBe(true)
    expect(r.checks.autoReplaceBlocked).toBe(true)
    expect(r.checks.passBlockedNoSha).toBe(true)
    expect(r.checks.passBlockedOverRatio).toBe(true)
    expect(m.MAX_DIFF_PIXEL_RATIO).toBe(0.002)
    expect(r.NOT_SHIPPABLE).toMatch(/no live visual proof/)
  })

  it('planVisualMatrix binds baseline paths to fullSha', async () => {
    const m = await loadVisualFlow()
    const sha = 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd'
    const planned = m.planVisualMatrix({ boardId: 'mfs-rebuild', fullSha: sha })
    expect(planned.plannedCount).toBe(24)
    expect(planned.maxDiffPixelRatio).toBe(0.002)
    for (const row of planned.rows) {
      expect(row.baselinePng).toContain(`/baselines/${sha}/`)
      expect(row.receiptPath).toContain(`${row.artSid}.receipt.json`)
      expect(row.maxDiffPixelRatio).toBe(0.002)
    }
  })
})

describe('screenshot-manifest ART SID helpers (TM-10)', () => {
  it('exposes 24 ART SIDs and maxDiffPixelRatio 0.002', () => {
    expect(ART_SID_IDS).toHaveLength(24)
    expect(ART_SID_IDS[0]).toBe('S01')
    expect(ART_SID_IDS[23]).toBe('S24')
    expect(MAX_DIFF_PIXEL_RATIO).toBe(0.002)
  })

  it('builds SHA-bound baseline and axe paths', () => {
    const sha = 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd'
    const dir = baselineDirForFullSha(sha)
    expect(dir.replace(/\\/g, '/')).toMatch(/baselines\/b9c86c2d1ef6c26d4436d4ffd434642421f847bd$/)
    const paths = artSidBaselinePaths('S07', sha)
    expect(paths.baselinePng).toContain('S07.png')
    expect(paths.receiptPath).toContain('S07.receipt.json')
    expect(artSidAxePath('S07')).toMatch(/axe-S07\.json$/)
  })

  it('buildManifestRow accepts artSid + maxDiffPixelRatio 0.002', () => {
    const sha = 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd'
    const row = buildManifestRow({
      route: '/b/mfs-rebuild/',
      state: 'populated',
      viewport: '1440x900',
      browserTestId: 'visual-S01',
      accessibilityResult: artSidAxePath('S01'),
      missionQuestionLink: 'Q1',
      artSid: 'S01',
      maxDiffPixelRatio: 0.002,
      baselinePath: artSidBaselinePaths('S01', sha).baselinePng,
      fullSha: sha,
      stagingUrl: 'http://127.0.0.1:3210',
      schemaVersion: 'TM_UI_CONTRACT_V1',
    })
    expect(row.artSid).toBe('S01')
    expect(row.maxDiffPixelRatio).toBe(0.002)
    expect(row.baselinePath).toContain(`/baselines/${sha}/S01.png`)
  })

  it('refuses non-0.002 maxDiffPixelRatio on manifest rows', () => {
    expect(() =>
      buildManifestRow({
        route: '/b/mfs-rebuild/',
        state: 'populated',
        viewport: '1440x900',
        browserTestId: 'x',
        accessibilityResult: 'a.json',
        artSid: 'S01',
        maxDiffPixelRatio: 0.05,
      }),
    ).toThrow(/maxDiffPixelRatio must be 0\.002/)
  })
})

