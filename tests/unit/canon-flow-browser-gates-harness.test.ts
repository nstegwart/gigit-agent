/**
 * Unit/self-tests for TM canon-v3 browser acceptance harnesses (no server).
 * Imports Node harness modules via pathToFileURL and exercises pure contracts.
 *
 * Repair R1: adversarial F1–F6 contracts + source anti-regression checks.
 * Semantic R2: criterion 3 graph/layer + related-nav fixtures (no COL_CAP).
 * Semantic R3: explicit five-project cross portfolio (requiredProjects); no tautology.
 * Does NOT claim live functional PASS or staging/prod release.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const STATIC_HARNESS = join(ROOT, 'qa/e2e/flows/canon-flow-static-fidelity.mjs')
const FUNC_HARNESS = join(ROOT, 'qa/e2e/flows/canon-flow-functional.mjs')
const VIS_HARNESS = join(ROOT, 'qa/e2e/flows/canon-flow-visual.mjs')
const SPEC = join(ROOT, 'tests/e2e/canon-flow-total-replacement.spec.ts')
const HELPER = join(ROOT, 'tests/e2e/helpers/canon-flow-gate.ts')

type SelfReport = {
  ok: boolean
  status: string
  failures: string[]
  cases: Record<string, string>
  targetGate?: string
  semantic?: { fixtureOk?: boolean }
}

async function load<T>(abs: string): Promise<T> {
  return (await import(pathToFileURL(abs).href)) as T
}

describe('canon-flow browser gates — file presence', () => {
  it('ships all owned harness paths', () => {
    for (const p of [STATIC_HARNESS, FUNC_HARNESS, VIS_HARNESS, SPEC, HELPER]) {
      expect(existsSync(p), p).toBe(true)
    }
  })
})

describe('canon-flow-static-fidelity self-test', () => {
  it('runSelfTest passes and marks HARNESS_READY', async () => {
    const m = await load<{
      runSelfTest: () => SelfReport
      planFidelityChecks: (o?: object) => { route: string; targetGate: string }
      findTechIdHits: (t: string) => Array<{ match: string }>
      classifyDataHonesty: (i: object) => { claim: string }
      TARGET_GATE: string
    }>(STATIC_HARNESS)
    const r = m.runSelfTest()
    expect(r.ok).toBe(true)
    expect(r.status).toBe('HARNESS_READY')
    expect(r.failures).toEqual([])
    expect(m.TARGET_GATE).toBe('TM_CANON_V3_BROWSER_HARNESS_READY')
    expect(m.planFidelityChecks({ boardId: 'mfs-rebuild' }).route).toBe(
      '/b/mfs-rebuild/alur',
    )
    expect(m.findTechIdHits('GET /api/x').length).toBe(0)
    expect(m.classifyDataHonesty({ source: 'file', pinFieldsPresent: false }).claim).toBe(
      'LOCAL_ONLY',
    )
  })

  it('CLI --self-test exits 0', () => {
    const out = execFileSync(process.execPath, [STATIC_HARNESS, '--self-test'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    const j = JSON.parse(out)
    expect(j.ok).toBe(true)
    expect(j.status).toBe('HARNESS_READY')
  })

  it('CLI --plan exits 0 without server', () => {
    const out = execFileSync(process.execPath, [STATIC_HARNESS, '--plan'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    const j = JSON.parse(out)
    expect(j.route).toMatch(/\/alur$/)
    expect(j.layers.A1_markup.length).toBeGreaterThan(5)
  })
})

describe('canon-flow-functional self-test', () => {
  it('runSelfTest + plan steps + adversarial F3–F6 + semantic R2/R3 cases', async () => {
    const m = await load<{
      runSelfTest: () => SelfReport & {
        semantic?: {
          fixtureOk?: boolean
          requiredCrossProjects?: number
          requiredCrossProjectsList?: string[]
        }
      }
      planFunctionalSteps: (o?: object) => {
        steps: unknown[]
        storageKey: string
        requiredCrossProjects?: number
        requiredCrossProjectsList?: string[]
      }
      evaluatePanDelta: (n: number) => { ok: boolean }
      evaluateDragMovement: (
        a: { x: number; y: number; cx: number; cy: number },
        b: { x: number; y: number; cx: number; cy: number },
      ) => { ok: boolean }
      evaluateEdgeEndpointRedraw: (i: object) => { ok: boolean }
      evaluateRelatedNavigation: (i: object) => { ok: boolean; residual?: boolean }
      evaluateSemanticRelatedNavigation: (i: object) => {
        ok: boolean
        residual?: boolean
        hardFail?: boolean
      }
      evaluateSemanticLayerContract: (i: object) => {
        ok: boolean
        hardFail?: boolean
        reason?: string
        projects?: string[]
        details?: Record<string, unknown>
      }
      evaluateRequiredProjectsCoverage: (i: object) => {
        ok: boolean
        missing: string[]
        unexpected: string[]
      }
      toSemanticLayerPublicDetail: (e: object) => Record<string, unknown>
      evaluateKeyboardNodeOpen: (i: object) => { ok: boolean }
      evaluateNaturalSheetFocus: (i: object) => { ok: boolean }
      evaluateFocusReturn: (i: object) => { ok: boolean }
      evaluateReducedMotionDurations: (
        s: Array<{ selector: string; durationMs: number }>,
      ) => { ok: boolean }
      runSemanticFixtureSelfTest: () => {
        ok: boolean
        cases: Record<string, string>
        failures: string[]
      }
      collectFunctionalHardFails: (
        c: Array<{ name: string; ok: boolean }>,
      ) => Array<{ name: string }>
      isFunctionalHardFailName: (n: string) => boolean
      ALL_SEMANTIC_FIXTURE_SCENARIOS: string[]
      REQUIRED_CROSS_PROJECTS: readonly string[]
      STORAGE_KEY: string
      FUNCTIONAL_STEPS: Array<{ id: string }>
    }>(FUNC_HARNESS)
    const r = m.runSelfTest()
    expect(r.ok).toBe(true)
    expect(r.status).toBe('HARNESS_READY')
    expect(m.STORAGE_KEY).toBe('cairn-flow-pos-v1')
    expect(m.FUNCTIONAL_STEPS.length).toBeGreaterThanOrEqual(18)
    expect(m.evaluatePanDelta(300).ok).toBe(true)
    expect(
      m.evaluateDragMovement(
        { x: 0, y: 0, cx: 10, cy: 10 },
        { x: 120, y: 0, cx: 130, cy: 10 },
      ).ok,
    ).toBe(true)
    const plan = m.planFunctionalSteps({ boardId: 'mfs-rebuild' })
    expect(plan.storageKey).toBe('cairn-flow-pos-v1')
    expect(plan.steps.length).toBe(m.FUNCTIONAL_STEPS.length)

    // Adversarial pure contracts (must be present after repair)
    expect(r.cases.edgeProxyNeg).toBe('PASS')
    expect(r.cases.relatedAbsentNeg).toBe('PASS')
    expect(r.cases.relatedTautNeg).toBe('PASS')
    expect(r.cases.d2SoftNeg).toBe('PASS')
    expect(r.cases.d3ForceNeg).toBe('PASS')
    expect(r.cases.d4SheetOnlyNeg).toBe('PASS')
    expect(r.cases.d6LongNeg).toBe('PASS')
    expect(r.cases.d6EmptyNeg).toBe('PASS')

    // Semantic R2 self-test cases
    expect(r.cases.sem_same_feature_hardneg).toBe('PASS')
    expect(r.cases.sem_inv_goto_neg).toBe('PASS')
    expect(r.cases.sem_hardfail_registry).toBe('PASS')
    expect(r.cases.sem_soft_green_neg).toBe('PASS')
    expect(r.cases.sem_steps).toBe('PASS')
    expect(r.semantic?.fixtureOk).toBe(true)

    // F5 center-only proxy
    expect(
      m.evaluateEdgeEndpointRedraw({
        canvasChanged: false,
        beforeInkNearOldCenter: 5,
        afterInkNearOldCenter: 5,
        afterInkNearNewCenter: 0,
        nodeCenterDelta: 100,
      }).ok,
    ).toBe(false)

    // F6 absence
    const absent = m.evaluateRelatedNavigation({ hasRelatedControl: false })
    expect(absent.ok).toBe(false)
    expect(absent.residual).toBe(true)

    // F3 tautology shape
    expect(
      m.evaluateRelatedNavigation({
        hasRelatedControl: true,
        titleBefore: 'X',
        titleAfter: 'X',
        hlId: null,
        gotoId: 'y',
        sheetOpen: true,
      }).ok,
    ).toBe(false)

    // F4
    expect(
      m.evaluateKeyboardNodeOpen({
        nodeKeyboardFocusable: false,
        openedViaKeyboard: false,
      }).ok,
    ).toBe(false)
    expect(
      m.evaluateNaturalSheetFocus({
        sheetOpen: true,
        activeInSheet: true,
        forceFocused: true,
      }).ok,
    ).toBe(false)
    expect(
      m.evaluateFocusReturn({ sheetClosed: true, focusOnOpener: false }).ok,
    ).toBe(false)
    expect(
      m.evaluateReducedMotionDurations([{ selector: '.s', durationMs: 300 }]).ok,
    ).toBe(false)
    expect(m.evaluateReducedMotionDurations([]).ok).toBe(false)

    // Semantic fixture matrix
    const sem = m.runSemanticFixtureSelfTest()
    expect(sem.ok).toBe(true)
    expect(sem.failures).toEqual([])
    for (const scenario of m.ALL_SEMANTIC_FIXTURE_SCENARIOS) {
      expect(sem.cases[scenario], scenario).toBe('PASS')
    }

    // Legacy multi (≥2) still works when requireMultiProject claimed
    expect(
      m.evaluateSemanticLayerContract({
        mode: 'cross',
        rootLayer: 'app_flow',
        nodes: [
          { id: 'af:rn:a', kind: 'journey_app' },
          { id: 'af:web-member:b', kind: 'journey_app' },
        ],
        honestyState: 'ok',
        requireMultiProject: true,
      }).ok,
    ).toBe(true)

    // R3: explicit five-project portfolio constant
    expect([...m.REQUIRED_CROSS_PROJECTS]).toEqual([
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])

    // R3: full five PASS; 1/5 and wrong alias FAIL hard
    const five = [...m.REQUIRED_CROSS_PROJECTS]
    expect(
      m.evaluateSemanticLayerContract({
        mode: 'cross',
        rootLayer: 'app_flow',
        nodes: five.map((p) => ({ id: `af:${p}:step`, kind: 'journey_app' })),
        honestyState: 'ok',
        requiredProjects: five,
      }).ok,
    ).toBe(true)
    const under = m.evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: [{ id: 'af:rn:a', kind: 'journey_app' }],
      honestyState: 'ok',
      requiredProjects: five,
    })
    expect(under.ok).toBe(false)
    expect(under.hardFail).toBe(true)
    expect(under.reason).toMatch(/missing=\[/)
    expect(under.reason).not.toMatch(/af:rn:/)
    expect(
      m.evaluateSemanticLayerContract({
        mode: 'cross',
        rootLayer: 'app_flow',
        nodes: [
          { id: 'af:rn:a', kind: 'journey_app' },
          { id: 'af:web:b', kind: 'journey_app' },
          { id: 'af:sales:c', kind: 'journey_app' },
          { id: 'af:affiliate:d', kind: 'journey_app' },
          { id: 'af:backend:e', kind: 'journey_app' },
        ],
        honestyState: 'ok',
        requiredProjects: five,
      }).ok,
    ).toBe(false)

    // R3: public detail scrub
    const pub = m.toSemanticLayerPublicDetail(under)
    expect(JSON.stringify(pub)).not.toMatch(/af:rn:/)
    expect((pub.details as { missingProjects?: string[] }).missingProjects?.length).toBeGreaterThan(
      0,
    )

    // R3 self-test portfolio cases
    expect(r.cases.sem_required_cross_const).toBe('PASS')
    expect(r.cases.sem_plan_required_cross).toBe('PASS')
    expect(r.cases.sem_portfolio_1of5).toBe('PASS')
    expect(r.cases.sem_portfolio_5of5).toBe('PASS')
    expect(r.cases.sem_portfolio_wrong_alias).toBe('PASS')
    expect(r.cases.sem_public_detail_scrub).toBe('PASS')
    expect(r.semantic?.requiredCrossProjects).toBe(5)

    // R3 plan advertises requiredCrossProjects=5/list
    expect(plan.requiredCrossProjects).toBe(5)
    expect(plan.requiredCrossProjectsList).toEqual(five)

    // Negative undercoverage fixtures in matrix
    for (const sc of [
      'cross-undercover-1of5',
      'cross-undercover-4of5',
      'cross-wrong-alias',
      'cross-dup-same-project',
      'cross-extra-unknown',
    ]) {
      expect(m.ALL_SEMANTIC_FIXTURE_SCENARIOS).toContain(sc)
      expect(sem.cases[sc]).toBe('PASS')
    }

    // Negative: same-feature
    expect(
      m.evaluateSemanticRelatedNavigation({
        hasRelatedControl: true,
        controlKind: 'same-feature',
        gotoId: 'af:rn:home',
        titleBefore: 'A',
        titleAfter: 'B',
        hlId: 'af:rn:home',
        sheetOpen: true,
      }).ok,
    ).toBe(false)

    // Hard-fail registry includes S*
    expect(m.isFunctionalHardFailName('S1_semantic_layer')).toBe(true)
    expect(m.isFunctionalHardFailName('S2_semantic_related_nav')).toBe(true)
    expect(m.isFunctionalHardFailName('S3_id_id_chrome')).toBe(true)
    expect(
      m.collectFunctionalHardFails([
        { name: 'S1_semantic_layer', ok: false },
        { name: 'optional_info', ok: false },
      ]).map((h) => h.name),
    ).toEqual(['S1_semantic_layer'])

    // Steps include S1/S2/S3
    const ids = new Set(m.FUNCTIONAL_STEPS.map((s) => s.id))
    expect(ids.has('S1')).toBe(true)
    expect(ids.has('S2')).toBe(true)
    expect(ids.has('S3')).toBe(true)
  })

  it('CLI --self-test and --plan exit 0', () => {
    for (const flag of ['--self-test', '--plan']) {
      const out = execFileSync(process.execPath, [FUNC_HARNESS, flag], {
        encoding: 'utf8',
        cwd: ROOT,
      })
      const j = JSON.parse(out)
      if (flag === '--self-test') {
        expect(j.ok).toBe(true)
        expect(j.cases.edgeProxyNeg).toBe('PASS')
        expect(j.cases.relatedAbsentNeg).toBe('PASS')
        expect(j.cases.sem_same_feature_hardneg).toBe('PASS')
        expect(j.cases.sem_portfolio_1of5).toBe('PASS')
        expect(j.semantic?.fixtureOk).toBe(true)
        expect(j.semantic?.requiredCrossProjects).toBe(5)
      } else {
        expect(j.steps?.length).toBeGreaterThan(10)
        expect(j.steps.some((s: { id: string }) => s.id === 'S1')).toBe(true)
        expect(j.requiredCrossProjects).toBe(5)
        expect(j.requiredCrossProjectsList).toEqual([
          'rn',
          'web-member',
          'panel-sales',
          'affiliate',
          'backend',
        ])
      }
    }
  })
})

describe('canon-flow-visual self-test', () => {
  it('runSelfTest + FULL_SHA fail-closed + plan matrix', async () => {
    const m = await load<{
      runSelfTest: () => SelfReport
      planVisualCaptures: (o: { fullSha: string; boardId?: string }) => {
        rowCount: number
        fullSha: string
        autoReplaceForbidden: boolean
        baselineBlessForbidden: boolean
        rows: Array<{ deviceScaleFactor: number; viewport: string; state: string }>
      }
      requireVisualFullSha: (o: { fullSha: string }) => string
      buildCompareInputs: (o: { fullSha: string }) => { pairs: unknown[] }
      VIEWPORTS: Array<{ name: string }>
      VISUAL_STATES: string[]
    }>(VIS_HARNESS)

    const r = m.runSelfTest()
    expect(r.ok).toBe(true)
    expect(r.status).toBe('HARNESS_READY')

    expect(() => m.requireVisualFullSha({ fullSha: 'nope' })).toThrow(/FULL_SHA|40-char/)
    expect(() => m.requireVisualFullSha({ fullSha: 'UNKNOWN_SHA' })).toThrow()

    const sha = 'e'.repeat(40)
    const plan = m.planVisualCaptures({ fullSha: sha, boardId: 'mfs-rebuild' })
    expect(plan.fullSha).toBe(sha)
    expect(plan.autoReplaceForbidden).toBe(true)
    expect(plan.baselineBlessForbidden).toBe(true)
    expect(plan.rowCount).toBe(4 * 3 + 1)
    expect(plan.rows.some((row) => row.deviceScaleFactor === 2)).toBe(true)
    expect(m.VIEWPORTS.map((v) => v.name)).toEqual(['390x844', '1440x900', '2560x1300'])
    expect(m.VISUAL_STATES).toContain('after-drag')
    expect(m.buildCompareInputs({ fullSha: sha }).pairs.length).toBe(plan.rowCount)
  })

  it('CLI --self-test exits 0; --plan with FULL_SHA exits 0', () => {
    const selfOut = execFileSync(process.execPath, [VIS_HARNESS, '--self-test'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    expect(JSON.parse(selfOut).ok).toBe(true)

    const sha = 'f'.repeat(40)
    const planOut = execFileSync(process.execPath, [VIS_HARNESS, '--plan'], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, FULL_SHA: sha },
    })
    const plan = JSON.parse(planOut)
    expect(plan.fullSha).toBe(sha)
    expect(plan.rowCount).toBeGreaterThanOrEqual(13)
  })

  it('CLI --plan fails closed when FULL_SHA is invalid', () => {
    let code = 0
    try {
      execFileSync(process.execPath, [VIS_HARNESS, '--plan'], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, FULL_SHA: 'not-a-sha' },
      })
      code = 0
    } catch (e: unknown) {
      const err = e as { status?: number }
      code = err.status ?? 1
    }
    expect(code).not.toBe(0)
  })
})

describe('canon-flow TS helper + Playwright anti-regression (F1–F6 + S* + R3)', () => {
  it('helper declares fail-closed FULL_SHA + repair + semantic evaluators + R3 portfolio', () => {
    const src = readFileSync(HELPER, 'utf8')
    expect(src).toContain('TM_CANON_V3_BROWSER_HARNESS_READY')
    expect(src).toContain('cairn-flow-pos-v1')
    expect(src).toContain('LOCAL_ONLY')
    expect(src).toContain('deviceScaleFactor')
    expect(src).toContain('requireFullSha')
    expect(src).toContain('evaluateEdgeEndpointRedraw')
    expect(src).toContain('evaluateRelatedNavigation')
    expect(src).toContain('evaluateSemanticLayerContract')
    expect(src).toContain('evaluateSemanticRelatedNavigation')
    expect(src).toContain('evaluateRequiredProjectsCoverage')
    expect(src).toContain('toSemanticLayerPublicDetail')
    expect(src).toContain('REQUIRED_CROSS_PROJECTS')
    expect(src).toContain('requiredProjects')
    expect(src).toContain('cross-undercover-1of5')
    expect(src).toContain('cross-undercover-4of5')
    expect(src).toContain('cross-wrong-alias')
    expect(src).toContain('cross-dup-same-project')
    expect(src).toContain('cross-extra-unknown')
    expect(src).toContain('evaluateIndonesianChromeLabels')
    expect(src).toContain('buildSemanticFixture')
    expect(src).toContain('runSemanticFixtureSelfTest')
    expect(src).toContain('evaluateKeyboardNodeOpen')
    expect(src).toContain('evaluateNaturalSheetFocus')
    expect(src).toContain('evaluateFocusReturn')
    expect(src).toContain('evaluateLiveAuthResidual')
    expect(src).toContain('collectHardFails')
    expect(src).toContain('PLAYWRIGHT_HARD_FAIL_LAYERS')
    expect(src).toContain("'S1'")
    expect(src).toContain("'S2'")
    expect(src).toContain("'S3'")
    // No COL_CAP token in semantic gate helper
    expect(src).not.toMatch(/\bCOL_CAP\b/)
    // R3: no tautological auto-require from visible project count
    expect(src).not.toMatch(/projectList\.length\s*>=\s*2[\s\S]{0,40}requireMulti/)
  })

  it('Playwright source rejects F1 green residual / F2 narrow hardFails / F3 tautology / semantic / R3', () => {
    const src = readFileSync(SPEC, 'utf8')
    // F3: no related_changes tautology (historical vacuous form)
    expect(src).not.toMatch(/t1\s*!==\s*t0\s*\|\|\s*true/)
    expect(src).not.toMatch(/related_changes[\s\S]{0,80}\|\|\s*true/)
    // F1: residual uses evaluateLiveAuthResidual / checkOk false path
    expect(src).toContain('evaluateLiveAuthResidual')
    expect(src).toContain('LOCAL_ONLY residual')
    expect(src).toMatch(/live_residual_auth/)
    // F2: collectHardFails (includes A5)
    expect(src).toContain('collectHardFails')
    expect(src).toContain("'A5'")
    // F5: canvas edge evaluator
    expect(src).toContain('evaluateEdgeEndpointRedraw')
    // F4
    expect(src).toContain('evaluateKeyboardNodeOpen')
    expect(src).toContain('evaluateNaturalSheetFocus')
    expect(src).toContain('evaluateFocusReturn')
    // Semantic R2/R3
    expect(src).toContain('evaluateSemanticLayerContract')
    expect(src).toContain('evaluateSemanticRelatedNavigation')
    expect(src).toContain('REQUIRED_CROSS_PROJECTS')
    expect(src).toContain('toSemanticLayerPublicDetail')
    expect(src).toContain('requiredProjects')
    expect(src).toContain('flow-related')
    expect(src).toContain('flow-same-feature-item')
    expect(src).toContain('same_feature_cannot_pass')
    expect(src).toContain('semantic_layer')
    expect(src).toContain('semantic_related_nav')
    expect(src).toMatch(/\/alur/)
    // R3: no live tautological requireMultiProject auto-detect
    expect(src).not.toMatch(
      /requireMultiProject:\s*\n?\s*semanticDom\.mode\s*===\s*['"]cross['"]\s*&&/,
    )
    expect(src).toContain('[...REQUIRED_CROSS_PROJECTS]')
    // No force-focus on close for D3
    expect(src).not.toMatch(/close\.focus\s*\(/)
    expect(src).not.toMatch(/flow-sheet-close[^\n]*\.focus/)
    expect(src).not.toMatch(/\bCOL_CAP\b/)
  })

  it('functional harness source has canvas probe, semantic gates, R3 portfolio, no B9 soft skip, no COL_CAP', () => {
    const src = readFileSync(FUNC_HARNESS, 'utf8')
    expect(src).toContain('evaluateEdgeEndpointRedraw')
    expect(src).toContain('getImageData')
    expect(src).toContain('evaluateRelatedNavigation')
    expect(src).toContain('evaluateSemanticLayerContract')
    expect(src).toContain('evaluateSemanticRelatedNavigation')
    expect(src).toContain('evaluateRequiredProjectsCoverage')
    expect(src).toContain('toSemanticLayerPublicDetail')
    expect(src).toContain('REQUIRED_CROSS_PROJECTS')
    expect(src).toContain('requiredCrossProjects')
    expect(src).toContain('requiredProjects')
    expect(src).toContain('collectFunctionalHardFails')
    expect(src).toContain('flow-related')
    expect(src).toContain('flow-same-feature-item')
    expect(src).toContain('Navigasi terkait')
    expect(src).toContain('evaluateKeyboardNodeOpen')
    expect(src).toContain('forceFocused: false')
    expect(src).not.toMatch(/B9_related_content_changes',\s*true/)
    expect(src).not.toMatch(/skipped:\s*true[\s\S]{0,80}not a hard FAIL/)
    // D6 must use rmEval.ok as fail condition
    expect(src).toMatch(/rm\.matches\s*&&\s*rmEval\.ok/)
    // No COL_CAP token in this functional harness (criterion 3)
    expect(src).not.toMatch(/\bCOL_CAP\b/)
    // R3: no live tautological requireMultiProject auto-detect
    expect(src).not.toMatch(
      /requireMultiProject:\s*\n?\s*semanticDom\.mode\s*===\s*['"]cross['"]\s*&&/,
    )
    expect(src).toContain('[...REQUIRED_CROSS_PROJECTS]')
    // Authenticated alur entry
    expect(src).toMatch(/\/alur/)
  })

  it('before false-green proof: pre-R2 any data-goto would pass; post-R2 Fitur sama fails', async () => {
    const m = await load<{
      evaluateRelatedNavigation: (i: object) => { ok: boolean }
      evaluateSemanticRelatedNavigation: (i: object) => { ok: boolean; reason: string }
    }>(FUNC_HARNESS)
    // Legacy base evaluator: content+highlight with arbitrary data-goto still "passes"
    // (this is the false-green shape criterion 3 closes).
    const legacy = m.evaluateRelatedNavigation({
      hasRelatedControl: true,
      titleBefore: 'A',
      titleAfter: 'B',
      hlId: 'af:rn:home',
      gotoId: 'af:rn:home',
      sheetOpen: true,
    })
    expect(legacy.ok).toBe(true)
    // Same shape as Fitur sama control — semantic evaluator rejects
    const semantic = m.evaluateSemanticRelatedNavigation({
      hasRelatedControl: true,
      controlKind: 'same-feature',
      gotoId: 'af:rn:home',
      targetPresentAsJourney: true,
      titleBefore: 'A',
      titleAfter: 'B',
      hlId: 'af:rn:home',
      sheetOpen: true,
      mode: 'rn',
      layer: 'app_flow',
      routePathBefore: '/b/x/alur',
      routePathAfter: '/b/x/alur',
    })
    expect(semantic.ok).toBe(false)
    expect(semantic.reason).toMatch(/Fitur sama/i)
  })
})
